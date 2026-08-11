# Share-link import — design, deferred

**Status: not built. Deliberately suppressed.** This is the design so it can be
picked up later without re-doing the investigation.

The goal was to let a user paste a Google Earth project or Google Maps list
share link and have its places arrive as POI markers, alongside the KML/KMZ file
import that *is* built (`js/poi.js`).

## Why it isn't built: CORS

A browser cannot fetch these URLs. Probed with an `Origin` header on
2026-08-11; **none returns an `access-control-allow-origin` header**:

| URL | Result |
|---|---|
| `earth.google.com/earth/d/<id>` | 302 → HTML app, no CORS header |
| `www.google.com/maps/d/kml?mid=<id>` | reachable, no CORS header |
| `maps.app.goo.gl/<id>` | 302 → HTML, no CORS header |

This is not a bug to work around. A cross-origin `fetch` without that header is
blocked by the browser regardless of what the server returns, so **any** version
of this feature needs something server-side to relay the request.

## Feasibility per source, assuming a proxy exists

| Source | With a proxy |
|---|---|
| **Google My Maps** (`/maps/d/kml?mid=…`) | **Works.** Returns real KML. CORS was the only obstacle. This is the one worth building. |
| **Google Earth project** (`earth.google.com/earth/d/…`) | **Probably.** The web UI's "Export as KML" calls an internal, undocumented endpoint. Usable, but unversioned and liable to break without notice — needs a clear failure path. |
| **Google Maps saved list** (`maps.app.goo.gl`, shared lists) | **No — do not build.** There is no public API, and the page is JS-rendered: the places are not in the HTML the proxy would receive. Extracting them means headless-browser rendering or scraping an obfuscated internal payload that changes without warning. Flaky by construction. |

**The realistic path for Maps lists stays what it is today:** the user exports to
KML (My Maps → ⋮ → *Download KML*; Google Earth → *Project* → *Export as KML*)
and imports the file, which already works.

## The hosting cost, stated plainly

KelpSpotter is a static GitHub Pages site. A proxy is server-side, so **this
feature ends pure-Pages hosting.** The mitigation is to keep the proxy tiny and
isolated so the *app* stays static and merely calls out to it.

## Recommended shape

Two options, both viable:

1. **A route on the existing Cloud Run service** (`api/main.py`) —
   `GET /fetch?url=…`. No new infrastructure, one less thing to deploy and pay
   attention to. The cost is coupling an unrelated concern to the kelp backend.
   **This is the recommendation** purely because that service already exists.
2. **A separate Cloudflare Worker** — cleaner separation, free tier of 100k
   req/day, no build step, deploys with one `wrangler deploy`. Needs a
   Cloudflare account, `npm i -g wrangler`, `wrangler login`, and a
   `wrangler.toml`. Roughly 40 lines.

### The proxy itself

Small and, importantly, **not an open relay**:

- Accept `?url=` and allow **only** an explicit host allowlist:
  `earth.google.com`, `www.google.com/maps/d/`, `drive.google.com`.
- Follow redirects, cap the response (a few MB), enforce a timeout.
- Return the bytes with `Access-Control-Allow-Origin:` set to the site origin.
- No credentials forwarded, no cookies, `GET` only.

Without the allowlist this becomes an open proxy that anyone can point at
anything, attributed to your account.

### How the app would call it

`js/config.js` gains one setting, and the feature is absent when it is unset:

```js
PROXY_URL: '<your-proxy-url>',   // blank/placeholder disables share-link import
```

`js/poi.js` already has `importUrl(url)` and already distinguishes a CORS failure
from other errors. The change is: when a direct fetch fails **and** `PROXY_URL`
is configured, retry via `PROXY_URL + '?url=' + encodeURIComponent(url)`. When it
is not configured, keep today's behaviour — a message telling the user to export
the KML and import the file. So the app degrades to the current state rather
than breaking.

## Not affected by this deferral

The **Import from URL…** item in the ⚙ menu stays. It is a direct fetch of a
`.kml`/`.kmz` URL, which works today for any host that sends CORS headers
(GitHub raw, most open-data portals) — it is only Google's endpoints that
require the proxy.
