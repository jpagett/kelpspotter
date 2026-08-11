/*
 * POI — points of interest imported from KML / KMZ.
 *
 * Everything happens in the browser: KML is XML, so DOMParser handles it, and
 * KMZ is a ZIP, unpacked here with DecompressionStream rather than a library.
 * That keeps the site deployable on GitHub Pages with no server and no new
 * dependency.
 *
 * Points are the priority — dive sites, landmarks — but LineStrings and Polygons
 * are drawn too, since a dive-site KML often carries a boundary or a track and
 * silently dropping them would look like a broken import.
 */
const POI = (function () {
  const PANE = 'poi';

  /*
   * Marker symbols. `match` is scanned against the placemark's name, description
   * and enclosing folder so a typical dive-site KML lands on sensible icons
   * without the user classifying every point by hand; the panel lets them
   * override per point.
   */
  const SYMBOLS = {
    dive:     { glyph: '⚓', label: 'Dive site', colour: '#f2b134',
                match: /\b(dive|diving|divesite|scuba|shore\s*dive|boat\s*dive)\b/i },
    wreck:    { glyph: '⚱', label: 'Wreck', colour: '#e2725b',
                match: /\b(wreck|sunken|shipwreck)\b/i },
    kelp:     { glyph: '❦', label: 'Kelp bed', colour: '#a6d95b',
                match: /\b(kelp|macrocystis|canopy|forest)\b/i },
    reef:     { glyph: '▲', label: 'Reef / pinnacle', colour: '#5ec6c9',
                match: /\b(reef|rock|pinnacle|ledge|bank)\b/i },
    launch:   { glyph: '⚑', label: 'Launch / access', colour: '#c78bd9',
                match: /\b(launch|ramp|access|parking|entry|harbou?r|pier)\b/i },
    marker:   { glyph: '●', label: 'Marker', colour: '#6fb7bd', match: null }
  };
  const SYMBOL_KEYS = Object.keys(SYMBOLS);

  let cfg = null, L = null, map = null, say = null, toast = null;
  let items = [];          // {id,name,desc,lat,lng,symbol,visible,marker}
  let shapes = [];         // non-point geometry, drawn but not listed
  let nextId = 1;

  function init(config, leaflet, leafletMap, logger, toaster) {
    cfg = config; L = leaflet; map = leafletMap;
    say = logger || function () {};
    toast = toaster || function () {};
    map.createPane(PANE).style.zIndex = 640;   // above kelp, below the UI
    wireUi();
    render();
  }

  /* ------------------------------------------------------------- KMZ (zip) */

  /*
   * Minimal ZIP reader: walk the central directory, inflate with the platform's
   * DecompressionStream. Only what KMZ actually uses — stored (0) and deflate
   * (8) — is supported, which covers every KMZ Google Earth produces.
   */
  async function unzipFirstKml(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const u32 = (o) => view.getUint32(o, true);
    const u16 = (o) => view.getUint16(o, true);

    // End of central directory, scanned backwards past any trailing comment
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a valid KMZ (no zip directory)');

    let ptr = u32(eocd + 16);
    const count = u16(eocd + 10);
    for (let n = 0; n < count; n++) {
      if (u32(ptr) !== 0x02014b50) break;
      const method = u16(ptr + 10);
      const compSize = u32(ptr + 20);
      const nameLen = u16(ptr + 28);
      const extraLen = u16(ptr + 30);
      const commentLen = u16(ptr + 32);
      const localOff = u32(ptr + 42);
      const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;
      if (!/\.kml$/i.test(name)) continue;

      // the local header repeats the name/extra lengths, and they can differ
      const lnLen = u16(localOff + 26), leLen = u16(localOff + 28);
      const start = localOff + 30 + lnLen + leLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) throw new Error('unsupported KMZ compression');
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('this browser cannot unpack KMZ — unzip it and import the .kml');
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([data]).stream().pipeThrough(ds);
      return new Response(stream).text();
    }
    throw new Error('no .kml inside the KMZ');
  }

  /* ------------------------------------------------------------ KML parsing */

  const textOf = (el, tag) => {
    const n = el.getElementsByTagName(tag)[0];
    return n && n.textContent ? n.textContent.trim() : '';
  };

  // "lng,lat[,alt] lng,lat…" — whitespace separated, altitude optional
  function parseCoords(raw) {
    return (raw || '').trim().split(/\s+/).map((tok) => {
      const p = tok.split(',');
      const lng = parseFloat(p[0]), lat = parseFloat(p[1]);
      return (isFinite(lat) && isFinite(lng)) ? [lat, lng] : null;
    }).filter(Boolean);
  }

  function guessSymbol(hay) {
    for (const k of SYMBOL_KEYS) {
      const s = SYMBOLS[k];
      if (s.match && s.match.test(hay)) return k;
    }
    return 'marker';
  }

  function parseKml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('malformed KML');

    const points = [], lines = [], polys = [];
    const marks = doc.getElementsByTagName('Placemark');
    for (const pm of marks) {
      const name = textOf(pm, 'name') || 'Unnamed';
      const desc = textOf(pm, 'description');
      // folder name is a strong hint for type ("Dive sites", "Wrecks"…)
      let folder = '';
      for (let a = pm.parentElement; a; a = a.parentElement) {
        if (a.tagName === 'Folder' || a.tagName === 'Document') {
          folder = textOf(a, 'name'); if (folder) break;
        }
      }
      const hay = [name, desc, folder, textOf(pm, 'styleUrl')].join(' ');

      for (const pt of pm.getElementsByTagName('Point')) {
        const c = parseCoords(textOf(pt, 'coordinates'))[0];
        if (c) points.push({ name, desc, folder, lat: c[0], lng: c[1], symbol: guessSymbol(hay) });
      }
      for (const ls of pm.getElementsByTagName('LineString')) {
        const c = parseCoords(textOf(ls, 'coordinates'));
        if (c.length > 1) lines.push({ name, coords: c });
      }
      for (const pg of pm.getElementsByTagName('Polygon')) {
        const c = parseCoords(textOf(pg, 'coordinates'));
        if (c.length > 2) polys.push({ name, coords: c });
      }
    }
    return { points, lines, polys };
  }

  /* ---------------------------------------------------------------- markers */

  function iconFor(symbol) {
    const s = SYMBOLS[symbol] || SYMBOLS.marker;
    return L.divIcon({
      className: 'poi-pin',
      html: '<span style="background:' + s.colour + '">' + s.glyph + '</span>',
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
  }

  function addMarker(p) {
    const m = L.marker([p.lat, p.lng], { icon: iconFor(p.symbol), pane: PANE, title: p.name });
    m.bindPopup('<b>' + escapeHtml(p.name) + '</b>' +
                (p.desc ? '<br>' + escapeHtml(p.desc).slice(0, 300) : ''));
    m.addTo(map);
    return m;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function ingest(parsed, sourceName) {
    parsed.points.forEach((p) => {
      const rec = Object.assign({ id: nextId++, visible: true, source: sourceName }, p);
      rec.marker = addMarker(rec);
      items.push(rec);
    });
    parsed.lines.forEach((l) => {
      shapes.push(L.polyline(l.coords, { pane: PANE, color: '#6fb7bd', weight: 2, opacity: 0.85 }).addTo(map));
    });
    parsed.polys.forEach((g) => {
      shapes.push(L.polygon(g.coords, { pane: PANE, color: '#6fb7bd', weight: 1.5,
        opacity: 0.85, fillOpacity: 0.12 }).addTo(map));
    });
    render();
    const extra = parsed.lines.length + parsed.polys.length;
    say('Imported ' + parsed.points.length + ' point' + (parsed.points.length === 1 ? '' : 's') +
        (extra ? ' and ' + extra + ' shape' + (extra === 1 ? '' : 's') : '') +
        ' from ' + sourceName, 'ok');
    if (!parsed.points.length && !extra) toast('No placemarks found in that file.', true);
    else fitAll();
  }

  async function importFile(file) {
    try {
      let text;
      if (/\.kmz$/i.test(file.name)) text = await unzipFirstKml(await file.arrayBuffer());
      else text = await file.text();
      ingest(parseKml(text), file.name);
    } catch (err) {
      console.warn(err);
      toast('Could not read that file — ' + err.message, true);
      say('KML import failed — ' + err.message, 'warn');
    }
  }

  /*
   * Direct URL import. Works only for hosts that send CORS headers; Google's
   * share links do not, which is why the failure message names that case
   * explicitly rather than just saying "failed".
   */
  async function importUrl(url) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const isKmz = /\.kmz(\?|$)/i.test(url) ||
                    (new Uint8Array(buf, 0, 2)[0] === 0x50 && new Uint8Array(buf, 1, 1)[0] === 0x4b);
      const text = isKmz ? await unzipFirstKml(buf) : new TextDecoder().decode(buf);
      ingest(parseKml(text), url.split('/').pop().slice(0, 40) || 'link');
    } catch (err) {
      console.warn(err);
      const blocked = /Failed to fetch|NetworkError|CORS/i.test(String(err.message));
      const msg = blocked
        ? 'That host blocks browser downloads (CORS). Google Earth and Google Maps links always do — export the KML and import the file instead.'
        : err.message;
      toast(msg, true);
      say('URL import failed — ' + (blocked ? 'blocked by CORS' : err.message), 'warn');
    }
  }

  /* ------------------------------------------------------------------ panel */

  function fitAll() {
    const vis = items.filter((i) => i.visible);
    if (!vis.length) return;
    map.fitBounds(L.latLngBounds(vis.map((i) => [i.lat, i.lng])).pad(0.25));
  }

  function flyTo(rec) {
    map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 14));
    if (rec.marker) rec.marker.openPopup();
  }

  function setSymbol(rec, key) {
    rec.symbol = key;
    if (rec.marker) rec.marker.setIcon(iconFor(key));
    render();
  }

  function setVisible(rec, on) {
    rec.visible = on;
    if (!rec.marker) return;
    if (on) rec.marker.addTo(map); else map.removeLayer(rec.marker);
    render();
  }

  function remove(rec) {
    if (rec.marker) map.removeLayer(rec.marker);
    items = items.filter((i) => i !== rec);
    render();
  }

  function clearAll() {
    items.forEach((i) => { if (i.marker) map.removeLayer(i.marker); });
    shapes.forEach((s) => map.removeLayer(s));
    items = []; shapes = [];
    render();
    say('Points of interest cleared');
  }

  function render() {
    const box = document.getElementById('poi-list');
    const note = document.getElementById('poi-note');
    if (!box) return;
    box.textContent = '';
    if (!items.length) {
      note.textContent = 'No points yet — import a KML from the ⚙ menu.';
      return;
    }
    note.textContent = items.length + ' point' + (items.length === 1 ? '' : 's') +
                       ' · tap one to jump to it';
    items.forEach((rec) => {
      const row = document.createElement('div');
      row.className = 'poi-item' + (rec.visible ? '' : ' off');

      const pin = document.createElement('button');
      pin.className = 'poi-sym'; pin.type = 'button';
      pin.style.background = (SYMBOLS[rec.symbol] || SYMBOLS.marker).colour;
      pin.textContent = (SYMBOLS[rec.symbol] || SYMBOLS.marker).glyph;
      pin.title = 'Change symbol';
      pin.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const i = SYMBOL_KEYS.indexOf(rec.symbol);
        setSymbol(rec, SYMBOL_KEYS[(i + 1) % SYMBOL_KEYS.length]);   // cycle
      });

      const name = document.createElement('span');
      name.className = 'poi-name';
      name.textContent = rec.name;
      name.title = rec.name + (rec.desc ? ' — ' + rec.desc.slice(0, 120) : '');

      const eye = document.createElement('button');
      eye.className = 'poi-eye'; eye.type = 'button';
      eye.textContent = rec.visible ? '◉' : '◌';
      eye.title = rec.visible ? 'Hide this point' : 'Show this point';
      eye.addEventListener('click', (ev) => { ev.stopPropagation(); setVisible(rec, !rec.visible); });

      const del = document.createElement('button');
      del.className = 'poi-del'; del.type = 'button'; del.textContent = '×';
      del.title = 'Remove this point';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); remove(rec); });

      row.addEventListener('click', () => flyTo(rec));
      row.appendChild(pin); row.appendChild(name); row.appendChild(eye); row.appendChild(del);
      box.appendChild(row);
    });
  }

  function wireUi() {
    const file = document.getElementById('poi-file');
    const pick = () => file && file.click();
    ['poi-import', 'poi-add-btn'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', pick);
    });
    if (file) file.addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) importFile(f);
      ev.target.value = '';
    });
    const urlBtn = document.getElementById('poi-import-url');
    if (urlBtn) urlBtn.addEventListener('click', () => {
      const u = window.prompt('Direct URL to a .kml or .kmz file:\n\n' +
        'Google Earth / Google Maps share links will not work — they block browser ' +
        'downloads. Export the KML from those and use Import KML / KMZ instead.');
      if (u && u.trim()) importUrl(u.trim());
    });
    const clr = document.getElementById('poi-clear');
    if (clr) clr.addEventListener('click', clearAll);
    const fit = document.getElementById('poi-fit');
    if (fit) fit.addEventListener('click', fitAll);
  }

  return {
    init: init,
    importFile: importFile,
    importUrl: importUrl,
    clearAll: clearAll,
    fitAll: fitAll,
    parseKml: parseKml,          // exported for testing
    get list() { return items; },
    SYMBOLS: SYMBOLS
  };
})();

window.POI = POI;
