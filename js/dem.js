/*
 * DemSampler — shared elevation/depth sampling against the NOAA NCEI DEM mosaic,
 * used by both the custom-contour module and the Paths panel.
 *
 * The ImageServer's getSamples endpoint takes a multipoint geometry and returns
 * the raw pixel value (metres, negative below sea level) at each point. Two hard
 * facts shape everything here:
 *
 *   1. It caps at 1000 samples per request — verified: asking for 1600 or 4096
 *      returns exactly 1000. So every grid is chunked.
 *   2. It allows cross-origin POSTs, so no proxy is needed.
 *
 * Points are snapped to a POWER-OF-TWO lattice in degrees. That matters: nesting
 * the lattices means a point sampled at one zoom is reused at another, and
 * panning only ever fetches the newly exposed points rather than re-sampling the
 * whole view.
 */
const DemSampler = (function () {
  const MAX_PER_REQUEST = 1000;
  const M_TO_FT = 3.280839895;

  let cfg = null;
  const cache = new Map();        // 'step|gx|gy' -> metres | null (null = NoData)
  const inflight = new Map();     // same key -> Promise, so concurrent asks share

  function init(config) { cfg = config; }

  const keyOf = (step, gx, gy) => step + '|' + gx + '|' + gy;

  // Nearest power-of-two degree step giving roughly `cols` columns across `width`.
  function stepFor(widthDeg, cols) {
    const raw = widthDeg / (cols || 48);
    const p = Math.round(Math.log(raw) / Math.LN2);
    return Math.pow(2, Math.max(-14, Math.min(0, p)));   // ~0.00006° .. 1°
  }

  async function postSamples(points) {
    const baseUrl = cfg.DEPTH.probe.url;
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: points, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      f: 'json'
    });
    const res = await fetch(baseUrl + '/getSamples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    if (!res.ok) throw new Error('getSamples ' + res.status);
    const json = await res.json();
    // Points with no data are simply absent, so seed nulls and fill by locationId.
    const out = new Array(points.length).fill(null);
    (json.samples || []).forEach((s) => {
      const v = parseFloat(s.value);
      if (isFinite(v)) out[s.locationId] = v;
    });
    return out;
  }

  // Single-point lookup, used by the cursor readout. Returns metres, or null
  // where the mosaic has no data.
  async function identify(lat, lng, signal) {
    const geom = JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } });
    const url = cfg.DEPTH.probe.url + '/identify?f=json&geometryType=esriGeometryPoint' +
                '&returnGeometry=false&returnCatalogItems=false&geometry=' +
                encodeURIComponent(geom);
    const res = await fetch(url, { signal: signal });
    if (!res.ok) throw new Error('identify ' + res.status);
    const v = parseFloat((await res.json()).value);   // "NoData" parses to NaN
    return isFinite(v) ? v : null;
  }

  /*
   * Ensure every lattice point in the list is cached, fetching only what's
   * missing. Returns nothing — read values back out of the cache.
   */
  async function ensure(step, cells, onProgress) {
    const missing = [];
    const seen = new Set();
    cells.forEach((c) => {
      const k = keyOf(step, c.gx, c.gy);
      if (cache.has(k) || inflight.has(k) || seen.has(k)) return;
      seen.add(k);
      missing.push(c);
    });
    if (!missing.length) return { fetched: 0, cached: cells.length };

    const chunks = [];
    for (let i = 0; i < missing.length; i += MAX_PER_REQUEST) {
      chunks.push(missing.slice(i, i + MAX_PER_REQUEST));
    }
    let done = 0;
    for (const chunk of chunks) {
      const pts = chunk.map((c) => [c.gx * step, c.gy * step]);
      const promise = postSamples(pts);
      chunk.forEach((c) => inflight.set(keyOf(step, c.gx, c.gy), promise));
      try {
        const vals = await promise;
        chunk.forEach((c, i) => cache.set(keyOf(step, c.gx, c.gy), vals[i]));
      } finally {
        chunk.forEach((c) => inflight.delete(keyOf(step, c.gx, c.gy)));
      }
      done += chunk.length;
      if (onProgress) onProgress(done, missing.length);
    }
    return { fetched: missing.length, cached: cells.length - missing.length };
  }

  /*
   * Sample a lattice covering `bounds` (a Leaflet LatLngBounds). Returns the grid
   * plus how much of it had to be fetched, so callers can report cache hits.
   */
  async function grid(bounds, cols, onProgress) {
    const w = bounds.getWest(), e = bounds.getEast();
    const s = bounds.getSouth(), n = bounds.getNorth();
    const step = stepFor(e - w, cols);

    const gx0 = Math.floor(w / step), gx1 = Math.ceil(e / step);
    const gy0 = Math.floor(s / step), gy1 = Math.ceil(n / step);
    const nx = gx1 - gx0 + 1, ny = gy1 - gy0 + 1;

    const cells = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) cells.push({ gx: gx0 + i, gy: gy0 + j });
    }
    const stats = await ensure(step, cells, onProgress);

    const values = new Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = cache.get(keyOf(step, gx0 + i, gy0 + j));
        values[j * nx + i] = (v === undefined ? null : v);
      }
    }
    return { step: step, gx0: gx0, gy0: gy0, nx: nx, ny: ny, values: values, stats: stats };
  }

  // Sample `count` evenly spaced points along a polyline of {lat,lng}.
  async function alongPath(nodes, count) {
    if (nodes.length < 2) return [];
    const segs = [];
    let total = 0;
    for (let i = 1; i < nodes.length; i++) {
      const d = haversine(nodes[i - 1], nodes[i]);
      segs.push({ a: nodes[i - 1], b: nodes[i], d: d, at: total });
      total += d;
    }
    const n = Math.max(2, Math.min(count || 200, MAX_PER_REQUEST));
    const pts = [], dists = [];
    for (let i = 0; i < n; i++) {
      const target = total * i / (n - 1);
      let seg = segs[segs.length - 1];
      for (const s of segs) { if (target <= s.at + s.d) { seg = s; break; } }
      const t = seg.d ? (target - seg.at) / seg.d : 0;
      pts.push([seg.a.lng + (seg.b.lng - seg.a.lng) * t,
                seg.a.lat + (seg.b.lat - seg.a.lat) * t]);
      dists.push(target);
    }
    const vals = await postSamples(pts);
    return vals.map((v, i) => ({
      distance: dists[i],
      lng: pts[i][0], lat: pts[i][1],
      metres: v,
      feet: v === null ? null : v * M_TO_FT
    }));
  }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const la1 = a.lat * rad, la2 = b.lat * rad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  return {
    init: init,
    grid: grid,
    identify: identify,
    alongPath: alongPath,
    haversine: haversine,
    M_TO_FT: M_TO_FT,
    get cacheSize() { return cache.size; },
    clearCache: function () { cache.clear(); }
  };
})();

window.DemSampler = DemSampler;
