/*
 * POI — points of interest imported from KML / KMZ.
 *
 * Everything happens in the browser: KML is XML, so DOMParser handles it, and
 * KMZ is a ZIP, unpacked here with DecompressionStream rather than a library.
 * That keeps the site deployable on GitHub Pages with no server and no new
 * dependency.
 *
 * File import only, by design. Fetching share links was built and then removed:
 * see docs/share-link-import.md — no proxy can make Google Maps saved lists work
 * (the places are not in the document a proxy would receive), and Earth projects
 * would need an undocumented endpoint that breaks without warning.
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
  // set by init: tells the host something worth saving happened
  let changed = function () {};
  let items = [];          // {id,name,desc,lat,lng,symbol,visible,marker}
  let shapes = [];         // non-point geometry, drawn but not listed
  let nextId = 1;
  let filterText = '';     // live text of the panel's filter box

  function init(config, leaflet, leafletMap, logger, toaster, onChanged) {
    cfg = config; L = leaflet; map = leafletMap;
    say = logger || function () {};
    toast = toaster || function () {};
    changed = onChanged || function () {};
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

  /* ------------------------------------------------------------ GPX parsing */

  /*
   * GPX is the other file every mapping app exports — dive computers, Garmin
   * units, phone GPS loggers. Same shape as the KML result so both formats
   * flow through one import path: <wpt> are points, <trk>/<rte> draw as lines.
   * Coordinates are attributes (lat/lon) rather than a text blob, and the
   * usual metadata lives in <name>/<desc>/<cmt>/<sym>/<type>.
   */
  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('malformed GPX');

    const points = [], lines = [], polys = [];
    const coordOf = (el) => {
      const lat = parseFloat(el.getAttribute('lat'));
      const lng = parseFloat(el.getAttribute('lon'));
      return (isFinite(lat) && isFinite(lng)) ? [lat, lng] : null;
    };

    for (const wpt of doc.getElementsByTagName('wpt')) {
      const c = coordOf(wpt);
      if (!c) continue;
      const name = textOf(wpt, 'name') || 'Unnamed';
      const desc = textOf(wpt, 'desc') || textOf(wpt, 'cmt');
      const hay = [name, desc, textOf(wpt, 'sym'), textOf(wpt, 'type')].join(' ');
      points.push({ name, desc, folder: '', lat: c[0], lng: c[1], symbol: guessSymbol(hay) });
    }

    // tracks (recorded) and routes (planned) both draw as context lines;
    // a track's segments stay separate so gaps in the recording stay gaps
    for (const trk of doc.getElementsByTagName('trk')) {
      const name = textOf(trk, 'name') || 'Track';
      for (const seg of trk.getElementsByTagName('trkseg')) {
        const coords = Array.from(seg.getElementsByTagName('trkpt')).map(coordOf).filter(Boolean);
        if (coords.length > 1) lines.push({ name, coords });
      }
    }
    for (const rte of doc.getElementsByTagName('rte')) {
      const coords = Array.from(rte.getElementsByTagName('rtept')).map(coordOf).filter(Boolean);
      if (coords.length > 1) lines.push({ name: textOf(rte, 'name') || 'Route', coords });
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
    /*
     * Draggable, because a point dropped at the map centre or read off a
     * screenshot is usually roughly right and wants nudging — and nudging it
     * by typing coordinates means converting what your eye already knows into
     * numbers. autoPan lets a drag continue past the edge of the view.
     */
    const m = L.marker([p.lat, p.lng], {
      icon: iconFor(p.symbol), pane: PANE, title: p.name,
      draggable: true, autoPan: true, autoPanSpeed: 12
    });
    m.bindPopup('<b>' + escapeHtml(p.name) + '</b>' +
                (p.desc ? '<br>' + escapeHtml(p.desc).slice(0, 300) : ''));
    /*
     * Only on drop, not on every frame: each move re-reads the charted depth
     * and rewrites storage, and doing that per pointermove would hammer both
     * for positions the user is still dragging through.
     */
    m.on('dragend', () => {
      const ll = m.getLatLng();
      // the marker is already where it was dropped, so the map must not follow
      moveTo(p, ll.lat, ll.lng, false);
    });
    m.addTo(map);
    return m;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /*
   * Depth under each marker, fetched once per point and kept on the record —
   * a dive-site list without depths is half a list. Best-effort: a failed
   * batch leaves the rows without a depth rather than failing the import.
   */
  // Coalesce bursts (a session import upserts one POI at a time) into one
  // batched NOAA request rather than one per marker.
  let annotateTimer = null;
  function scheduleAnnotate() {
    clearTimeout(annotateTimer);
    annotateTimer = setTimeout(annotateDepths, 250);
  }
  async function annotateDepths() {
    const todo = items.filter((i) => i.depthFt === undefined);
    if (!todo.length || !window.DemSampler) return;
    try {
      const vals = await DemSampler.points(todo.map((i) => ({ lat: i.lat, lng: i.lng })));
      todo.forEach((it, k) => {
        it.depthFt = vals[k] === null ? null : Math.round(-vals[k] * 3.280839895);
      });
      render();
    } catch (err) { console.warn('POI depth annotation skipped:', err); }
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
    else { fitAll(); annotateDepths(); }
  }

  // shapes are decorative context (tracks, boundaries) — they draw
  // immediately; only the point markers go through the review
  function ingestShapes(parsed) {
    parsed.lines.forEach((l) => {
      shapes.push(L.polyline(l.coords, { pane: PANE, color: '#6fb7bd', weight: 2, opacity: 0.85 }).addTo(map));
    });
    parsed.polys.forEach((g) => {
      shapes.push(L.polygon(g.coords, { pane: PANE, color: '#6fb7bd', weight: 1.5,
        opacity: 0.85, fillOpacity: 0.12 }).addTo(map));
    });
  }

  async function importFile(file) {
    try {
      let text;
      if (/\.kmz$/i.test(file.name)) text = await unzipFirstKml(await file.arrayBuffer());
      else text = await file.text();
      const parsed = /\.gpx$/i.test(file.name) ? parseGpx(text) : parseKml(text);
      /*
       * Placemarks go through the same diff review the session importer uses:
       * additions and changes ticked, merge by default, overwrite (removals)
       * opt-in per the replace toggle. Nothing lands until Import is pressed.
       */
      if (window.Session && window.SessionUI && parsed.points.length) {
        ingestShapes(parsed);
        const recs = parsed.points.map((pt) => ({
          uid: Session.poiUid(pt), name: pt.name, lat: pt.lat, lng: pt.lng,
          symbol: pt.symbol, desc: pt.desc || '', visible: true
        }));
        say(file.name + ': ' + recs.length + ' placemark' + (recs.length === 1 ? '' : 's') +
            ' — review before import');
        SessionUI.open(Session.diffPois(recs), file.name);
      } else {
        ingest(parsed, file.name);   // no review machinery loaded, or no points
      }
    } catch (err) {
      console.warn(err);
      toast('Could not read that file — ' + err.message, true);
      say('Import failed — ' + err.message, 'warn');
    }
  }

  /*
   * Direct URL import. Works only for hosts that send CORS headers; Google's
   * share links do not, which is why the failure message names that case
   * explicitly rather than just saying "failed".
   */
  /* ------------------------------------------------------------------ panel */

  function fitAll() {
    const vis = items.filter((i) => i.visible);
    if (!vis.length) return;
    map.fitBounds(L.latLngBounds(vis.map((i) => [i.lat, i.lng])).pad(0.25));
  }

  function flyTo(rec) {
    // Get the panel out of the way first, so the map is already visible when
    // it moves: on a phone the POI sheet fills the screen, and centring the
    // map behind it looked like the button had done nothing at all.
    if (window.MobileShell) MobileShell.closeSheet();
    map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 14));
    if (rec.marker) rec.marker.openPopup();
  }

  /*
   * Positions here are read by the path editor's parser, so one typed into a
   * point and one typed into a path node behave identically — decimal, DDM,
   * DMS, and the first pair out of a maps URL. The fallback is only for a page
   * that somehow loaded without paths.js.
   */
  function readCoords(text) {
    if (window.Paths && typeof Paths.parseCoords === 'function') return Paths.parseCoords(text);
    const m = String(text).match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    return (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ? { lat: lat, lng: lng } : null;
  }

  function refreshMarker(rec) {
    if (!rec.marker) return;
    rec.marker.setPopupContent('<b>' + escapeHtml(rec.name) + '</b>' +
      (rec.desc ? '<br>' + escapeHtml(rec.desc).slice(0, 300) : ''));
    if (rec.marker.options) rec.marker.options.title = rec.name;
  }

  /*
   * `follow` is for the caller that cannot see where the point went: typing a
   * position into the panel can send it anywhere, so the map goes with it. A
   * drag already put it where you were looking, and re-centring on drop would
   * yank the view out from under the hand that just placed it.
   */
  function moveTo(rec, lat, lng, follow) {
    rec.lat = lat; rec.lng = lng;
    // the charted depth described where it used to be
    delete rec.depthFt;
    if (rec.marker) rec.marker.setLatLng([lat, lng]);
    refreshMarker(rec);
    if (follow !== false) map.setView([lat, lng], Math.max(map.getZoom(), 14));
    say(rec.name + ' moved to ' + lat.toFixed(5) + ', ' + lng.toFixed(5));
    changed();
    scheduleAnnotate();          // re-read the charted depth at the new spot
    render();
  }

  /*
   * A new point in the middle of what you are looking at, opened with its name
   * selected. Placing it at the map centre rather than asking for a position
   * first means the common case — "here, roughly" — is one click, and the
   * position field in the detail is there for when it needs to be exact.
   */
  function addHere() {
    const c = map.getCenter();
    const rec = { id: nextId++, name: 'New point', lat: c.lat, lng: c.lng,
                  symbol: 'marker', desc: '', visible: true, source: 'manual',
                  open: true, renaming: true };
    rec.marker = addMarker(rec);
    items.push(rec);
    // an active filter would hide the thing that was just created
    filterText = '';
    const search = document.getElementById('poi-search');
    if (search) search.value = '';
    say('Point added at the map centre — name it, or paste a position');
    changed();
    scheduleAnnotate();
    render();
    const el = document.querySelector('#poi-list [data-poi="' + rec.id + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    return rec;
  }

  function setSymbol(rec, key) {
    rec.symbol = key;
    if (rec.marker) rec.marker.setIcon(iconFor(key));
    changed();
    render();
  }

  function setVisible(rec, on) {
    rec.visible = on;
    changed();
    if (!rec.marker) return;
    if (on) rec.marker.addTo(map); else map.removeLayer(rec.marker);
    render();
  }

  function remove(rec) {
    if (rec.marker) map.removeLayer(rec.marker);
    items = items.filter((i) => i !== rec);
    changed();
    render();
  }

  function clearAll() {
    items.forEach((i) => { if (i.marker) map.removeLayer(i.marker); });
    shapes.forEach((s) => map.removeLayer(s));
    items = []; shapes = [];
    render();
    say('Points of interest cleared');
  }

  /*
   * ---- filtering ----
   * Subsequence matching, not substring: the query's characters must appear in
   * order, but anything may sit between them. So "rstea" finds "Refugio State
   * Beach" — the initials-plus-a-bit way people actually half-remember a dive
   * site, and the way a phone keyboard makes you want to search, since every
   * character you skip is a character you did not have to type.
   *
   * Spaces in the query are dropped rather than treated as separators: a
   * subsequence already spans words, so "rs tea" and "rstea" ask the same
   * thing. Matching is greedy left-to-right, one pass, no backtracking — it is
   * a list of dive sites, not a search engine.
   */
  function subsequenceSpan(hay, needle) {
    let i = 0, first = -1, last = -1;
    for (let n = 0; n < needle.length; n++) {
      const at = hay.indexOf(needle[n], i);
      if (at < 0) return null;
      if (first < 0) first = at;
      last = at;
      i = at + 1;
    }
    return { first: first, span: last - first + 1 };
  }

  function filterScore(rec) {
    if (!filterText) return 0;
    const name = (rec.name || '').toLowerCase();
    const extras = [rec.desc, (SYMBOLS[rec.symbol] || SYMBOLS.marker).label,
      (typeof rec.depthFt === 'number' && rec.depthFt > 0) ? rec.depthFt + ' ft' : ''
    ].join(' ').toLowerCase();

    // a plain substring hit is the strongest signal there is
    if (name.includes(filterText)) return 1000 - name.indexOf(filterText);
    const inName = subsequenceSpan(name, filterText);
    /*
     * Tighter and earlier wins. "rstea" scores better on "Refugio State Beach"
     * than on a name where the same letters are scattered across forty
     * characters, so the thing you meant floats to the top.
     */
    if (inName) return 500 - Math.min(400, inName.span) - Math.min(50, inName.first);
    if (extras.includes(filterText)) return 100;
    return subsequenceSpan(extras, filterText) ? 10 : -1;
  }

  function matchesFilter(rec) {
    return !filterText || filterScore(rec) >= 0;
  }

  function render() {
    const box = document.getElementById('poi-list');
    const note = document.getElementById('poi-note');
    const search = document.getElementById('poi-search');
    if (!box) return;
    box.textContent = '';
    // the filter box only appears once the list is long enough to need one
    if (search) search.hidden = items.length < 6 && !filterText;
    if (!items.length) {
      note.textContent = 'No points yet — import a KML from the ⚙ menu.';
      return;
    }
    /*
     * Ranked while filtering, left alone otherwise: with no query the list's
     * own order is the user's order (creation / import), and re-sorting it
     * behind their back would be its own bug.
     */
    let shown = items.filter(matchesFilter);
    if (filterText) {
      shown = shown
        .map((rec, i) => ({ rec: rec, i: i, score: filterScore(rec) }))
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))
        .map((x) => x.rec);
    }
    note.textContent = (filterText
      ? shown.length + ' of ' + items.length + ' point' + (items.length === 1 ? '' : 's')
      : items.length + ' point' + (items.length === 1 ? '' : 's')) +
      ' · tap one to open it';
    shown.forEach((rec) => {
      const item = document.createElement('div');
      item.className = 'poi-item' + (rec.visible ? '' : ' off') + (rec.open ? ' open' : '');
      item.dataset.poi = rec.id;
      const row = document.createElement('div');
      row.className = 'poi-row';

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
      if (typeof rec.depthFt === 'number' && rec.depthFt > 0) {
        const dep = document.createElement('span');
        dep.className = 'poi-depth';
        dep.textContent = rec.depthFt + ' ft';
        dep.title = 'Charted depth under this point (NOAA DEM)';
        name.appendChild(dep);
      }
      name.title = rec.name + (rec.desc ? ' — ' + rec.desc.slice(0, 120) : '');

      /*
       * Rename in place, not in a window.prompt. A browser dialog blocks the
       * page, cannot show the point it is renaming, and on a phone covers the
       * map entirely — so the name becomes an input in the row it belongs to,
       * committing on blur or Enter and abandoning on Escape, the same idiom
       * the path rows use.
       */
      const startRename = () => {
        if (row.querySelector('.poi-name-input')) return;
        const input = document.createElement('input');
        input.className = 'poi-name-input'; input.type = 'text'; input.value = rec.name;
        input.setAttribute('aria-label', 'Point name');
        let done = false;
        const commit = (save) => {
          if (done) return;
          done = true;
          const clean = input.value.trim();
          if (save && clean && clean !== rec.name) {
            rec.name = clean;
            refreshMarker(rec);
            say('Renamed to ' + rec.name);
            changed();
          }
          render();
        };
        input.addEventListener('blur', () => commit(true));
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') commit(true);
          else if (ev.key === 'Escape') commit(false);
        });
        input.addEventListener('click', (ev) => ev.stopPropagation());
        row.replaceChild(input, name);
        input.focus(); input.select();
      };

      name.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRename(); });

      const pen = document.createElement('button');
      pen.className = 'poi-eye'; pen.type = 'button'; pen.textContent = '✎';
      pen.title = 'Rename this point and edit its position';
      pen.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // the position field lives in the detail, so editing opens it
        if (!rec.open) { rec.open = true; rec.renaming = true; render(); return; }
        startRename();
      });

      const eye = document.createElement('button');
      eye.className = 'poi-eye'; eye.type = 'button';
      eye.textContent = rec.visible ? '◉' : '◌';
      eye.title = rec.visible ? 'Hide this point' : 'Show this point';
      eye.addEventListener('click', (ev) => { ev.stopPropagation(); setVisible(rec, !rec.visible); });

      const del = document.createElement('button');
      del.className = 'poi-del'; del.type = 'button'; del.textContent = '×';
      del.title = 'Remove this point';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); remove(rec); });

      /*
       * Opening a point rather than flying to it. Jumping the map on every
       * stray tap made the list hostile to browse — you could not read a name
       * without being taken somewhere — so the row opens its detail and the
       * detail carries an explicit Zoom to.
       */
      row.addEventListener('click', () => { rec.open = !rec.open; render(); });
      row.appendChild(pin); row.appendChild(name); row.appendChild(pen);
      row.appendChild(eye); row.appendChild(del);
      item.appendChild(row);

      if (rec.open) item.appendChild(detailFor(rec));
      box.appendChild(item);

      // a rename asked for while the row was still closed, deferred until the
      // detail existed so both appear in one paint
      if (rec.renaming) { rec.renaming = false; startRename(); }
    });
  }

  /*
   * The opened body of a point: where it is, what it is, and a way to go
   * there. Every field commits on blur or Enter and re-renders only then —
   * committing per keystroke would rebuild the list under the cursor and throw
   * focus away mid-word.
   */
  function detailFor(rec) {
    const wrap = document.createElement('div');
    wrap.className = 'poi-detail';
    // clicks inside the detail must not reach the row's open/close toggle
    wrap.addEventListener('click', (ev) => ev.stopPropagation());

    const field = (labelText, el) => {
      const l = document.createElement('label');
      l.className = 'poi-field';
      const s = document.createElement('span');
      s.className = 'poi-field-label';
      s.textContent = labelText;
      l.appendChild(s); l.appendChild(el);
      wrap.appendChild(l);
      return l;
    };

    /*
     * Position is editable here, and parsed by the same reader the path node
     * editor uses — decimal, DDM and DMS all work, so a position copied out of
     * a chart or a text message goes straight in.
     */
    const coord = document.createElement('input');
    coord.type = 'text';
    coord.className = 'poi-coord';
    coord.value = rec.lat.toFixed(6) + ', ' + rec.lng.toFixed(6);
    coord.setAttribute('aria-label', 'Position of ' + rec.name);
    coord.title = 'Edit or paste a position — decimal, DDM and DMS all work';
    const applyCoord = () => {
      const got = readCoords(coord.value);
      if (!got) {
        toast('Could not read those coordinates.', true);
        coord.value = rec.lat.toFixed(6) + ', ' + rec.lng.toFixed(6);
        return;
      }
      if (got.lat === rec.lat && got.lng === rec.lng) return;
      moveTo(rec, got.lat, got.lng);
    };
    coord.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); applyCoord(); }
      else if (ev.key === 'Escape') { coord.value = rec.lat.toFixed(6) + ', ' + rec.lng.toFixed(6); coord.blur(); }
    });
    // a pasted position that already parses applies immediately, matching the
    // path node editor — no Enter needed
    coord.addEventListener('paste', () => {
      setTimeout(() => { if (readCoords(coord.value)) applyCoord(); }, 0);
    });
    coord.addEventListener('blur', applyCoord);
    // focusing selects what is there, so a paste replaces the position rather
    // than landing in the middle of it — same behaviour as a path node's box
    if (window.Paths && Paths.selectOnFocus) Paths.selectOnFocus(coord);
    /*
     * On touch the field gets a Paste button. blur fires before the button's
     * click, and blur runs applyCoord — which would re-stamp the OLD position
     * into the field before the paste ever landed. Wrapping both in one row
     * and applying explicitly after the paste keeps that order honest.
     */
    const coordPaste = (window.Paths && Paths.pasteButton)
      ? Paths.pasteButton(coord, applyCoord, toast) : null;
    if (coordPaste) {
      const row = document.createElement('div');
      row.className = 'poi-coord-row';
      row.appendChild(coord); row.appendChild(coordPaste);
      field('Position', row);
    } else {
      field('Position', coord);
    }

    const desc = document.createElement('textarea');
    desc.className = 'poi-desc';
    desc.rows = 2;
    desc.value = rec.desc || '';
    desc.placeholder = 'Notes — entry, hazards, what is down there…';
    desc.setAttribute('aria-label', 'Notes for ' + rec.name);
    desc.addEventListener('keydown', (ev) => ev.stopPropagation());
    desc.addEventListener('blur', () => {
      const next = desc.value.trim();
      if (next === (rec.desc || '')) return;
      rec.desc = next;
      refreshMarker(rec);
      changed();
      render();
    });
    field('Notes', desc);

    const foot = document.createElement('div');
    foot.className = 'poi-detail-foot';
    if (typeof rec.depthFt === 'number' && rec.depthFt > 0) {
      const d = document.createElement('span');
      d.className = 'poi-detail-depth';
      d.textContent = rec.depthFt + ' ft charted';
      d.title = 'Charted depth under this point (NOAA DEM)';
      foot.appendChild(d);
    }
    /*
     * A code someone else can paste. Built by Session so a shared point and a
     * shared path are the same kind of thing, and so it lands on the same
     * review screen a session file does.
     */
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'poi-zoom poi-share';
    share.textContent = 'Copy code';
    share.title = 'Copy a share code for this point';
    share.addEventListener('click', () => {
      if (!window.Session || !Session.shareCode) { toast('Sharing is unavailable.', true); return; }
      Session.copyText(Session.shareCode('poi', rec), rec.name);
    });
    foot.appendChild(share);

    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'poi-zoom';
    zoom.textContent = 'Zoom to';
    zoom.title = 'Centre the map on this point';
    zoom.addEventListener('click', () => flyTo(rec));
    foot.appendChild(zoom);
    wrap.appendChild(foot);
    return wrap;
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
    const clr = document.getElementById('poi-clear');
    if (clr) clr.addEventListener('click', clearAll);
    const search = document.getElementById('poi-search');
    if (search) search.addEventListener('input', () => {
      filterText = search.value.toLowerCase().replace(/\s+/g, '');
      render();
    });
    const fit = document.getElementById('poi-fit');
    if (fit) fit.addEventListener('click', fitAll);
    const add = document.getElementById('poi-new');
    if (add) add.addEventListener('click', addHere);
  }

  /*
   * uid-addressed operations, used by session import and by persistence. The
   * uid is a content hash owned by Session so both sides agree; the fallback
   * only matters if this module is loaded standalone.
   */
  const uidOf = (p) => (window.Session ? Session.poiUid(p)
                                       : p.name + '|' + p.lat + '|' + p.lng);

  function upsert(rec) {
    const existing = items.find((i) => uidOf(i) === (rec.uid || uidOf(rec)));
    if (existing) {
      Object.assign(existing, {
        name: rec.name, lat: rec.lat, lng: rec.lng,
        symbol: rec.symbol || existing.symbol, desc: rec.desc || existing.desc,
        visible: rec.visible !== false
      });
      if (existing.marker) map.removeLayer(existing.marker);
      existing.marker = addMarker(existing);
      if (!existing.visible) map.removeLayer(existing.marker);
    } else {
      const p = { id: nextId++, name: rec.name, lat: rec.lat, lng: rec.lng,
                  symbol: rec.symbol || 'marker', desc: rec.desc || '',
                  visible: rec.visible !== false, source: 'import' };
      p.marker = addMarker(p);
      if (!p.visible) map.removeLayer(p.marker);
      items.push(p);
    }
    render();
    scheduleAnnotate();
  }

  function removeByUid(uid) {
    const p = items.find((i) => uidOf(i) === uid);
    if (p) remove(p);
  }

  // Rebuild from stored records without the import chatter or the auto fit.
  function restore(records) {
    (records || []).forEach((rec) => {
      const p = { id: nextId++, name: rec.name, lat: rec.lat, lng: rec.lng,
                  symbol: rec.symbol || 'marker', desc: rec.desc || '',
                  depthFt: (typeof rec.depthFt === 'number' || rec.depthFt === null)
                    ? rec.depthFt : undefined,
                  visible: rec.visible !== false, source: 'saved' };
      p.marker = addMarker(p);
      if (!p.visible) map.removeLayer(p.marker);
      items.push(p);
    });
    render();
    annotateDepths();
    return items.length;
  }

  return {
    init: init,
    upsert: upsert,
    removeByUid: removeByUid,
    restore: restore,
    importFile: importFile,
    clearAll: clearAll,
    fitAll: fitAll,
    addHere: addHere,
    parseKml: parseKml,          // exported for testing
    parseGpx: parseGpx,
    get list() { return items; },
    SYMBOLS: SYMBOLS
  };
})();

window.POI = POI;
