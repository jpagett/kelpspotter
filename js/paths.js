/*
 * Paths — draw transects on the map and read the depth profile along them.
 *
 * A path is a list of nodes (lat/lng). The polyline is derived from the nodes,
 * and every node is a draggable marker, so editing a path is just moving nodes
 * and re-deriving. Depth along a path comes from DemSampler.alongPath, which
 * samples evenly spaced points in a single getSamples call (the endpoint caps at
 * 1000 samples, so the profile resolution is capped there too).
 *
 * Export is a real .xlsx with two sheets — Profile (distance/depth) and Nodes
 * (the coordinates) — because a single CSV cannot carry two tables. SheetJS is
 * loaded from a CDN and is the only dependency added for this.
 */
const Paths = (function () {
  const PANE = 'paths';
  const PROFILE_SAMPLES = 250;
  const COLORS = ['#f2b134', '#5ec6c9', '#e2725b', '#a6d95b', '#c78bd9',
                  '#ffd166', '#7fb3ff', '#ff9ec4'];

  let cfg = null, map = null, L = null, say = null, toast = null;
  let paths = [];          // {id, name, color, nodes:[LatLng], line, markers[], profile, expanded}
  let nextId = 1;
  let selectedId = null;
  let drawing = null;      // the path being drawn, or null
  let onChange = function () {};

  function init(config, leaflet, leafletMap, logger, toaster, changed) {
    cfg = config; L = leaflet; map = leafletMap;
    say = logger || function () {};
    toast = toaster || function () {};
    onChange = changed || function () {};
    map.createPane(PANE).style.zIndex = 380;   // above kelp, below the demo canvas
    map.on('click', onMapClick);
    document.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Escape' || ev.key === 'Enter') && drawing) finishDrawing();
    });
  }

  const selected = () => paths.find((p) => p.id === selectedId) || null;

  /*
   * Marker tying the profile chart back to the map: hovering the plot at some
   * distance along the path shows where that distance actually is on the water.
   */
  let hoverDot = null;
  function hoverAt(id, sample) {
    const p = paths.find((x) => x.id === id);
    if (!p || !sample) return;
    const ll = L.latLng(sample.lat, sample.lng);
    if (!hoverDot) {
      hoverDot = L.circleMarker(ll, {
        pane: PANE, radius: 5, weight: 2, color: '#ffffff',
        fillColor: p.color, fillOpacity: 1, interactive: false
      }).addTo(map);
    } else {
      hoverDot.setLatLng(ll).setStyle({ fillColor: p.color });
    }
  }
  function hoverOff() {
    if (hoverDot) { map.removeLayer(hoverDot); hoverDot = null; }
  }

  /* ---------- geometry ---------- */

  function redraw(p) {
    const latlngs = p.nodes;
    const isSel = p.id === selectedId;
    if (!p.line) {
      p.line = L.polyline(latlngs, { pane: PANE, interactive: false }).addTo(map);
    } else {
      p.line.setLatLngs(latlngs);
    }
    p.line.setStyle({
      color: p.color,
      weight: isSel ? 4 : 2,
      opacity: isSel ? 0.95 : 0.5
    });

    // rebuild node handles
    p.markers.forEach((m) => map.removeLayer(m));
    p.markers = [];
    if (!isSel) return;                       // only the selected path is editable
    p.nodes.forEach((ll, i) => {
      const icon = L.divIcon({
        className: 'path-node',
        html: '<span style="background:' + p.color + '"></span>',
        iconSize: [11, 11]
      });
      const m = L.marker(ll, { icon: icon, draggable: true, pane: PANE });
      m.on('drag', (ev) => {
        p.nodes[i] = ev.target.getLatLng();
        p.line.setLatLngs(p.nodes);
      });
      m.on('dragend', () => { p.profile = null; refreshProfile(p); });
      m.on('contextmenu', () => removeNode(p, i));
      m.addTo(map);
      p.markers.push(m);
    });
  }

  function removeNode(p, i) {
    if (p.nodes.length <= 2) { toast('A path needs at least two nodes.', true); return; }
    p.nodes.splice(i, 1);
    p.profile = null;
    redraw(p); refreshProfile(p);
  }

  function lengthOf(p) {
    let d = 0;
    for (let i = 1; i < p.nodes.length; i++) d += DemSampler.haversine(p.nodes[i - 1], p.nodes[i]);
    return d;
  }

  /* ---------- drawing ---------- */

  function startDrawing() {
    if (drawing) { finishDrawing(); return; }
    const id = nextId++;
    const p = {
      id: id, name: 'Path ' + id, nodes: [],
      color: COLORS[(id - 1) % COLORS.length],
      line: null, markers: [], profile: null, expanded: true,
      mirrored: false, preMirrorNodes: null
    };
    paths.push(p);
    selectedId = p.id;
    drawing = p;
    map.getContainer().classList.add('drawing');
    say('Draw mode — click the map to add nodes, Esc or ✓ to finish');
    onChange();
  }

  function onMapClick(ev) {
    if (!drawing) return;
    drawing.nodes.push(ev.latlng);
    drawing.profile = null;
    redraw(drawing);
    onChange();
  }

  function finishDrawing() {
    const p = drawing;
    drawing = null;
    map.getContainer().classList.remove('drawing');
    if (!p) return;
    if (p.nodes.length < 2) {
      remove(p.id);
      if (p.id === nextId - 1) nextId--;   // discarded before anything else claimed the next number
      toast('A path needs at least two nodes.', true);
      say('Path discarded — fewer than two nodes', 'warn');
      onChange();
      return;
    }
    say(p.name + ' drawn — ' + p.nodes.length + ' nodes, ' + Math.round(lengthOf(p)) + ' m');
    redraw(p);
    refreshProfile(p);
    onChange();
  }

  /* ---------- depth profile ---------- */

  async function refreshProfile(p) {
    if (p.nodes.length < 2) return;
    try {
      say('Reading depth along ' + p.name + '…');
      p.profile = await DemSampler.alongPath(p.nodes, PROFILE_SAMPLES);
      const deep = p.profile.filter((s) => s.feet !== null);
      say(p.name + ': ' + deep.length + ' depth samples over ' +
          Math.round(lengthOf(p)) + ' m', 'ok');
      onChange();
    } catch (err) {
      console.warn(err);
      say('Depth profile failed — see console', 'warn');
    }
  }

  /* ---------- public actions ---------- */

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    paths.forEach(redraw);
    const p = selected();
    if (p && !p.profile) refreshProfile(p);
    onChange();
  }

  function toggleExpand(id) {
    const p = paths.find((x) => x.id === id);
    if (p) { p.expanded = !p.expanded; onChange(); }
  }

  function rename(id, name) {
    const p = paths.find((x) => x.id === id);
    if (!p || !name) return;
    p.name = name;
    onChange();
  }

  /*
   * Toggled, not one-shot: turning it on appends the reversed out-and-back
   * nodes (remembering the pre-mirror list so turning it off can restore
   * exactly, rather than guessing how many trailing nodes to drop).
   */
  function setMirrored(id, on) {
    const p = paths.find((x) => x.id === id);
    if (!p || p.mirrored === on) return;
    if (on) {
      if (p.nodes.length < 2) return;
      p.preMirrorNodes = p.nodes.slice();
      p.nodes = p.nodes.concat(p.nodes.slice(0, -1).reverse());
      say(p.name + ' mirrored — now ' + p.nodes.length + ' nodes out-and-back');
    } else if (p.preMirrorNodes) {
      p.nodes = p.preMirrorNodes;
      p.preMirrorNodes = null;
      say(p.name + ' mirror removed — back to ' + p.nodes.length + ' nodes');
    }
    p.mirrored = on;
    p.profile = null;
    redraw(p);
    refreshProfile(p);
    onChange();
  }

  function setColor(id, color) {
    const p = paths.find((x) => x.id === id);
    if (!p) return;
    p.color = color;
    redraw(p);
    onChange();
  }

  function remove(id) {
    const i = paths.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = paths[i];
    if (p.line) map.removeLayer(p.line);
    p.markers.forEach((m) => map.removeLayer(m));
    paths.splice(i, 1);
    if (selectedId === id) selectedId = paths.length ? paths[paths.length - 1].id : null;
    if (drawing && drawing.id === id) { drawing = null; map.getContainer().classList.remove('drawing'); }
    paths.forEach(redraw);
    onChange();
  }

  /* ---------- spreadsheet in / out ---------- */

  function exportPath(id) {
    const p = paths.find((x) => x.id === id);
    if (!p) return;
    if (typeof XLSX === 'undefined') { toast('Spreadsheet library did not load.', true); return; }
    if (!p.profile) { toast('Depth profile is still being read.', true); return; }

    const profile = p.profile.map((s) => ({
      'distance_m': Math.round(s.distance * 100) / 100,
      'depth_ft': s.feet === null ? '' : Math.round(-s.feet * 100) / 100,
      'elevation_m': s.metres === null ? '' : Math.round(s.metres * 1000) / 1000,
      'lat': s.lat, 'lng': s.lng
    }));
    const nodes = p.nodes.map((n, i) => ({ 'node': i + 1, 'lat': n.lat, 'lng': n.lng }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(profile), 'Profile');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nodes), 'Nodes');
    XLSX.writeFile(wb, p.name.replace(/[^\w-]+/g, '_') + '.xlsx');
    say('Exported ' + p.name + ' (' + profile.length + ' samples, ' + nodes.length + ' nodes)', 'ok');
  }

  async function importFile(file) {
    if (typeof XLSX === 'undefined') { toast('Spreadsheet library did not load.', true); return; }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets['Nodes'] || wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
      if (!sheet) throw new Error('no Nodes sheet');
      const rows = XLSX.utils.sheet_to_json(sheet);
      const nodes = rows
        .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) }))
        .filter((n) => isFinite(n.lat) && isFinite(n.lng))
        .map((n) => L.latLng(n.lat, n.lng));
      if (nodes.length < 2) throw new Error('need at least two nodes');

      const id = nextId++;
      const p = {
        id: id, name: file.name.replace(/\.xlsx?$/i, ''), nodes: nodes,
        color: COLORS[(id - 1) % COLORS.length],
        line: null, markers: [], profile: null, expanded: true,
        mirrored: false, preMirrorNodes: null
      };
      paths.push(p);
      selectedId = p.id;
      paths.forEach(redraw);
      map.fitBounds(L.latLngBounds(nodes).pad(0.2));
      say('Loaded ' + p.name + ' — ' + nodes.length + ' nodes', 'ok');
      onChange();
      refreshProfile(p);
    } catch (err) {
      console.warn(err);
      toast('Could not read that spreadsheet — needs a Nodes sheet with lat/lng.', true);
      say('Path import failed — ' + err.message, 'warn');
    }
  }

  return {
    init: init,
    startDrawing: startDrawing,
    finishDrawing: finishDrawing,
    select: select,
    rename: rename,
    toggleExpand: toggleExpand,
    setMirrored: setMirrored,
    setColor: setColor,
    remove: remove,
    exportPath: exportPath,
    importFile: importFile,
    lengthOf: lengthOf,
    hoverAt: hoverAt,
    hoverOff: hoverOff,
    get list() { return paths; },
    get selectedId() { return selectedId; },
    get drawing() { return !!drawing; }
  };
})();

window.Paths = Paths;
