/*
 * Session — export the working state to a file, and import one back with a diff
 * to review before anything is applied.
 *
 * Also owns POI persistence, since a POI in localStorage and a POI in an export
 * file are the same record with the same identity rules; keeping one definition
 * avoids the two drifting apart.
 *
 * IDENTITY is the load-bearing decision. Records are matched across files by a
 * content hash of the fields that make them that thing — a POI's name and
 * position, a path's name and node list. The in-memory integer ids are
 * session-local and meaningless in someone else's file: matching on those, every
 * import would read as 100% additions and the diff would be worthless.
 */
const Session = (function () {
  const SCHEMA = 2;   // v2: ceiling/floor meanings corrected (v1 had them swapped)
  const STORE_POIS = 'kelp.pois';

  /*
   * Which settings belong to which section of the diff. Splitting them matters
   * because they are reviewed differently: view settings are a single
   * take-it-or-leave-it block, while diver settings are individually meaningful
   * — importing someone's SAC rate without their cylinder set would be wrong.
   */
  const VIEW_KEYS = [
    'indexType', 'kelpThresh', 'maxCloud', 'opacity', 'kelpPalette',
    'paletteMin', 'paletteMax', 'mode', 'overlayOrder', 'dockWidth',
    'dockView', 'dockSplit',
    'showRelief', 'showContours', 'depthStyle', 'depthOpacity', 'trueColorOpacity',
    'turbidityOpacity', 'cloudOpacity', 'turbidityPalette', 'cloudPalette',
    'cloudVisMin', 'cloudSwirMin', 'cloudWhiteness',
    // where cloud is measured when picking dates, and whether to use it
    'cloudSample', 'useAoiCloud', 'minCoverage',
    'fsUi', 'fsPlot',
    'turbMode', 'turbClarityMin', 'turbClarityMax',
    'turbGlint', 'turbNirFloor', 'turbGlintGain'
  ];
  const USER_KEYS = [
    'sac', 'sacUnit', 'speed', 'speedUnit', 'time', 'timeMode', 'showGas',
    'kickDistance', 'kickUnit', 'declination', 'cylinders',
    'useReserveCuft', 'useReservePsi', 'pressureUnit', 'distUnit', 'depthUnit'
  ];

  let cfg = null, say = null, toast = null;
  let getState = null, applyState = null;

  function init(opts) {
    cfg = opts.cfg; say = opts.say || function () {}; toast = opts.toast || function () {};
    getState = opts.getState; applyState = opts.applyState;
  }

  /* ------------------------------------------------------------- identity */

  // Small, stable, order-independent string hash. Not cryptographic — it only
  // has to be consistent between two files on the same planet.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const r6 = (n) => Math.round(n * 1e6) / 1e6;

  const poiUid = (p) => 'poi_' + hash([p.name, r6(p.lat), r6(p.lng)].join('|'));
  const pathUid = (p) => 'path_' + hash(p.name + '|' +
    p.nodes.map((n) => r6(n.lat) + ',' + r6(n.lng)).join(';'));

  /* ------------------------------------------------------ serialise / read */

  function poiRecord(p) {
    return { uid: poiUid(p), name: p.name, lat: p.lat, lng: p.lng,
             symbol: p.symbol, desc: p.desc || '', visible: p.visible !== false,
             depthFt: (typeof p.depthFt === 'number' || p.depthFt === null) ? p.depthFt : undefined };
  }
  function pathRecord(p) {
    return { uid: pathUid(p), name: p.name, color: p.color,
             ceilings: p.ceilings || [], floors: p.floors || [], offsets: p.offsets || [],
             nodes: p.nodes.map((n) => ({ lat: n.lat, lng: n.lng })) };
  }

  function snapshot() {
    const st = getState();
    const pick = (keys) => keys.reduce((o, k) => {
      if (st.params[k] !== undefined) o[k] = st.params[k];
      return o;
    }, {});
    return {
      kelpspotter: SCHEMA,
      exported: new Date().toISOString(),
      pois: (window.POI ? POI.list : []).map(poiRecord),
      paths: (window.Paths ? Paths.list : []).map(pathRecord),
      view: pick(VIEW_KEYS),
      user: pick(USER_KEYS)
    };
  }

  function exportFile() {
    const data = snapshot();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kelpspotter-session-' + data.exported.slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say('Session exported — ' + data.pois.length + ' POIs, ' + data.paths.length + ' paths', 'ok');
  }

  /* ------------------------------------------------------------ share codes */

  /*
   * One point or one path as a paste-able code.
   *
   * The payload is just a session file with a single record in it, so a code
   * arrives at exactly the same review screen a whole session file does —
   * matched by the same uid, diffed the same way, added only when the reader
   * says so. Sharing a dive site should not be a second, quieter import path
   * with its own rules about what silently overwrites what.
   *
   * base64 of the JSON, url-safe and unpadded so it survives a chat message,
   * a URL and a QR code without anything helpfully re-wrapping it. Not
   * compressed and not encrypted: it is a handful of coordinates, and a reader
   * being able to eyeball what they were sent is a feature.
   */
  const SHARE_PREFIX = 'kelp1:';

  function toB64Url(str) {
    // btoa is byte-oriented; go through UTF-8 so accented names survive
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64Url(code) {
    let b = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /*
   * Copy to the clipboard, with a fallback that still works.
   *
   * navigator.clipboard needs a secure context and a live user gesture, and
   * quietly rejects without either — over plain http on a phone, which is a
   * normal way to run this on a boat, it simply is not there. The fallback
   * selects the text in a throwaway field so the code can at least be copied
   * by hand rather than lost.
   */
  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      say(what + ' copied — paste it wherever you like', 'ok');
      return true;
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed; left:8px; bottom:8px; width:min(90vw,520px); z-index:2000;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) {
        ta.remove();
        say(what + ' copied — paste it wherever you like', 'ok');
        return true;
      }
      // leave it on screen, selected, so it can be copied manually
      toast('Could not reach the clipboard — the code is selected, copy it by hand.', true);
      ta.addEventListener('blur', () => ta.remove());
      return false;
    }
  }

  function shareCode(kind, rec) {
    const payload = {
      kelpspotter: SCHEMA,
      exported: new Date().toISOString(),
      pois: kind === 'poi' ? [poiRecord(rec)] : [],
      paths: kind === 'path' ? [pathRecord(rec)] : [],
      view: {}, user: {}
    };
    return SHARE_PREFIX + toB64Url(JSON.stringify(payload));
  }

  /*
   * Read a pasted code. Tolerant about what surrounds it — people paste with
   * quotes, stray newlines and a chat client's line wrapping — but strict
   * about what it decodes to, since anything reaching parse() is treated as a
   * session file from there on.
   */
  function readShareCode(text) {
    const raw = String(text || '').trim().replace(/\s+/g, '');
    const i = raw.toLowerCase().indexOf(SHARE_PREFIX);
    if (i < 0) throw new Error('that does not look like a share code');
    const body = raw.slice(i + SHARE_PREFIX.length).replace(/[^A-Za-z0-9\-_]/g, '');
    if (!body) throw new Error('the code is empty');
    let json;
    try { json = fromB64Url(body); } catch (e) { throw new Error('the code is damaged'); }
    const data = parse(json);
    if (!data.pois.length && !data.paths.length) throw new Error('the code carries nothing');
    return data;
  }

  function parse(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
    if (!data || typeof data !== 'object') throw new Error('not a session file');
    if (!data.kelpspotter) throw new Error('not a KelpSpotter session file');
    if (data.kelpspotter > SCHEMA) {
      throw new Error('written by a newer version (schema ' + data.kelpspotter + ')');
    }
    const paths = Array.isArray(data.paths) ? data.paths : [];
    // v1 files used "ceilings" for max-depth caps; the dive-correct meaning is
    // the reverse, so a v1 import swaps the arrays on the way in
    if (data.kelpspotter === 1) {
      paths.forEach((p) => {
        const c = p.ceilings; p.ceilings = p.floors || []; p.floors = c || [];
      });
    }
    return {
      kelpspotter: data.kelpspotter,
      exported: data.exported || '',
      pois: Array.isArray(data.pois) ? data.pois : [],
      paths: paths,
      view: data.view && typeof data.view === 'object' ? data.view : {},
      user: data.user && typeof data.user === 'object' ? data.user : {}
    };
  }

  /* ------------------------------------------------------------------ diff */

  // Compare two records field by field, ignoring the uid they were matched on.
  function changedFields(a, b, keys) {
    const out = [];
    keys.forEach((k) => {
      const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
      if (av !== bv) out.push({ key: k, from: a[k], to: b[k] });
    });
    return out;
  }

  function diffCollection(currentRecs, incomingRecs, compareKeys) {
    const cur = new Map(currentRecs.map((r) => [r.uid, r]));
    const inc = new Map(incomingRecs.map((r) => [r.uid, r]));
    const rows = [];
    inc.forEach((r, uid) => {
      if (!cur.has(uid)) {
        rows.push({ kind: 'add', uid: uid, name: r.name, incoming: r, selected: true });
      } else {
        const fields = changedFields(cur.get(uid), r, compareKeys);
        if (fields.length) {
          rows.push({ kind: 'change', uid: uid, name: r.name, incoming: r,
                      current: cur.get(uid), fields: fields, selected: true });
        }
      }
    });
    cur.forEach((r, uid) => {
      if (!inc.has(uid)) {
        // only meaningful under replace; left unselected so merge never deletes
        rows.push({ kind: 'remove', uid: uid, name: r.name, current: r, selected: false });
      }
    });
    return rows;
  }

  function settingsDiff(currentParams, incoming, keys) {
    const rows = [];
    keys.forEach((k) => {
      if (!(k in incoming)) return;
      const a = JSON.stringify(currentParams[k]), b = JSON.stringify(incoming[k]);
      if (a !== b) {
        rows.push({ kind: 'change', uid: k, name: k, from: currentParams[k],
                    to: incoming[k], selected: true });
      }
    });
    return rows;
  }

  /*
   * A POI-only diff, for KML import review. The full diff would list every
   * current path as a "removal" against a file that never mentions paths —
   * technically true, useless to read. Scoping the sections to empty keeps the
   * same review sheet honest for a file that only carries placemarks.
   */
  function diffPois(incomingPois) {
    return {
      file: { pois: incomingPois, paths: [], view: {}, user: {} },
      pois: diffCollection((window.POI ? POI.list : []).map(poiRecord), incomingPois,
                           ['name', 'lat', 'lng', 'symbol', 'desc']),
      paths: [], view: [], user: []
    };
  }

  function diff(incoming) {
    const st = getState();
    return {
      file: incoming,
      pois: diffCollection((window.POI ? POI.list : []).map(poiRecord), incoming.pois,
                           ['name', 'lat', 'lng', 'symbol', 'desc']),
      paths: diffCollection((window.Paths ? Paths.list : []).map(pathRecord), incoming.paths,
                            ['name', 'color', 'nodes', 'ceilings', 'floors']),
      view: settingsDiff(st.params, incoming.view, VIEW_KEYS),
      user: settingsDiff(st.params, incoming.user, USER_KEYS)
    };
  }

  /* ----------------------------------------------------------------- apply */

  /*
   * `modes` is per section: 'merge' (default) or 'replace'. Merge applies the
   * selected additions and changes and leaves everything else alone. Replace
   * additionally honours the removal rows, so the section ends up matching the
   * file. Either way only *selected* rows are touched — an unticked row is
   * never applied, whichever mode the section is in.
   */
  function apply(d, modes, selection) {
    const chosen = (section) => d[section].filter((row) => selection[section][row.uid]);
    const counts = { pois: 0, paths: 0, view: 0, user: 0 };

    // ---- POIs
    chosen('pois').forEach((row) => {
      if (row.kind === 'add' || row.kind === 'change') {
        POI.upsert(row.incoming); counts.pois++;
      } else if (row.kind === 'remove' && modes.pois === 'replace') {
        POI.removeByUid(row.uid); counts.pois++;
      }
    });

    // ---- paths
    chosen('paths').forEach((row) => {
      if (row.kind === 'add' || row.kind === 'change') {
        Paths.upsert(row.incoming); counts.paths++;
      } else if (row.kind === 'remove' && modes.paths === 'replace') {
        Paths.removeByUid(row.uid); counts.paths++;
      }
    });

    // ---- settings: scalar, so merge and replace differ only in scope
    const settings = {};
    chosen('view').forEach((row) => { settings[row.uid] = row.to; counts.view++; });
    chosen('user').forEach((row) => { settings[row.uid] = row.to; counts.user++; });
    if (modes.view === 'replace') {
      VIEW_KEYS.forEach((k) => { if (k in d.file.view) settings[k] = d.file.view[k]; });
      counts.view = VIEW_KEYS.filter((k) => k in d.file.view).length;
    }
    if (modes.user === 'replace') {
      USER_KEYS.forEach((k) => { if (k in d.file.user) settings[k] = d.file.user[k]; });
      counts.user = USER_KEYS.filter((k) => k in d.file.user).length;
    }
    if (Object.keys(settings).length) applyState(settings);

    say('Imported ' + counts.pois + ' POI changes, ' + counts.paths + ' path changes, ' +
        counts.view + ' view settings, ' + counts.user + ' diver settings', 'ok');
    return counts;
  }

  /* ----------------------------------------------------- POI persistence */

  function savePois() {
    try {
      localStorage.setItem(STORE_POIS,
        JSON.stringify((window.POI ? POI.list : []).map(poiRecord)));
    } catch (err) { console.warn('POI save skipped:', err); }
  }
  function loadPois() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_POIS) || 'null');
      return Array.isArray(raw) ? raw : [];
    } catch (err) { return []; }
  }
  function clearPois() {
    try { localStorage.removeItem(STORE_POIS); } catch (err) { /* nothing to do */ }
  }

  return {
    init: init,
    SCHEMA: SCHEMA,
    VIEW_KEYS: VIEW_KEYS,
    USER_KEYS: USER_KEYS,
    snapshot: snapshot,
    exportFile: exportFile,
    parse: parse,
    diff: diff,
    diffPois: diffPois,
    apply: apply,
    poiUid: poiUid,
    pathUid: pathUid,
    shareCode: shareCode,
    copyText: copyText,
    readShareCode: readShareCode,
    savePois: savePois,
    loadPois: loadPois,
    clearPois: clearPois
  };
})();

window.Session = Session;
