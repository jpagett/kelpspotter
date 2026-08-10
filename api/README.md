# KelpSpotter backend — public kelp imagery, no sign-in

A small Cloud Run service that runs the Mora-Soto et al. (2020) kelp filter on
Earth Engine as a **service account** and returns a tile-URL template.

It does **not** proxy tiles. `getMapId()` returns a URL the browser fetches
directly from Google's tile servers, so this service handles a handful of small
JSON requests per visitor session rather than thousands of images. That is what
keeps it inside free tiers and off the critical path for map rendering.

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ok: true, project: …}` — the client probes this to decide whether the backend is live |
| `GET /scenes?start&end&maxCloud` | `[{id, date, cloud}]`, one entry per date, keeping the clearest |
| `GET /layer?mode&date\|start&end&index&kelpThresh&b11Thresh&maxCloud` | `{urlFormat, expiresIn}` |

## Setup

Everything below runs once. Replace `kelpscape` if your project differs.

### 1. Enable the APIs

```bash
gcloud config set project kelpscape
gcloud services enable earthengine.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### 2. Create the service account

```bash
gcloud iam service-accounts create kelpspotter-api \
  --display-name="KelpSpotter Earth Engine backend"
```

### 3. Grant it Earth Engine access

```bash
SA="kelpspotter-api@kelpscape.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding kelpscape \
  --member="serviceAccount:$SA" --role="roles/earthengine.viewer"

gcloud projects add-iam-policy-binding kelpscape \
  --member="serviceAccount:$SA" --role="roles/serviceusage.serviceUsageConsumer"
```

**This is the step that most often blocks a first deploy.** The Cloud project
must already be registered for Earth Engine (you did this for the browser
client), and the service account must be allowed to use it. If `/health`
succeeds but `/scenes` returns a permission error, this binding — or the
project's Earth Engine registration — is the cause. Some Earth Engine setups
also require registering the service-account address at
<https://code.earthengine.google.com/register>.

**No key file is created, and none should be.** The service reads Application
Default Credentials from the runtime identity, so nothing secret is committed,
built into the image, or shipped to the browser. `.gitignore` blocks
`*-key.json` in case anyone is tempted.

### 4. Deploy

From the repository root:

```bash
gcloud run deploy kelpspotter-api \
  --source=api \
  --region=us-west1 \
  --service-account=kelpspotter-api@kelpscape.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars='^##^EE_PROJECT=kelpscape##ALLOWED_ORIGINS=https://jpagett.github.io,http://localhost:8000' \
  --memory=512Mi --cpu=1 --timeout=120 --max-instances=5
```

`--allow-unauthenticated` is the point of the exercise: the *service* is public,
while the Earth Engine *credential* stays on the server. `--max-instances=5`
caps how much concurrent Earth Engine work strangers can trigger.

**The `^##^` prefix is not decoration.** `--set-env-vars` splits on commas, and
`ALLOWED_ORIGINS` contains one. That prefix redefines the separator as `##`, so
the comma is treated as data. Escaping it as `\,` instead does *not* work from
bash — the shell strips the backslash before gcloud sees it, and you get:

    ERROR: argument --set-env-vars: Bad syntax for dict arg: [http://localhost:8000]

The single quotes matter too, for the same reason.

If you only need the published origin, there is no comma and no problem:

```bash
--set-env-vars=EE_PROJECT=kelpscape,ALLOWED_ORIGINS=https://jpagett.github.io
```

### 5. Point the site at it

```bash
gcloud run services describe kelpspotter-api --region=us-west1 \
  --format='value(status.url)'
```

Put that URL in `js/config.js`:

```js
API_URL: 'https://kelpspotter-api-xxxxxxxx-uw.a.run.app',
```

Commit and push.

**Engine precedence, best first:**

1. **The visitor's own Earth Engine session.** Probed first, so anyone signed in
   spends their own quota rather than this project's. The probe is raced against
   a 2.5 s timeout — when Google's popup is blocked its callbacks can simply
   never fire, and without the race the page would hang at boot instead of
   falling through.
2. **This backend.** Live imagery for everyone else, no sign-in.
3. **Demo mode.** Synthetic, always works.

So a missing or broken backend degrades rather than breaks, and signing in
upgrades a visitor off the shared quota mid-session.

Because the shared backend is public but rate-limited, the site shows a
persistent bottom-centre invitation to sign in. It clears when the visitor signs
in, or when they dismiss it with the **×**; it is not an error banner and does
not auto-hide.

### 6. Check it

```bash
API=$(gcloud run services describe kelpspotter-api --region=us-west1 --format='value(status.url)')
curl -s "$API/health"
curl -s "$API/scenes?start=2026-06-01&end=2026-08-01&maxCloud=100" | head -c 300
curl -s "$API/layer?mode=single&date=2026-07-05&index=KD&kelpThresh=0.003216&b11Thresh=0.028"
```

## Guardrails

The quota is now exposed to the public, so the service:

- **fixes the AOI server-side** — a caller-supplied geometry would let anyone run
  a global computation against your project
- **clamps** index, thresholds and cloud ceiling to the ranges the UI offers, and
  **refuses** date ranges over 400 days
- **caches** minted map ids (30 min) and scene lists (1 hour); ids are ephemeral,
  so the TTL is deliberately under their lifetime
- **rate-limits** per IP, 60/min — best effort only, since each Cloud Run
  instance keeps its own counter. For a hard limit, put Cloud Armor in front
- **restricts CORS** to `ALLOWED_ORIGINS`

## Keeping the two implementations in step

`api/main.py` and `js/ee-kelp.js` implement the same detection. A change to one
must be mirrored in the other, or signed-in and signed-out visitors will see
different maps. The shared constants are the collection id, the 1e-4 rescale,
the QA60 bits, the band centres, `DEM_ID`, the palette, the alpha gamma, and the
per-index thresholds and ramps in `js/config.js`.

## Cost

Earth Engine noncommercial is free; Cloud Run scales to zero. At low traffic this
is realistically $0. Cold starts add roughly 1–3 s to the first request, which is
small against the Earth Engine round trip behind it.

Check that Earth Engine's terms cover serving derived imagery to the public under
the noncommercial license before launching this widely.
