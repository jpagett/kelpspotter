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
  // label is a pre-formatted string (e.g. "42 ft") — app.js owns unit conversion/formatting.
  function hoverAt(id, sample, label) {
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
    if (label) {
      if (hoverDot.getTooltip()) hoverDot.setTooltipContent(label);
      else {
        hoverDot.bindTooltip(label, {
          permanent: true, direction: 'top', offset: [0, -8], className: 'path-hover-label'
        }).openTooltip();
      }
    }
  }
  function hoverOff() {
    if (hoverDot) { map.removeLayer(hoverDot); hoverDot = null; }
  }

  /* ---------- GPS coordinate parsing ----------
   *
   * Accepts most of the ways people write a position:
   *   34.4123, -119.8765            decimal degrees (comma/space/semicolon)
   *   N34.4123 W119.8765           hemisphere prefix or suffix
   *   34°24.738'N 119°52.59'W      degrees + decimal minutes
   *   34°24'44.3"N 119°52'35.4"W   degrees minutes seconds (any quote/degree glyphs)
   *   34 24 44.3 N 119 52 35.4 W   bare DMS
   *   (34.4123, -119.8765)         parenthesised, e.g. copied from elsewhere
   *   .../maps/@34.41,-119.87,14z  first two numbers of a maps URL
   *   -119.8765, 34.4123           lon-lat order, fixed up when unambiguous
   *
   * Returns {lat, lng} or null. Minutes/seconds must be < 60; a group with a
   * second number >= 60 is taken as the start of the other coordinate instead
   * (that is what distinguishes "34 24 119 52" = two DDM pairs from nonsense).
   */
  function parseCoords(text) {
    if (!text) return null;
    let t = String(text).toUpperCase()
      .replace(/\bNORTH\b/g, ' N ').replace(/\bSOUTH\b/g, ' S ')
      .replace(/\bEAST\b/g, ' E ').replace(/\bWEST\b/g, ' W ')
      .replace(/[()\[\]{}]/g, ' ')
      .replace(/[°º]/g, ' ')
      .replace(/[′’']/g, ' ')
      .replace(/[″”"]/g, ' ')
      .replace(/−/g, '-')             // unicode minus
      .replace(/[;|]/g, ',')
      .replace(/[A-Z]{2,}/g, ' ')          // drop words (URLs, LAT:, DEG, ...)
      .replace(/[A-DF-MO-RT-VX-Z]/g, ' '); // drop stray letters except N/S/E/W
    const tokens = t.match(/[NSEW]|[-+]?\d+(?:\.\d+)?|,/g);
    if (!tokens) return null;

    // Split the token stream into coordinate groups.
    const groups = [];
    let cur = [];
    const close = () => { if (cur.some((x) => !/[NSEW]/.test(x))) groups.push(cur); cur = []; };
    const hasNumbers = () => cur.some((x) => !/[NSEW]/.test(x));
    const hasLetter = () => cur.some((x) => /[NSEW]/.test(x));
    tokens.forEach((tok) => {
      if (tok === ',') { close(); return; }
      if (/[NSEW]/.test(tok)) {
        // a letter closes a numbered group (suffix) unless the group already
        // carries its letter as a prefix — then this one starts the next group
        if (hasNumbers() && !hasLetter()) { cur.push(tok); close(); }
        else if (hasNumbers()) { close(); cur.push(tok); }
        else cur.push(tok);
        return;
      }
      // number: a value that cannot be minutes/seconds starts the next group
      if (hasNumbers() && Math.abs(parseFloat(tok)) >= 60) close();
      cur.push(tok);
    });
    close();

    // One undelimited run of 2/4/6 numbers splits evenly into the two halves.
    if (groups.length === 1 && !groups[0].some((x) => /[NSEW]/.test(x))) {
      const nums = groups[0];
      if (nums.length === 2 || nums.length === 4 || nums.length === 6) {
        groups[0] = nums.slice(0, nums.length / 2);
        groups.push(nums.slice(nums.length / 2));
      }
    }
    if (groups.length < 2) return null;

    function parseGroup(g) {
      const letter = g.find((x) => /^[NSEW]$/.test(x)) || null;
      const nums = g.filter((x) => !/^[NSEW]$/.test(x)).map(parseFloat).slice(0, 3);
      if (!nums.length || nums.some((n) => !isFinite(n))) return null;
      const [d, m, s] = [nums[0], nums[1] || 0, nums[2] || 0];
      if (m < 0 || m >= 60 || s < 0 || s >= 60) return null;
      const neg = d < 0 || letter === 'S' || letter === 'W';
      const value = (Math.abs(d) + m / 60 + s / 3600) * (neg ? -1 : 1);
      return { value: value, axis: letter === 'N' || letter === 'S' ? 'lat' : (letter ? 'lng' : null) };
    }
    const a = parseGroup(groups[0]), b = parseGroup(groups[1]);
    if (!a || !b) return null;

    let lat, lng;
    if (a.axis === 'lat' || b.axis === 'lng') { lat = a.value; lng = b.value; }
    else if (a.axis === 'lng' || b.axis === 'lat') { lng = a.value; lat = b.value; }
    else { lat = a.value; lng = b.value; }
    // no hemisphere hints and an impossible latitude: assume lon-lat order
    if (!a.axis && !b.axis && Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
      const swap = lat; lat = lng; lng = swap;
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  /* ---------- node coordinate editor ----------
   * Hovering a node opens a small editor with its position; typing or pasting
   * a new position (any format parseCoords accepts) moves the node there.
   */
  let nodePopup = null, nodeCloseTimer = null;

  function closeNodeEditor() {
    if (nodeCloseTimer) { clearTimeout(nodeCloseTimer); nodeCloseTimer = null; }
    if (nodePopup) { map.closePopup(nodePopup); nodePopup = null; }
  }

  function scheduleNodeEditorClose() {
    if (nodeCloseTimer) clearTimeout(nodeCloseTimer);
    nodeCloseTimer = setTimeout(() => {
      const el = nodePopup && nodePopup.getElement();
      if (el && el.matches(':hover')) { scheduleNodeEditorClose(); return; }   // still in use
      closeNodeEditor();
    }, 450);
  }

  function showNodeEditor(p, i) {
    closeNodeEditor();
    const ll = p.nodes[i];
    const wrap = document.createElement('div');
    wrap.className = 'node-coord';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6);
    input.title = 'Edit or paste coordinates — decimal, DDM and DMS all work';
    input.setAttribute('aria-label', 'Node ' + (i + 1) + ' coordinates');
    const apply = () => {
      const got = parseCoords(input.value);
      if (!got) { toast('Could not read those coordinates.', true); return; }
      p.nodes[i] = L.latLng(got.lat, got.lng);
      p.profile = null;
      closeNodeEditor();
      redraw(p);
      refreshProfile(p);
      onChange();
      say('Node ' + (i + 1) + ' moved to ' + got.lat.toFixed(5) + ', ' + got.lng.toFixed(5));
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') apply();
      else if (ev.key === 'Escape') closeNodeEditor();
      ev.stopPropagation();   // Enter/Escape here must not finish path drawing
    });
    // a pasted position that already parses applies immediately — no Enter needed
    input.addEventListener('paste', () => {
      setTimeout(() => { if (parseCoords(input.value)) apply(); }, 0);
    });
    wrap.appendChild(input);
    nodePopup = L.popup({
      className: 'node-coord-popup', closeButton: false,
      closeOnClick: true, offset: [0, -8], autoPan: false
    }).setLatLng(ll).setContent(wrap);
    nodePopup.openOn(map);
    const el = nodePopup.getElement();
    if (el) {
      el.addEventListener('mouseleave', scheduleNodeEditorClose);
      el.addEventListener('mouseenter', () => { if (nodeCloseTimer) clearTimeout(nodeCloseTimer); });
    }
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
      m.on('mouseover', () => showNodeEditor(p, i));
      m.on('mouseout', scheduleNodeEditorClose);
      m.on('dragstart', closeNodeEditor);
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
      mirrored: false, preMirrorNodes: null, plotHeight: 62
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

  /*
   * Called once per drag, on release (see app.js) — not on every pointermove,
   * since that already redraws the SVG directly for a smooth drag and only
   * needs to persist the final value here.
   */
  function setPlotHeight(id, px) {
    const p = paths.find((x) => x.id === id);
    if (!p || !(px > 0)) return;
    p.plotHeight = px;
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
        mirrored: false, preMirrorNodes: null, plotHeight: 62
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
    setPlotHeight: setPlotHeight,
    setColor: setColor,
    remove: remove,
    exportPath: exportPath,
    importFile: importFile,
    lengthOf: lengthOf,
    hoverAt: hoverAt,
    hoverOff: hoverOff,
    parseCoords: parseCoords,
    get list() { return paths; },
    get selectedId() { return selectedId; },
    get drawing() { return !!drawing; }
  };
})();

window.Paths = Paths;
