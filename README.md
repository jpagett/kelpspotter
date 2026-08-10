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
| **Index: KD / FAI / NDVI** | Which spectral index defines "kelp" (see below). |
| **Kelp threshold** | Index value at or above which a pixel counts as canopy. Snaps back to the published value each time you switch index. |
| **B11 land filter** | Step 1 of the algorithm — pixels at or above this B11 (1610 nm) reflectance are dropped as coast or land vegetation. |
| **Layer opacity** | Blend of the kelp layer over the basemap. |

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

Two things worth knowing about those numbers:

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

- **Two deliberate deviations from the paper**, both in `js/ee-kelp.js`:
  1. *Cloud screening.* The authors ran an ~800-line JRC cloud-free compositing tool
     offline. This app uses the Sentinel-2 **QA60** bitmask (opaque cloud + cirrus)
     instead, plus the scene-level `CLOUDY_PIXEL_PERCENTAGE` ceiling from the console.
  2. *Compositing.* The paper filters a single multi-year (2015–2019) median composite.
     KelpSpotter filters **each pass separately** so the timeline is scrubbable;
     Composite mode then averages those per-scene masks into a detection *frequency*.
     That frequency map is KelpSpotter's own view, not a product from the paper.
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
