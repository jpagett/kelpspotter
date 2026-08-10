/*
 * DemoEngine — synthetic kelp so the whole site works with zero setup.
 * It exposes the SAME interface as KelpEngine (js/ee-kelp.js): init, listScenes,
 * singleSceneLayer, compositeLayer. The difference is the "layer" it returns is a
 * canvas overlay that draws procedural kelp anchored to the real Santa Barbara
 * Channel coast, responding to every tuning parameter so you can feel how the
 * live version will behave.
 */
const DemoEngine = (function () {

  // --- deterministic noise (same math the node prototype was tuned with) ---
  function rand(seed) { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function noise2(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const tl = rand(xi + yi * 57 + seed * 131), tr = rand(xi + 1 + yi * 57 + seed * 131);
    const bl = rand(xi + (yi + 1) * 57 + seed * 131), br = rand(xi + 1 + (yi + 1) * 57 + seed * 131);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return tl * (1 - u) * (1 - v) + tr * u * (1 - v) + bl * (1 - u) * v + br * u * v;
  }
  function fbm(x, y, seed) { let a = 0, amp = 0.6, f = 1; for (let i = 0; i < 4; i++) { a += amp * noise2(x * f, y * f, seed + i * 10); amp *= 0.5; f *= 2; } return a; }

  // Real giant-kelp reefs along the SB Channel mainland [lng, lat, strength]
  const BEDS = [
    [-120.36, 34.462, 0.9], [-120.28, 34.468, 1.0], [-120.20, 34.458, 0.8],
    [-120.05, 34.436, 0.85], [-119.98, 34.418, 1.0], [-119.93, 34.410, 0.9],
    [-119.88, 34.404, 1.0], [-119.84, 34.404, 0.8], [-119.75, 34.400, 0.7],
    [-119.69, 34.398, 0.85], [-119.62, 34.396, 0.75], [-119.53, 34.388, 0.9]
  ];

  function dateSeed(iso) { let h = 0; for (const c of iso) h = (h * 31 + c.charCodeAt(0)) % 100000; return h; }

  // Build a synthetic scene list at the Sentinel-2 revisit cadence (~5 days).
  function scenes(lookbackDays) {
    const out = [];
    const today = new Date();
    for (let d = 2; d <= lookbackDays; d += 5) {
      const dt = new Date(today.getTime() - d * 86400000);
      const iso = dt.toISOString().slice(0, 10);
      const cloud = Math.round(Math.pow(rand(dateSeed(iso)), 1.7) * 85); // skew toward clear
      out.push({ id: 'demo_' + iso, date: iso, cloud });
    }
    return out.sort((a, b) => a.date < b.date ? -1 : 1);
  }

  // A Leaflet layer that paints amber kelp glow for a given seed set + params.
  function makeLayer(L, seeds, p, freqMode) {
    return L.Layer.extend({
      onAdd(map) {
        this._map = map;
        this._c = L.DomUtil.create('canvas', 'kelp-overlay');
        this._c.style.position = 'absolute';
        this._c.style.pointerEvents = 'none';
        map.getPanes().overlayPane.appendChild(this._c);
        map.on('moveend zoomend resize', this._draw, this);
        this._draw();
      },
      onRemove(map) {
        map.off('moveend zoomend resize', this._draw, this);
        L.DomUtil.remove(this._c);
      },
      setParams(np) { p = np; this._draw(); },
      _draw() {
        const map = this._map, size = map.getSize();
        const tl = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._c, tl);
        this._c.width = size.x; this._c.height = size.y;
        const ctx = this._c.getContext('2d');
        ctx.clearRect(0, 0, size.x, size.y);
        ctx.globalCompositeOperation = 'lighter';

        // meters-per-pixel so bed radius stays geographically sensible on zoom
        const c = map.getCenter();
        const mpp = 40075016.686 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
        const bedRadiusM = 1600;
        const rPx = bedRadiusM / mpp;

        seeds.forEach((seed) => {
          BEDS.forEach(([lng, lat, strength]) => {
            const pt = map.latLngToContainerPoint([lat, lng]);
            if (pt.x < -rPx * 2 || pt.x > size.x + rPx * 2 ||
                pt.y < -rPx * 2 || pt.y > size.y + rPx * 2) return;
            const step = Math.max(2, rPx / 16);
            for (let dy = -rPx; dy <= rPx; dy += step) {
              for (let dx = -rPx * 1.5; dx <= rPx * 1.5; dx += step) { // elongate along-shore
                const rr = (dx * dx) / (rPx * rPx * 2.25) + (dy * dy) / (rPx * rPx);
                if (rr > 1) continue;
                const falloff = 1 - rr;
                const nx = (lng * 60 + dx / rPx * 1.6);
                const ny = (lat * 60 + dy / rPx * 1.6);
                let v = fbm(nx, ny, seed) * strength * falloff;
                const m = v - (0.42 + p.kelpThresh) + 0.06 * (0.10 - p.waterThresh);
                if (m <= 0) continue;
                const inten = Math.min(1, m * 2.6);
                const a = Math.min(0.55, m * 2.4) * p.opacity;
                let r, g, b;
                if (freqMode) { // cool->amber->gold ramp for composite frequency
                  r = Math.round(120 + 135 * inten);
                  g = Math.round(95 + 115 * inten);
                  b = Math.round(60 - 20 * inten);
                } else {        // amber canopy, capped below white-hot
                  r = Math.round(214 + 24 * inten);
                  g = Math.round(150 + 45 * inten);
                  b = Math.round(44 + 18 * inten);
                }
                ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
                ctx.beginPath();
                ctx.arc(pt.x + dx, pt.y + dy, step * 1.75, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          });
        });
        ctx.globalCompositeOperation = 'source-over';
      }
    });
  }

  let cfg = null, L = null, _scenes = [];

  return {
    name: 'demo',
    available: true,
    needsLogin: false,
    init(config, leaflet) { cfg = config; L = leaflet; _scenes = scenes(cfg.LOOKBACK_DAYS); return Promise.resolve(true); },
    login() { return Promise.resolve(true); },
    listScenes(startISO, endISO, maxCloud) {
      return Promise.resolve(_scenes.filter((s) => s.cloud <= maxCloud && s.date >= startISO.slice(0, 10) && s.date <= endISO.slice(0, 10)));
    },
    singleSceneLayer(dateISO, p) {
      const Layer = makeLayer(L, [dateSeed(dateISO)], p, false);
      return Promise.resolve(new Layer());
    },
    compositeLayer(startISO, endISO, maxCloud, p) {
      const seeds = _scenes.filter((s) => s.cloud <= maxCloud).map((s) => dateSeed(s.date));
      const Layer = makeLayer(L, seeds.slice(0, 6), p, true);
      return Promise.resolve(new Layer());
    }
  };
})();

window.DemoEngine = DemoEngine;
