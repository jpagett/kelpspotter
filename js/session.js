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
    'showRelief', 'showContours', 'depthOpacity', 'trueColorOpacity'
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
             ceilings: p.ceilings || [], floors: p.floors || [],
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
    savePois: savePois,
    loadPois: loadPois,
    clearPois: clearPois
  };
})();

window.Session = Session;
