/*
 * KelpEngine — the real Sentinel-2 -> kelp-index pipeline, running on Google
 * Earth Engine's servers. Everything here mirrors the interface of DemoEngine
 * (js/demo.js) so app.js can treat them interchangeably.
 *
 * Sensor:  COPERNICUS/S2_SR_HARMONIZED (surface reflectance, 10 m)
 * Masking: Scene Classification Layer (SCL) removes cloud / shadow / cirrus;
 *          NDWI keeps water so we only look for kelp on the sea surface.
 * Index:   NDVI = (NIR - Red)/(NIR + Red)         — simple, robust for canopy
 *          FAI  = NIR - baseline(Red, SWIR)        — glint-tolerant floating-algae index
 */
const KelpEngine = (function () {
  const S2_RED = 'B4', S2_NIR = 'B8', S2_SWIR = 'B11', S2_GREEN = 'B3';
  const L_RED = 665, L_NIR = 842, L_SWIR = 1610; // Sentinel-2 band centers (nm), for FAI baseline

  let cfg = null;
  let ready = false;

  function region() {
    const [w, s, e, n] = cfg.AOI;
    return ee.Geometry.Rectangle([w, s, e, n]);
  }

  function collection(startISO, endISO, maxCloud) {
    return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region())
      .filterDate(startISO, endISO)
      .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', maxCloud));
  }

  // Turn one raw S2 image into a masked kelp mask (1 = kelp, else masked out).
  function kelpMask(img, p) {
    const scl = img.select('SCL');
    const clear = scl.neq(3)   // cloud shadow
      .and(scl.neq(8))         // cloud, medium prob
      .and(scl.neq(9))         // cloud, high prob
      .and(scl.neq(10));       // thin cirrus

    const b = img.select([S2_GREEN, S2_RED, S2_NIR, S2_SWIR]).divide(10000);
    const green = b.select(S2_GREEN), red = b.select(S2_RED),
          nir = b.select(S2_NIR), swir = b.select(S2_SWIR);

    // NDWI > threshold marks water; kelp must sit on water, not land.
    const ndwi = green.subtract(nir).divide(green.add(nir));
    const water = ndwi.gt(p.waterThresh);

    let index;
    if (p.indexType === 'FAI') {
      const baseline = red.add(
        swir.subtract(red).multiply((L_NIR - L_RED) / (L_SWIR - L_RED))
      );
      index = nir.subtract(baseline);
    } else {
      index = nir.subtract(red).divide(nir.add(red)); // NDVI
    }

    return index.gt(p.kelpThresh).and(water).and(clear)
      .selfMask().rename('kelp')
      .set('system:time_start', img.get('system:time_start'));
  }

  // Amber-on-teal palette matching the site.
  const SINGLE_VIS = { min: 0, max: 1, palette: ['f2b134'] };
  const FREQ_VIS = { min: 0, max: 1, palette: ['0a2830', '7a6a1f', 'd9a441', 'f2b134', 'ffd166'] };

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

    // Tile-URL template for a single scene's kelp mask.
    singleSceneLayer(dateISO, p) {
      const start = dateISO;
      const end = ee.Date(dateISO).advance(1, 'day');
      const col = collection(start, end, 100);
      const masked = kelpMask(ee.Image(col.mosaic()), p);
      return tileLayerFromImage(masked.visualize(SINGLE_VIS), {});
    },

    // Kelp *frequency* (0..1) across every clear scene in the window.
    compositeLayer(startISO, endISO, maxCloud, p) {
      const col = collection(startISO, endISO, maxCloud);
      const masks = col.map((img) => kelpMask(img, p).unmask(0));
      const freq = masks.mean().updateMask(masks.count().gt(0));
      return tileLayerFromImage(freq.visualize(FREQ_VIS), {});
    }
  };
})();

window.KelpEngine = KelpEngine;
