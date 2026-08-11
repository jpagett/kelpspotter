# Share-link import — built, then removed

**Status: removed.** The app imports KML/KMZ **files** only. This note exists so
the investigation is not repeated.

A Cloudflare Worker proxy was written, deployed and wired up; it worked for
Google My Maps. It was then removed because the two sources actually wanted —
Google Earth projects and Google Maps saved lists — cannot be made to work well,
and a feature that handles only the case nobody asked for is not worth an extra
service, an extra hosting dependency, and an allowlist to maintain.

## What a proxy does and does not fix

CORS is a *browser* rule: the server sends the bytes, the browser refuses to let
the page read them without an `Access-Control-Allow-Origin` header. A proxy
sidesteps that because servers have no such rule.

So a proxy fixes exactly one thing: *the data is in the response, but the browser
will not hand it over.* It cannot conjure data that is absent, and it cannot
guess an address that was never published.

Probed with an `Origin` header on 2026-08-11 — none of these send CORS headers:

| URL | Result |
|---|---|
| `earth.google.com/earth/d/<id>` | 302 → HTML app shell |
| `www.google.com/maps/d/kml?mid=<id>` | reachable, real KML |
| `maps.app.goo.gl/<id>` | 302 → HTML |

## Per source

| Source | Data in the response? | Stable public URL? | Needs the viewer's session? | Verdict |
|---|---|---|---|---|
| **My Maps** | yes | yes (`/maps/d/kml?mid=`) | no | a proxy fixes it — this is the only one that worked |
| **Earth project** | yes, as KML | **no** — the web app calls an internal, unversioned endpoint | often | possible but a maintenance liability; would fail silently when Google changes it |
| **Maps saved list** | **no** — places are rendered by script after load | no | — | no proxy can fix this; it needs a headless browser, which is a different class of service |

## What replaced it

The manual export, which is one click and produces exactly the same data:

- Earth: **Project → Export as KML file**
- Maps list: rebuild once in My Maps, then **Download KML**

## If this is ever revisited

The Worker was ~150 lines: host allowlist, My Maps viewer→KML rewrite, 8 MB cap,
20 s timeout, GET only, CORS restricted to the site origin. It lived at
`proxy/worker.js` and is in the history — recover it with
`git log --diff-filter=D -- proxy/worker.js`. The client side hooked in at
`POI.importUrl()`, which tried a direct fetch first and fell back to the relay.

Whatever the shape, **the allowlist is not optional**: without it the proxy is an
open relay anyone can point anywhere, attributed to your account.
