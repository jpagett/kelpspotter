/*
 * ApiKelpEngine — kelp imagery without a Google sign-in.
 *
 * Implements the same four methods as KelpEngine and DemoEngine (init,
 * listScenes, singleSceneLayer, compositeLayer), so app.js treats all three
 * identically. The difference is where the work happens: a Cloud Run service
 * (see api/main.py) authenticates as a service account, runs the identical
 * detection, and returns a tile-URL template. The browser then pulls tiles
 * straight from Google's tile servers, so this module only ever exchanges small
 * JSON payloads.
 *
 * Nothing secret reaches the page: the API URL is public, and the credential
 * that does the computing never leaves the server.
 *
 * Minted map ids are ephemeral. The service caches and re-mints them, and
 * app.js re-requests a layer if its tiles start failing, so an expired id
 * self-heals on the next interaction rather than needing a reload.
 */
const ApiKelpEngine = (function () {
  let cfg = null;
  let base = null;
  let ready = false;

  function url(path, params) {
    const u = new URL(base.replace(/\/+$/, '') + path);
    Object.keys(params || {}).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
    });
    return u.toString();
  }

  async function getJSON(path, params) {
    const res = await fetch(url(path, params), { mode: 'cors' });
    if (!res.ok) {
      let detail = res.status;
      try { detail = (await res.json()).error || detail; } catch (e) { /* not json */ }
      throw new Error('API ' + detail);
    }
    return res.json();
  }

  /*
   * Query-param bundles, one per model. The kelp trio (index/thresholds) rides
   * with turbidity too: the server excludes kelp-classified pixels from the
   * clarity render, so it needs the same numbers the kelp layer was drawn
   * with, or the two would disagree about where the canopy ends.
   */
  function kelpArgs(p) {
    return {
      index: p.indexType,
      kelpThresh: p.kelpThresh,
      b11Thresh: p.b11Thresh
    };
  }
  // cloud thresholds travel whenever they can matter: on the cloud layer
  // itself, and on kelp/turbidity while the mask is gating them
  function cloudArgs(p) {
    return {
      cloudVisMin: p.cloudVisMin,
      cloudSwirMin: p.cloudSwirMin,
      cloudWhiteness: p.cloudWhiteness
    };
  }
  /*
   * The backend caps an explicit day list at 400 and falls back to its cloud
   * ceiling without one, so an over-long list would be silently truncated into
   * a composite nobody asked for. Better to send nothing and get the ceiling.
   */
  const MAX_DATES = 400;
  function dateList(dates) {
    if (!dates || !dates.length || dates.length > MAX_DATES) return undefined;
    return dates.join(',');
  }
  function gateArgs(p) {
    const on = (p.cloudOpacity || 0) > 0;
    return on ? Object.assign({ cloudMask: 1 }, cloudArgs(p)) : { cloudMask: 0 };
  }
  function turbArgs(p) {
    return Object.assign({
      turbMode: p.turbMode,
      turbClarityMin: p.turbClarityMin,
      turbClarityMax: p.turbClarityMax,
      turbGlint: p.turbGlint === false ? 0 : 1,
      turbNirFloor: p.turbNirFloor,
      turbGlintGain: p.turbGlintGain,
      tstops: ((cfg.TURBIDITY_PALETTES || {})[p.turbidityPalette] || []).join(',')
    }, kelpArgs(p), gateArgs(p));
  }

  return {
    name: 'api',
    get available() { return ready; },
    needsLogin: false,

    /*
     * Resolves true only if the service answers /health, so a missing or broken
     * backend falls through to the next engine rather than leaving a dead map.
     */
    init(config) {
      cfg = config;
      base = cfg.API_URL || '';
      if (!base || base.indexOf('<') === 0) { ready = false; return Promise.resolve(false); }
      return fetch(base.replace(/\/+$/, '') + '/health', { mode: 'cors' })
        .then((r) => r.ok)
        .then((ok) => { ready = ok; return ok; })
        .catch(() => { ready = false; return false; });
    },

    // Trust a previously-healthy backend without re-probing — the boot memo's
    // fast path. A wrong guess self-corrects on the first failed call.
    assumeReady(config) {
      cfg = config;
      base = cfg.API_URL || '';
      ready = !!base && base.indexOf('<') !== 0;
    },

    // No sign-in exists for this engine; present for interface parity.
    login() { return Promise.resolve(ready); },

    /*
     * `region` asks the backend to measure cloud over that box with the same
     * mask the cloud overlay draws, instead of reporting Sentinel-2's
     * granule-wide CLOUDY_PIXEL_PERCENTAGE. Rows come back with aoiCloud and
     * coverage alongside the metadata number. Omitting it keeps the old cheap
     * metadata-only listing, which is also what happens for windows too wide
     * to sample — so callers must treat aoiCloud as optional, never assumed.
     */
    listScenes(startISO, endISO, maxCloud, region) {
      return getJSON('/scenes', {
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: 100,                     // filtering happens client-side
        region: region || undefined
      });
    },

    singleSceneLayer(dateISO, p) {
      return getJSON('/layer', Object.assign({
        mode: 'single',
        date: dateISO,
        palette: p.kelpPalette,
        stops: (p.paletteStops || []).join(',')
      }, kelpArgs(p), gateArgs(p))).then((r) => r.urlFormat);
    },

    /*
     * `dates` names exactly which passes the median is built from, replacing
     * the server's CLOUDY_PIXEL_PERCENTAGE ceiling. The client has already had
     * cloud measured over its sample box and decided which days are usable, so
     * this keeps the composite honest — it reduces over the same days the date
     * picker showed as clear — and it is the whole speed story: composite tile
     * cost tracks scene count hard (76 scenes 2.4s/tile, 141 scenes 9.3s).
     * Omitted when the caller has no opinion, which restores the old ceiling.
     */
    compositeLayer(startISO, endISO, maxCloud, p, dates) {
      return getJSON('/layer', Object.assign({
        mode: 'composite',
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: maxCloud,
        dates: dateList(dates),
        palette: p.kelpPalette,
        stops: (p.paletteStops || []).join(',')
      }, kelpArgs(p), gateArgs(p))).then((r) => r.urlFormat);
    },

    trueColorLayer(dateISO) {
      return getJSON('/layer', { mode: 'truecolor', date: dateISO }).then((r) => r.urlFormat);
    },

    turbidityLayer(dateISO, p) {
      return getJSON('/layer', Object.assign({
        mode: 'turbidity',
        date: dateISO
      }, turbArgs(p))).then((r) => r.urlFormat);
    },

    turbidityCompositeLayer(startISO, endISO, maxCloud, p, dates) {
      return getJSON('/layer', Object.assign({
        mode: 'turbidityComposite',
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: maxCloud,
        dates: dateList(dates)
      }, turbArgs(p))).then((r) => r.urlFormat);
    },

    cloudLayer(dateISO, p) {
      return getJSON('/layer', Object.assign({
        mode: 'cloud',
        date: dateISO,
        cstops: ((cfg.CLOUD_PALETTES || {})[p.cloudPalette] || []).join(',')
      }, cloudArgs(p))).then((r) => r.urlFormat);
    },

    cloudCompositeLayer(startISO, endISO, maxCloud, p, dates) {
      return getJSON('/layer', Object.assign({
        mode: 'cloudComposite',
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: maxCloud,
        dates: dateList(dates),
        cstops: ((cfg.CLOUD_PALETTES || {})[p.cloudPalette] || []).join(',')
      }, cloudArgs(p))).then((r) => r.urlFormat);
    }
  };
})();

window.ApiKelpEngine = ApiKelpEngine;
