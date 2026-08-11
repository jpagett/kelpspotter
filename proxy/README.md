# Import proxy (Cloudflare Worker)

Google's KML endpoints send no `Access-Control-Allow-Origin` header, so a browser
cannot read them no matter how the request is shaped. This Worker relays the
fetch and returns the bytes with CORS attached.

**The app does not depend on it.** With `PROXY_URL` unset, share-link import is
simply unavailable and the file importer carries on as before.

## What it does and does not fix

| Source | Through this proxy |
|---|---|
| **Google My Maps** (`/maps/d/…`) | **Works.** The viewer URL is rewritten to `/maps/d/kml?forcekml=1&mid=…`, which returns real KML. |
| **Direct `.kml` / `.kmz`** on an allowlisted host | **Works.** |
| **Google Earth project** (`earth.google.com/earth/d/…`) | **Refused, deliberately.** There is no stable KML export URL — the web UI calls an internal endpoint that is unversioned and would break silently. The proxy returns a message telling the user to use *Project → Export as KML file* and import that. |
| **Google Maps saved list** (`maps.app.goo.gl`, shared lists) | **Not possible.** The link resolves to HTML whose places are rendered by script, so there is nothing to parse even server-side. The proxy detects an HTML response and says so, pointing at Google Takeout or re-saving into My Maps. |

That last row is not a limitation of this proxy — no proxy fixes it. Extracting
those places needs a headless browser, which is a different class of service.

## Deploy

```bash
npm install -g wrangler     # once
cd proxy
wrangler login             # opens a browser, authorises your Cloudflare account
wrangler deploy
```

`wrangler deploy` prints the URL, e.g.
`https://kelpspotter-proxy.<your-subdomain>.workers.dev`.

Edit `ALLOWED_ORIGINS` in `wrangler.toml` if your site origin differs, then
redeploy. No account-level configuration, custom domain, or route is needed —
the generated `workers.dev` URL is enough.

## Point the app at it

In `js/config.js`:

```js
PROXY_URL: 'https://kelpspotter-proxy.<your-subdomain>.workers.dev',
```

Commit and push; Pages redeploys and the ⚙ → *Import from URL…* option starts
accepting share links.

## Free tier

Cloudflare Workers' free plan covers this comfortably:

- **100,000 requests/day**, and this is called once per import — not per tile.
- **10 ms CPU per request.** Relaying is I/O, not computation, so the work here
  is nowhere near that ceiling. Waiting on the upstream fetch does not count
  against CPU time.
- No egress charges, no cold-start billing, scales to zero.
- The `workers.dev` subdomain is free; a custom domain is optional.

## Guard rails

Worth knowing, since this runs under your account:

- **Host allowlist** — only Google Maps/Earth/Drive and the short-link domains.
  Without it this is an open proxy that anyone can point anywhere.
- **8 MB cap**, checked on both `Content-Length` and the actual body.
- **20 s timeout** via `AbortController`.
- **GET only**, no cookies or credentials forwarded.
- **CORS restricted** to `ALLOWED_ORIGINS`.
