/*
 * KelpSpotter service worker — cache-first for the NOAA map services.
 *
 * NOAA sends `cache-control: private` with no max-age, ETag or Last-Modified,
 * so the browser has no freshness signal and re-downloads every relief and
 * contour tile on every visit. Bathymetry does not change week to week; serving
 * it from cache and refreshing in the background is strictly better.
 *
 * Everything else passes straight through — the app's own files come from
 * GitHub Pages with sane caching, and Earth Engine tile URLs are ephemeral by
 * design and must never be cached here.
 */
const CACHE = 'kelp-noaa-v1';
const NOAA_HOSTS = ['gis.ngdc.noaa.gov', 'gis.charttools.noaa.gov'];
const MAX_ENTRIES = 400;

self.addEventListener('install', (ev) => { self.skipWaiting(); });
self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    // drop caches from older versions of this worker
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  // FIFO is fine here: tiles are revisited in clusters, not uniformly
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || !NOAA_HOSTS.includes(url.hostname)) return;

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(ev.request);
    // stale-while-revalidate: answer from cache instantly, refresh behind it
    const refresh = fetch(ev.request).then((res) => {
      if (res && res.ok) {
        cache.put(ev.request, res.clone()).then(() => trim(cache));
      }
      return res;
    }).catch(() => null);
    if (hit) { ev.waitUntil(refresh); return hit; }
    const fresh = await refresh;
    if (fresh) return fresh;
    return new Response('', { status: 504 });
  })());
});
