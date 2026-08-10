"""
KelpSpotter tile-URL minter.

Runs the Mora-Soto et al. (2020) kelp filter on Earth Engine as a *service
account*, and hands the browser back a tile-URL template. It deliberately does
NOT proxy tiles: getMapId returns a URL that the browser fetches directly from
Google's tile servers, so this service handles a handful of requests per visitor
session rather than thousands of images. That is what keeps it inside free tiers
and off the critical path for map rendering.

The detection is a direct port of js/ee-kelp.js — same four steps, same
constants. Any change to one must be mirrored in the other.

Credentials come from the runtime service account via Application Default
Credentials, so no key material is committed, built into the image, or shipped
to the browser.
"""
import datetime as dt
import logging
import os
import threading
import time
import traceback

import ee
import google.auth
from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------- configuration

PROJECT = os.environ.get("EE_PROJECT", "kelpscape")
# Comma-separated list. Defaults are the published site plus local development.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://jpagett.github.io,http://localhost:8000",
    ).split(",")
    if o.strip()
]

# The AOI is fixed server-side on purpose: a caller-supplied geometry would let
# anyone run a global computation against this project's quota.
AOI = [-120.55, 34.30, -119.45, 34.55]

MAX_RANGE_DAYS = 400          # a composite over more than this is refused
MAPID_TTL_SECONDS = 30 * 60   # minted ids are ephemeral; re-mint after this
SCENES_TTL_SECONDS = 60 * 60
RATE_LIMIT_PER_MIN = 60       # per client IP, best effort (see README)

S2_RED, S2_RE6, S2_NIR, S2_SWIR = "B4", "B6", "B8", "B11"
L_RED, L_NIR, L_SWIR = 0.665, 0.833, 1.612          # µm, as in the paper's code
DEM_ID = "USGS/SRTMGL1_003"
KELP_PALETTE = ["7a6a1f", "d9a441", "f2b134", "ffd166"]

# Bounds mirror the slider ranges in js/config.js. Values outside these are
# clamped rather than rejected, so a stale client still gets a usable map.
INDEX_LIMITS = {
    "KD":   {"min": 0.0,   "max": 0.05, "ramp": 0.02},
    "FAI":  {"min": 0.0,   "max": 0.05, "ramp": 0.02},
    "NDVI": {"min": -0.01, "max": 0.30, "ramp": 0.15},
}

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)

_init_lock = threading.Lock()
_initialised = False


def ensure_ee():
    """Initialise Earth Engine once per process, from the runtime credentials."""
    global _initialised
    if _initialised:
        return
    with _init_lock:
        if _initialised:
            return
        creds, _ = google.auth.default(
            scopes=[
                "https://www.googleapis.com/auth/earthengine",
                "https://www.googleapis.com/auth/cloud-platform",
            ]
        )
        ee.Initialize(creds, project=PROJECT)
        _initialised = True


# ------------------------------------------------------------------ small cache

_cache = {}
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        value, expires = hit
        if time.time() > expires:
            _cache.pop(key, None)
            return None
        return value


def cache_put(key, value, ttl):
    with _cache_lock:
        if len(_cache) > 500:          # crude bound; this is a cache, not storage
            _cache.clear()
        _cache[key] = (value, time.time() + ttl)


_hits = {}
_hits_lock = threading.Lock()


def rate_limited(ip):
    """Best-effort per-IP limit. Cloud Run may run several instances, so this
    bounds a single instance rather than the service as a whole."""
    now = time.time()
    with _hits_lock:
        bucket = [t for t in _hits.get(ip, []) if now - t < 60]
        if len(bucket) >= RATE_LIMIT_PER_MIN:
            _hits[ip] = bucket
            return True
        bucket.append(now)
        _hits[ip] = bucket
        if len(_hits) > 5000:
            _hits.clear()
        return False


# -------------------------------------------------------------- the detection
# Mirrors js/ee-kelp.js exactly. Mora-Soto et al. 2020, Remote Sens. 12(4), 694.


def region():
    w, s, e, n = AOI
    return ee.Geometry.Rectangle([w, s, e, n])


def collection(start_iso, end_iso, max_cloud):
    return (
        ee.ImageCollection("COPERNICUS/S2_HARMONIZED")   # L1C TOA
        .filterBounds(region())
        .filterDate(start_iso, end_iso)
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", max_cloud))
    )


def clear_sky(img):
    """QA60 bit 10 = opaque cloud, bit 11 = cirrus."""
    qa = img.select("QA60")
    return qa.bitwiseAnd(1 << 10).eq(0).And(qa.bitwiseAnd(1 << 11).eq(0))


def reflectance(img):
    """TOA DN -> reflectance, the paper's 1e-4 rescale."""
    return img.select([S2_RED, S2_RE6, S2_NIR, S2_SWIR]).divide(10000)


def spectral_index(b, index_type):
    red = b.select(S2_RED)
    re6 = b.select(S2_RE6)
    nir = b.select(S2_NIR)
    swir = b.select(S2_SWIR)
    if index_type == "FAI":
        baseline = red.add(
            swir.subtract(red).multiply((L_NIR - L_RED) / (L_SWIR - L_RED))
        )
        return nir.subtract(baseline)
    if index_type == "NDVI":
        return nir.subtract(red).divide(nir.add(red))
    return re6.subtract(red)        # KD — the paper's Kelp Difference, Eq. (1)


def classify(b, params, clear=None):
    """The paper's three steps plus the GEE sea-level mask."""
    not_land = b.select(S2_SWIR).lte(params["b11Thresh"])          # step 1
    idx = spectral_index(b, params["indexType"])                    # step 2
    kelp = (
        idx.gte(params["kelpThresh"])                               # step 3
        .And(not_land)
        .And(ee.Image(DEM_ID).eq(0))                                # GEE step (c)
    )
    if clear is not None:
        kelp = kelp.And(clear)
    return kelp, idx


def render(kelp, idx, params):
    """Opacity ramped by index strength; fully transparent at the threshold.
    Display only — it never changes which pixels are classified as kelp."""
    limits = INDEX_LIMITS[params["indexType"]]
    ramp = limits["ramp"]
    lo = params["kelpThresh"]
    hi = lo + ramp
    strength = idx.subtract(lo).divide(ramp).clamp(0, 1)
    alpha = strength.pow(0.7).multiply(kelp)
    # Keyword arguments, NOT a params dict. The JavaScript API takes
    # visualize({min, max, palette}); the Python signature is
    # visualize(bands, gain, bias, min, max, gamma, palette, ...), so a dict is
    # swallowed positionally as `bands` and fails with
    #   "Expected a string or list of strings for field 'bands'".
    visual = idx.visualize(min=lo, max=hi, palette=KELP_PALETTE)
    return visual.updateMask(alpha)


def tile_url(image):
    """Mint a tile template, tolerating both getMapId return shapes.

    Recent earthengine-api returns a `tile_fetcher` object carrying the full
    template; older builds return only a `mapid` string to interpolate. Reading
    just one of them is what makes this fail on a version bump."""
    mapid = image.getMapId({})
    fetcher = mapid.get("tile_fetcher") if isinstance(mapid, dict) else None
    if fetcher is not None and getattr(fetcher, "url_format", None):
        return fetcher.url_format
    raw = mapid["mapid"]
    if raw.startswith("projects/"):
        return "https://earthengine.googleapis.com/v1/%s/tiles/{z}/{x}/{y}" % raw
    return (
        "https://earthengine.googleapis.com/map/%s/{z}/{x}/{y}?token=%s"
        % (raw, mapid.get("token", ""))
    )


# ------------------------------------------------------------------ validation


def clamp(value, low, high):
    return max(low, min(high, value))


def read_params(args):
    index_type = args.get("index", "KD").upper()
    if index_type not in INDEX_LIMITS:
        index_type = "KD"
    limits = INDEX_LIMITS[index_type]
    try:
        kelp_thresh = float(args.get("kelpThresh", 0.003216))
    except ValueError:
        kelp_thresh = 0.003216
    try:
        b11_thresh = float(args.get("b11Thresh", 0.028))
    except ValueError:
        b11_thresh = 0.028
    return {
        "indexType": index_type,
        "kelpThresh": clamp(kelp_thresh, limits["min"], limits["max"]),
        "b11Thresh": clamp(b11_thresh, 0.0, 0.1),
    }


def read_dates(args, key_start="start", key_end="end"):
    start = args.get(key_start, "")
    end = args.get(key_end, "")
    try:
        d0 = dt.date.fromisoformat(start)
        d1 = dt.date.fromisoformat(end)
    except ValueError:
        raise ValueError("start and end must be YYYY-MM-DD")
    if d1 < d0:
        raise ValueError("end is before start")
    if (d1 - d0).days > MAX_RANGE_DAYS:
        raise ValueError("range longer than %d days" % MAX_RANGE_DAYS)
    return d0.isoformat(), d1.isoformat()


# -------------------------------------------------------------------- endpoints


@app.after_request
def no_store(resp):
    # Minted map ids expire; never let an intermediary hold them past their life.
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.route("/health")
def health():
    return jsonify({"ok": True, "project": PROJECT})


@app.route("/scenes")
def scenes():
    if rate_limited(request.remote_addr or "?"):
        return jsonify({"error": "rate limited"}), 429
    try:
        start, end = read_dates(request.args)
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    max_cloud = clamp(float(request.args.get("maxCloud", 100)), 0, 100)
    key = "scenes|%s|%s|%s" % (start, end, max_cloud)
    cached = cache_get(key)
    if cached is not None:
        return jsonify(cached)

    ensure_ee()
    col = collection(start, end, max_cloud)
    feats = col.map(
        lambda img: ee.Feature(
            None,
            {
                "id": img.get("system:index"),
                "date": img.date().format("YYYY-MM-dd"),
                "cloud": img.get("CLOUDY_PIXEL_PERCENTAGE"),
            },
        )
    )
    rows = [f["properties"] for f in ee.FeatureCollection(feats).getInfo()["features"]]

    # one entry per date, keeping the clearest — same rule as the browser client
    by_date = {}
    for r in rows:
        cur = by_date.get(r["date"])
        if cur is None or r["cloud"] < cur["cloud"]:
            by_date[r["date"]] = r
    out = sorted(by_date.values(), key=lambda r: r["date"])
    cache_put(key, out, SCENES_TTL_SECONDS)
    return jsonify(out)


@app.route("/layer")
def layer():
    if rate_limited(request.remote_addr or "?"):
        return jsonify({"error": "rate limited"}), 429

    mode = request.args.get("mode", "single")
    params = read_params(request.args)
    max_cloud = clamp(float(request.args.get("maxCloud", 40)), 0, 100)

    try:
        if mode == "composite":
            start, end = read_dates(request.args)
            cache_key = "layer|composite|%s|%s|%s|%s|%s|%s" % (
                start, end, max_cloud, params["indexType"],
                params["kelpThresh"], params["b11Thresh"],
            )
        else:
            date = request.args.get("date", "")
            dt.date.fromisoformat(date)          # validate
            cache_key = "layer|single|%s|%s|%s|%s" % (
                date, params["indexType"], params["kelpThresh"], params["b11Thresh"],
            )
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    cached = cache_get(cache_key)
    if cached is not None:
        return jsonify(dict(cached, cached=True))

    try:
        ensure_ee()
        if mode == "composite":
            # median, not mean — see the note in js/ee-kelp.js compositeLayer
            clear = collection(start, end, max_cloud).map(
                lambda img: reflectance(img).updateMask(clear_sky(img))
            )
            kelp, idx = classify(clear.median(), params, None)
        else:
            day = ee.Date(date)
            img = ee.Image(collection(date, day.advance(1, "day"), 100).mosaic())
            kelp, idx = classify(reflectance(img), params, clear_sky(img))

        payload = {
            "urlFormat": tile_url(render(kelp, idx, params)),
            "expiresIn": MAPID_TTL_SECONDS,
        }
    except Exception as err:                    # noqa: BLE001 — reported, not hidden
        # A bare 500 page says nothing, and this service is remote by design, so
        # the reason has to travel back with the response as well as to the log.
        logging.exception("layer failed")
        return jsonify({"error": "%s: %s" % (type(err).__name__, err)}), 500

    cache_put(cache_key, payload, MAPID_TTL_SECONDS)
    return jsonify(payload)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
