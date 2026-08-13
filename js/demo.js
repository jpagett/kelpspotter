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

  /*
   * Synthetic scenes at the Sentinel-2 revisit cadence (~5 days) across whatever
   * window is asked for. Passes are anchored to a fixed epoch rather than to
   * "today", so a given date always yields the same scene and cloud cover no
   * matter which range the user picks.
   */
  const DAY = 86400000, CADENCE = 5, MAX_SCENES = 400;
  const EPOCH = Date.UTC(2015, 5, 23); // Sentinel-2 archive start, roughly

  function scenesBetween(startISO, endISO) {
    const start = Date.parse(startISO + 'T00:00:00Z');
    const end = Date.parse(endISO + 'T00:00:00Z');
    if (!(start <= end)) return [];
    const step = CADENCE * DAY;
    let t = EPOCH + Math.ceil((start - EPOCH) / step) * step;
    // When the range holds more passes than the cap, keep the most RECENT
    // ones: the dates a user actually works with (and the default window)
    // sit at the end of the range, so filling oldest-first dropped exactly
    // the passes they were looking at.
    const total = Math.floor((end - t) / step) + 1;
    if (total > MAX_SCENES) t += (total - MAX_SCENES) * step;
    const out = [];
    for (; t <= end; t += step) {
      const d = new Date(t).toISOString().slice(0, 10);
      // one decimal, matching the precision of the real CLOUDY_PIXEL_PERCENTAGE
      out.push({ id: 'demo_' + d, date: d, cloud: Math.round(Math.pow(rand(dateSeed(d)), 1.7) * 850) / 10 });
    }
    return out;
  }

  // The real indices sit on scales two orders of magnitude apart (KD ~0.003 vs
  // NDVI ~0.1), so translate the live threshold into a 0-centred "strictness"
  // relative to that index's published value. 0 = the paper's threshold, so the
  // demo looks the same at defaults whichever index is selected.
  function strictness(p) {
    const spec = cfg && cfg.INDICES && cfg.INDICES[p.indexType];
    if (!spec) return 0;
    return (p.kelpThresh - spec.thresh) / (spec.max - spec.min);
  }

  /*
   * Colormap support: interpolate along cfg.KELP_PALETTES[p.kelpPalette] by
   * intensity, so the demo tracks the legend's colormap picker the same way
   * the live EE/API renderers do. The old procedural ramps remain as the
   * fallback if no palette resolves.
   */
  function hexRGB(h) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function paletteRGB(stops, t) {
    const n = stops.length - 1;
    const x = Math.max(0, Math.min(1, t)) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    const a = hexRGB(stops[i]), b = hexRGB(stops[i + 1]);
    return [Math.round(a[0] + (b[0] - a[0]) * f),
            Math.round(a[1] + (b[1] - a[1]) * f),
            Math.round(a[2] + (b[2] - a[2]) * f)];
  }

  // A Leaflet layer that paints kelp glow for a given seed set + params.
  function makeLayer(L, seeds, p, freqMode) {
    return L.Layer.extend({
      onAdd(map) {
        this._map = map;
        this._c = L.DomUtil.create('canvas', 'kelp-overlay');
        this._c.style.position = 'absolute';
        this._c.style.pointerEvents = 'none';
        // kelpPane, not overlayPane: the overlay picker reorders the map
        // layers by pane z-index, and the demo canvas has to move with the
        // real kelp tile layer rather than always floating above everything.
        (map.getPanes().kelpPane || map.getPanes().overlayPane).appendChild(this._c);
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
        // raising the B11 ceiling keeps more pixels, so more demo kelp survives
        const cut = 0.52 + strictness(p) * 0.6 - 0.8 * (p.b11Thresh - 0.028);
        const bedRadiusM = 1600;
        const rPx = bedRadiusM / mpp;

        // Non-default colormaps interpolate the shared palette; 'amber' keeps
        // the hand-tuned procedural ramps below, which it was derived from.
        // prefer the range-sliced palette from app.js; only the untouched
        // amber default falls through to the hand-tuned procedural ramps
        const sliced = p.paletteStops && p.paletteStops.length ? p.paletteStops : null;
        const stops = (p.kelpPalette && p.kelpPalette !== 'amber')
          ? (sliced || (cfg && cfg.KELP_PALETTES && cfg.KELP_PALETTES[p.kelpPalette]))
          : (p.paletteMin > 0 || p.paletteMax < 1 ? sliced : null);

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
                const m = v - cut;
                if (m <= 0) continue;
                const inten = Math.min(1, m * 2.6);
                const a = Math.min(0.55, m * 2.4) * p.opacity;
                let r, g, b;
                if (stops) {
                  const rgb = paletteRGB(stops, inten);
                  r = rgb[0]; g = rgb[1]; b = rgb[2];
                } else if (freqMode) { // cool->amber->gold ramp for composite frequency
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

  let cfg = null, L = null;

  return {
    name: 'demo',
    available: true,
    needsLogin: false,
    init(config, leaflet) { cfg = config; L = leaflet; return Promise.resolve(true); },
    login() { return Promise.resolve(true); },
    listScenes(startISO, endISO, maxCloud) {
      return Promise.resolve(
        scenesBetween(startISO.slice(0, 10), endISO.slice(0, 10))
          .filter((s) => s.cloud <= maxCloud)
      );
    },
    singleSceneLayer(dateISO, p) {
      const Layer = makeLayer(L, [dateSeed(dateISO)], p, false);
      return Promise.resolve(new Layer());
    },
    // stand-in for the mean composite: blend the clear passes in the window
    compositeLayer(startISO, endISO, maxCloud, p) {
      const seeds = scenesBetween(startISO.slice(0, 10), endISO.slice(0, 10))
        .filter((s) => s.cloud <= maxCloud)
        .map((s) => dateSeed(s.date));
      const Layer = makeLayer(L, seeds.slice(0, 6), p, true);
      return Promise.resolve(new Layer());
    },
    // Demo mode has no real Sentinel-2 pixels to composite — nothing honest to
    // show here, so the caller is told plainly rather than being handed a fake.
    // The same goes for the band-derived turbidity and cloud-mask layers: the
    // synthetic kelp exists to demo the CONTROLS, but fabricating water clarity
    // or cloud cover would be pure fiction with nothing to teach.
    trueColorLayer(dateISO) {
      return Promise.reject(new Error('True color needs a live Earth Engine or API connection — demo mode has no real imagery.'));
    },
    turbidityLayer() {
      return Promise.reject(new Error('Turbidity needs a live Earth Engine or API connection — demo mode has no real imagery.'));
    },
    turbidityCompositeLayer() {
      return Promise.reject(new Error('Turbidity needs a live Earth Engine or API connection — demo mode has no real imagery.'));
    },
    cloudLayer() {
      return Promise.reject(new Error('The cloud mask needs a live Earth Engine or API connection — demo mode has no real imagery.'));
    },
    cloudCompositeLayer() {
      return Promise.reject(new Error('The cloud mask needs a live Earth Engine or API connection — demo mode has no real imagery.'));
    }
  };
})();

window.DemoEngine = DemoEngine;
