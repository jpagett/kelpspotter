/*
 * CustomContours — user-defined depth contours traced over the current view.
 *
 * The NOAA ENC layer only carries the depths the chart happens to publish, so an
 * arbitrary "show me -87 ft" contour has to be computed. That is done here:
 *
 *   1. DemSampler returns a power-of-two lattice of elevations covering the view,
 *      fetching only the lattice points it hasn't already cached.
 *   2. Marching squares extracts the isoline at the requested level from that
 *      lattice, with linear interpolation along cell edges.
 *   3. The segments are drawn as one Leaflet multi-polyline per contour.
 *
 * Because the lattice is cached per point rather than per view, panning only
 * fetches the newly exposed strip; the previously sampled area is reused and the
 * isoline is simply re-extracted, which is pure client-side arithmetic.
 */
const CustomContours = (function () {
  const PANE = 'custom';
  const GRID_COLS = 44;          // ~1936 lattice points -> 2 requests at the cap
  const PALETTE = ['#f2b134', '#5ec6c9', '#e2725b', '#a6d95b', '#c78bd9', '#ffd166'];

  let cfg = null, map = null, L = null, say = null;
  let items = [];                // {id, feet, color, layer, menuOpen}
  let nextId = 1;
  let lastKey = null;            // view signature of the last extraction
  let pending = false;

  function init(config, leaflet, leafletMap, logger) {
    cfg = config; L = leaflet; map = leafletMap; say = logger || function () {};
    map.createPane(PANE).style.zIndex = 270;
    map.on('moveend zoomend', () => refresh(false));
  }

  /* ---------- marching squares ---------- */

  /*
   * `level` is the elevation in metres to trace. Cells with any NoData corner are
   * skipped rather than guessed at, which leaves honest gaps over unmapped water
   * instead of inventing a contour.
   */
  function isoSegments(g, level) {
    const segs = [];
    const at = (i, j) => g.values[j * g.nx + i];
    const lng = (i) => (g.gx0 + i) * g.step;
    const lat = (j) => (g.gy0 + j) * g.step;

    // interpolate the crossing point between two corners
    const cross = (v1, v2, a, b) => {
      const t = (level - v1) / (v2 - v1);
      return a + (b - a) * t;
    };

    for (let j = 0; j < g.ny - 1; j++) {
      for (let i = 0; i < g.nx - 1; i++) {
        const bl = at(i, j), br = at(i + 1, j), tr = at(i + 1, j + 1), tl = at(i, j + 1);
        if (bl === null || br === null || tr === null || tl === null) continue;

        let idx = 0;
        if (bl > level) idx |= 1;
        if (br > level) idx |= 2;
        if (tr > level) idx |= 4;
        if (tl > level) idx |= 8;
        if (idx === 0 || idx === 15) continue;

        const x0 = lng(i), x1 = lng(i + 1), y0 = lat(j), y1 = lat(j + 1);
        const B = () => [y0, cross(bl, br, x0, x1)];   // bottom edge -> [lat,lng]
        const R = () => [cross(br, tr, y0, y1), x1];   // right edge
        const T = () => [y1, cross(tl, tr, x0, x1)];   // top edge
        const Lf = () => [cross(bl, tl, y0, y1), x0];  // left edge

        switch (idx) {
          case 1: case 14: segs.push([Lf(), B()]); break;
          case 2: case 13: segs.push([B(), R()]); break;
          case 3: case 12: segs.push([Lf(), R()]); break;
          case 4: case 11: segs.push([R(), T()]); break;
          case 6: case 9:  segs.push([B(), T()]); break;
          case 7: case 8:  segs.push([Lf(), T()]); break;
          // saddles: draw both branches
          case 5:  segs.push([Lf(), T()], [B(), R()]); break;
          case 10: segs.push([Lf(), B()], [R(), T()]); break;
        }
      }
    }
    return segs;
  }

  /* ---------- view handling ---------- */

  // Signature of the current view at lattice resolution: if this is unchanged
  // there is nothing new to sample or re-extract.
  function viewKey() {
    const b = map.getBounds();
    return [map.getZoom(), b.getWest().toFixed(3), b.getSouth().toFixed(3),
            b.getEast().toFixed(3), b.getNorth().toFixed(3)].join(',');
  }

  async function refresh(force) {
    if (!items.length) return;
    const key = viewKey();
    if (!force && key === lastKey) return;
    if (pending) return;
    pending = true;
    try {
      const grid = await DemSampler.grid(map.getBounds(), GRID_COLS);
      lastKey = key;
      items.forEach((it) => draw(it, grid));
      if (grid.stats.fetched) {
        say('Sampled ' + grid.stats.fetched + ' new depth points (' +
            grid.stats.cached + ' cached)', 'ok');
      }
    } catch (err) {
      console.warn(err);
      say('Contour sampling failed — see console', 'warn');
    } finally {
      pending = false;
    }
  }

  function draw(item, grid) {
    const level = item.feet / DemSampler.M_TO_FT;   // ft below sea level -> metres
    const segs = isoSegments(grid, level);
    if (item.layer) { map.removeLayer(item.layer); item.layer = null; }
    if (!segs.length) return;
    item.layer = L.polyline(segs, {
      color: item.color, weight: 1.5, opacity: 0.9, interactive: false, pane: PANE
    }).addTo(map);
  }

  /* ---------- public API ---------- */

  function add(feet) {
    if (!isFinite(feet)) return null;
    const item = {
      id: nextId++,
      feet: -Math.abs(feet),                       // always below sea level
      color: PALETTE[(nextId - 2) % PALETTE.length],
      layer: null
    };
    items.push(item);
    lastKey = null;                                // force an extraction
    refresh(true);
    return item;
  }

  function remove(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return;
    if (items[i].layer) map.removeLayer(items[i].layer);
    items.splice(i, 1);
  }

  function setColor(id, color) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.color = color;
    if (it.layer) it.layer.setStyle({ color: color });
  }

  function setDepth(id, feet) {
    const it = items.find((x) => x.id === id);
    if (!it || !isFinite(feet)) return;
    it.feet = -Math.abs(feet);
    lastKey = null;                                // force an extraction at the new depth
    refresh(true);
  }

  return {
    init: init,
    add: add,
    remove: remove,
    setColor: setColor,
    setDepth: setDepth,
    refresh: refresh,
    get items() { return items; }
  };
})();

window.CustomContours = CustomContours;
