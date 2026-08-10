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
  // Earth Engine / Google Cloud
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
   * they only mean anything against the L1C product ee-kelp.js loads. min/max
   * just bound the slider either side of the published value.
   *
   * `ramp` is not from the paper: it is how far above the threshold the index has
   * to climb before the overlay reaches full opacity, so thin canopy fades out
   * instead of painting a hard-edged block over the basemap.
   */
  INDICES: {
    KD: {
      thresh: 0.003216,    // Table 2: KD >= 0.003216 (set by max River grass value)
      min: -0.02, max: 0.05, ramp: 0.02,
      hint: 'KD = B6 − B4 (Mora-Soto et al. 2020). The paper’s own index — best kappa of the three.'
    },
    FAI: {
      thresh: 0.005352,    // Table 2: FAI >= 0.005352 (set by max Organic water value)
      min: -0.02, max: 0.05, ramp: 0.02,
      hint: 'FAI: floating-algae index, tolerant of sun glint.'
    },
    NDVI: {
      thresh: -0.0003411,  // as published in the authors' GEE script (see README caveat)
      min: -0.05, max: 0.30, ramp: 0.15,
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
  BATHYMETRY: {
    url: 'https://gis.ngdc.noaa.gov/arcgis/services/DEM_mosaics/DEM_global_mosaic/ImageServer/WMSServer',
    layers: 'DEM_global_mosaic:ColorHillshade',
    opacity: 0.65,
    attribution: 'Depth: NOAA NCEI DEM global mosaic'
  },

  // Default model parameters (all adjustable live in the console)
  DEFAULTS: {
    indexType: 'KD',        // 'KD', 'FAI' or 'NDVI'
    kelpThresh: 0.003216,   // index value at/above which a pixel counts as kelp
    b11Thresh: 0.028,       // paper step 1: mask out B11 >= 0.028 (coast + land vegetation)
    maxCloud: 40,           // discard scenes cloudier than this (%)
    opacity: 0.85,          // kelp layer opacity
    mode: 'single',         // 'single' scene, or 'composite' (mean composite over the range)
    showBathymetry: false   // NOAA depth overlay, off until asked for
  }
};
