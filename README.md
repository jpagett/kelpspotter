# KelpSpotter

A single-page web app that maps giant-kelp (*Macrocystis pyrifera*) canopy in the
Santa Barbara Channel from Sentinel-2 imagery. Tab through recent satellite passes,
filter by cloud cover, build multi-day composites, and tune the kelp-detection model
live from the console.

It runs in two modes:

- **Demo mode** (default, zero setup) — synthetic kelp anchored to the real channel
  coast so you can see exactly how every control behaves.
- **Live mode** — real Sentinel-2 surface reflectance through Google Earth Engine,
  once you add your own (free, noncommercial) Earth Engine credentials.

---

## Quick start

The app must be served over HTTP (map tiles and Earth Engine's OAuth won't work from a
`file://` path). From the project folder:

```bash
# Python (already on most machines)
python -m http.server 8000
# then open http://localhost:8000
```

or

```bash
npx serve .
```

On first load you'll see amber kelp beds glowing along the coast in **DEMO DATA** mode.
Everything is interactive immediately.

---

## Going live with Earth Engine

Live imagery is free for personal / noncommercial use. One-time setup:

1. **Register for Earth Engine.** Sign in at <https://code.earthengine.google.com>
   with a Google account and create (or pick) a Cloud project. Complete the
   noncommercial verification questionnaire when prompted — this is required for
   free access.
2. **Enable the Earth Engine API** on that Cloud project.
3. **Create an OAuth 2.0 Client ID** (Cloud Console → APIs & Services → Credentials
   → *Create credentials* → *OAuth client ID* → *Web application*). Under
   *Authorized JavaScript origins* add the origin you serve from,
   e.g. `http://localhost:8000`.
4. **Fill in `js/config.js`:**

   ```js
   CLIENT_ID: '1234567890-abcd.apps.googleusercontent.com',
   PROJECT_ID: 'your-cloud-project-id',
   ```

5. Reload, then click **Connect Earth Engine** and sign in. The status pill switches
   to **LIVE · SENTINEL-2** and the map now shows real kelp.

The whole thing stays a static site — Earth Engine does the heavy computation on
Google's servers and returns map tiles to your browser. There's no server for you to
run or pay for. (If you later want a native iPhone app, that same Earth Engine logic
moves to a small Python cloud function; this web app is the prototype and fallback.)

---

## The console

| Control | What it does |
|---|---|
| **Scene ‹ ›** | Step through individual satellite passes (the timeline at the bottom). |
| **Single day / Composite** | One pass, or a kelp-*frequency* map averaged across every clear pass in the window. |
| **Cloud cover ceiling** | Drop scenes cloudier than this from the timeline. |
| **Index: NDVI / FAI** | Which spectral index defines "kelp" (see below). |
| **Kelp threshold** | Index value above which a water pixel counts as canopy. Raise it to keep only dense kelp. |
| **Water threshold** | NDWI cutoff separating sea from land, so kelp is only detected on water. |
| **Layer opacity** | Blend of the kelp layer over the basemap. |

### The two indices

- **NDVI** = (NIR − Red) / (NIR + Red). Kelp canopy floating at the surface reflects
  strongly in the near-infrared, so it stands out against dark water. Simple and
  robust; a good default (threshold ~0.10).
- **FAI** (Floating Algae Index) = NIR − a baseline interpolated between Red and SWIR.
  More tolerant of sun glint and thin haze, which is why it's popular for floating
  vegetation. It lives on a different numeric scale, so the app resets the kelp
  threshold when you switch (start ~0.02).

Masking uses the Sentinel-2 Scene Classification band to remove cloud, cloud shadow,
and cirrus before the index is computed.

---

## Project structure

```
kelpspotter/
├── index.html        markup: map stage, console, timeline, legend
├── css/styles.css    the bathymetric / depth-sounder styling
└── js/
    ├── config.js     your credentials + area of interest + defaults
    ├── ee-kelp.js    the real Sentinel-2 → kelp pipeline (Earth Engine)
    ├── demo.js       synthetic kelp engine (same interface as ee-kelp)
    └── app.js        map, controls, timeline, engine selection, run loop
```

`ee-kelp.js` and `demo.js` expose the same four methods —
`init`, `listScenes`, `singleSceneLayer`, `compositeLayer` — so `app.js` treats live
and demo identically. To change the region, edit `AOI` (`[west, south, east, north]`)
in `config.js`.

---

## Notes & caveats

- The demo kelp is **procedural, not real** — bed *locations* follow actual channel
  reefs, but their extent is generated noise. It exists to exercise the UI, not to
  report real canopy. Only **LIVE** mode reflects the sea.
- Earth Engine's browser client and OAuth flow occasionally change; this app follows
  Google's current `ee.data.authenticate` → `authenticateViaPopup` → `ee.initialize`
  pattern. If the CDN path to `ee_api_js.js` ever moves, download the built file from
  the [earthengine-api repo](https://github.com/google/earthengine-api) and point the
  `<script>` in `index.html` at a local copy.
- Kelp thresholds are sensitive to tide, sun angle, and water clarity — expect to tune
  per scene. That's exactly what the sliders are for.

Free for personal use.
