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
  --member="serviceAccount:$SA" --role="roles/earthengine.writer"

gcloud projects add-iam-policy-binding kelpscape \
  --member="serviceAccount:$SA" --role="roles/serviceusage.serviceUsageConsumer"
```

**`writer`, not `viewer`.** `earthengine.viewer` is enough to *run computations*,
so `/scenes` will work with it and everything looks fine — but minting map tiles
needs `earthengine.maps.create`, which only `writer` carries. The symptom is very
specific and easy to misread:

    /health   -> ok
    /scenes   -> real data
    /layer    -> Permission 'earthengine.maps.create' denied on resource 'projects/kelpscape'

If you see that, this role is the reason. No redeploy is needed after fixing it —
Earth Engine checks the permission per request.

**This is also the step that most often blocks a first deploy.** The Cloud project
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

1. **The visitor's own Earth Engine session** — but only once they have signed
   in. Boot checks for an existing token and never prompts: the Earth Engine
   client's `authenticate()` now opens an account picker immediately rather than
   attempting silent auth as the old gapi flow did, so calling it at startup
   demanded a Google account before the visitor had asked for anything.
   Signing in is exclusively the Connect button's job.
2. **This backend.** Live imagery for everyone else, no sign-in.
3. **Demo mode.** Synthetic, always works.

So the page opens straight into live imagery with no account, and signing in
upgrades that visitor off the shared quota mid-session.

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

## Automatic redeploys

GitHub Pages redeploys the static site on push. **Cloud Run does not watch the
repo**, so `api/` changes need a deploy. `cloudbuild.yaml` in the repo root
automates that: a Cloud Build trigger rebuilds and redeploys on any push to
`master` that touches `api/**`.

It runs inside GCP as the Cloud Build service account, so **no key material is
stored in GitHub** — the same reason the service uses the runtime identity
rather than a JSON key. (A GitHub Actions workflow would need either a
service-account key in a repo secret, or Workload Identity Federation to avoid
one; the Cloud Build trigger sidesteps the choice.)

### One-time setup

**1. Connect the repository.** This step needs the console — it is a GitHub
OAuth authorisation, not something a command can do on your behalf:

→ https://console.cloud.google.com/cloud-build/repositories?project=kelpscape

*Connect repository* → GitHub → authorise → pick `jpagett/kelpspotter`.

**2. Give Cloud Build permission to deploy.** It needs to update the Cloud Run
service, and to *act as* the runtime service account:

```bash
PROJECT_NUMBER=$(gcloud projects describe kelpscape --format='value(projectNumber)')
```

```bash
gcloud projects add-iam-policy-binding kelpscape --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/run.admin" --condition=None
```

```bash
gcloud iam service-accounts add-iam-policy-binding kelpspotter-api@kelpscape.iam.gserviceaccount.com --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/iam.serviceAccountUser" --condition=None
```

Without the second binding the build fails with a `PERMISSION_DENIED` naming
`iam.serviceaccounts.actAs` — that error means this step, not a broken YAML.

**`--condition=None` is load-bearing.** Connecting the repository leaves behind a
short-lived conditional binding (`cloudbuild-connection-setup`, expiring within
the hour). Once *any* binding on the policy carries a condition, gcloud refuses
to add an unconditional one silently and prompts instead:

    The policy contains bindings with conditions, so specifying a condition is
    required when adding a binding. Please specify a condition.

Answer `None`, or pass the flag as above. Picking the offered
`cloudbuild-connection-setup` condition instead would give Cloud Build deploy
rights that expire the same hour, and the trigger would start failing later for
no visible reason.

**3. Create the trigger.**

Which command you need depends on how the repository was connected, and using
the wrong one fails with a bare `INVALID_ARGUMENT: Request contains an invalid
argument` that names nothing.

*2nd generation* — the Cloud Build **Repositories** page, the one that warns
about bot accounts and stores a token in Secret Manager. Find the connection
first, since the console often creates it in `us-central1` rather than the
region you expect:

```bash
gcloud builds connections list --region=us-west1
```

```bash
gcloud builds repositories list --connection=CONNECTION_NAME --region=REGION
```

```bash
gcloud builds triggers create github --name=kelpspotter-api-deploy --region=REGION --repository=projects/kelpscape/locations/REGION/connections/CONNECTION_NAME/repositories/REPO_NAME --branch-pattern='^master$' --build-config=cloudbuild.yaml --included-files='api/**'
```

*1st generation* — the older GitHub App connection. Takes owner/name directly
and lives in `global`:

```bash
gcloud builds triggers create github --name=kelpspotter-api-deploy --region=global --repo-owner=jpagett --repo-name=kelpspotter --branch-pattern='^master$' --build-config=cloudbuild.yaml --included-files='api/**'
```

**The trigger region must match the connection's region.** It does *not* need to
match Cloud Run's: `cloudbuild.yaml` passes `--region` to the deploy step
explicitly, so a build running in `us-central1` still deploys the service to
`us-west1`.

`--included-files='api/**'` is what stops a CSS change from rebuilding a
container.

### Checking it

```bash
gcloud builds triggers run kelpspotter-api-deploy --region=us-west1 --branch=master
```

```bash
gcloud builds list --region=us-west1 --limit=3
```

After that, editing anything under `api/` and pushing is the whole workflow —
no manual deploy. The manual command above still works if you need to force one.

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
