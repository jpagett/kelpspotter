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
    initBoxSelect();
    document.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Escape' || ev.key === 'Enter') && drawing) { finishDrawing(); return; }
      if (ev.key === 'Escape' && picked.size) { clearPicked(); return; }
      // Delete/Backspace clears the whole selection at once, but not while
      // the user is typing into the coordinate editor
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && picked.size) {
        const tag = ev.target && ev.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        ev.preventDefault();
        removePicked();
      }
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

  /*
   * Depth formatting lives in app.js (it owns the unit settings), so hovering
   * a path on the MAP borrows the same formatter the plot hover uses. Without
   * one set, fall back to raw feet rather than showing nothing.
   */
  let depthLabel = (s) => Math.round(-s.feet) + ' ft';
  function setDepthFormatter(fn) { if (typeof fn === 'function') depthLabel = fn; }

  // The profile sample closest to a point on the path. Squared degrees is a
  // fine metric here: the candidates all lie along one short line.
  function sampleNearest(p, latlng) {
    const pts = (p.profile || []).filter((s) => s.feet !== null);
    if (!pts.length) return null;
    let best = null, bestD = Infinity;
    pts.forEach((s) => {
      const dLat = s.lat - latlng.lat, dLng = s.lng - latlng.lng;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestD) { bestD = d; best = s; }
    });
    return best;
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

    // same action as right-clicking the node, reachable without a right button
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'node-coord-del';
    del.textContent = '×'; del.title = 'Delete this node';
    del.addEventListener('click', () => removeNode(p, i));
    wrap.appendChild(del);
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

  /* ---------- multi-node selection ----------
   * Shift-drag on the map rubber-bands a box and picks every node of the
   * selected path inside it. This REPLACES Leaflet's shift-drag box zoom,
   * which is disabled below — node editing is what that gesture is for here.
   * (Shift-CLICK on a single node still snaps it to a contour; a click has no
   * drag distance, so the two never fire together.)
   *
   * Picked nodes drag as a group and delete as a group; deleting interior
   * nodes simply removes them from the list, so their surviving neighbours
   * become adjacent and the line closes up.
   */
  const picked = new Set();        // node indices, always within the selected path
  let pickedPathId = null;

  function clearPicked() {
    if (!picked.size) return;
    picked.clear();
    pickedPathId = null;
    const p = selected();
    if (p) redraw(p);
  }

  function removePicked() {
    const p = selected();
    if (!p || pickedPathId !== p.id || !picked.size) return;
    const keep = p.nodes.filter((_, i) => !picked.has(i));
    if (keep.length < 2) {
      toast('A path needs at least two nodes — that selection would empty it.', true);
      return;
    }
    const n = picked.size;
    p.nodes = keep;
    if (p.mirrored) { p.mirrored = false; p.preMirrorNodes = null; }
    picked.clear(); pickedPathId = null;
    p.profile = null;
    closeNodeEditor();
    redraw(p); refreshProfile(p);
    say(n + ' node' + (n === 1 ? '' : 's') + ' deleted from ' + p.name);
    onChange();
  }

  function initBoxSelect() {
    map.boxZoom.disable();                       // the gesture belongs to selection now
    const container = map.getContainer();
    let origin = null, boxEl = null;

    function corners(a, b) {
      return {
        left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
        right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y)
      };
    }

    container.addEventListener('mousedown', (ev) => {
      if (!ev.shiftKey || ev.button !== 0) return;
      const p = selected();
      if (!p || drawing) return;
      origin = map.mouseEventToContainerPoint(ev);
      boxEl = L.DomUtil.create('div', 'node-select-box', container);
      L.DomUtil.disableTextSelection();
      ev.preventDefault();
    });

    container.addEventListener('mousemove', (ev) => {
      if (!origin || !boxEl) return;
      const now = map.mouseEventToContainerPoint(ev);
      const c = corners(origin, now);
      boxEl.style.left = c.left + 'px';
      boxEl.style.top = c.top + 'px';
      boxEl.style.width = (c.right - c.left) + 'px';
      boxEl.style.height = (c.bottom - c.top) + 'px';
    });

    document.addEventListener('mouseup', (ev) => {
      if (!origin) return;
      const now = map.mouseEventToContainerPoint(ev);
      const c = corners(origin, now);
      if (boxEl) { L.DomUtil.remove(boxEl); boxEl = null; }
      L.DomUtil.enableTextSelection();
      origin = null;

      const p = selected();
      if (!p) return;
      // a shift-click with no drag is not a box; leave it to the node handler
      if (c.right - c.left < 4 && c.bottom - c.top < 4) return;
      picked.clear();
      pickedPathId = p.id;
      p.nodes.forEach((ll, i) => {
        const pt = map.latLngToContainerPoint(ll);
        if (pt.x >= c.left && pt.x <= c.right && pt.y >= c.top && pt.y <= c.bottom) picked.add(i);
      });
      if (!picked.size) pickedPathId = null;
      redraw(p);
      if (picked.size) {
        say(picked.size + ' node' + (picked.size === 1 ? '' : 's') +
            ' selected — drag to move them together, Delete to remove');
      }
    });
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

    /*
     * A fat, fully transparent companion line under the visible one: it is
     * the click target for "add a node here", so the hit radius is generous
     * without thickening the stroke. Only the selected path gets one, and
     * never while drawing (it would swallow the clicks that place nodes).
     */
    if (p.hitLine) { map.removeLayer(p.hitLine); p.hitLine = null; }
    if (p.nodes.length >= 2 && !drawing) {
      p.hitLine = L.polyline(latlngs, {
        // wide catch radius: this line is only a hover/click target, so it can
        // be far fatter than the stroke the user actually sees
        pane: PANE, weight: 32, opacity: 0, interactive: true
      }).addTo(map);
      /*
       * Hovering anywhere near a path reads its depth there, the same dot and
       * label the profile plot's hover produces. Every path gets this, not
       * just the selected one — reading a depth should not require selecting.
       */
      p.hitLine.on('mousemove', (ev) => {
        const s = sampleNearest(p, ev.latlng);
        if (s) hoverAt(p.id, s, depthLabel(s));
      });
      p.hitLine.on('mouseout', hoverOff);
      // ...but editing does: only the selected path takes an inserted node.
      if (isSel) {
        p.hitLine.on('click', (ev) => {
          const oe = ev.originalEvent;
          // Ctrl/Cmd means "start a new path", even over an existing one
          if (oe && (oe.ctrlKey || oe.metaKey)) {
            startDrawing();
            drawing.nodes.push(ev.latlng);
            redraw(drawing);
            onChange();
          } else if (!(oe && oe.shiftKey)) {   // shift-drag is box select
            insertNodeAt(p, ev.latlng);
          }
          L.DomEvent.stop(ev);
        });
      }
    }

    // rebuild node handles
    p.markers.forEach((m) => map.removeLayer(m));
    p.markers = [];
    if (!isSel) return;                       // only the selected path is editable
    const isPicked = (i) => pickedPathId === p.id && picked.has(i);
    p.nodes.forEach((ll, i) => {
      const icon = L.divIcon({
        className: 'path-node' + (isPicked(i) ? ' picked' : ''),
        html: '<span style="background:' + p.color + '"></span>',
        iconSize: [11, 11]
      });
      const m = L.marker(ll, { icon: icon, draggable: true, pane: PANE });
      /*
       * Dragging a picked node carries the rest of the selection with it: the
       * delta this node moved is applied to every other picked node, so their
       * relative geometry is preserved.
       */
      let dragFrom = null, groupFrom = null;
      m.on('dragstart', () => {
        if (!isPicked(i)) return;
        dragFrom = p.nodes[i];
        groupFrom = {};
        picked.forEach((k) => { groupFrom[k] = p.nodes[k]; });
      });
      m.on('drag', (ev) => {
        const now = ev.target.getLatLng();
        if (dragFrom && groupFrom) {
          const dLat = now.lat - dragFrom.lat, dLng = now.lng - dragFrom.lng;
          Object.keys(groupFrom).forEach((k) => {
            const from = groupFrom[k];
            p.nodes[k] = L.latLng(from.lat + dLat, from.lng + dLng);
          });
          // the dragged marker is authoritative for its own node
          p.nodes[i] = now;
          p.markers.forEach((mk, k) => { if (k !== i && picked.has(k)) mk.setLatLng(p.nodes[k]); });
        } else {
          p.nodes[i] = now;
        }
        p.line.setLatLngs(p.nodes);
        if (p.hitLine) p.hitLine.setLatLngs(p.nodes);
      });
      m.on('dragend', () => {
        dragFrom = null; groupFrom = null;
        p.profile = null;
        refreshProfile(p);
      });
      m.on('contextmenu', () => removeNode(p, i));
      m.on('click', (ev) => {
        const oe = ev.originalEvent;
        if (oe && oe.shiftKey) { snapNodeToContour(p, i); L.DomEvent.stop(ev); }
      });
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
    closeNodeEditor();
    redraw(p); refreshProfile(p);
    onChange();
  }

  /*
   * Drop a node into the segment nearest the click, rather than appending to
   * the end — this is how the middle of a finished path gets edited. Work is
   * done in projected pixel space (via L.LineUtil) so "nearest" matches what
   * the eye sees on screen, and the new node lands exactly ON the line.
   */
  function insertNodeAt(p, latlng) {
    if (p.nodes.length < 2) return;
    const pt = map.latLngToLayerPoint(latlng);
    let best = -1, bestD = Infinity, bestPt = null;
    for (let i = 0; i < p.nodes.length - 1; i++) {
      const a = map.latLngToLayerPoint(p.nodes[i]);
      const b = map.latLngToLayerPoint(p.nodes[i + 1]);
      const cp = L.LineUtil.closestPointOnSegment(pt, a, b);
      const d = pt.distanceTo(cp);
      if (d < bestD) { bestD = d; best = i; bestPt = cp; }
    }
    if (best < 0) return;
    p.nodes.splice(best + 1, 0, map.layerPointToLatLng(bestPt));
    p.profile = null;
    // an inserted node invalidates the stored pre-mirror list; drop the pairing
    if (p.mirrored) { p.mirrored = false; p.preMirrorNodes = null; }
    redraw(p); refreshProfile(p);
    say('Node added to ' + p.name + ' — now ' + p.nodes.length + ' nodes');
    onChange();
  }

  /*
   * Shift-click pulls a node onto the nearest custom depth contour, so a path
   * can be pinned to "the 40 ft line" without eyeballing it. Bounded by
   * SNAP_PX of screen distance: past that the nearest contour is not what the
   * user meant, and silently teleporting the node would be worse than a miss.
   */
  const SNAP_PX = 70;
  function snapNodeToContour(p, i) {
    const contours = (window.CustomContours && CustomContours.items) || [];
    const src = map.latLngToLayerPoint(p.nodes[i]);
    let bestPt = null, bestD = Infinity, bestFt = null;
    contours.forEach((it) => {
      if (!it.layer) return;
      const rings = it.layer.getLatLngs();
      (Array.isArray(rings[0]) ? rings : [rings]).forEach((ring) => {
        for (let k = 0; k < ring.length - 1; k++) {
          const a = map.latLngToLayerPoint(ring[k]);
          const b = map.latLngToLayerPoint(ring[k + 1]);
          const cp = L.LineUtil.closestPointOnSegment(src, a, b);
          const d = src.distanceTo(cp);
          if (d < bestD) { bestD = d; bestPt = cp; bestFt = Math.abs(it.feet); }
        }
      });
    });
    if (!contours.length) { toast('No custom contours to snap to — add one on the depth ruler.', true); return; }
    if (!bestPt || bestD > SNAP_PX) { toast('No contour within snapping range of that node.', true); return; }
    p.nodes[i] = map.layerPointToLatLng(bestPt);
    p.profile = null;
    closeNodeEditor();
    redraw(p); refreshProfile(p);
    say('Node ' + (i + 1) + ' snapped to the ' + bestFt + ' ft contour');
    onChange();
  }

  function lengthOf(p) {
    let d = 0;
    for (let i = 1; i < p.nodes.length; i++) d += DemSampler.haversine(p.nodes[i - 1], p.nodes[i]);
    return d;
  }

  // Cumulative distance (metres) from the start of the path to each node —
  // the bridge between node indices and the evenly-spaced profile samples.
  function nodeDistances(p) {
    const out = [0];
    let d = 0;
    for (let i = 1; i < p.nodes.length; i++) {
      d += DemSampler.haversine(p.nodes[i - 1], p.nodes[i]);
      out.push(d);
    }
    return out;
  }

  /*
   * TRUE bearing (degrees from true north). Note for navigation: a diver's
   * compass reads MAGNETIC, which differs from this by the local declination
   * — roughly 11-12° east in the Santa Barbara Channel. The leg table labels
   * the column accordingly rather than silently implying magnetic.
   */
  function bearing(a, b) {
    const rad = Math.PI / 180;
    const lat1 = a.lat * rad, lat2 = b.lat * rad;
    const dLng = (b.lng - a.lng) * rad;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  /*
   * One row per segment: what a diver would write on a slate. Depths come
   * from whichever profile samples fall inside the leg's distance span, so
   * they are null until the profile has been read.
   */
  function legsOf(id) {
    const p = paths.find((x) => x.id === id);
    if (!p || p.nodes.length < 2) return [];
    const cum = nodeDistances(p);
    const samples = (p.profile || []).filter((s) => s.feet !== null);
    return p.nodes.slice(0, -1).map((from, i) => {
      const to = p.nodes[i + 1];
      const depths = samples
        .filter((s) => s.distance >= cum[i] && s.distance <= cum[i + 1])
        .map((s) => -s.feet);
      return {
        leg: i + 1, from: from, to: to,
        heading: bearing(from, to),
        metres: cum[i + 1] - cum[i],
        maxFt: depths.length ? Math.max.apply(null, depths) : null,
        avgFt: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null
      };
    });
  }

  /* ---------- drawing ---------- */

  function startDrawing() {
    if (drawing) { finishDrawing(); return; }
    const id = nextId++;
    const p = {
      id: id, name: 'Path ' + id, nodes: [],
      color: COLORS[(id - 1) % COLORS.length],
      line: null, markers: [], profile: null, expanded: true,
      mirrored: false, preMirrorNodes: null, plotHeight: 62, plotHeightManual: false,
      showNodes: false, showLegs: false, legGas: {}
    };
    paths.push(p);
    selectedId = p.id;
    drawing = p;
    map.getContainer().classList.add('drawing');
    say('Draw mode — click the map to add nodes, Esc or ✓ to finish');
    onChange();
  }

  function onMapClick(ev) {
    /*
     * Ctrl (or Cmd) + click starts a path and drops its first node in one go,
     * so drawing never has to begin at the + button. Cmd is accepted because
     * macOS turns Ctrl+click into a secondary click, which never reaches here.
     */
    const oe = ev.originalEvent;
    if (!drawing && oe && (oe.ctrlKey || oe.metaKey)) startDrawing();
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
  function toggleShowNodes(id) {
    const p = paths.find((x) => x.id === id);
    if (p) { p.showNodes = !p.showNodes; onChange(); }
  }

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
    if (p.hitLine) map.removeLayer(p.hitLine);
    p.markers.forEach((m) => map.removeLayer(m));
    paths.splice(i, 1);
    if (selectedId === id) selectedId = paths.length ? paths[paths.length - 1].id : null;
    if (drawing && drawing.id === id) { drawing = null; map.getContainer().classList.remove('drawing'); }
    paths.forEach(redraw);
    onChange();
  }

  /*
   * Rebuild paths from their persisted form (see persistNow in app.js).
   * Only geometry and display fields are stored; profiles are derived and
   * re-sample from the DEM here. Entries that fail validation are skipped
   * individually rather than aborting the whole restore.
   */
  function restore(list) {
    const valid = (n) => n && isFinite(n.lat) && isFinite(n.lng);
    (list || []).forEach((s) => {
      if (!s || !Array.isArray(s.nodes)) return;
      const nodes = s.nodes.filter(valid).map((n) => L.latLng(n.lat, n.lng));
      if (nodes.length < 2) return;
      const id = nextId++;
      paths.push({
        id: id,
        name: typeof s.name === 'string' && s.name ? s.name : 'Path ' + id,
        nodes: nodes,
        color: typeof s.color === 'string' ? s.color : COLORS[(id - 1) % COLORS.length],
        line: null, markers: [], profile: null,
        expanded: s.expanded !== false,
        mirrored: !!s.mirrored,
        preMirrorNodes: Array.isArray(s.preMirrorNodes)
          ? s.preMirrorNodes.filter(valid).map((n) => L.latLng(n.lat, n.lng)) : null,
        plotHeight: s.plotHeight > 0 ? s.plotHeight : 62,
        showNodes: !!s.showNodes,
        showLegs: !!s.showLegs,
        plotHeightManual: !!s.plotHeightManual,
        legGas: (s.legGas && typeof s.legGas === 'object') ? s.legGas : {}
      });
    });
    if (!paths.length) return;
    selectedId = paths[paths.length - 1].id;
    paths.forEach(redraw);
    paths.forEach(refreshProfile);
    say(paths.length + ' path' + (paths.length === 1 ? '' : 's') + ' restored from your last visit', 'ok');
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
        mirrored: false, preMirrorNodes: null, plotHeight: 62, plotHeightManual: false,
      showNodes: false, showLegs: false, legGas: {}
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
    toggleShowNodes: toggleShowNodes,
    setPlotHeight: setPlotHeight,
    legsOf: legsOf,
    nodeDistances: nodeDistances,
    setColor: setColor,
    remove: remove,
    exportPath: exportPath,
    importFile: importFile,
    restore: restore,
    lengthOf: lengthOf,
    hoverAt: hoverAt,
    hoverOff: hoverOff,
    setDepthFormatter: setDepthFormatter,
    clearPicked: clearPicked,
    get pickedCount() { return picked.size; },
    parseCoords: parseCoords,
    get list() { return paths; },
    get selectedId() { return selectedId; },
    get drawing() { return !!drawing; }
  };
})();

window.Paths = Paths;
