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
     * NOAA's GetCapabilities lists exactly two colored renderers — ColorHillshade
     * (blue) and ColorHillshade2 (slate); a third, "None", is a flat mid-grey and
     * useless. To offer more than two depth colormaps without more NOAA layers,
     * the extra styles reuse one of those two base renders and recolour it with a
     * CSS `filter` applied to the depth tile images (the same per-image filter
     * trick the ENC contour pane already uses — see styles.css). `layers` picks
     * the NOAA render, `filter` is the recolour (empty = the raw NOAA colours),
     * and `swatch` is a 2-stop approximation of the BASE render, sampled from real
     * tile output; the picker applies the same `filter` to the swatch so it always
     * matches the map. Deep end first (dark), shallow end last (bright).
     */
    reliefStyles: {
      blue:    { layers: 'DEM_global_mosaic:ColorHillshade',  label: 'Blue',    filter: '',
                 swatch: ['0c253d', '4f83b2'] },
      slate:   { layers: 'DEM_global_mosaic:ColorHillshade2', label: 'Slate',   filter: '',
                 swatch: ['08233e', '407cad'] },
      teal:    { layers: 'DEM_global_mosaic:ColorHillshade',  label: 'Teal',
                 filter: 'hue-rotate(-28deg) saturate(1.4)',                 swatch: ['0c253d', '4f83b2'] },
      viridis: { layers: 'DEM_global_mosaic:ColorHillshade',  label: 'Viridis',
                 filter: 'hue-rotate(-95deg) saturate(1.5) brightness(1.05)', swatch: ['0c253d', '4f83b2'] },
      amber:   { layers: 'DEM_global_mosaic:ColorHillshade',  label: 'Amber',
                 filter: 'sepia(1) saturate(2.6) hue-rotate(-12deg) brightness(1.08)', swatch: ['0c253d', '4f83b2'] },
      mono:    { layers: 'DEM_global_mosaic:ColorHillshade',  label: 'Mono',
                 filter: 'grayscale(1) contrast(1.08) brightness(1.12)',      swatch: ['0c253d', '4f83b2'] }
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
    // green->orange, from the "kelp + water clarity" evalscript's KELP_STOPS
    // ([0.13,0.42,0.16] .. [0.98,0.40,0.08] scaled to 8-bit hex) — the default
    canopy:    ['216b29', '5cb833', 'edd633', 'fa6614'],
    amber:     ['7a6a1f', 'd9a441', 'f2b134', 'ffd166'],   // the original signature look
    viridis:   ['440154', '31688e', '35b779', 'fde725'],
    inferno:   ['1b0c41', '781c6d', 'ed6925', 'fcffa4'],
    magma:     ['000004', '51127c', 'b73779', 'fcfdbf'],
    plasma:    ['0d0887', '9c179e', 'ed7953', 'f0f921'],
    thermal:   ['042333', '7c1d6f', 'e35933', 'e8fa5b'],
    ice:       ['0d3b66', '3fa7d6', '90e0ef', 'caf0f8'],
    grayscale: ['111111', '555555', 'aaaaaa', 'f4f4f4']
  },

  // turbid -> clear, dark to bright; 'clarity' is the evalscript's WATER_STOPS
  TURBIDITY_PALETTES: {
    clarity:   ['571f70', '3333ad', '1c7acc', '47d9e6'],
    abyss:     ['0b1b3d', '23509c', '3f9bc4', '9fe6ee'],
    sediment:  ['5e3a17', 'a97b33', '58aebf', 'c9eef2'],
    grayscale: ['1a1a1a', '595959', '9e9e9e', 'e8e8e8']
  },

  // Cloud-mask display constant (not a detection parameter, so it is not in
  // DEFAULTS with the tunable thresholds below): the visible brightness where
  // the cloud tint's ramp saturates.
  CLOUD_MASK: {
    visMax: 0.55
  },
  // the mask is drawn ramped by cloud brightness (texture, not a flat stamp)
  CLOUD_PALETTES: {
    gray:   ['566067', 'ffffff'],
    storm:  ['232f36', '93aab8'],
    violet: ['58184a', 'f2a1dd'],
    sand:   ['4a3d20', 'f2e3b5']
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
    kelpPalette: 'canopy',  // key into KELP_PALETTES above
    // sub-range of that palette actually used, 0..1 from its dark end to its
    // bright end — the legend's vertical bar drags these
    paletteMin: 0,
    paletteMax: 1,
    /*
     * Turbidity and cloud-mask overlays, off by default. cloudOpacity doubles
     * as the "cloud mask enabled" switch: while it is above zero the kelp and
     * turbidity computations also EXCLUDE cloud-covered pixels (per scene,
     * before the median in composite mode) — see the engines.
     */
    turbidityOpacity: 0,
    cloudOpacity: 0,
    turbidityPalette: 'clarity',  // key into TURBIDITY_PALETTES above
    cloudPalette: 'gray',         // key into CLOUD_PALETTES above
    /*
     * Cloud-mask detection, adapted from the kelp + water clarity Sentinel Hub
     * evalscript and tuned live from the console's Models → Cloud tab. Clouds
     * are bright in BOTH the visible and SWIR; turbid water and foam are
     * bright in visible but stay dark at 1610 nm, which is what separates
     * them. No SCL (that classification is L2A-only and this app loads L1C);
     * QA60's opaque/cirrus bits are OR'd in instead, and cloud SHADOW has no
     * L1C detector — a known gap. Server-side defaults mirrored in api/main.py.
     */
    cloudVisMin: 0.18,      // mean(B2,B3,B4) at/above this = candidate
                            //   (script, L2A: 0.14 — path radiance lifts TOA visible)
    cloudSwirMin: 0.10,     // AND B11 at/above this = cloud (B11 barely sees atmosphere)
    cloudWhiteness: 0.55,   // spectral flatness gate, 0 = perfectly white;
                            //   raise to loosen, lower to tighten
    /*
     * Water-clarity ("turbidity") model, same evalscript, tuned from the
     * Models → Turbidity tab. A normalized blue/green difference over open
     * water: high = clear, low = turbid. CAVEAT: the evalscript targets L2A
     * surface reflectance; this app computes on L1C TOA (the kelp thresholds
     * demand it — see js/ee-kelp.js). Path radiance lifts the TOA blue/green
     * bands and shifts the ratio, so the display range and NIR floor are
     * TOA-seeded rather than the script's published L2A numbers.
     */
    turbMode: 'KD490',      // 'KD490' (B2/B3, 10-20 m) | 'BLUE_RATIO' (B1/B2, 60 m, CDOM-sensitive)
    turbClarityMin: -0.05,  // rendered as most turbid   (script, L2A: -0.25)
    turbClarityMax: 0.35,   // rendered as clearest      (script, L2A:  0.40)
    // Glint is near-flat spectrally, so it cancels in the kelp KD difference
    // but not in a ratio — subtract a B8-derived estimate from the clarity
    // bands first. KD needs no correction.
    turbGlint: true,
    turbNirFloor: 0.012,    // B8 of the darkest clean water (script, L2A: 0.004)
    turbGlintGain: 1.0,
    dockWidth: 360,         // width of the docked paths panel, in px
    /*
     * The right dock's arrangement (desktop): 'paths' or 'poi' shows one pane,
     * 'split' stacks paths above POI. dockSplit is the fraction of the dock's
     * height the paths pane keeps in split mode; the seam is draggable.
     */
    dockView: 'paths',
    dockSplit: 0.55,
    // stacking order of the map overlays, bottom to top; dragged in the
    // bottom-right overlay picker and applied as pane z-indexes
    overlayOrder: ['truecolor', 'depth', 'turbidity', 'kelp', 'clouds'],
    mode: 'composite',      // 'single' scene, or 'composite' (median composite over the range)
    /*
     * Text scale, as multipliers on the drawn sizes — 1 is exactly what the
     * design was drawn at. fsPlot is a second multiplier on the depth-profile
     * labels alone: small mono digits read at arm's length on a boat are the
     * text that actually needs to grow, and inflating every panel to match
     * would cost more room than it is worth.
     */
    fsUi: 1,
    fsPlot: 1,
    /*
     * Where cloud cover is measured when picking dates.
     *
     * Sentinel-2's own CLOUDY_PIXEL_PERCENTAGE covers a whole ~110km granule,
     * and this AOI spans three of them — so it routinely calls a date cloudy
     * because of weather over the mountains while the channel is clear. This
     * box is the water you actually care about; the backend runs the same
     * cloud mask the overlay draws and averages it over here instead.
     *
     * Defaults to the central channel rather than the whole AOI: the AOI's
     * corners are open ocean and back-country, and neither should get a vote
     * on whether a dive day looks clear. Draggable — see the calendar.
     */
    cloudSample: { w: -120.35, s: 34.38, e: -119.60, n: 34.50 },
    useAoiCloud: true,      // false falls back to the granule metadata figure
    /*
     * A pass that clips the corner of the sample box would report the cloud
     * fraction of that corner alone, so a sliver of clear sky could read as a
     * perfect day. Dates observing less than this much of the box are treated
     * as unusable rather than as clear.
     */
    minCoverage: 60,        // percent of the sample box that must be observed
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
    depthStyle: 'blue',      // key into DEPTH.reliefStyles
    depthOpacity: 0.45,     // kept well under 1 so the kelp layer still reads over it
    // The real view is the default: true colour is on at load, and the kelp
    // overlay rides on top of it independently.
    trueColorOpacity: 0.85  // Sentinel-2 B4/B3/B2 RGB read
                            // (auto-zeroed in demo mode, which has no real imagery)
  }
};
