/*
 * KelpEngine — the real Sentinel-2 -> kelp pipeline, running on Google Earth
 * Engine's servers. Everything here mirrors the interface of DemoEngine
 * (js/demo.js) so app.js can treat them interchangeably.
 *
 * DETECTION FOLLOWS:
 *   Mora-Soto, A.; Palacios, M.; Macaya, E.C.; Gómez, I.; Huovinen, P.;
 *   Pérez-Matus, A.; Young, M.; Golding, N.; Toro, M.; Yaqub, M.;
 *   Macias-Fauria, M. "A High-Resolution Global Map of Giant Kelp (Macrocystis
 *   pyrifera) Forests and Intertidal Green Algae (Ulvophyceae) with Sentinel-2
 *   Imagery." Remote Sens. 2020, 12, 694. doi:10.3390/rs12040694
 *   Reference implementation: github.com/BiogeoscienceslabOxford/kelp_forests
 *
 * Their "kelp filter algorithm" is a 3-step threshold chain, not a water-index
 * classifier:
 *   1. Band-based threshold — drop every pixel with B11 >= 0.028. B11 (1610 nm)
 *      is where Coast and Land Vegetation separate cleanly from everything wet;
 *      100% of their coast/land training pixels sit above this line.
 *   2. Index — the paper's own Kelp Difference, KD = B6 - B4. Giant kelp shows a
 *      large red-edge/red gap, and B6 (740 nm) is where that gap is widest.
 *   3. Index threshold — KD >= 0.003216, set by the largest River grass value in
 *      their training set, which removes 100% of non-kelp/non-green-algae cells.
 * Applied globally in GEE they then add a DEM step: mask anything with elevation
 * above sea level, so land features that never appeared in training can't leak in.
 *
 * IMPORTANT: those thresholds are calibrated on Sentinel-2 *L1C top-of-atmosphere*
 * reflectance rescaled by 1e-4, so this file loads L1C — not the L2A surface-
 * reflectance product. Feeding surface reflectance into these numbers would be
 * meaningless.
 *
 * Composite mode reproduces the paper's preprocessing: a mean cloud-free
 * reflectance composite over the selected window, filtered once. Single-scene
 * mode runs the same filter on one pass so the timeline stays scrubbable.
 *
 * One deliberate deviation, noted in the README: cloud screening uses the QA60
 * bitmask rather than the ~800-line JRC cloud-free compositing tool the authors
 * ran offline.
 *
 * Rendering note: the classification is binary, but painting it as a flat block
 * hides the basemap. Detected pixels are therefore drawn with opacity ramped by
 * how far the index sits above the threshold, reaching fully transparent at the
 * threshold itself. That ramp is a display choice, not part of the algorithm —
 * it never changes which pixels are classified as kelp.
 */
const KelpEngine = (function () {
  const S2_RED = 'B4', S2_RE6 = 'B6', S2_NIR = 'B8', S2_SWIR = 'B11';
  // extra bands for the turbidity and cloud-mask layers
  const S2_AERO = 'B1', S2_BLUE = 'B2', S2_GREEN = 'B3';

  // Band centres in µm exactly as written in the authors' FAI expression.
  const L_RED = 0.665, L_NIR = 0.833, L_SWIR = 1.612;

  // Sea-level mask. The published script masks with USGS/SRTMGL1_003 .eq(0);
  // the paper also mentions ALOS AW3D30 where it has coverage, but SRTM is what
  // the released code actually applies, so we match the code.
  const DEM_ID = 'USGS/SRTMGL1_003';

  let cfg = null;
  let ready = false;

  function region() {
    const [w, s, e, n] = cfg.AOI;
    return ee.Geometry.Rectangle([w, s, e, n]);
  }

  // Sentinel-2 L1C (TOA). Harmonized so post-2022 scenes keep the original
  // radiometric offset and stay comparable with the paper's 2015-2019 calibration.
  function collection(startISO, endISO, maxCloud) {
    return ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
      .filterBounds(region())
      .filterDate(startISO, endISO)
      .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', maxCloud));
  }

  /*
   * ---- cloud measured over a box ----
   * The signed-in twin of cloud_over() in api/main.py. Same mask, same scale,
   * same per-granule reduction and per-date merge, so a visitor sees the same
   * numbers whether they are using their own Earth Engine account or the
   * shared backend. Any change here has to land there too.
   */
  const CLOUD_SAMPLE_SCALE = 200;
  const CLOUD_SAMPLE_MAX_PIXELS = 1e7;
  const MIN_SAMPLE_SPAN = 0.005;
  const MAX_SAMPLE_DAYS = 95;
  /*
   * Pinned, not the live sliders. Wiring the date filter to tunable cloud
   * thresholds would mean every nudge of one invalidates the whole scene
   * listing and re-runs a reduction per granule. Mirrors CLOUD_MASK in
   * api/main.py.
   */
  const CLOUD_SAMPLE_MASK = { cloudVisMin: 0.18, cloudSwirMin: 0.10, cloudWhiteness: 0.55 };

  /*
   * The caller's box, ordered and clamped to the AOI. There is no quota
   * argument for clamping here — this is the user's own account — but the two
   * engines must agree on which water was measured, and the backend clamps.
   */
  function sampleGeometry(spec) {
    if (!spec) return null;
    const v = String(spec).split(',').map(Number);
    if (v.length !== 4 || v.some((n) => !isFinite(n))) return null;
    const aw = cfg.AOI[0], as = cfg.AOI[1], ae = cfg.AOI[2], an = cfg.AOI[3];
    const lo = (x, a, b) => Math.max(a, Math.min(b, x));
    const w = lo(Math.min(v[0], v[2]), aw, ae), e = lo(Math.max(v[0], v[2]), aw, ae);
    const s = lo(Math.min(v[1], v[3]), as, an), n = lo(Math.max(v[1], v[3]), as, an);
    if (e - w < MIN_SAMPLE_SPAN || n - s < MIN_SAMPLE_SPAN) return null;
    return ee.Geometry.Rectangle([w, s, e, n]);
  }

  const daysBetween = (a, b) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  // every pass in the window, tagged with its calendar day
  function datedCollection(startISO, endISO) {
    return collection(startISO, endISO, 100)
      .map((img) => img.set('day', img.date().format('YYYY-MM-dd')));
  }

  /*
   * What a composite reduces over. With an explicit day list, exactly those
   * days — the caller has already had cloud measured over its box and decided
   * which passes are usable, and re-deciding here would both cost a reduction
   * per granule on every tile and risk disagreeing with the dates the picker
   * just showed. Without one, the old metadata ceiling. Mirrors
   * composite_source() in api/main.py.
   */
  function compositeSource(startISO, endISO, maxCloud, dates) {
    if (!dates || !dates.length) return collection(startISO, endISO, maxCloud);
    return datedCollection(startISO, endISO)
      .filter(ee.Filter.inList('day', dates.slice(0, 400)));
  }

  /*
   * Per-date cloud fraction over `geom`, from the same QA60-or-band-test mask
   * the cloud overlay draws.
   *
   * Mapped over IMAGES, not over distinct dates. Listing the days and
   * mosaicking each one re-filters the whole collection once per day inside a
   * server-side map, which Earth Engine handles badly; one pass over the
   * images and a merge here is the same answer far quicker.
   *
   * `coverage` is not decoration. reduceRegion ignores masked pixels, so a
   * pass whose swath clips the corner of the box would report that corner's
   * cloud fraction — and one whose swath misses entirely reports nothing at
   * all while its granule metadata still says "0% cloud". Those are the dates
   * this whole feature exists to stop recommending, so every row carries how
   * much of the box was actually seen.
   */
  function sampledScenes(startISO, endISO, geom) {
    const stats = (img) => {
      const b = reflectance(img);
      const cloudy = bandCloud(b, CLOUD_SAMPLE_MASK).or(clearSky(img).not());
      const seen = img.select(S2_RED).mask().unmask(0).rename('seen');
      const r = cloudy.toFloat().rename('cloud').addBands(seen).reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: geom,
        scale: CLOUD_SAMPLE_SCALE,
        maxPixels: CLOUD_SAMPLE_MAX_PIXELS,
        bestEffort: true
      });
      return ee.Feature(null, {
        day: img.get('day'),
        cloud: r.get('cloud'),
        seen: r.get('seen'),
        meta: img.get('CLOUDY_PIXEL_PERCENTAGE'),
        id: img.get('system:index')
      });
    };

    return new Promise((resolve, reject) => {
      ee.FeatureCollection(datedCollection(startISO, endISO).map(stats))
        .evaluate((fc, err) => {
          if (err) return reject(err);
          /*
           * Merge a date's granules by how much of the box each saw. Their
           * footprints are near-disjoint over a box this size, so observed
           * area adds and cloud is the area-weighted mean of the parts —
           * what mosaic-then-reduce would have measured, without the
           * per-day refiltering.
           */
          const acc = {};
          (fc.features || []).forEach((f) => {
            const p = f.properties || {};
            if (!p.day) return;
            const seen = p.seen || 0;
            const a = acc[p.day] || (acc[p.day] = { seen: 0, cloudy: 0, meta: null, id: null });
            a.seen += seen;
            a.cloudy += (p.cloud || 0) * seen;
            if (p.meta !== null && p.meta !== undefined && (a.meta === null || p.meta < a.meta)) {
              a.meta = p.meta;
              a.id = p.id;
            }
            if (a.id === null) a.id = p.id;
          });
          const round2 = (v) => Math.round(v * 100) / 100;
          const out = Object.keys(acc).sort().map((day) => {
            const a = acc[day];
            return {
              date: day,
              id: a.id,
              cloud: a.meta,
              // null, not zero, when the box was never observed: no pixels
              // means no opinion, and the caller has to tell those apart
              aoiCloud: a.seen <= 0 ? null : round2(100 * a.cloudy / a.seen),
              coverage: round2(100 * Math.min(a.seen, 1))   // granule overlap must not exceed the box
            };
          });
          resolve(out);
        });
    });
  }

  // QA60: bit 10 = opaque cloud, bit 11 = cirrus. Stands in for the paper's
  // offline cloud-free compositing step.
  function clearSky(img) {
    const qa = img.select('QA60');
    return qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  }

  // TOA DN -> reflectance, the paper's 1e-4 rescale. B1-B3 ride along for the
  // turbidity and cloud-mask layers; everything downstream selects by name.
  function reflectance(img) {
    return img.select([S2_AERO, S2_BLUE, S2_GREEN, S2_RED, S2_RE6, S2_NIR, S2_SWIR])
      .divide(10000);
  }

  /*
   * Band-based cloud test: bright in the visible AND in SWIR, AND spectrally
   * flat. Turbid water and foam are bright in visible but dark at 1610 nm;
   * sand and algae are bright but coloured — both fail a gate. Thresholds are
   * live params (Models → Cloud tab in the console). QA60 is OR'd in by the
   * callers that build the visible mask, so metadata clouds the band test
   * misses (thin cirrus) are still counted.
   */
  function bandCloud(b, p) {
    const vis = b.select(S2_BLUE).add(b.select(S2_GREEN)).add(b.select(S2_RED)).divide(3);
    const dev = b.select(S2_BLUE).subtract(vis).abs()
      .add(b.select(S2_GREEN).subtract(vis).abs())
      .add(b.select(S2_RED).subtract(vis).abs());
    return vis.gte(p.cloudVisMin === undefined ? 0.18 : p.cloudVisMin)
      .and(b.select(S2_SWIR).gte(p.cloudSwirMin === undefined ? 0.10 : p.cloudSwirMin))
      .and(dev.divide(vis.max(1e-6)).lt(p.cloudWhiteness === undefined ? 0.55 : p.cloudWhiteness));
  }

  // The cloud-mask overlay doubles as a computation gate: while it is enabled
  // (opacity above zero) kelp and turbidity exclude cloud-covered pixels.
  const cloudGated = (p) => (p.cloudOpacity || 0) > 0;

  function index(b, indexType) {
    const red = b.select(S2_RED), re6 = b.select(S2_RE6),
          nir = b.select(S2_NIR), swir = b.select(S2_SWIR);

    if (indexType === 'FAI') {
      // B8 - (B4 + (B11-B4) * ((0.833-0.665)/(1.612-0.665)))
      const baseline = red.add(
        swir.subtract(red).multiply((L_NIR - L_RED) / (L_SWIR - L_RED))
      );
      return nir.subtract(baseline);
    }
    if (indexType === 'NDVI') {
      return nir.subtract(red).divide(nir.add(red));
    }
    return re6.subtract(red); // KD — the paper's Kelp Difference, Eq. (1)
  }

  /*
   * Run the filter chain on already-scaled reflectance and return BOTH the
   * classification and the index itself, so the renderer can fade by strength.
   *   kelp  — boolean, exactly the paper's 3 steps + the DEM mask
   *   index — the raw index value, for the opacity ramp only
   */
  function classify(b, p, clear) {
    const notLand = b.select(S2_SWIR).lte(p.b11Thresh);   // step 1
    const idx = index(b, p.indexType);                     // step 2
    let kelp = idx.gte(p.kelpThresh)                       // step 3
      .and(notLand)
      .and(ee.Image(DEM_ID).eq(0));                        // GEE step (c)
    if (clear) kelp = kelp.and(clear);
    return { kelp: kelp, index: idx };
  }

  // Amber canopy fallback; the live palette comes from cfg.KELP_PALETTES
  // keyed by p.kelpPalette, so the legend's colormap picker steers this too.
  const KELP_VIS = ['7a6a1f', 'd9a441', 'f2b134', 'ffd166'];
  function paletteFor(p) {
    // paletteStops is the named palette already sliced to the legend's
    // selected range (see refreshPaletteStops in app.js); fall back to the
    // whole palette, then to amber, if it has not been computed.
    if (p.paletteStops && p.paletteStops.length) return p.paletteStops;
    return (cfg.KELP_PALETTES && cfg.KELP_PALETTES[p.kelpPalette]) || KELP_VIS;
  }

  /*
   * Paint detected kelp with opacity proportional to index strength. Earth Engine
   * renders a fractional mask as partial alpha, so a 0..1 mask gives a genuine
   * per-pixel alpha channel: 0 at the detection threshold, opaque well above it.
   * Everything not classified as kelp is masked out entirely and stays fully
   * transparent, leaving the basemap visible.
   */
  function renderKelp(res, p) {
    const spec = (cfg.INDICES && cfg.INDICES[p.indexType]) || {};
    const ramp = spec.ramp || 0.02;
    const lo = p.kelpThresh, hi = p.kelpThresh + ramp;

    const strength = res.index.subtract(lo).divide(ramp).clamp(0, 1);
    // gamma < 1 lifts thin canopy just enough to read, still hitting 0 at lo
    const alpha = strength.pow(0.7).multiply(res.kelp);

    return res.index.visualize({ min: lo, max: hi, palette: paletteFor(p) })
      .updateMask(alpha);
  }

  /*
   * Water clarity: a normalized blue/green difference, glint-corrected, over
   * water only — land/foam out via the same B11 test the kelp chain uses,
   * kelp-classified pixels out (canopy reads as false extreme turbidity),
   * clouds out when `clear` is supplied. High = clear water. All knobs are
   * live params (Models → Turbidity tab in the console).
   */
  function clarityValue(b, p) {
    let b1 = b.select(S2_AERO), b2 = b.select(S2_BLUE), b3 = b.select(S2_GREEN);
    if (p.turbGlint !== false) {
      const glint = b.select(S2_NIR)
        .subtract(p.turbNirFloor === undefined ? 0.012 : p.turbNirFloor)
        .max(0).multiply(p.turbGlintGain === undefined ? 1 : p.turbGlintGain);
      b1 = b1.subtract(glint).max(0);
      b2 = b2.subtract(glint).max(0);
      b3 = b3.subtract(glint).max(0);
    }
    if (p.turbMode === 'BLUE_RATIO') return b1.subtract(b2).divide(b1.add(b2).add(1e-6));
    return b2.subtract(b3).divide(b2.add(b3).add(1e-6));   // KD490-style, 10-20 m
  }

  function renderTurbidity(b, p, clear) {
    const water = b.select(S2_SWIR).lte(p.b11Thresh).and(ee.Image(DEM_ID).eq(0));
    let mask = water.and(classify(b, p, null).kelp.not());
    if (clear) mask = mask.and(clear);
    const palette = (cfg.TURBIDITY_PALETTES || {})[p.turbidityPalette] ||
                    ['571f70', '3333ad', '1c7acc', '47d9e6'];
    return clarityValue(b, p).visualize({
      min: p.turbClarityMin === undefined ? -0.05 : p.turbClarityMin,
      max: p.turbClarityMax === undefined ? 0.35 : p.turbClarityMax,
      palette: palette
    }).updateMask(mask);
  }

  // Cloud pixels tinted by their visible brightness, so the mask keeps cloud
  // texture instead of stamping a flat block. Faint QA60-only detections sit
  // below visMin and clamp to the palette's dark end.
  function renderCloud(b, cloud, p) {
    const cm = cfg.CLOUD_MASK || {};
    const palette = (cfg.CLOUD_PALETTES || {})[p.cloudPalette] || ['566067', 'ffffff'];
    const vis = b.select(S2_BLUE).add(b.select(S2_GREEN)).add(b.select(S2_RED)).divide(3);
    return vis.visualize({
      min: p.cloudVisMin === undefined ? 0.18 : p.cloudVisMin,
      max: cm.visMax || 0.55,
      palette: palette
    }).updateMask(cloud);
  }

  function tileLayerFromImage(image, vis) {
    return new Promise((resolve, reject) => {
      image.getMapId(vis, (obj, err) => {
        if (err || !obj) return reject(err || new Error('getMapId failed'));
        resolve(obj.urlFormat); // Leaflet-ready {z}/{x}/{y} template
      });
    });
  }

  return {
    name: 'earth-engine',
    supportsCloudSample: true,   // listScenes honours a `region` box
    get available() { return ready; },
    needsLogin: false,

    /*
     * Configure, and report whether Earth Engine is ALREADY usable. This never
     * prompts.
     *
     * It used to call ee.data.authenticate() here, described as "silent auth".
     * That was true of the old gapi flow, which tried immediate mode first; the
     * current Google Identity Services client instead opens an account picker
     * (prompt=select_account) straight away. The effect was that merely opening
     * the page demanded a Google sign-in — before the visitor had asked for
     * anything, and for a map that works perfectly well without one.
     *
     * So the only thing checked here is whether a token already exists from a
     * sign-in earlier in this page session. Signing in is now exclusively the
     * job of login(), reached from the Connect button.
     */
    init(config) {
      cfg = config;
      return new Promise((resolve) => {
        if (typeof ee === 'undefined' ||
            !cfg.CLIENT_ID || cfg.CLIENT_ID.indexOf('<') === 0) {
          ready = false; return resolve(false);
        }
        let token = null;
        try { token = ee.data.getAuthToken && ee.data.getAuthToken(); } catch (e) { token = null; }
        if (!token) { ready = false; this.needsLogin = true; return resolve(false); }
        ee.initialize(
          null, null,
          () => { ready = true; resolve(true); },
          (e) => { console.warn('EE init error:', e); ready = false; resolve(false); },
          null, cfg.PROJECT_ID
        );
      });
    },

    /*
     * Interactive popup sign-in, called straight from the Connect button.
     *
     * The popup must be opened inside the click's own call stack — browsers drop
     * the user-gesture grant across an await, and the popup is then blocked
     * silently. So this stays synchronous up to authenticateViaPopup, and the
     * caller must not await anything before invoking it.
     *
     * Errors are reported rather than swallowed: an origin that isn't registered
     * on the OAuth client fails here with origin_mismatch, and a blocked popup
     * fails with nothing visible at all unless we say so.
     */
    login() {
      const self = this;
      return new Promise((resolve, reject) => {
        const fail = (e) => reject(new Error(e && e.message ? e.message : String(e)));
        const finish = () => ee.initialize(
          null, null,
          () => { ready = true; self.needsLogin = false; resolve(true); },
          (e) => reject(new Error('Earth Engine init failed: ' + (e && e.message ? e.message : e))),
          null, cfg.PROJECT_ID
        );
        try {
          /*
           * authenticate() rather than authenticateViaPopup(): it is what
           * registers the client id with the Earth Engine client. The popup
           * variant takes no client id of its own and fails with "Missing
           * required parameter client_id" if nothing configured it first —
           * which is exactly what happened once the boot-time call was removed.
           *
           * On an explicit Connect click, this opening an account picker is the
           * intended behaviour rather than an intrusion. If it declines to do so
           * silently, the popup fallback runs — still inside the click's call
           * stack, so the user-gesture grant survives.
           */
          ee.data.authenticate(cfg.CLIENT_ID, finish, fail, null, () => {
            try { ee.data.authenticateViaPopup(finish, fail); } catch (e) { fail(e); }
          });
        } catch (e) {
          fail(e);
        }
      });
    },

    // Return [{id, date:'YYYY-MM-DD', cloud:Number}] for the scrubber.
    /*
     * `region` switches this from Sentinel-2's granule-wide
     * CLOUDY_PIXEL_PERCENTAGE to cloud actually measured over that box, adding
     * aoiCloud and coverage to every row. Same contract as the shared
     * backend's /scenes, including the fallbacks: without a usable box, or for
     * a window too wide to sample in one computation, this returns the plain
     * metadata listing and the caller must treat aoiCloud as optional.
     */
    listScenes(startISO, endISO, maxCloud, region) {
      const geom = sampleGeometry(region);
      if (geom && daysBetween(startISO, endISO) <= MAX_SAMPLE_DAYS) {
        return sampledScenes(startISO, endISO, geom);
      }
      const col = collection(startISO, endISO, maxCloud);
      const feats = col.map((img) => ee.Feature(null, {
        id: img.get('system:index'),
        date: img.date().format('YYYY-MM-dd'),
        cloud: img.get('CLOUDY_PIXEL_PERCENTAGE')
      }));
      return new Promise((resolve, reject) => {
        ee.FeatureCollection(feats).evaluate((fc, err) => {
          if (err) return reject(err);
          const rows = (fc.features || []).map((f) => f.properties);
          // one entry per date, keep the clearest
          const byDate = {};
          rows.forEach((r) => {
            if (!byDate[r.date] || r.cloud < byDate[r.date].cloud) byDate[r.date] = r;
          });
          resolve(Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1));
        });
      });
    },

    // Tile-URL template for one satellite pass.
    singleSceneLayer(dateISO, p) {
      const start = dateISO;
      const end = ee.Date(dateISO).advance(1, 'day');
      const img = ee.Image(collection(start, end, 100).mosaic());
      const b = reflectance(img);
      let clear = clearSky(img);
      if (cloudGated(p)) clear = clear.and(bandCloud(b, p).not());
      const res = classify(b, p, clear);
      return tileLayerFromImage(renderKelp(res, p), {});
    },

    /*
     * Cloud-free reflectance composite over the window, filtered once.
     *
     * MEDIAN, not mean — this matches the authors' released script, and it
     * matters here. A mean drags every residual cloud edge, glint and haze into
     * the composite, and averaging a canopy that drifts with tide and current
     * between passes smears it below the KD threshold. Over a short window that
     * is enough to wipe out the detection entirely. The median throws out those
     * outliers, so thin canopy survives.
     */
    compositeLayer(startISO, endISO, maxCloud, p, dates) {
      // per-scene masking BEFORE the median: with the cloud mask enabled the
      // band test joins QA60, so cloudy observations never enter the composite
      const gated = cloudGated(p);
      const clear = compositeSource(startISO, endISO, maxCloud, dates)
        .map((img) => {
          const b = reflectance(img);
          let m = clearSky(img);
          if (gated) m = m.and(bandCloud(b, p).not());
          return b.updateMask(m);
        });
      return tileLayerFromImage(renderKelp(classify(clear.median(), p, null), p), {});
    },

    /*
     * Water-clarity overlay, following the same single/composite split as the
     * kelp layer. QA60 clouds are always excluded (same rule as kelp); the
     * band-based test joins in only while the cloud-mask overlay is enabled.
     */
    turbidityLayer(dateISO, p) {
      const end = ee.Date(dateISO).advance(1, 'day');
      const img = ee.Image(collection(dateISO, end, 100).mosaic());
      const b = reflectance(img);
      let clear = clearSky(img);
      if (cloudGated(p)) clear = clear.and(bandCloud(b, p).not());
      return tileLayerFromImage(renderTurbidity(b, p, clear), {});
    },

    turbidityCompositeLayer(startISO, endISO, maxCloud, p, dates) {
      const gated = cloudGated(p);
      const clear = compositeSource(startISO, endISO, maxCloud, dates)
        .map((img) => {
          const b = reflectance(img);
          let m = clearSky(img);
          if (gated) m = m.and(bandCloud(b, p).not());
          return b.updateMask(m);
        });
      return tileLayerFromImage(renderTurbidity(clear.median(), p, null), {});
    },

    /*
     * Cloud-mask overlay. Single scene: that pass's clouds — the band test
     * OR QA60's opaque/cirrus bits. Composite: the pixels with NO clear
     * observation anywhere in the window (what "cloud" honestly means for a
     * median composite), tinted by the median brightness.
     */
    cloudLayer(dateISO, p) {
      const end = ee.Date(dateISO).advance(1, 'day');
      const img = ee.Image(collection(dateISO, end, 100).mosaic());
      const b = reflectance(img);
      const cloud = bandCloud(b, p).or(clearSky(img).not());
      return tileLayerFromImage(renderCloud(b, cloud, p), {});
    },

    cloudCompositeLayer(startISO, endISO, maxCloud, p, dates) {
      const col = compositeSource(startISO, endISO, maxCloud, dates);
      const clearCount = col.map((img) => {
        const b = reflectance(img);
        return clearSky(img).and(bandCloud(b, p).not())
          .toInt().unmask(0).rename('clear');
      }).sum();
      // clip: outside the collection's footprints "zero clear observations"
      // is vacuously true; without it the whole world outside the swaths
      // would paint as cloud
      const never = clearCount.eq(0).clip(region());
      const med = col.map(reflectance).median();
      return tileLayerFromImage(renderCloud(med, never, p), {});
    },

    /*
     * True-color RGB (B4=red, B3=green, B2=blue), an alternative to the kelp
     * mask rather than a layer on top of it — a plain visual read of the scene.
     * Raw TOA DN is used directly (not the 1e-4 rescale reflectance() applies),
     * since visualize()'s min/max is just a display stretch either way.
     */
    trueColorLayer(dateISO) {
      const start = dateISO;
      const end = ee.Date(dateISO).advance(1, 'day');
      const img = ee.Image(collection(start, end, 100).mosaic());
      const vis = img.select(['B4', 'B3', 'B2']).visualize({ min: 0, max: 2500, gamma: 1.3 });
      return tileLayerFromImage(vis, {});
    }
  };
})();

window.KelpEngine = KelpEngine;
