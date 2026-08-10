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
  CLIENT_ID: '<your-oauth-client-id>',      // e.g. '1234-abcd.apps.googleusercontent.com'
  PROJECT_ID: '<your-cloud-project-id>',    // e.g. 'kelpspotter-jp'

  // Area of interest: Santa Barbara Channel giant-kelp coast [W, S, E, N]
  AOI: [-120.55, 34.30, -119.45, 34.55],

  // How far back the scene scrubber looks, in days
  LOOKBACK_DAYS: 60,

  // Default model parameters (all adjustable live in the console)
  DEFAULTS: {
    indexType: 'NDVI',   // 'NDVI' or 'FAI'
    kelpThresh: 0.10,    // index value above which a water pixel counts as kelp
    waterThresh: 0.10,   // NDWI cutoff separating water from land
    maxCloud: 40,        // discard scenes cloudier than this (%)
    opacity: 0.85,       // kelp layer opacity
    mode: 'single'       // 'single' scene, or 'composite' (kelp frequency over range)
  }
};
