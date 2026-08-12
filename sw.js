/*
 * KelpSpotter service worker.
 *
 * Two caches, two reasons:
 *
 *   SHELL — the app itself (HTML, CSS, JS, vendored Leaflet). Served
 *   stale-while-revalidate: a repeat visit paints from cache immediately while
 *   the network quietly refreshes it, and with no network at all the whole app
 *   still opens. For a tool used on boats, offline is a feature, not an edge
 *   case. SWR also self-heals staleness after a deploy: the first load after a
 *   push may be one version behind, the next is current.
 *
 *   NOAA — relief and contour tiles. NOAA sends cache-control:private with no
 *   freshness signal, so the browser re-downloads every tile every visit;
 *   bathymetry does not change week to week.
 *
 * Never cached: Earth Engine tile URLs (ephemeral by design), the Cloud Run
 * API (its answers change with the archive), Google auth, fonts (Google's CDN
 * handles those with proper headers).
 */
const SHELL = 'kelp-shell-v1';
const NOAA = 'kelp-noaa-v1';
const NOAA_HOSTS = ['gis.ngdc.noaa.gov', 'gis.charttools.noaa.gov'];
const NOAA_MAX = 400;

const SHELL_ASSETS = [
  './', 'index.html', 'manifest.json', 'favicon.svg',
  'css/styles.css',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'js/config.js', 'js/wmm.js', 'js/dem.js', 'js/contours.js', 'js/paths.js',
  'js/poi.js', 'js/session.js', 'js/session-ui.js', 'js/api-kelp.js',
  'js/ee-kelp.js', 'js/demo.js', 'js/app.js', 'js/mobile.js'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // best-effort: a missing asset must not block install
    await Promise.all(SHELL_ASSETS.map((a) => cache.add(a).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL && n !== NOAA)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// stale-while-revalidate against a named cache
async function swr(cacheName, request, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: false });
  const refresh = fetch(request).then((res) => {
    if (res && res.ok) {
      cache.put(request, res.clone()).then(() => {
        if (maxEntries) trim(cache, maxEntries);
      });
    }
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const fresh = await refresh;
  if (fresh) return fresh;
  return new Response('', { status: 504 });
}

self.addEventListener('fetch', (ev) => {
  if (ev.request.method !== 'GET') return;
  const url = new URL(ev.request.url);

  if (NOAA_HOSTS.includes(url.hostname)) {
    ev.respondWith(swr(NOAA, ev.request, NOAA_MAX));
    return;
  }

  // the app shell: same-origin documents and static assets only
  if (url.origin === self.location.origin) {
    ev.respondWith(swr(SHELL, ev.request));
  }
});
