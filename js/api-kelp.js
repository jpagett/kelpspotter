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

    // No sign-in exists for this engine; present for interface parity.
    login() { return Promise.resolve(ready); },

    listScenes(startISO, endISO) {
      return getJSON('/scenes', {
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: 100                      // filtering happens client-side
      });
    },

    singleSceneLayer(dateISO, p) {
      return getJSON('/layer', {
        mode: 'single',
        date: dateISO,
        index: p.indexType,
        kelpThresh: p.kelpThresh,
        b11Thresh: p.b11Thresh,
        palette: p.kelpPalette,
        stops: (p.paletteStops || []).join(',')
      }).then((r) => r.urlFormat);
    },

    compositeLayer(startISO, endISO, maxCloud, p) {
      return getJSON('/layer', {
        mode: 'composite',
        start: startISO.slice(0, 10),
        end: endISO.slice(0, 10),
        maxCloud: maxCloud,
        index: p.indexType,
        kelpThresh: p.kelpThresh,
        b11Thresh: p.b11Thresh,
        palette: p.kelpPalette,
        stops: (p.paletteStops || []).join(',')
      }).then((r) => r.urlFormat);
    },

    trueColorLayer(dateISO) {
      return getJSON('/layer', { mode: 'truecolor', date: dateISO }).then((r) => r.urlFormat);
    }
  };
})();

window.ApiKelpEngine = ApiKelpEngine;
