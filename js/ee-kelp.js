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

  // QA60: bit 10 = opaque cloud, bit 11 = cirrus. Stands in for the paper's
  // offline cloud-free compositing step.
  function clearSky(img) {
    const qa = img.select('QA60');
    return qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  }

  // TOA DN -> reflectance, the paper's 1e-4 rescale.
  function reflectance(img) {
    return img.select([S2_RED, S2_RE6, S2_NIR, S2_SWIR]).divide(10000);
  }

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

  // Amber canopy. Low end is the threshold itself, where the layer is invisible.
  const KELP_VIS = ['7a6a1f', 'd9a441', 'f2b134', 'ffd166'];

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

    return res.index.visualize({ min: lo, max: hi, palette: KELP_VIS })
      .updateMask(alpha);
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
    get available() { return ready; },
    needsLogin: false,

    // Try silent auth with existing credentials. Resolves true if we end up ready.
    init(config) {
      cfg = config;
      return new Promise((resolve) => {
        if (typeof ee === 'undefined' ||
            !cfg.CLIENT_ID || cfg.CLIENT_ID.indexOf('<') === 0) {
          ready = false; return resolve(false);
        }
        const initEE = () => ee.initialize(
          null, null,
          () => { ready = true; resolve(true); },
          (e) => { console.warn('EE init error:', e); ready = false; resolve(false); },
          null, cfg.PROJECT_ID
        );
        const onImmediateFail = () => { this.needsLogin = true; ready = false; resolve(false); };
        try {
          ee.data.authenticate(cfg.CLIENT_ID, initEE,
            (e) => { console.warn('EE auth error:', e); resolve(false); },
            null, onImmediateFail);
        } catch (e) { console.warn(e); resolve(false); }
      });
    },

    // Interactive popup sign-in (called from the "Connect" button).
    login() {
      return new Promise((resolve) => {
        ee.data.authenticateViaPopup(() => ee.initialize(
          null, null,
          () => { ready = true; this.needsLogin = false; resolve(true); },
          () => resolve(false),
          null, cfg.PROJECT_ID
        ));
      });
    },

    // Return [{id, date:'YYYY-MM-DD', cloud:Number}] for the scrubber.
    listScenes(startISO, endISO, maxCloud) {
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
      const res = classify(reflectance(img), p, clearSky(img));
      return tileLayerFromImage(renderKelp(res, p), {});
    },

    /*
     * The paper's own preprocessing: a mean cloud-free reflectance composite over
     * the window, filtered once. Cloudy pixels are masked per scene before the
     * mean, so the composite is built only from clear observations.
     */
    compositeLayer(startISO, endISO, maxCloud, p) {
      const clear = collection(startISO, endISO, maxCloud)
        .map((img) => reflectance(img).updateMask(clearSky(img)));
      const mean = clear.mean();
      return tileLayerFromImage(renderKelp(classify(mean, p, null), p), {});
    }
  };
})();

window.KelpEngine = KelpEngine;
