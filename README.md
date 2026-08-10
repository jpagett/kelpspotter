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
| **Scene ‹ ›** | Step through individual satellite passes (the timeline at the bottom). **← / →** do the same from the keyboard, except while a form control has focus. |
| **The date itself** | Click it to open a calendar with its own cloud-ceiling slider. Only dates whose pass meets the ceiling are clickable; passes that exist but are too cloudy are struck through, so you can see what raising the ceiling would buy you. |
| **Single day / Composite** | One pass, or the paper's mean cloud-free composite across the date range. |
| **Date range** | The window feeding both the timeline and the composite. *reset* returns it to the last `LOOKBACK_DAYS`. |
| **Cloud cover ceiling** | Drop scenes cloudier than this from the timeline and the composite. |
| **Depth → Shaded relief** | NOAA depth/relief overlay (**on** by default). |
| **Depth → Depth contours** | Charted depth contours from NOAA ENC (off by default). |
| **Depth → Depth opacity** | Dims the relief so the kelp layer stays readable over it. |
| **Depth at the cursor** | With either depth layer on, the depth (or land elevation) under the pointer is read out in feet beside the crosshair. |
| **Index: KD / FAI / NDVI** | Which spectral index defines "kelp" (see below). |
| **Kelp threshold** | Index value at or above which a pixel counts as canopy. Snaps back to the published value each time you switch index. |
| **B11 land filter** | Step 1 of the algorithm — pixels at or above this B11 (1610 nm) reflectance are dropped as coast or land vegetation. |
| **Layer opacity** | Overall blend of the kelp layer over the basemap. |

### Scene caching

Scenes are fetched **once per date range**, unfiltered (ceiling 100), and every
cloud-ceiling change is a client-side filter over that cached list. Previously each
nudge of the slider was a fresh Earth Engine round trip. Per-ceiling results are
memoised as well, so returning to a ceiling you have already used — the common case when
dragging back and forth — is a map lookup. Only changing the *date range* costs a
request. The cache is cleared when the engine switches, since demo and live scene lists
are not interchangeable.

Two consequences worth knowing:

- The calendar can show passes that are **over** the ceiling, because the unfiltered list
  is already in memory. That is what makes the struck-through days possible.
- Ceiling changes recompute the kelp layer only when it would actually differ: the
  ceiling feeds the composite directly, but a single scene is fetched by date, so the
  slider matters there only if it moved you onto a different pass. Recomputes are also
  debounced, so dragging the slider end to end fires **one** computation rather than one
  per step.

### How the kelp layer is drawn

The classification is binary, but drawing it as a flat block hides the basemap. So
detected pixels are painted with opacity ramped by how far the index sits above the
threshold — fully transparent at the threshold, opaque once it clears it by `ramp`
(set per index in `config.js`). Anything not classified as kelp is masked out entirely,
so the basemap and the depth overlay stay visible underneath.

**This ramp is a display choice, not part of the algorithm.** It never changes which
pixels are classified as kelp — only how strongly they are shaded.

### Depth overlays

Two independent NOAA layers, each in its own Leaflet pane so they toggle separately and
always sit beneath the kelp:

| Layer | Source | Notes |
|---|---|---|
| Shaded relief | NCEI **DEM global mosaic**, `ColorHillshade` | On by default at 45% opacity |
| Depth contours | **NOAA ENC** coastal charts, WMS layer `95` (`Coastal.Depth_Contour_line`) | Off by default |

Both are public, need no API key, and serve EPSG:3857 directly, so Leaflet's built-in
`L.tileLayer.wms` consumes them with no extra dependency.

Two gotchas worth recording:

- The ENC WMS layer numbering is **not** the same as the REST layer ids — the contour
  layer is `95` over WMS but `82` over REST.
- ENC draws contours as black lines on transparent, invisible against this basemap, so
  the contour pane is inverted to white in CSS.

NCEI's higher-resolution Coastal Relief Model would be the better product for US coastal
water, but it returns blank tiles below roughly 2° of extent, so it is not usable here.

**Stacking order** is set explicitly with panes, because the CARTO basemap is opaque and
anything sent behind it disappears: basemap 200 → relief 250 → contours 260 → kelp tiles
350 → demo canvas 400.

### Why the depth layers feel slow, and what is done about it

NOAA sends `cache-control: private` with **no** `max-age`, `ETag`, or `Last-Modified`, so
the browser has no freshness signal and re-requests aggressively. Nothing client-side can
make it cache properly. What the app does instead is cut the number of requests
(`DEPTH.tuning` in `config.js`):

- `tileSize: 512` — a quarter as many requests as the 256 px default
- `updateWhenIdle` / `updateWhenZooming: false` — no requests for tiles that scroll past
- `keepBuffer: 4` — offscreen tiles are retained, so panning back is free
- Toggling a layer off **hides its pane** rather than removing the layer, so tiles stay in
  the DOM and switching back is instant

For caching that survives a reload, the next step would be a service worker with a
cache-first strategy for the two NOAA hosts. That is a real addition rather than a tweak,
so it is deliberately not in yet.

### Depth at the cursor

Whenever either depth layer is on, the value under the pointer is read from the same
NCEI ImageServer's `identify` endpoint, which returns the raw pixel in metres (negative
below sea level) and sends `Access-Control-Allow-Origin: *` — so it is a direct browser
fetch with no proxy. Metres are converted to feet and labelled *depth* below sea level or
*elev.* above it.

`mousemove` fires far too often to hit the network each time, so lookups are debounced
(180 ms), the in-flight request is aborted as soon as the cursor moves on, and results are
cached per ~11 m of ground. The readout follows the pointer immediately regardless; it
just dims while the value under it is stale. Sanity check against known points:

| Location | Pixel value | Readout |
|---|---|---|
| Mid-channel | −93.14 m | 306 ft depth |
| Santa Ynez ridge | +749.2 m | 2,458 ft elev. |
| Near Santa Barbara harbour | −0.40 m | 1 ft depth |

---

## The detection algorithm

Detection follows the kelp filter algorithm of:

> Mora-Soto, A.; Palacios, M.; Macaya, E.C.; Gómez, I.; Huovinen, P.; Pérez-Matus, A.;
> Young, M.; Golding, N.; Toro, M.; Yaqub, M.; Macias-Fauria, M.
> **A High-Resolution Global Map of Giant Kelp (*Macrocystis pyrifera*) Forests and
> Intertidal Green Algae (Ulvophyceae) with Sentinel-2 Imagery.**
> *Remote Sensing* **2020**, 12, 694. [doi:10.3390/rs12040694](https://doi.org/10.3390/rs12040694)

Their Earth Engine reference implementation lives at
[BiogeoscienceslabOxford/kelp_forests](https://github.com/BiogeoscienceslabOxford/kelp_forests);
`js/ee-kelp.js` is a port of it.

It is a chain of threshold filters, not a classifier:

1. **Band-based threshold.** Drop every pixel with **B11 ≥ 0.028**. B11 (1610 nm) is
   where *Coast* and *Land Vegetation* separate cleanly from anything wet — 100% of
   the authors' coast and land training pixels sit at or above that line.
2. **Index.** Compute one of three:
   - **KD** (Kelp Difference, the paper's own formula) = **B6 − B4**. Giant kelp shows
     a conspicuously large gap between the red edge and the red band, and B6 (740 nm)
     is where that gap is widest. This is the index the authors used for their global
     map, and it scored the best Cohen's kappa (0.66) of the three.
   - **FAI** (Floating Algae Index) = B8 − [B4 + (B11 − B4) · (0.833 − 0.665)/(1.612 − 0.665)].
     Tolerant of sun glint and thin haze.
   - **NDVI** = (B8 − B4) / (B8 + B4). Simple and robust.
3. **Index threshold.** Keep pixels at or above the value that removed 100% of the
   non-kelp, non-green-algae training cells:

   | Index | Threshold | Set by |
   |---|---|---|
   | KD | ≥ 0.003216 | max *River grass* value |
   | FAI | ≥ 0.005352 | max *Organic water* value |
   | NDVI | ≥ −0.0003411 | max *River grass* value |

4. **Sea-level mask.** Drop anything with a DEM elevation above sea level
   (`USGS/SRTMGL1_003` = 0), so land features absent from the training set can't leak in.

Three things worth knowing about those numbers:

- **KD and FAI must be positive; NDVI's is legitimately negative.** KD and FAI are both
  defined as one band exceeding another (red edge over red; NIR over the red↔SWIR
  baseline), so a cutoff at or below zero would admit pixels that are not vegetation at
  all — their sliders floor at 0. NDVI's published threshold really does sit just below
  zero: over water in TOA reflectance, atmospheric path radiance lifts the red band
  while NIR is nearly black, putting kelp pixels right at the NDVI zero crossing. Its
  slider keeps a small negative floor so the published value stays reachable.
- They are calibrated on **Sentinel-2 L1C top-of-atmosphere reflectance rescaled by
  1e-4**, so the app loads `COPERNICUS/S2_HARMONIZED` (L1C), *not* the L2A surface-
  reflectance product it used before. Applying these thresholds to surface reflectance
  would be meaningless.
- The algorithm cannot separate giant kelp from intertidal green algae (Ulvophyceae) —
  their spectra overlap too much. The paper is explicit about this; on the Santa Barbara
  Channel coast it mostly matters around river mouths and shallow rocky intertidal.

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

- **One deliberate deviation from the paper**, in `js/ee-kelp.js`: the authors ran an
  ~800-line JRC cloud-free compositing tool offline. This app uses the Sentinel-2
  **QA60** bitmask (opaque cloud + cirrus) instead, plus the scene-level
  `CLOUDY_PIXEL_PERCENTAGE` ceiling from the console.
- **Composite vs. single-scene.** Composite mode reproduces the paper's preprocessing:
  a mean cloud-free reflectance composite over the date range, filtered once. Single-day
  mode runs the same filter on one pass so the timeline stays scrubbable — useful, but
  a single pass is noisier than the multi-year composite the published thresholds were
  calibrated against.
- **Band resolution.** KD mixes B4 (10 m) with B6 (20 m), and the B11 filter is also
  20 m; Earth Engine resamples to the requested output scale, matching the paper's
  10 m validation.
- **One discrepancy in the source material.** The paper's Table 2 gives the NDVI
  threshold as −0.003411, but the authors' published GEE script uses −0.0003411 (an
  extra zero). This app follows the script, since that is the code that produced the
  global map. It only affects NDVI — KD and FAI agree in both places.
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
