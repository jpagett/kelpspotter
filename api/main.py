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
import re
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

# Generous bound: the whole Sentinel-2 archive (2015->now) fits, so any range a
# user can actually pick works — including archive-wide composites, which the
# paper itself ran. The guard only exists to refuse nonsense (e.g. year 9999)
# before it reaches Earth Engine. Note /scenes shares this validator with
# /layer: when it was 400, a wide-but-valid range failed at the *scene listing*
# step and surfaced client-side as a bogus "no passes under N% cloud".
MAX_RANGE_DAYS = 4500
MAPID_TTL_SECONDS = 30 * 60   # minted ids are ephemeral; re-mint after this
# Every layer this service can render. Mirrors the `mode:` values in
# js/api-kelp.js — a mode added there and not here is refused by name.
MODES = ("single", "composite", "truecolor", "turbidity", "turbidityComposite",
         "cloud", "cloudComposite")
SCENES_TTL_SECONDS = 60 * 60
RATE_LIMIT_PER_MIN = 60       # per client IP, best effort (see README)

S2_RED, S2_RE6, S2_NIR, S2_SWIR = "B4", "B6", "B8", "B11"
S2_AERO, S2_BLUE, S2_GREEN = "B1", "B2", "B3"        # turbidity + cloud mask
L_RED, L_NIR, L_SWIR = 0.665, 0.833, 1.612          # µm, as in the paper's code
DEM_ID = "USGS/SRTMGL1_003"
# Mirrors KELP_PALETTES in js/config.js — any change there must land here too.
KELP_PALETTES = {
    "canopy":    ["216b29", "5cb833", "edd633", "fa6614"],
    "amber":     ["7a6a1f", "d9a441", "f2b134", "ffd166"],
    "viridis":   ["440154", "31688e", "35b779", "fde725"],
    "inferno":   ["1b0c41", "781c6d", "ed6925", "fcffa4"],
    "magma":     ["000004", "51127c", "b73779", "fcfdbf"],
    "plasma":    ["0d0887", "9c179e", "ed7953", "f0f921"],
    "thermal":   ["042333", "7c1d6f", "e35933", "e8fa5b"],
    "ice":       ["0d3b66", "3fa7d6", "90e0ef", "caf0f8"],
    "grayscale": ["111111", "555555", "aaaaaa", "f4f4f4"],
}
KELP_PALETTE = KELP_PALETTES["amber"]
HEX6 = re.compile(r"[0-9a-fA-F]{6}")

# Defaults for the tunable turbidity / cloud-mask params, mirroring DEFAULTS
# in js/config.js — used when a (stale) client omits them. CLOUD_VIS_MAX is a
# display constant (where the cloud tint's brightness ramp saturates), not a
# detection parameter, so it is not client-tunable.
TURBIDITY = {
    "turbMode": "KD490",       # 'KD490' (B2/B3) | 'BLUE_RATIO' (B1/B2, 60 m)
    "turbClarityMin": -0.05,   # rendered as most turbid
    "turbClarityMax": 0.35,    # rendered as clearest
    "turbGlint": True,
    "turbNirFloor": 0.012,
    "turbGlintGain": 1.0,
}
CLOUD_MASK = {"cloudVisMin": 0.18, "cloudSwirMin": 0.10, "cloudWhiteness": 0.55}
CLOUD_VIS_MAX = 0.55
TURBIDITY_PALETTE = ["571f70", "3333ad", "1c7acc", "47d9e6"]
CLOUD_PALETTE = ["566067", "ffffff"]

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
    """TOA DN -> reflectance, the paper's 1e-4 rescale. B1-B3 ride along for
    the turbidity and cloud-mask layers; everything downstream selects by name."""
    return img.select(
        [S2_AERO, S2_BLUE, S2_GREEN, S2_RED, S2_RE6, S2_NIR, S2_SWIR]
    ).divide(10000)


def band_cloud(b, params):
    """Band-based cloud test, mirroring js/ee-kelp.js: bright in the visible
    AND in SWIR, AND spectrally flat. Turbid water/foam stay dark at 1610 nm;
    sand and algae are bright but coloured — both fail a gate. Thresholds are
    client-tunable (the console's Models -> Cloud tab)."""
    vis = b.select(S2_BLUE).add(b.select(S2_GREEN)).add(b.select(S2_RED)).divide(3)
    dev = (
        b.select(S2_BLUE).subtract(vis).abs()
        .add(b.select(S2_GREEN).subtract(vis).abs())
        .add(b.select(S2_RED).subtract(vis).abs())
    )
    return (
        vis.gte(params["cloudVisMin"])
        .And(b.select(S2_SWIR).gte(params["cloudSwirMin"]))
        .And(dev.divide(vis.max(1e-6)).lt(params["cloudWhiteness"]))
    )


def reducer_bands(mode, params):
    """The reflectance bands a composite's render actually reads.

    A composite's cost is dominated by the reducer, and a reducer costs per
    band: median over seven bands is roughly seven sorts per pixel, not one.
    reflectance() carries all seven because the three overlays want different
    subsets, but any single render reads far fewer — the kelp chain never
    touches B1/B2/B3, and the cloud tint never touches anything but the
    visible three. Narrowing the collection to this set BEFORE the reducer is
    the whole optimisation; it cannot change the result, because everything
    downstream selects by name and the dropped bands are the ones nothing asks
    for.

    Applies to the composite modes only. Single-scene renders reduce nothing
    (a one-day mosaic), so there is no reducer to make cheaper there, and the
    full set has to survive anyway for band_cloud's own use.
    """
    if mode == "cloudComposite":
        return [S2_BLUE, S2_GREEN, S2_RED]      # render_cloud reads the visible mean

    # classify(): the index's own inputs, plus B11 for the land test
    keep = {
        "KD":   {S2_RE6, S2_RED},
        "NDVI": {S2_NIR, S2_RED},
        "FAI":  {S2_NIR, S2_RED, S2_SWIR},
    }[params["indexType"]] | {S2_SWIR}

    if mode == "turbidityComposite":
        # clarity_value() reads B1/B2/B3, and B8 as well when deglinting;
        # render_turbidity() also runs the whole kelp classify to exclude canopy
        keep |= {S2_AERO, S2_BLUE, S2_GREEN}
        if params["turbGlint"]:
            keep.add(S2_NIR)

    order = [S2_AERO, S2_BLUE, S2_GREEN, S2_RED, S2_RE6, S2_NIR, S2_SWIR]
    return [b for b in order if b in keep]


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
    palette = params.get("stops") or KELP_PALETTES.get(params.get("palette", "amber"), KELP_PALETTE)
    # Keyword arguments, NOT a params dict. The JavaScript API takes
    # visualize({min, max, palette}); the Python signature is
    # visualize(bands, gain, bias, min, max, gamma, palette, ...), so a dict is
    # swallowed positionally as `bands` and fails with
    #   "Expected a string or list of strings for field 'bands'".
    visual = idx.visualize(min=lo, max=hi, palette=palette)
    return visual.updateMask(alpha)


def render_truecolor(img):
    """Plain RGB read of the scene — an alternative to the kelp mask, not a
    layer on top of it. Raw TOA DN, same as render(): visualize()'s min/max is
    just a display stretch either way."""
    return img.select(["B4", "B3", "B2"]).visualize(min=0, max=2500, gamma=1.3)


def clarity_value(b, params):
    """Normalized blue/green difference, glint-corrected. High = clear water.
    Mirrors clarityValue in js/ee-kelp.js; knobs are client-tunable."""
    b1, b2, b3 = b.select(S2_AERO), b.select(S2_BLUE), b.select(S2_GREEN)
    if params["turbGlint"]:
        glint = (
            b.select(S2_NIR).subtract(params["turbNirFloor"]).max(0)
            .multiply(params["turbGlintGain"])
        )
        b1 = b1.subtract(glint).max(0)
        b2 = b2.subtract(glint).max(0)
        b3 = b3.subtract(glint).max(0)
    if params["turbMode"] == "BLUE_RATIO":
        return b1.subtract(b2).divide(b1.add(b2).add(1e-6))
    return b2.subtract(b3).divide(b2.add(b3).add(1e-6))   # KD490-style


def render_turbidity(b, params, clear=None):
    """Water only (same B11 test as the kelp chain, plus the sea-level DEM),
    kelp-classified pixels excluded, clouds excluded when `clear` is given."""
    water = b.select(S2_SWIR).lte(params["b11Thresh"]).And(ee.Image(DEM_ID).eq(0))
    kelp, _ = classify(b, params)
    mask = water.And(kelp.Not())
    if clear is not None:
        mask = mask.And(clear)
    palette = params.get("tstops") or TURBIDITY_PALETTE
    visual = clarity_value(b, params).visualize(
        min=params["turbClarityMin"], max=params["turbClarityMax"], palette=palette
    )
    return visual.updateMask(mask)


def render_cloud(b, cloud, params):
    """Cloud pixels tinted by their visible brightness — texture, not a flat
    stamp. Faint QA60-only detections clamp to the palette's dark end."""
    palette = params.get("cstops") or CLOUD_PALETTE
    vis = b.select(S2_BLUE).add(b.select(S2_GREEN)).add(b.select(S2_RED)).divide(3)
    visual = vis.visualize(
        min=params["cloudVisMin"], max=CLOUD_VIS_MAX, palette=palette
    )
    return visual.updateMask(cloud)


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
    palette = args.get("palette", "amber")
    if palette not in KELP_PALETTES:
        palette = "amber"
    # The client may send an explicit ramp (the named palette already sliced to
    # the legend's selected range). Only accept well-formed 6-digit hex so a
    # crafted query cannot inject arbitrary strings into the EE call.
    stops = [s for s in args.get("stops", "").split(",") if HEX6.fullmatch(s)]
    # turbidity / cloud-mask palettes, validated the same way
    tstops = [s for s in args.get("tstops", "").split(",") if HEX6.fullmatch(s)]
    cstops = [s for s in args.get("cstops", "").split(",") if HEX6.fullmatch(s)]

    # Tunable model numbers: clamped, never rejected, defaulting to the
    # config.js mirrors so a stale client still gets a usable map.
    def fnum(name, default, lo, hi):
        try:
            return clamp(float(args.get(name, default)), lo, hi)
        except (TypeError, ValueError):
            return default

    t = TURBIDITY
    clarity_min = fnum("turbClarityMin", t["turbClarityMin"], -1.0, 1.0)
    clarity_max = fnum("turbClarityMax", t["turbClarityMax"], -1.0, 1.0)
    if clarity_max <= clarity_min:          # a degenerate stretch renders nothing
        clarity_max = clarity_min + 0.01
    return {
        "indexType": index_type,
        "kelpThresh": clamp(kelp_thresh, limits["min"], limits["max"]),
        "b11Thresh": clamp(b11_thresh, 0.0, 0.1),
        "palette": palette,
        "stops": stops[:16] if len(stops) >= 2 else [],
        "tstops": tstops[:16] if len(tstops) >= 2 else [],
        "cstops": cstops[:16] if len(cstops) >= 2 else [],
        # while the cloud-mask overlay is on, kelp and turbidity computations
        # exclude cloud-covered pixels (per scene, before a composite's median)
        "cloudMask": args.get("cloudMask") == "1",
        "cloudVisMin": fnum("cloudVisMin", CLOUD_MASK["cloudVisMin"], 0.0, 1.0),
        "cloudSwirMin": fnum("cloudSwirMin", CLOUD_MASK["cloudSwirMin"], 0.0, 1.0),
        "cloudWhiteness": fnum("cloudWhiteness", CLOUD_MASK["cloudWhiteness"], 0.0, 2.0),
        "turbMode": "BLUE_RATIO" if args.get("turbMode") == "BLUE_RATIO" else "KD490",
        "turbClarityMin": clarity_min,
        "turbClarityMax": clarity_max,
        "turbGlint": args.get("turbGlint", "1") != "0",
        "turbNirFloor": fnum("turbNirFloor", t["turbNirFloor"], 0.0, 0.2),
        "turbGlintGain": fnum("turbGlintGain", t["turbGlintGain"], 0.0, 5.0),
    }


def aux_sig(params):
    """Cache-key fragment for the tunable turbidity/cloud numbers — without it
    two clients with different thresholds would share a minted layer."""
    return "|".join(
        str(params[k])
        for k in (
            "cloudMask", "cloudVisMin", "cloudSwirMin", "cloudWhiteness",
            "turbMode", "turbClarityMin", "turbClarityMax",
            "turbGlint", "turbNirFloor", "turbGlintGain",
        )
    )


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

    # Name an unknown mode instead of letting it fall through to the
    # single-scene branch, which then demands a `date` the caller never sent
    # and reports the miss as "Invalid isoformat string: ''". That is exactly
    # what a client running ahead of a not-yet-redeployed backend hits, and the
    # date complaint sends the reader looking in entirely the wrong place.
    if mode not in MODES:
        return jsonify({"error": "unknown mode: %s" % mode}), 400

    try:
        if mode in ("composite", "turbidityComposite", "cloudComposite"):
            start, end = read_dates(request.args)
            cache_key = "layer|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s" % (
                mode, start, end, max_cloud, params["indexType"],
                params["kelpThresh"], params["b11Thresh"], params["palette"],
                ",".join(params["stops"]), ",".join(params["tstops"]),
                ",".join(params["cstops"]), aux_sig(params),
            )
        elif mode == "truecolor":
            date = request.args.get("date", "")
            dt.date.fromisoformat(date)          # validate
            cache_key = "layer|truecolor|%s" % date
        else:                                    # single-scene kelp/turbidity/cloud
            date = request.args.get("date", "")
            dt.date.fromisoformat(date)          # validate
            cache_key = "layer|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s" % (
                mode, date, params["indexType"], params["kelpThresh"],
                params["b11Thresh"], params["palette"], ",".join(params["stops"]),
                ",".join(params["tstops"]), ",".join(params["cstops"]),
                aux_sig(params),
            )
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    cached = cache_get(cache_key)
    if cached is not None:
        return jsonify(dict(cached, cached=True))

    try:
        ensure_ee()

        def masked_collection():
            """Per-scene cloud masking BEFORE the median: QA60 always, the
            band test joining in while the cloud-mask overlay is enabled."""
            gate = params["cloudMask"]
            keep = reducer_bands(mode, params)

            def prep(img):
                b = reflectance(img)
                m = clear_sky(img)
                if gate:
                    # the band test reads B2/B3/B4/B11, so it runs against the
                    # full image — the narrowing below is what reaches the median
                    m = m.And(band_cloud(b, params).Not())
                return b.select(keep).updateMask(m)

            return collection(start, end, max_cloud).map(prep)

        def scene_and_clear():
            """The day's mosaic reflectance plus its clear-pixel mask."""
            day = ee.Date(date)
            img = ee.Image(collection(date, day.advance(1, "day"), 100).mosaic())
            b = reflectance(img)
            clear = clear_sky(img)
            if params["cloudMask"]:
                clear = clear.And(band_cloud(b, params).Not())
            return img, b, clear

        if mode == "composite":
            # median, not mean — see the note in js/ee-kelp.js compositeLayer
            kelp, idx = classify(masked_collection().median(), params, None)
            image = render(kelp, idx, params)
        elif mode == "turbidityComposite":
            image = render_turbidity(masked_collection().median(), params, None)
        elif mode == "cloudComposite":
            # a composite's honest cloud mask: pixels with NO clear observation
            # anywhere in the window, tinted by the median brightness
            col = collection(start, end, max_cloud)
            clear_count = col.map(
                lambda img: clear_sky(img)
                .And(band_cloud(reflectance(img), params).Not())
                .toInt().unmask(0).rename("clear")
            ).sum()
            never = clear_count.eq(0).clip(region())
            tint = reducer_bands(mode, params)
            image = render_cloud(
                col.map(lambda img: reflectance(img).select(tint)).median(), never, params
            )
        elif mode == "truecolor":
            day = ee.Date(date)
            img = ee.Image(collection(date, day.advance(1, "day"), 100).mosaic())
            image = render_truecolor(img)
        elif mode == "turbidity":
            _, b, clear = scene_and_clear()
            image = render_turbidity(b, params, clear)
        elif mode == "cloud":
            img, b, _ = scene_and_clear()
            cloud = band_cloud(b, params).Or(clear_sky(img).Not())
            image = render_cloud(b, cloud, params)
        else:
            _, b, clear = scene_and_clear()
            kelp, idx = classify(b, params, clear)
            image = render(kelp, idx, params)

        payload = {
            "urlFormat": tile_url(image),
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
