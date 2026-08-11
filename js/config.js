/*
 * KelpSpotter configuration
 * -------------------------
 * Fill these in to connect live Sentinel-2 imagery from Google Earth Engine.
 * Until you do, the site runs in DEMO mode with synthetic kelp so you can see
 * how everything behaves.
 *
 * How to get these two values (one-time setup, free for personal use):
 *   1. Create / pick a Google Cloud project and enable the Earth Engine API.
 *   2. Register that project for Earth Engine (noncommercial) at
 *      https://code.earthengine.google.com  (accept the verification questionnaire).
 *   3. In the Cloud Console -> APIs & Services -> Credentials, create an
 *      "OAuth 2.0 Client ID" of type "Web application". Add the origin you'll
 *      serve this page from (e.g. http://localhost:8000) to the Authorized
 *      JavaScript origins. Copy the client ID string below.
 *
 * Leave CLIENT_ID as the placeholder to stay in demo mode.
 */
window.KELP_CONFIG = {
  /*
   * Public kelp backend (api/main.py on Cloud Run). When this answers, visitors
   * get live imagery with NO sign-in: the service holds the Earth Engine
   * credential and returns tile URLs. Leave as the placeholder to fall back to
   * per-user OAuth, then demo mode.
   *   e.g. 'https://kelpspotter-api-abc123-uw.a.run.app'
   */
  /*
   * Optional import proxy (proxy/worker.js on Cloudflare Workers). Google's KML
   * endpoints send no CORS headers, so share links can only be fetched through
   * a relay. Leave as the placeholder to disable share-link import — the file
   * importer is unaffected either way.
   */
  PROXY_URL: 'https://kelpspotter-proxy.pagett-jared.workers.dev',

  API_URL: 'https://kelpspotter-api-mjhkueccia-uw.a.run.app',

  // Earth Engine / Google Cloud (only used when API_URL is not reachable)
  CLIENT_ID: '651837907269-341ri4qffbcl6pqq5su2144dlno4smq5.apps.googleusercontent.com',      // e.g. '1234-abcd.apps.googleusercontent.com'
  PROJECT_ID: 'kelpscape',    // e.g. 'kelpspotter-jp'

  // Area of interest: Santa Barbara Channel giant-kelp coast [W, S, E, N]
  AOI: [-120.55, 34.30, -119.45, 34.55],

  // How far back the scene scrubber looks, in days
  LOOKBACK_DAYS: 60,

  /*
   * Detection indices and their published masking thresholds, from
   *   Mora-Soto et al. (2020), "A High-Resolution Global Map of Giant Kelp
   *   (Macrocystis pyrifera) Forests and Intertidal Green Algae (Ulvophyceae)
   *   with Sentinel-2 Imagery", Remote Sensing 12(4), 694.
   *   doi:10.3390/rs12040694  ·  code: github.com/BiogeoscienceslabOxford/kelp_forests
   *
   * `thresh` is the paper's Table 2 masking threshold (a pixel is kelp when the
   * index is >= this). They are calibrated on TOA reflectance scaled to 0..1, so
   * they only mean anything against the L1C product ee-kelp.js loads.
   *
   * min/max bound the slider. KD and FAI floor at 0 on purpose: both are defined
   * as one band exceeding another (red edge over red; NIR over the red-SWIR
   * baseline), so a negative cutoff would admit pixels that are not vegetation at
   * all. NDVI is the exception and keeps a small negative floor, because its
   * published threshold is itself just below zero — over water in TOA reflectance,
   * path radiance lifts the red band while NIR is nearly black, putting kelp
   * pixels right at the NDVI zero crossing.
   *
   * `ramp` is not from the paper: it is how far above the threshold the index has
   * to climb before the overlay reaches full opacity, so thin canopy fades out
   * instead of painting a hard-edged block over the basemap.
   */
  INDICES: {
    KD: {
      thresh: 0.003216,    // Table 2: KD >= 0.003216 (set by max River grass value)
      min: 0, max: 0.05, ramp: 0.02,
      hint: 'KD (Kelp Difference) = B6 − B4. The paper’s own index, best kappa of the three. ' +
            'Mora-Soto et al. (2020), Remote Sens. 12(4), 694. doi:10.3390/rs12040694'
    },
    FAI: {
      thresh: 0.005352,    // Table 2: FAI >= 0.005352 (set by max Organic water value)
      min: 0, max: 0.05, ramp: 0.02,
      hint: 'FAI: floating-algae index, tolerant of sun glint.'
    },
    NDVI: {
      thresh: -0.0003411,  // as published in the authors' GEE script (see README caveat)
      min: -0.01, max: 0.30, ramp: 0.15,   // negative floor: the published value is below zero
      hint: 'NDVI: canopy vs. dark water. Simple and robust.'
    }
  },

  /*
   * NOAA NCEI DEM global mosaic — public, no API key, and its ArcGIS ImageServer
   * exposes a WMS endpoint that serves EPSG:3857 directly, so Leaflet's built-in
   * L.tileLayer.wms can consume it with no extra dependency. ColorHillshade is
   * the shaded depth/relief rendering. (NCEI's higher-resolution Coastal Relief
   * Model was the first choice but returns blank tiles below ~2° extent.)
   */
  DEPTH: {
    // Shaded relief from the elevation/bathymetry mosaic.
    relief: {
      url: 'https://gis.ngdc.noaa.gov/arcgis/services/DEM_mosaics/DEM_global_mosaic/ImageServer/WMSServer',
      layers: 'DEM_global_mosaic:ColorHillshade',
      attribution: 'Depth: NOAA NCEI DEM global mosaic'
    },
    /*
     * Charted depth contours from NOAA's ENC (Electronic Navigational Chart)
     * coastal service. WMS layer 95 is Coastal.Depth_Contour_line — note the WMS
     * numbering is NOT the same as the REST layer ids (there it is layer 82).
     * The service draws black lines on transparent, which are invisible on this
     * basemap, so the pane is inverted to white in CSS.
     */
    contours: {
      url: 'https://gis.charttools.noaa.gov/arcgis/services/encdirect/enc_coastal/MapServer/WMSServer',
      layers: '95',
      attribution: 'Contours: NOAA ENC'
    },
    /*
     * Point lookup for the cursor readout. The same ImageServer exposes an
     * `identify` endpoint returning the raw pixel value (elevation in metres,
     * negative below sea level), and it sends Access-Control-Allow-Origin: *, so
     * the browser can query it directly with no proxy.
     */
    probe: {
      url: 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer',
      // don't re-read until the cursor has travelled this far, in screen pixels
      minMovePx: 5
    },

    /*
     * NOAA sends `cache-control: private` with no max-age, ETag or Last-Modified,
     * so browsers have no freshness signal and re-request aggressively. These
     * cut the number of requests rather than trying to cache harder: 512 px tiles
     * mean a quarter as many, and holding off until the map settles avoids firing
     * requests for tiles that scroll past. keepBuffer retains offscreen tiles so
     * panning back is free.
     */
    tuning: { tileSize: 512, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 4 }
  },

  /*
   * Colormaps for the kelp overlay, dark-to-bright with increasing canopy
   * density. Shared by all three engines (ee-kelp.js visualize palette,
   * api/main.py mirror, demo.js canvas interpolation) and the legend ramp,
   * so adding one here is enough — except main.py, which must mirror the
   * entries server-side (it cannot read this file).
   */
  KELP_PALETTES: {
    amber:   ['7a6a1f', 'd9a441', 'f2b134', 'ffd166'],   // the original signature look
    viridis: ['440154', '31688e', '35b779', 'fde725'],
    inferno: ['1b0c41', '781c6d', 'ed6925', 'fcffa4'],
    ice:     ['0d3b66', '3fa7d6', '90e0ef', 'caf0f8']
  },

  /*
   * Common cylinders, as rated volume at rated fill pressure. Picking one
   * fills in a gas source's numbers; they stay editable afterwards, since
   * actual fills and cylinder vintages vary (LP steels in particular are
   * routinely filled past their 2400 psi rating).
   */
  CYLINDERS: [
    { name: 'AL80',         totalCuft: 77.4, startPsi: 3000 },
    { name: 'HP80',         totalCuft: 80,   startPsi: 3442 },
    { name: 'LP85',         totalCuft: 85,   startPsi: 2400 },
    { name: 'HP100',        totalCuft: 100,  startPsi: 3442 },
    { name: 'HP100 doubles', totalCuft: 200, startPsi: 3442 },
    { name: 'LP85 doubles',  totalCuft: 170, startPsi: 2400 }
  ],

  // Default model parameters (all adjustable live in the console)
  DEFAULTS: {
    indexType: 'KD',        // 'KD', 'FAI' or 'NDVI'
    kelpThresh: 0.003216,   // index value at/above which a pixel counts as kelp
    b11Thresh: 0.028,       // paper step 1: mask out B11 >= 0.028 (coast + land vegetation)
    maxCloud: 40,           // discard scenes cloudier than this (%)
    opacity: 0.85,          // kelp layer opacity
    kelpPalette: 'amber',   // key into KELP_PALETTES above
    // sub-range of that palette actually used, 0..1 from its dark end to its
    // bright end — the legend's vertical bar drags these
    paletteMin: 0,
    paletteMax: 1,
    dockWidth: 360,         // width of the docked paths panel, in px
    // stacking order of the map overlays, bottom to top; dragged in the
    // bottom-right overlay picker and applied as pane z-indexes
    overlayOrder: ['truecolor', 'depth', 'kelp'],
    mode: 'composite',      // 'single' scene, or 'composite' (median composite over the range)
    distUnit: 'mi',         // path profile x-axis: 'ft' | 'mi' | 'm' | 'km'
    depthUnit: 'ft',        // path profile y-axis: 'ft' | 'm'
    sacUnit: 'cuft/min',    // gas planning: 'cuft/min' | 'L/min'
    speedUnit: 'mi/hr',     // gas planning: 'mi/hr' | 'm/s' | 'kts' | 'km/hr'
    /*
     * Gas planning applies to every path at once (one console, not one per
     * path). timeMode picks which of time/speed is the input the diver typed
     * in; the other is always derived from it plus each path's own length.
     */
    sac: 0.6,               // cuft/min
    speed: 0.5,             // mi/hr — used when timeMode is 'speed'
    time: 30,               // minutes — used when timeMode is 'time'
    timeMode: 'speed',      // 'speed' | 'time'
    showGas: true,
    kickDistance: 0,        // metres per kick cycle; 0 = omit kicks from the leg table
    kickUnit: 'ft',         // how that number is typed/shown: 'm' | 'ft'
    /*
     * Magnetic declination in degrees, EAST positive. Leg-table headings are
     * corrected by this so they can be steered directly on a compass:
     * magnetic = true - declination. Roughly +11.5 deg in the Santa Barbara
     * Channel; it drifts slowly, so it is a setting rather than a constant.
     */
    declination: 11.5,
    /*
     * Gas sources. Each is a cylinder the diver carries; legs in the leg
     * table are assigned to one of them, and a source is "over budget" once
     * the legs drawing on it exceed (totalCuft - reserve). Reserve can be
     * expressed as a volume, as a pressure, or both — whichever boxes are
     * ticked; with both, the LARGER reserve wins, since that is the
     * conservative reading of two stated minimums.
     */
    cylinders: [
      { id: 1, name: 'AL80', totalCuft: 77.4, startPsi: 3000,
        useReserveCuft: false, reserveCuft: 15,
        useReservePsi: true, reservePsi: 500 }
    ],
    pressureUnit: 'psi',    // 'psi' | 'bar'
    showRelief: true,       // NOAA shaded-relief depth overlay
    showContours: true,     // NOAA ENC charted depth contours
    depthOpacity: 0.45,     // kept well under 1 so the kelp layer still reads over it
    // The real view is the default: true colour is on at load, and the kelp
    // overlay rides on top of it independently.
    trueColorOpacity: 0.85  // Sentinel-2 B4/B3/B2 RGB read
                            // (auto-zeroed in demo mode, which has no real imagery)
  }
};
