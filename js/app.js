/* KelpSpotter app wiring. Talks to whichever engine is available
   (KelpEngine when Earth Engine is connected, else DemoEngine) through
   one shared interface: listScenes / singleSceneLayer / compositeLayer. */
(function () {
  const cfg = window.KELP_CONFIG;
  const $ = (id) => document.getElementById(id);

  // Touch or pen: hit areas that are comfortable for a cursor are not for a
  // fingertip, and several places on the profile plot size themselves by this.
  const COARSE_POINTER = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  /*
   * How close to the drawn seabed a press counts as "grab this stretch and
   * lift it" — in viewBox px, since that is what the plot is drawn in. One
   * constant because TWO things must agree on it exactly: the hit test that
   * starts an offset drag, and the invisible band that tells the browser not
   * to scroll there. If the band were the smaller of the two, a press in the
   * gap would start a drag and get scrolled out from under itself.
   */
  const SEABED_GRAB_PX = COARSE_POINTER ? 30 : 14;

  /*
   * ---- drag readout ----
   * A value that is being dragged should say what it is while it is being
   * dragged. The plot's numbers live inside an SVG that is torn down and
   * rebuilt on every frame of a drag, so the readout is a plain DOM chip that
   * follows the pointer instead — it survives the re-render, and it stays
   * legible over the plot at any zoom. Offset above the finger so the value
   * is not under the hand setting it.
   */
  let dragReadoutEl = null;
  function showDragReadout(text, clientX, clientY) {
    if (!dragReadoutEl) {
      dragReadoutEl = document.createElement('div');
      dragReadoutEl.className = 'drag-readout';
      document.body.appendChild(dragReadoutEl);
    }
    dragReadoutEl.textContent = text;
    dragReadoutEl.style.left = clientX + 'px';
    dragReadoutEl.style.top = Math.max(4, clientY - (COARSE_POINTER ? 46 : 26)) + 'px';
    dragReadoutEl.classList.add('show');
  }
  function hideDragReadout() {
    if (dragReadoutEl) dragReadoutEl.classList.remove('show');
  }

  const state = {
    engine: null,
    scenes: [],        // filtered to the current cloud ceiling
    allScenes: [],     // every pass in range, cached per date range
    idx: -1,
    layer: null,
    range: { start: null, end: null }, // filled in at boot from LOOKBACK_DAYS
    params: Object.assign({}, cfg.DEFAULTS)
  };

  /*
   * ---- persistence ----
   * Settings and paths live in localStorage (across visits); the date range
   * and selected scene in sessionStorage (per tab). Restoring params happens
   * RIGHT HERE, before any of the module-scope UI wiring below reads them —
   * merged over the DEFAULTS copy so config keys added later still get their
   * defaults. STORE_V discards stored data wholesale on a schema change
   * rather than half-loading it. Every write is best-effort: private-mode or
   * full storage degrades to a stateless session, never a broken one.
   */
  const STORE_V = '1';
  try {
    if (localStorage.getItem('kelp.v') !== STORE_V) {
      localStorage.removeItem('kelp.params');
      localStorage.removeItem('kelp.paths');
      localStorage.removeItem('kelp.pois');
      localStorage.setItem('kelp.v', STORE_V);
    } else {
      const saved = JSON.parse(localStorage.getItem('kelp.params') || 'null');
      if (saved && typeof saved === 'object') Object.assign(state.params, saved);
    }
  } catch (err) { console.warn('settings restore skipped:', err); }

  // ---- map ----
  const [w, s, e, n] = cfg.AOI;
  // zoomControl:false — replaced by the custom horizontal control in .corner-br
  const map = L.map('map', { zoomControl: false, attributionControl: true })
    .fitBounds([[s, w], [n, e]]);
  window.__kelpMap = map;   // console/debug handle; nothing in the app uses it
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());
  /*
   * One subdomain on purpose. Sharding across a-d was an HTTP/1.1 trick; on
   * HTTP/2 it splits tiles over four TLS connections instead of multiplexing
   * one, and a cold shard was the third-slowest request of the whole boot.
   */
  L.tileLayer('https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
  }).addTo(map);

  /*
   * Stacking order. The basemap is an opaque dark layer in the default tilePane
   * (z-index 200), so anything sent behind it is invisible — the depth overlay
   * needs its own pane above it, and the kelp needs a pane above that. The demo
   * engine's canvas lives in Leaflet's overlayPane (400) and stays on top.
   */
  // both unit systems, matching the configurable readouts everywhere else
  L.control.scale({ position: 'bottomleft', maxWidth: 130, imperial: true, metric: true }).addTo(map);

  map.createPane('truecolor').style.zIndex = 240;   // an alternative base image, so it sits just under depth
  map.createPane('depth').style.zIndex = 250;
  map.createPane('contour').style.zIndex = 260;
  map.createPane('turbidity').style.zIndex = 280;   // water clarity, under the kelp
  map.createPane('kelpPane').style.zIndex = 350;
  map.createPane('cloudmask').style.zIndex = 330;   // masked pixels read over everything below
  // initial values only — applyOverlayOrder() rewrites all of these from
  // state.params.overlayOrder as soon as the overlay picker initialises

  // ---- helpers ----
  let toastTimer;
  function toast(msg, warn) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (warn ? ' warn' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 3800);
  }
  function sweep(on) { $('sweep').className = 'sweep' + (on ? ' on' : ''); }

  // ---- activity readout ----
  // A running account of what the app is doing, so long Earth Engine round-trips
  // and tile loads aren't silent. Busy is a counter, not a flag: scene listing,
  // the kelp computation and the depth tiles can all be in flight at once.
  const ACT_MAX = 8;
  let busyCount = 0;
  function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    $('act-dot').className = 'act-dot' + (busyCount ? ' on' : '');
  }
  function say(msg, kind) {
    const ul = $('act-log');
    const li = document.createElement('li');
    li.className = 'act-line' + (kind ? ' ' + kind : '');
    const t = document.createElement('span');
    t.className = 'act-t';
    t.textContent = new Date().toTimeString().slice(0, 8);
    const m = document.createElement('span');
    m.className = 'act-m';
    m.textContent = msg;                 // textContent: messages can carry user input
    li.appendChild(t); li.appendChild(m);
    ul.appendChild(li);
    while (ul.children.length > ACT_MAX) ul.removeChild(ul.firstChild);
    ul.scrollTop = ul.scrollHeight;
  }

  // scene cloud cover, always to one decimal
  const pct = (v) => Number(v).toFixed(1);

  const iso = (d) => d.toISOString().slice(0, 10);

  // The window the user picked, or the LOOKBACK_DAYS default before they touch it.
  function defaultRange() {
    return [iso(new Date(Date.now() - cfg.LOOKBACK_DAYS * 86400000)),
            iso(new Date(Date.now() + 86400000))];
  }
  function dateRangeISO() {
    return [state.range.start, state.range.end];
  }

  /*
   * A hidden overlay comes OFF the map rather than merely out of sight.
   *
   * Leaflet drives tile loading from map events, not from visibility, so a
   * layer left attached under a display:none pane still fetches a full tile
   * set on every pan and zoom. Measured at a 1280px viewport, one zoom change
   * with two of the four Earth Engine overlays hidden created 96 tiles, 48 of
   * them for panes nobody could see — and each Earth Engine tile is a
   * server-side computation, not a file read.
   *
   * The cost of detaching is that re-showing refetches, which is why this used
   * to hide instead. But the tile URLs are unchanged across a hide/show, and
   * Earth Engine serves tiles with Cache-Control: max-age=3600 (NOAA's go
   * through the service worker's own cache), so the second look is a browser
   * cache hit rather than a recomputation. Paying that once on re-show beats
   * paying a full tile set on every map move while hidden.
   */
  function attachOverlay(layer, on) {
    if (!layer) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    else if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  /*
   * ---- NOAA depth overlays ----
   * Two independent WMS layers, each in its own pane so they toggle separately
   * and always sit under the kelp. Layers are created lazily, so an overlay the
   * user never enables costs nothing.
   */
  const DEPTH_LAYERS = {
    relief:   { cfgKey: 'relief',   pane: 'depth',   label: 'NOAA depth relief', layer: null },
    contours: { cfgKey: 'contours', pane: 'contour', label: 'NOAA depth contours', layer: null }
  };

  // the relief WMS layer name for whichever colormap is currently selected
  function reliefLayerName() {
    const styles = cfg.DEPTH.reliefStyles || {};
    const style = styles[state.params.depthStyle] || styles.blue;
    return style ? style.layers : cfg.DEPTH.relief.layers;
  }

  // Both conditions that make a depth layer visible: its own switch, and the
  // shared depth opacity. Either one at zero takes it off the map.
  function syncDepthAttachment() {
    const lit = state.params.depthOpacity > 0;
    attachOverlay(DEPTH_LAYERS.relief.layer, lit && !!state.params.showRelief);
    attachOverlay(DEPTH_LAYERS.contours.layer, lit && !!state.params.showContours);
  }

  function setDepthLayer(key, on) {
    const rec = DEPTH_LAYERS[key];
    if (!on) {
      attachOverlay(rec.layer, false);
      if (!depthEnabled()) hideProbe();   // nothing left to read a depth from
      say(rec.label + ' off');
      return;
    }
    if (rec.layer) { syncDepthAttachment(); return; }   // already built

    const src = cfg.DEPTH[rec.cfgKey];
    say('Loading ' + rec.label + '…');
    busy(true);
    let settled = false;
    const done = (msg, kind) => {
      if (settled) return;
      settled = true;
      say(msg, kind);
      busy(false);
    };
    rec.layer = L.tileLayer.wms(src.url, Object.assign({
      layers: key === 'relief' ? reliefLayerName() : src.layers,
      format: 'image/png', transparent: true,
      version: '1.1.1', attribution: src.attribution, pane: rec.pane,
      opacity: state.params.depthOpacity
    }, cfg.DEPTH.tuning));
    rec.layer.on('load', () => done(rec.label + ' ready', 'ok'));
    rec.layer.on('tileerror', () => done(rec.label + ' — some tiles failed', 'warn'));
    syncDepthAttachment();
    if (!map.hasLayer(rec.layer)) done(rec.label + ' ready', 'ok');   // built, but the opacity slider is at zero
  }

  function setDepthOpacity(v) {
    state.params.depthOpacity = v;
    if (DEPTH_LAYERS.relief.layer) DEPTH_LAYERS.relief.layer.setOpacity(v);
    syncDepthAttachment();   // zeroing the slider takes both layers off the map
    // one opacity, two controls — keep the console slider and the corner
    // flyout showing the same value no matter which one moved
    $('depth-op').value = v;
    $('depth-op-val').textContent = Math.round(v * 100) + '%';
    $('ov-ruler-slider').value = v;
  }

  /*
   * ---- true color (B4/B3/B2) ----
   * A plain RGB read of the current scene, tied to whatever single day is
   * selected — an alternative to the kelp mask rather than a layer stacked on
   * top of it, so it lives in its own pane just under depth.
   *
   * Loading it has two slow halves, each addressed separately:
   *   1. Minting a tile-URL template (getMapId / the API call) — cached here
   *     per engine+date with a TTL just under the backend's map-id expiry, so
   *     revisiting a scene never re-pays the mint round trip.
   *   2. EE rendering tiles on first request — once true color has been used
   *     this session (kelp.tcUsed), the layer is rebuilt in the background on
   *     every scene change even at opacity 0. The pane is hidden but the tile
   *     <img>s still fetch, so EE renders and caches the CURRENT VIEWPORT's
   *     tiles while the user is looking at the kelp mask — toggling the eye is
   *     then instant for the exact ROI on screen. Users who never touch true
   *     color never trigger any of this.
   */
  let trueColorLayer = null, trueColorDate = null, trueColorLoading = false;
  const tcUrlCache = new Map();          // engine|date -> {url, at}
  const TC_URL_TTL_MS = 25 * 60 * 1000;  // under the backend's 30-min map-id life
  let tcUsed = false;
  try { tcUsed = sessionStorage.getItem('kelp.tcUsed') === '1'; } catch (err) { /* fine */ }

  async function mintTrueColor(date) {
    const key = state.engine.name + '|' + date;
    const hit = tcUrlCache.get(key);
    if (hit && Date.now() - hit.at < TC_URL_TTL_MS) return hit.url;
    const res = await state.engine.trueColorLayer(date);
    if (typeof res === 'string') {
      if (tcUrlCache.size > 60) tcUrlCache.clear();   // crude bound; entries expire anyway
      tcUrlCache.set(key, { url: res, at: Date.now() });
    }
    return res;
  }

  /*
   * Which scene true colour should show. A composite spans the whole window
   * and has no single day, so it falls back to the most recent pass in range
   * — the freshest look at the water the composite was built from.
   */
  function trueColorScene() {
    if (state.params.mode === 'composite') return state.scenes[state.scenes.length - 1];
    return state.scenes[state.idx];
  }

  async function ensureTrueColor(prewarm) {
    const sc = trueColorScene();
    if (!sc || trueColorLoading) return;
    if (trueColorLayer && trueColorDate === sc.date) return;   // already built for this date
    if (typeof state.engine.trueColorLayer !== 'function') return;
    trueColorLoading = true;
    if (!prewarm) say('Loading true color · ' + sc.date + '…');
    try {
      const res = await mintTrueColor(sc.date);
      const now = trueColorScene();
      if (!now || now.date !== sc.date) return;   // scene changed mid-mint; next call rebuilds
      if (trueColorLayer) map.removeLayer(trueColorLayer);
      trueColorLayer = toLeafletLayer(res, { pane: 'truecolor', opacity: state.params.trueColorOpacity });
      /*
       * A prewarm builds the layer and banks the minted URL — the slow half —
       * but leaves it off the map. Attaching it would stream a full tile set
       * now and another on every pan for as long as it stayed hidden; the eye
       * toggle is still fast because the mint round trip is already paid.
       */
      attachOverlay(trueColorLayer, state.params.trueColorOpacity > 0);
      trueColorDate = sc.date;
      if (!prewarm) say('True color ready · ' + sc.date, 'ok');
    } catch (err) {
      console.warn(err);
      if (prewarm) return;    // background warm-up failing is not worth a toast
      say('True color unavailable — ' + err.message, 'warn');
      toast(err.message, true);
      // opacity 0 is enough: the icon's pressed state now derives from opacity,
      // so it stops reading "active" over a layer that never loaded
      setTrueColorOpacity(0);
      syncOverlayPicker();
    } finally {
      trueColorLoading = false;
    }
  }

  function setTrueColorOpacity(v) {
    state.params.trueColorOpacity = v;
    map.getPane('truecolor').style.display = v > 0 ? '' : 'none';
    attachOverlay(trueColorLayer, v > 0);
    if (v > 0) {
      if (!tcUsed) {
        tcUsed = true;   // from here on, scene changes prewarm the layer in the background
        try { sessionStorage.setItem('kelp.tcUsed', '1'); } catch (err) { /* fine */ }
      }
      ensureTrueColor();
    }
    if (trueColorLayer && trueColorLayer.setOpacity) trueColorLayer.setOpacity(v);
  }

  /*
   * ---- turbidity & cloud mask ----
   * Two more scene-derived overlays, modelled on true color above: each keeps
   * one layer in its own pane and re-mints when its inputs change. Unlike true
   * color they follow the single/composite mode split the same way the kelp
   * layer does, so each build is keyed on everything it was derived from and
   * rebuilt only when that key goes stale.
   *
   * The cloud mask is also a computation gate: while it is enabled (opacity
   * above zero) the kelp and turbidity layers are computed EXCLUDING cloudy
   * pixels — per scene, before the median in composite mode. Crossing the
   * on/off boundary therefore re-runs the kelp map; the mint caches carry the
   * flag, so toggling straight back is a cache hit, not a recompute.
   */
  let turbLayer = null, turbBuiltKey = null, turbBuiltAt = 0, turbLoading = false;
  let cloudLayer = null, cloudBuiltKey = null, cloudBuiltAt = 0, cloudLoading = false;
  const auxUrlCache = new Map();          // build key -> {url, at}
  const AUX_URL_TTL_MS = 25 * 60 * 1000;  // under the backend's 30-min map-id life

  const cloudMaskOn = () => (state.params.cloudOpacity || 0) > 0;

  // Tunable-model signatures for the mint cache keys. cloudSig only counts
  // while the mask is gating (or drawing) — with the mask off, its thresholds
  // are latent and changing them must not invalidate anything.
  function cloudSig() {
    const P = state.params;
    return [P.cloudVisMin, P.cloudSwirMin, P.cloudWhiteness].join(',');
  }
  function turbSig() {
    const P = state.params;
    return [P.turbMode, P.turbClarityMin, P.turbClarityMax,
            P.turbGlint === false ? 0 : 1, P.turbNirFloor, P.turbGlintGain].join(',');
  }

  // everything the mint depends on; the mode part mirrors layerCacheKey's
  function auxModePart() {
    if (state.params.mode === 'composite') {
      return 'c|' + state.range.start + '|' + state.range.end + '|' +
             state.params.maxCloud + '|' + compositeDateSig();
    }
    const sc = state.scenes[state.idx];
    return 's|' + (sc ? sc.date : '');
  }
  function turbKey() {
    const P = state.params;
    // kelp params matter: kelp-classified pixels are excluded from the render
    return [state.engine.name, 'turb', P.turbidityPalette, turbSig(),
            cloudMaskOn() ? 'cm:' + cloudSig() : '',
            P.indexType, P.kelpThresh, P.b11Thresh, auxModePart()].join('|');
  }
  function cloudKey() {
    return [state.engine.name, 'cloud', state.params.cloudPalette, cloudSig(),
            auxModePart()].join('|');
  }

  async function ensureAux(kind) {
    const isTurb = kind === 'turbidity';
    const label = isTurb ? 'Turbidity' : 'Cloud mask';
    if (isTurb ? turbLoading : cloudLoading) return;
    if (!state.engine || !state.scenes.length) return;
    const composite = state.params.mode === 'composite';
    if (!composite && !state.scenes[state.idx]) return;
    const method = isTurb
      ? (composite ? 'turbidityCompositeLayer' : 'turbidityLayer')
      : (composite ? 'cloudCompositeLayer' : 'cloudLayer');
    if (typeof state.engine[method] !== 'function') return;
    const key = isTurb ? turbKey() : cloudKey();
    // current AND younger than the mint's lifetime — an old build whose tile
    // URL has expired must be re-minted even though nothing else changed
    const fresh = Date.now() - (isTurb ? turbBuiltAt : cloudBuiltAt) < AUX_URL_TTL_MS;
    if ((isTurb ? turbBuiltKey : cloudBuiltKey) === key && fresh) return;

    if (isTurb) turbLoading = true; else cloudLoading = true;
    say('Loading ' + label.toLowerCase() + '…');
    try {
      const hit = auxUrlCache.get(key);
      let res;
      if (hit && Date.now() - hit.at < AUX_URL_TTL_MS) {
        res = hit.url;
      } else {
        if (composite) {
          const range = dateRangeISO();
          res = await state.engine[method](
            range[0], range[1], state.params.maxCloud, state.params, compositeDates());
        } else {
          res = await state.engine[method](state.scenes[state.idx].date, state.params);
        }
        if (typeof res === 'string') {
          if (auxUrlCache.size > 60) auxUrlCache.clear();   // crude bound; entries expire anyway
          auxUrlCache.set(key, { url: res, at: Date.now() });
        }
      }
      // inputs changed mid-mint: drop this result, the change's own trigger
      // re-invokes (same rule as ensureTrueColor)
      if ((isTurb ? turbKey() : cloudKey()) !== key) return;
      const old = isTurb ? turbLayer : cloudLayer;
      if (old) map.removeLayer(old);
      const opacity = isTurb ? state.params.turbidityOpacity : state.params.cloudOpacity;
      const layer = toLeafletLayer(res, {
        pane: isTurb ? 'turbidity' : 'cloudmask',
        opacity: opacity
      });
      attachOverlay(layer, opacity > 0);
      if (isTurb) { turbLayer = layer; turbBuiltKey = key; turbBuiltAt = Date.now(); }
      else { cloudLayer = layer; cloudBuiltKey = key; cloudBuiltAt = Date.now(); }
      say(label + ' ready', 'ok');
    } catch (err) {
      console.warn(err);
      say(label + ' unavailable — ' + err.message, 'warn');
      toast(err.message, true);
      // zero opacity is enough: the icon's pressed state derives from it, so
      // it stops reading "active" over a layer that never loaded
      (isTurb ? setTurbidityOpacity : setCloudOpacity)(0);
      syncOverlayPicker();
    } finally {
      if (isTurb) turbLoading = false; else cloudLoading = false;
    }
  }
  const ensureTurbidity = () => ensureAux('turbidity');
  const ensureCloudMask = () => ensureAux('clouds');

  function setTurbidityOpacity(v) {
    state.params.turbidityOpacity = v;
    map.getPane('turbidity').style.display = v > 0 ? '' : 'none';
    attachOverlay(turbLayer, v > 0);
    if (v > 0) ensureTurbidity();
    if (turbLayer && turbLayer.setOpacity) turbLayer.setOpacity(v);
    // one opacity, three controls — the corner flyout and the Models tab
    // mirror each other, same pattern as setDepthOpacity
    $('turb-op').value = v;
    $('turb-op-val').textContent = Math.round(v * 100) + '%';
    // the legend's summary ramp for turbidity only shows while the overlay does
    $('turb-line').hidden = !(v > 0);
  }

  let cloudWasOn = false;   // synced to the restored params just below
  function setCloudOpacity(v) {
    state.params.cloudOpacity = v;
    map.getPane('cloudmask').style.display = v > 0 ? '' : 'none';
    attachOverlay(cloudLayer, v > 0);
    if (v > 0) ensureCloudMask();
    if (cloudLayer && cloudLayer.setOpacity) cloudLayer.setOpacity(v);
    $('cloud-op').value = v;
    $('cloud-op-val').textContent = Math.round(v * 100) + '%';
    const on = v > 0;
    if (on !== cloudWasOn) {
      cloudWasOn = on;
      /*
       * The gate flipped: kelp and turbidity must be recomputed with (or
       * without) the cloud exclusion. run() re-mints the kelp layer and its
       * tail re-invokes the visible aux overlays; every mint cache key
       * carries the flag, so flipping back is instant.
       */
      if (state.scenes.length) {
        say('Cloud mask ' + (on ? 'on — recomputing kelp & turbidity without cloud pixels'
                                : 'off — recomputing kelp & turbidity'));
        run();
      }
    }
  }
  // a restored session may re-open these overlays; sync the gate tracker and
  // pane visibility now — the layers themselves build after the first run()
  cloudWasOn = cloudMaskOn();
  map.getPane('turbidity').style.display = state.params.turbidityOpacity > 0 ? '' : 'none';
  map.getPane('cloudmask').style.display = cloudMaskOn() ? '' : 'none';
  $('turb-line').hidden = !(state.params.turbidityOpacity > 0);

  /*
   * ---- depth at the cursor ----
   * The relief ImageServer's `identify` endpoint returns the raw pixel value in
   * metres (negative below sea level) and allows cross-origin reads, so this is a
   * direct browser fetch.
   *
   * mousemove fires far too often to hit the network on each one, so lookups are
   * debounced, the in-flight request is aborted when the cursor moves on, and
   * results are cached per ~11 m of ground. The box follows the cursor
   * immediately either way; it just dims while the value underneath is stale.
   */
  const M_TO_FT = 3.280839895;
  const probeCache = new Map();
  let probeAbort = null, probeTimer = null, probeFailed = false;
  let lastProbePt = null;   // screen position of the last lookup

  const depthEnabled = () => state.params.showRelief || state.params.showContours;

  function moveProbe(ev) {
    const el = $('depth-probe');
    el.style.left = ev.clientX + 'px';
    el.style.top = ev.clientY + 'px';
  }
  function hideProbe() {
    $('depth-probe').className = 'depth-probe';
    clearTimeout(probeTimer);
    lastProbePt = null;      // re-entering the map should read again
    if (probeAbort) { probeAbort.abort(); probeAbort = null; }
  }
  function showProbeLoading() {
    const el = $('depth-probe');
    el.textContent = '…';
    el.className = 'depth-probe show loading';
  }
  function renderProbe(metres) {
    const el = $('depth-probe');
    el.textContent = '';
    const main = document.createElement('span');
    const sub = document.createElement('span');
    sub.className = 'dp-sub';
    if (metres === null || metres === undefined) {
      main.textContent = '—';
      sub.textContent = 'no data';
    } else {
      const ft = Math.round(Math.abs(metres) * M_TO_FT);
      main.textContent = ft.toLocaleString() + ' ft';
      sub.textContent = metres < 0 ? 'depth' : 'elev.';
    }
    el.appendChild(main); el.appendChild(sub);
    el.className = 'depth-probe show';
  }

  /*
   * `urgent` is for the depth crosshair: the one lookup the user is actually
   * waiting on, watching a "…" until it lands. It supersedes the previous
   * read (already true for any probe), cancels the debounced hover read that
   * would otherwise fire behind it, and goes through DemSampler's priority
   * gate so bulk sample batches stop queueing ahead of it.
   */
  async function fetchDepth(latlng, urgent) {
    const key = latlng.lat.toFixed(4) + ',' + latlng.lng.toFixed(4);
    if (probeCache.has(key)) return probeCache.get(key);

    if (urgent && probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    if (probeAbort) probeAbort.abort();
    probeAbort = new AbortController();
    const read = urgent && DemSampler.urgentIdentify
      ? DemSampler.urgentIdentify : DemSampler.identify;
    const metres = await read(latlng.lat, latlng.lng, probeAbort.signal);
    if (probeCache.size > 800) probeCache.clear();
    probeCache.set(key, metres);
    return metres;
  }

  map.on('mousemove', (ev) => {
    if (!depthEnabled()) { hideProbe(); return; }
    const oe = ev.originalEvent;
    moveProbe(oe);

    const key = ev.latlng.lat.toFixed(4) + ',' + ev.latlng.lng.toFixed(4);
    if (probeCache.has(key)) {           // already known — no network, no "…"
      clearTimeout(probeTimer);
      renderProbe(probeCache.get(key));
      lastProbePt = { x: oe.clientX, y: oe.clientY };
      return;
    }

    /*
     * Screen-space guard on top of the debounce: tiny jitters around a spot
     * shouldn't blank a good reading and re-query. Only once the cursor has
     * actually travelled do we treat it as a new place worth reading.
     */
    const minMove = cfg.DEPTH.probe.minMovePx;
    if (lastProbePt) {
      const dx = oe.clientX - lastProbePt.x, dy = oe.clientY - lastProbePt.y;
      if (Math.sqrt(dx * dx + dy * dy) < minMove) return;
    }
    lastProbePt = { x: oe.clientX, y: oe.clientY };
    showProbeLoading();

    clearTimeout(probeTimer);
    const at = ev.latlng;
    probeTimer = setTimeout(() => {
      fetchDepth(at)
        .then(renderProbe)
        .catch((err) => {
          if (err.name === 'AbortError') return;   // superseded by a later move
          renderProbe(undefined);
          if (!probeFailed) { probeFailed = true; say('Depth lookup unavailable', 'warn'); }
        });
    }, 180);
  });
  map.on('mouseout', hideProbe);
  // the same screen point means somewhere new once the map itself has moved
  map.on('movestart zoomstart', () => { lastProbePt = null; });

  /*
   * ---- scenes + scrubber ----
   * Scenes are fetched ONCE per date range, unfiltered (cloud ceiling 100), and
   * every cloud-ceiling change is then a client-side filter over that cached
   * list. Previously each nudge of the slider was a fresh Earth Engine round
   * trip; now only changing the date range costs a request. The per-ceiling
   * results are memoised too, so re-picking a ceiling you've already used — the
   * common case when dragging the slider back and forth — is a map lookup.
   */
  const rawScenes = new Map();    // 'start|end'        -> every scene in range
  const filtScenes = new Map();   // 'start|end|ceil'   -> scenes at/under ceiling

  /*
   * The calendar is NOT limited to the current date range. It draws from its own
   * index of every pass we have ever heard about, filled in as the user
   * navigates. Without this, browsing to a month outside the window showed no
   * passes at all — not because there were none, but because nothing had ever
   * asked for them.
   */
  const sceneIndex = new Map();   // 'YYYY-MM-DD' -> {date, cloud}
  const loadedYears = new Map();  // 'YYYY'       -> true once fetched

  /*
   * ---- which cloud number the UI believes ----
   * The sample box, ordered and clamped to the AOI. The backend clamps too —
   * it has to, since a free geometry would aim the project's quota anywhere —
   * but a box dragged past the edge should LOOK like the one being measured.
   */
  /*
   * The default sample box: from config when it is there, derived from the AOI
   * when it is not.
   *
   * The fallback is not paranoia. sw.js serves the app shell
   * stale-while-revalidate, so the first load after a deploy can genuinely pair
   * a fresh app.js with a cached older config.js — and reading
   * cfg.DEFAULTS.cloudSample straight through threw there, aborting boot and
   * dropping the visitor to demo data. A missing preference must never cost
   * someone their live imagery.
   */
  function defaultSampleBox() {
    const d = (cfg.DEFAULTS || {}).cloudSample;
    const ok = (v) => typeof v === 'number' && isFinite(v);
    if (d && ok(d.w) && ok(d.s) && ok(d.e) && ok(d.n)) {
      return { w: d.w, s: d.s, e: d.e, n: d.n };
    }
    const aw = cfg.AOI[0], as = cfg.AOI[1], ae = cfg.AOI[2], an = cfg.AOI[3];
    return { w: aw + (ae - aw) * 0.18, s: as + (an - as) * 0.32,
             e: aw + (ae - aw) * 0.86, n: as + (an - as) * 0.80 };
  }

  function clampSample(box) {
    if (!box) return null;
    const aw = cfg.AOI[0], as = cfg.AOI[1], ae = cfg.AOI[2], an = cfg.AOI[3];
    const lo = (v, a, b) => Math.max(a, Math.min(b, v));
    const w = lo(Math.min(box.w, box.e), aw, ae), e = lo(Math.max(box.w, box.e), aw, ae);
    const s = lo(Math.min(box.s, box.n), as, an), n = lo(Math.max(box.s, box.n), as, an);
    if (e - w < 0.005 || n - s < 0.005) return null;    // reduces over nothing
    return { w: w, s: s, e: e, n: n };
  }
  function sampleRegionParam() {
    // sampleSupported() gates this too: asking an engine that ignores the
    // parameter just buys a slower listing with the same numbers in it
    if (!state.params.useAoiCloud || !sampleSupported()) return null;
    const r = clampSample(state.params.cloudSample);
    return r ? [r.w, r.s, r.e, r.n].map((v) => v.toFixed(4)).join(',') : null;
  }
  // every scene cache is keyed on this too: change the box and the old
  // listings describe a different question, not a stale answer to this one
  const sampleSig = () => sampleRegionParam() || 'meta';

  /*
   * The cloud number every part of the UI should reason about.
   *
   * aoiCloud — measured over the sample box with the same mask the cloud
   * overlay draws — is the honest one, and wins whenever the backend supplied
   * it. It is absent for the demo engine, for windows too wide to sample, and
   * when the feature is off, so this falls back to Sentinel-2's granule-wide
   * figure rather than pretending there is no number at all.
   *
   * A pass that barely clipped the box is not clear, it is unobserved: below
   * minCoverage its aoiCloud describes a corner of the box, so those dates
   * report as fully clouded rather than as the best day of the year.
   */
  /*
   * A row counts as measured once it carries a `coverage` figure — NOT once it
   * carries a cloud figure. The difference matters: a pass whose swath missed
   * the box entirely comes back measured, with coverage 0 and no cloud number
   * at all. Keying off the cloud number instead sent exactly those dates down
   * the metadata path, where they read as "0.0% cloud" and were offered as the
   * clearest days of the month — days on which the satellite never looked at
   * this water. That is the failure this whole feature exists to prevent, so
   * it must not survive in its most extreme form.
   */
  function cloudIsSampled(sc) {
    return !!(state.params.useAoiCloud && sc && typeof sc.coverage === 'number');
  }
  function seenEnough(sc) {
    return sc.coverage >= (state.params.minCoverage || 0) &&
           sc.aoiCloud !== null && sc.aoiCloud !== undefined;
  }
  function sceneCloud(sc) {
    if (!sc) return 100;
    if (!cloudIsSampled(sc)) return typeof sc.cloud === 'number' ? sc.cloud : 100;
    // measured, but this pass saw too little of the box to have an opinion
    return seenEnough(sc) ? sc.aoiCloud : 100;
  }
  // "12% cloud" vs "12% cloud over the sample area" — the tooltip has to say
  // which question was answered, since the two routinely disagree
  function cloudLabel(sc) {
    if (!sc) return '';
    if (!cloudIsSampled(sc)) return pct(sc.cloud) + '% cloud (whole scene)';
    if (!seenEnough(sc)) return 'this pass saw only ' + pct(sc.coverage) + '% of the sample area';
    return pct(sc.aoiCloud) + '% cloud over the sample area';
  }

  /*
   * Two rules, and they were fighting each other.
   *
   * "Keep the clearest" is a statement about GRANULE METADATA — which of a
   * date's granules to name. Comparing with sceneCloud() instead let a
   * metadata row (4% whole-scene) beat a sampled one (50% over the box) and
   * replace it, so every metadata refresh quietly threw away the measured
   * numbers and the calendar fell back to "whole scene" tooltips a few seconds
   * after showing the honest ones. So: compare on metadata, and carry any
   * sampled numbers across onto the row that wins.
   */
  function mergeScenes(list) {
    (list || []).forEach((s) => {
      const cur = sceneIndex.get(s.date);
      if (!cur) { sceneIndex.set(s.date, s); return; }
      if (s.coverage === undefined && cur.coverage !== undefined) {
        s.aoiCloud = cur.aoiCloud;
        s.coverage = cur.coverage;
      }
      const a = typeof s.cloud === 'number' ? s.cloud : 100;
      const b = typeof cur.cloud === 'number' ? cur.cloud : 100;
      if (a < b) sceneIndex.set(s.date, s);
    });
  }

  /*
   * Fill the index a YEAR at a time, not the single month being drawn.
   *
   * Paging month by month cost one scene listing per month stepped through,
   * and each of those is an Earth Engine round trip; walking back through a
   * season was a dozen of them. A year of passes over this AOI is a few
   * kilobytes of JSON and one request, so a year of browsing now costs what a
   * single month used to. Fire-and-forget by design: the calendar renders
   * immediately with whatever is known and fills in when this lands.
   */
  async function ensureMonth(y) {
    const key = String(y);
    if (loadedYears.has(key)) return;
    loadedYears.set(key, true);
    try {
      // metadata only: a year of it is one cheap round trip, where a year of
      // SAMPLED cloud is far past what one Earth Engine computation will do
      const list = await state.engine.listScenes(ymd(y, 0, 1), ymd(y, 11, 31), 100);
      mergeScenes(list);
      renderCalendar();
    } catch (err) {
      loadedYears.delete(key);          // let it retry next time
      console.warn(err);
    }
  }

  /*
   * Sampled cloud for the month on screen, so browsing the calendar shows the
   * same kind of number the map is filtered by. One month is ~5s of backend
   * work — small enough to fire on every month you land on, where the year
   * above would fail outright. Fire-and-forget, like its metadata sibling.
   */
  const sampledMonths = new Map();
  async function ensureMonthSampled(y, m) {
    const region = sampleRegionParam();
    if (!region || !state.engine) return;
    const key = y + '-' + m + '|' + region;
    if (sampledMonths.has(key)) return;
    sampledMonths.set(key, true);
    try {
      const last = new Date(y, m + 1, 0).getDate();
      const list = await state.engine.listScenes(ymd(y, m, 1), ymd(y, m, last), 100, region);
      if (sampleRegionParam() !== region) return;   // box moved while in flight
      if (!mergeCloudInto(list)) return;
      filtScenes.clear();
      applyCloudCeiling();
      renderCalendar();
    } catch (err) {
      sampledMonths.delete(key);
      console.warn(err);
    }
  }

  function clearSceneCache() {
    rawScenes.clear(); filtScenes.clear();
    sceneIndex.clear(); loadedYears.clear(); refinedRanges.clear();
  }

  /*
   * ---- second pass: cloud measured over the sample box ----
   * The rows already on screen came from Sentinel-2's granule metadata. This
   * asks the backend to measure the same dates properly and copies the answer
   * onto the scene objects already in hand, so there is exactly one object per
   * date and everything reading it (calendar, ceiling, readout) upgrades at
   * once. Fire-and-forget on purpose: if it fails the app is left exactly
   * where it was before this feature existed, which is a working map.
   */
  const refinedRanges = new Map();   // 'start|end|region' -> true once merged

  /*
   * The same date can be held by two different objects — sceneIndex is filled
   * per calendar year while allScenes comes from the selected range, and the
   * two fetches return separate objects. Both have to learn the new number or
   * the calendar and the timeline would disagree, so this indexes by date once
   * rather than rescanning allScenes per row.
   */
  function mergeCloudInto(list) {
    if (!list || !list.length) return 0;
    const byDate = new Map();
    const add = (sc) => {
      if (!sc) return;
      const bucket = byDate.get(sc.date);
      if (bucket) bucket.push(sc); else byDate.set(sc.date, [sc]);
    };
    sceneIndex.forEach(add);
    (state.allScenes || []).forEach(add);
    let touched = 0;
    list.forEach((row) => {
      // Merge on `coverage`, not on a cloud number. Rows whose swath missed
      // the box carry coverage 0 and no cloud value, and those are precisely
      // the ones that must not be left looking unmeasured — see cloudIsSampled.
      if (typeof row.coverage !== 'number') return;
      (byDate.get(row.date) || []).forEach((sc) => {
        sc.aoiCloud = row.aoiCloud;
        sc.coverage = row.coverage;
        touched++;
      });
    });
    return touched;
  }

  /*
   * Chunked, because one request cannot cover much window.
   *
   * Each date costs the backend an Earth Engine reduction per granule, and a
   * single computation gives out somewhere past three months — measured: one
   * month 5s, two 14s, three 23s, six fails inside Earth Engine. So a long
   * range is walked in ~3-month pieces, newest first (that is the end of the
   * range people are usually looking at), merging as each lands. Sequential on
   * purpose: these are expensive, the backend rate-limits per IP, and there is
   * no hurry — the map has been up on metadata since before this started.
   */
  const SAMPLE_CHUNK_DAYS = 90;
  const MAX_SAMPLE_CHUNKS = 8;       // ~2 years of background refinement

  function sampleChunks(start, end) {
    const out = [];
    const dayMs = 86400000;
    // Anchored at midday, not midnight. parseISO builds local midnight, and
    // stepping 90 days across a daylight-saving boundary from there lands at
    // 23:00 the day before — which isoOf would then read as the wrong date.
    const noon = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
    const lo = noon(parseISO(start));
    let hi = noon(parseISO(end));
    while (hi >= lo && out.length < MAX_SAMPLE_CHUNKS) {
      const from = new Date(Math.max(lo.getTime(), hi.getTime() - (SAMPLE_CHUNK_DAYS - 1) * dayMs));
      out.push([isoOf(from), isoOf(hi)]);
      hi = noon(new Date(from.getTime() - dayMs));
    }
    return out;
  }

  async function refineCloud(start, end) {
    const region = sampleRegionParam();
    if (!region || !state.engine) return;
    const chunks = sampleChunks(start, end);
    let merged = 0;
    for (let i = 0; i < chunks.length; i++) {
      const from = chunks[i][0], to = chunks[i][1];
      const key = from + '|' + to + '|' + region;
      if (refinedRanges.has(key)) continue;
      refinedRanges.set(key, true);
      try {
        const list = await state.engine.listScenes(from, to, 100, region);
        // the window or the box may have moved on while this was in flight;
        // applying a stale answer would quietly describe the wrong water
        const now = dateRangeISO();
        if (now[0] !== start || now[1] !== end || sampleRegionParam() !== region) return;
        if (!mergeCloudInto(list)) continue;
        merged++;
        filtScenes.clear();        // the ceiling now means something different
        applyCloudCeiling();
        renderCalendar();
      } catch (err) {
        refinedRanges.delete(key); // let a later interaction try again
        console.warn(err);
      }
    }
    if (merged) say('Cloud re-measured over the sample area', 'ok');
  }

  /*
   * Moving the box invalidates every sampled number in hand — they describe a
   * different patch of water, not a stale version of this one. Drop them and
   * re-measure rather than letting the calendar mix two questions.
   */
  function resetSampledCloud() {
    refinedRanges.clear();
    sampledMonths.clear();
    filtScenes.clear();
    const forget = (sc) => { if (sc) { delete sc.aoiCloud; delete sc.coverage; } };
    sceneIndex.forEach(forget);
    (state.allScenes || []).forEach(forget);
    applyCloudCeiling();
    renderCalendar();
    const [rs, re] = dateRangeISO();
    refineCloud(rs, re);
  }

  /*
   * Deliberately the METADATA listing: no sample region, no reductions, one
   * cheap round trip. Measuring cloud over the box costs an Earth Engine
   * reduction per granule — seconds, not milliseconds — and blocking first
   * paint on it would trade a real problem for a worse one. refineCloud()
   * below upgrades these rows in the background once the map is already up.
   */
  async function fetchAllScenes(start, end) {
    const key = start + '|' + end;
    if (rawScenes.has(key)) return rawScenes.get(key);
    say('Listing scenes ' + start + ' → ' + end + '…');
    busy(true);
    try {
      const list = await state.engine.listScenes(start, end, 100);
      rawScenes.set(key, list);
      mergeScenes(list);          // the calendar sees these too
      say(list.length + ' pass' + (list.length === 1 ? '' : 'es') + ' in range', 'ok');
      return list;
    } finally { busy(false); }
  }

  function scenesAtCeiling(ceiling) {
    const [start, end] = dateRangeISO();
    const key = start + '|' + end + '|' + ceiling + '|' + sampleSig();
    if (filtScenes.has(key)) return filtScenes.get(key);
    const out = (state.allScenes || []).filter((s) => sceneCloud(s) <= ceiling);
    filtScenes.set(key, out);
    return out;
  }

  let sceneLoadFailed = false;
  async function loadScenes() {
    const [start, end] = dateRangeISO();
    sceneLoadFailed = false;
    try { state.allScenes = await fetchAllScenes(start, end); }
    catch (err) {
      console.warn(err);
      state.allScenes = [];
      sceneLoadFailed = true;
      // carry the actual reason forward — a range refused by the backend used
      // to surface as a bogus "no passes under N% cloud" ceiling complaint
      say('Scene listing failed — ' + (err && err.message ? err.message : 'see console'), 'warn');
      toast('Could not list scenes — ' + (err && err.message ? err.message : 'check the console.'), true);
    }
    applyCloudCeiling();
    // the map is up on metadata now; go get the honest numbers
    refineCloud(start, end);
  }

  /*
   * Re-filter the cached scenes for the current ceiling and refresh everything
   * that depends on it. Keeps the user on the same date when that pass survives
   * the new ceiling, so nudging the slider doesn't jump them somewhere else.
   */
  function applyCloudCeiling(preferDate) {
    const was = state.scenes[state.idx] && state.scenes[state.idx].date;
    const want = preferDate || pendingPick || was;
    pendingPick = null;
    const scenes = scenesAtCeiling(state.params.maxCloud);
    state.scenes = scenes;

    if (!scenes.length) {
      state.idx = -1;
      $('date-big').textContent = '—';
      $('date-meta').textContent = 'no clear scenes';
      renderCalendar();
      /*
       * Say what actually happened. Only blame the cloud ceiling when the
       * ceiling is what filtered everything out — an empty or failed listing
       * has nothing to do with it, and "raise the ceiling" is a dead end there.
       */
      if (!sceneLoadFailed && (state.allScenes || []).length) {
        say('No passes at or under ' + state.params.maxCloud + '% cloud', 'warn');
        toast('No scenes under ' + state.params.maxCloud + '% cloud. Raise the ceiling.', true);
      } else if (!sceneLoadFailed) {
        say('No passes found in this date range', 'warn');
        toast('No passes found in this date range.', true);
      } // on a failed listing, loadScenes already reported the real reason
      clearLayer();
      return;
    }
    const at = want ? scenes.findIndex((s) => s.date === want) : -1;
    state.idx = at >= 0 ? at : scenes.length - 1;
    
    updateDate();
    renderCalendar();

    /*
     * Only recompute the kelp layer when it would actually differ. The ceiling
     * feeds the composite directly, but a single scene is fetched by date, so
     * moving the slider matters there only if it pushed us onto a different pass.
     * Without this, dragging the slider fires an Earth Engine request per step.
     */
    if (state.params.mode === 'composite' || scenes[state.idx].date !== was) scheduleRun();
  }

  // Coalesce bursts of parameter changes into a single computation.
  let runTimer = null;
  function scheduleRun(delay) {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, delay === undefined ? 260 : delay);
  }

  /*
   * ---- calendar picker ----
   * Opens off the date readout. Days are drawn from the cached scene list, so
   * moving the ceiling slider inside the popup re-renders instantly with no
   * network. Three states: a usable pass (clickable), a pass that is cloudier
   * than the ceiling (struck through, not clickable), and no pass at all.
   */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  let calMonth = null;   // Date pinned to the 1st of the displayed month
  /*
   * 'scene'       — clicking a day jumps to that pass (only ceiling-passing days)
   * 'start'/'end' — armed by the Start/End buttons; the next day clicked becomes
   *                 that edge of the date range. Any day is clickable in these
   *                 modes, and month navigation is unclamped, since the whole
   *                 point is to reach dates outside the current window.
   */
  let calMode = 'scene';
  let pendingPick = null;   // a date to select once a wider range has loaded

  const ymd = (y, m, d) =>
    y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();
  const parseISO = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const isoOf = (d) => ymd(d.getFullYear(), d.getMonth(), d.getDate());

  function calOpen() { return !$('cal').hasAttribute('hidden'); }

  function renderCalendar() {
    if (!calOpen()) return;
    const grid = $('cal-grid');
    grid.textContent = '';

    const selected = state.scenes[state.idx] && state.scenes[state.idx].date;
    const ceiling = state.params.maxCloud;

    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('cal-month').textContent = MONTHS[m];
    $('cal-year').textContent = y;
    ensureMonth(y);              // fills in and redraws if this year is new to us
    ensureMonthSampled(y, m);    // and re-measures this month's cloud over the box

    // Monday-first column offset
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < lead; i++) {
      const b = document.createElement('span');
      b.className = 'cal-day blank';
      grid.appendChild(b);
    }
    const [rs, re] = dateRangeISO();
    const picking = calMode !== 'scene';
    let usable = 0;
    for (let d = 1; d <= days; d++) {
      const date = ymd(y, m, d);
      const sc = sceneIndex.get(date);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = d;

      if (picking) {
        // any day can be a range edge, pass or no pass
        btn.className = 'cal-day edge' +
          (date === rs || date === re ? ' sel' : (sc && sceneCloud(sc) <= ceiling ? ' has' : ''));
        btn.title = 'Set the range ' + calMode + ' to ' + date;
        btn.addEventListener('click', () => setRangeEdge(date));
      } else if (!sc) {
        btn.className = 'cal-day';
        btn.disabled = true;
      } else if (sceneCloud(sc) > ceiling) {
        btn.className = 'cal-day over';
        btn.disabled = true;      // only ceiling-passing dates are clickable
        btn.title = date + ' · ' + cloudLabel(sc) + ' — above the ceiling';
      } else {
        usable++;
        btn.className = 'cal-day has' + (date === selected ? ' sel' : '');
        btn.title = date + ' · ' + cloudLabel(sc);
        btn.addEventListener('click', () => pickDate(date));
      }
      grid.appendChild(btn);
    }

    // Navigation is never clamped: the calendar indexes every month it has seen,
    // not just the current window, so browsing outside the range is meaningful.
    $('cal-prev').disabled = false;
    $('cal-next').disabled = false;
    $('cal-set-start').setAttribute('aria-pressed', calMode === 'start');
    $('cal-set-end').setAttribute('aria-pressed', calMode === 'end');
    $('cal-start-date').textContent = rs;
    $('cal-end-date').textContent = re;
    $('cal-note').textContent = picking
      ? 'Click a day to set the range ' + calMode + '. Currently ' + rs + ' → ' + re + '.'
      : (usable ? usable + ' selectable pass' + (usable === 1 ? '' : 'es') + ' this month'
                : 'No passes this month under ' + ceiling + '% cloud');
    $('cal-cloud').value = ceiling;
    $('cal-cloud-val').textContent = ceiling + '%';
  }

  // Arm / disarm the Start and End buttons.
  function setCalMode(mode) {
    calMode = calMode === mode ? 'scene' : mode;
    renderCalendar();
  }

  /*
   * Ranges are capped at RANGE_MAX_DAYS. The endpoint the user just set is
   * honoured and the OTHER one is pulled in to fit — picking a start five
   * years back gives you that start plus the following 400 days, rather
   * than a refusal.
   */
  const RANGE_MAX_DAYS = 400;
  function clampRange(start, end, anchor) {
    const maxMs = RANGE_MAX_DAYS * 86400000;
    if (Date.parse(end) - Date.parse(start) <= maxMs) return [start, end];
    if (anchor === 'start') {
      const e = new Date(Date.parse(start) + maxMs).toISOString().slice(0, 10);
      say('Range capped at ' + RANGE_MAX_DAYS + ' days — end pulled in to ' + e);
      return [start, e];
    }
    const s = new Date(Date.parse(end) - maxMs).toISOString().slice(0, 10);
    say('Range capped at ' + RANGE_MAX_DAYS + ' days — start pulled in to ' + s);
    return [s, end];
  }

  /*
   * Setting one edge advances to the other, so the natural flow after opening the
   * picker is: click a start, click an end, done. Setting the end drops back to
   * scene picking. Picking a start also pushes the end out if it would otherwise
   * be left behind, so the intermediate state is never invalid.
   */
  function setRangeEdge(date) {
    const [rs, re] = dateRangeISO();
    const next = clampRange.apply(null, calMode === 'start'
      ? [date, date > re ? date : re, 'start']
      : [date < rs ? date : rs, date, 'end']);
    const ok = applyRange(next[0], next[1], true);
    if (!ok) return;                 // rejected — stay armed and let them retry
    calMode = calMode === 'start' ? 'end' : 'scene';
    renderCalendar();
  }

  function pickDate(date) {
    if (state.params.mode !== 'single') setMode('single');

    // A pass outside the current window is still a legitimate choice — widen the
    // window to reach it rather than refusing the click. applyCloudCeiling picks
    // the date up once the new scene list lands.
    const [rs, re] = dateRangeISO();
    if (date < rs || date > re) {
      pendingPick = date;
      setCalendar(false);
      // widening obeys the range cap too, anchored on the clicked day so the
      // scene being asked for is always inside whatever window results
      const next = clampRange(
        date < rs ? date : rs, date > re ? date : re,
        date < rs ? 'start' : 'end');
      applyRange(next[0], next[1], true);
      return;
    }
    const at = state.scenes.findIndex((s) => s.date === date);
    if (at < 0) return;
    state.idx = at;
    updateDate();
    setCalendar(false);
    run();
  }

  function setCalendar(on) {
    const cal = $('cal');
    if (on) {
      const sel = state.scenes[state.idx];
      const [rs] = dateRangeISO();
      calMode = 'scene';                 // opens ready to pick a single day; Start/End are opt-in
      calMonth = parseISO(sel ? sel.date : rs);
      calMonth.setDate(1);
      cal.removeAttribute('hidden');
      $('date-big').setAttribute('aria-expanded', 'true');
      renderCalendar();
      syncSampleUi();          // and draws the sample box on the map
    } else {
      calMode = 'scene';
      cal.setAttribute('hidden', '');
      setYearList(false);
      $('date-big').setAttribute('aria-expanded', 'false');
      // closing the picker takes its map furniture and any armed draw with it
      setSampling(false);
      renderSampleBox();
    }
  }

  /*
   * ---- the cloud sample box ----
   * Drawn on the map whenever the calendar is open, so the cloud numbers in it
   * always have visible provenance: you can see the water they describe. It
   * sits in Leaflet's default overlay pane, which is above every imagery pane
   * this app creates, so it is never buried under the kelp mask.
   */
  let sampleRect = null, samplePreview = null, sampleAnchor = null, sampling = false;

  function sampleBounds() {
    const r = clampSample(state.params.cloudSample);
    return r ? L.latLngBounds([[r.s, r.w], [r.n, r.e]]) : null;
  }
  function sampleSizeLabel() {
    const r = clampSample(state.params.cloudSample);
    if (!r) return 'whole AOI';
    const km = (a, b) => L.latLng(a[0], a[1]).distanceTo(L.latLng(b[0], b[1])) / 1000;
    return Math.round(km([r.s, r.w], [r.s, r.e])) + ' × ' +
           Math.round(km([r.s, r.w], [r.n, r.w])) + ' km';
  }
  function renderSampleBox() {
    const b = sampleBounds();
    const want = b && calOpen() && state.params.useAoiCloud;
    if (!want) {
      if (sampleRect) { map.removeLayer(sampleRect); sampleRect = null; }
      return;
    }
    if (!sampleRect) {
      sampleRect = L.rectangle(b, {
        color: '#5ec6c9', weight: 1, dashArray: '4 3',
        fillColor: '#5ec6c9', fillOpacity: 0.06, interactive: false
      }).addTo(map);
    } else sampleRect.setBounds(b);
  }
  /*
   * Asked of the engine rather than inferred from its name: both the shared
   * backend and the signed-in Earth Engine path can measure cloud over a box,
   * the demo engine has no imagery to measure, and a name check would have to
   * be edited every time that changes. Where it is unsupported the control
   * says so and switches itself off — labelling whole-granule numbers as an
   * area measurement would be a promise the app cannot keep.
   */
  function sampleSupported() {
    return !!(state.engine && state.engine.supportsCloudSample);
  }
  function syncSampleUi() {
    const supported = sampleSupported();
    const on = !!state.params.useAoiCloud && supported;
    $('cal-sample-on').checked = on;
    $('cal-sample-on').disabled = !supported;
    $('cal-sample-val').textContent = !supported ? 'whole scene (needs the shared backend)'
                                    : on ? sampleSizeLabel() : 'whole scene';
    $('cal-sample-draw').disabled = !on;
    $('cal-sample-reset').disabled = !on;
    renderSampleBox();
  }

  /*
   * Pointer events rather than Leaflet's mouse events: Leaflet only fires
   * mousedown/mousemove/mouseup from real mouse input, so a touch drag would
   * never draw anything. Capture keeps the drag alive if the finger leaves the
   * map, and dragging is disabled meanwhile so the map does not pan underneath.
   */
  function setSampling(on) {
    if (on === sampling) return;
    sampling = on;
    $('cal-sample-draw').setAttribute('aria-pressed', on ? 'true' : 'false');
    map.getContainer().classList.toggle('sampling', on);
    if (on) {
      map.dragging.disable();
      if (map.boxZoom) map.boxZoom.disable();
      say('Drag a box on the map to set where cloud is measured — Esc to cancel');
    } else {
      map.dragging.enable();
      if (map.boxZoom) map.boxZoom.enable();
      sampleAnchor = null;
      if (samplePreview) { map.removeLayer(samplePreview); samplePreview = null; }
    }
  }

  (function bindSampleDrawing() {
    const el = map.getContainer();
    const at = (ev) => {
      const r = el.getBoundingClientRect();
      return map.containerPointToLatLng(L.point(ev.clientX - r.left, ev.clientY - r.top));
    };
    el.addEventListener('pointerdown', (ev) => {
      if (!sampling || (ev.button !== undefined && ev.button > 0)) return;
      ev.preventDefault(); ev.stopPropagation();
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
      sampleAnchor = at(ev);
      if (samplePreview) map.removeLayer(samplePreview);
      samplePreview = L.rectangle(L.latLngBounds(sampleAnchor, sampleAnchor), {
        color: 'var(--kelp)', weight: 1, dashArray: '4 3',
        fillColor: '#f2b134', fillOpacity: 0.10, interactive: false
      }).addTo(map);
      samplePreview.setStyle({ color: '#f2b134' });
    }, true);
    el.addEventListener('pointermove', (ev) => {
      if (!sampling || !sampleAnchor || !samplePreview) return;
      samplePreview.setBounds(L.latLngBounds(sampleAnchor, at(ev)));
    }, true);
    el.addEventListener('pointerup', (ev) => {
      if (!sampling || !sampleAnchor) return;
      ev.preventDefault(); ev.stopPropagation();
      const b = L.latLngBounds(sampleAnchor, at(ev));
      const box = clampSample({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() });
      setSampling(false);
      if (!box) {
        // a click rather than a drag, or a box outside the AOI entirely
        say('That box was too small to measure — sample area unchanged', 'warn');
        return;
      }
      state.params.cloudSample = box;
      syncSampleUi();
      say('Sample area set to ' + sampleSizeLabel() + ' — re-measuring cloud');
      resetSampledCloud();
      schedulePersist();
    }, true);
  })();

  function shiftMonth(delta) {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
    renderCalendar();
  }

  $('date-big').addEventListener('click', () => setCalendar(!calOpen()));
  $('cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('cal-next').addEventListener('click', () => shiftMonth(1));
  /*
   * Year jump. Months are fine for stepping a season, useless for going back
   * years — this lists from the present back to the start of the Sentinel-2
   * archive, so any year is one click away.
   */
  const S2_FIRST_YEAR = 2015;
  function renderYearList() {
    const box = $('cal-years');
    box.textContent = '';
    const now = new Date().getFullYear();
    for (let y = now; y >= S2_FIRST_YEAR; y--) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-year-opt' + (calMonth && y === calMonth.getFullYear() ? ' sel' : '');
      b.textContent = y;
      b.setAttribute('role', 'option');
      b.addEventListener('click', () => {
        calMonth = new Date(y, calMonth.getMonth(), 1);
        setYearList(false);
        renderCalendar();
      });
      box.appendChild(b);
    }
  }
  function setYearList(on) {
    $('cal-years').hidden = !on;
    $('cal-year').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) renderYearList();
  }
  $('cal-year').addEventListener('click', () => setYearList($('cal-years').hidden));

  $('cal-set-start').addEventListener('click', () => setCalMode('start'));
  $('cal-set-end').addEventListener('click', () => setCalMode('end'));
  $('cal-reset').addEventListener('click', () => {
    const [ds, de] = defaultRange();
    applyRange(ds, de, true);
    calMode = 'scene';
    renderCalendar();
  });
  $('cal-sample-draw').addEventListener('click', () => setSampling(!sampling));
  $('cal-sample-reset').addEventListener('click', () => {
    setSampling(false);
    state.params.cloudSample = defaultSampleBox();
    syncSampleUi();
    say('Sample area reset to the default channel box');
    resetSampledCloud();
    schedulePersist();
  });
  $('cal-sample-on').addEventListener('change', (ev) => {
    setSampling(false);
    state.params.useAoiCloud = ev.target.checked;
    syncSampleUi();
    say(ev.target.checked
      ? 'Cloud measured over the sample area'
      : 'Cloud back to the whole-scene figure Sentinel-2 reports');
    // switching the source changes what the ceiling means, both directions
    filtScenes.clear();
    applyCloudCeiling();
    renderCalendar();
    if (ev.target.checked) { const r = dateRangeISO(); refineCloud(r[0], r[1]); }
    schedulePersist();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // an armed draw is the innermost thing Esc should cancel — losing the
    // whole calendar because you thought better of redrawing would be rude
    if (sampling) { setSampling(false); say('Sample area unchanged'); return; }
    if (calOpen()) setCalendar(false);
  });
  /*
   * Capture phase, deliberately. A day button re-renders the grid in its own
   * click handler, so by the time a bubble-phase listener ran, the clicked node
   * would already be detached and `contains` would read it as an outside click —
   * closing the calendar on every pick.
   */
  document.addEventListener('click', (ev) => {
    if (!calOpen()) return;
    if ($('cal').contains(ev.target) || $('date-big').contains(ev.target)) return;
    setCalendar(false);
  }, true);

  function updateDate() {
    const sc = state.scenes[state.idx];
    if (!sc) return;
    if (state.params.mode === 'composite') {
      $('date-big').textContent = 'Composite';
      $('date-meta').textContent = state.scenes[0].date + ' → ' + state.scenes[state.scenes.length - 1].date;
    } else {
      $('date-big').textContent = sc.date;
      $('date-meta').textContent = pct(sceneCloud(sc)) + '% cloud' +
        (cloudIsSampled(sc) ? ' (area)' : '') +
        ' · ' + (state.idx + 1) + '/' + state.scenes.length;
      $('date-meta').title = cloudLabel(sc);
    }
    $('prev').disabled = state.params.mode === 'composite' || state.idx <= 0;
    $('next').disabled = state.params.mode === 'composite' || state.idx >= state.scenes.length - 1;
  }

  // ---- run the kelp map ----
  function clearLayer() {
    if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
  }
  async function run() {
    if (!state.scenes.length) return;
    const composite = state.params.mode === 'composite';
    const what = composite
      ? 'mean composite ' + state.range.start + ' → ' + state.range.end
      : 'scene ' + state.scenes[state.idx].date;
    sweep(true);
    busy(true);
    say('Computing ' + state.params.indexType + ' kelp mask · ' + what + '…');
    try {
      /*
       * The old layer stays on the map until the new one has something to
       * show. Clearing first meant every re-run flashed empty water for the
       * full mint+tile round trip; now the swap happens at the new layer's
       * first 'load' (with a timeout backstop for layers that never fire it),
       * and a failed run leaves the previous result on screen instead of
       * nothing.
       */
      const old = state.layer;
      let layer;
      if (composite) {
        const [start, end] = dateRangeISO();
        const days = compositeDates();
        const res = await cachedLayer(
          'c|' + start + '|' + end + '|' + state.params.maxCloud + '|' + compositeDateSig(),
          () => state.engine.compositeLayer(start, end, state.params.maxCloud, state.params, days));
        layer = toLeafletLayer(res);
      } else {
        const date = state.scenes[state.idx].date;
        const res = await cachedLayer('s|' + date,
          () => state.engine.singleSceneLayer(date, state.params));
        layer = toLeafletLayer(res);
        prefetchNeighbours();
      }
      state.layer = layer;
      // Built and cached either way, but only attached when it will be seen —
      // an invisible kelp layer would keep fetching tiles on every map move.
      const lit = state.params.opacity > 0;
      attachOverlay(layer, lit);
      if (layer.setOpacity) layer.setOpacity(state.params.opacity);
      let oldGone = !old;
      const dropOld = () => {
        if (oldGone) return;
        oldGone = true;
        if (old !== state.layer && map.hasLayer(old)) map.removeLayer(old);
      };
      // Earth Engine returns tiles that stream in; the demo layer draws immediately.
      // A layer that was never attached fires no 'load', so it takes the
      // straight-through branch rather than waiting on tiles that never come.
      if (lit && layer.on && layer.getContainer) {
        let announced = false;
        layer.on('load', () => {
          dropOld();
          if (!announced) { announced = true; say('Kelp tiles rendered', 'ok'); }
        });
        // 'load' never fires if every tile errors (offline, expired mint) —
        // don't leave a stale layer masquerading as the new result forever
        setTimeout(dropOld, 8000);
      } else {
        dropOld();
        say('Kelp layer drawn', 'ok');
      }
      /*
       * Keep a visible true-color layer on the scene now being shown — this is
       * also what re-materialises it after a restore, once scenes exist. With
       * the layer hidden but previously used, warm it in the background
       * instead, so the eye toggle is instant for the viewport on screen.
       */
      if (state.params.trueColorOpacity > 0) ensureTrueColor();
      else if (tcUsed) ensureTrueColor(true);
      // the aux overlays track the same scene/mode/params; rebuild whichever
      // is showing (their keys dedupe — an unchanged build is a no-op)
      if (state.params.turbidityOpacity > 0) ensureTurbidity();
      if (state.params.cloudOpacity > 0) ensureCloudMask();
    } catch (err) {
      console.warn(err);
      say('Kelp computation failed — see console', 'warn');
      toast('Kelp computation failed — see console.', true);
    } finally {
      busy(false);
      setDirty(false);        // whatever just rendered now matches the settings
      setTimeout(() => sweep(false), 350);
    }
  }

  /*
   * ---- layer URL cache + neighbour prefetch ----
   * A minted tile URL is valid for ~30 minutes, so re-requesting the same
   * scene with the same model settings is pure waste — switching single <->
   * composite, or stepping back to a scene just viewed, should be instant.
   * Only string results (tile templates) are cached; the demo engine returns
   * live Leaflet layers, which must be rebuilt each time.
   */
  const layerCache = new Map();          // key -> {url, at}
  const LAYER_TTL = 20 * 60 * 1000;      // under the mint lifetime, with margin

  /*
   * The days a composite should reduce over: exactly the passes that survived
   * the ceiling, which is the same set the calendar highlights.
   *
   * Only sent once cloud has actually been measured over the sample box.
   * Before that the list is just the metadata ceiling's opinion, which the
   * backend can apply itself for free — sending it would be a longer URL for
   * an identical composite. Once it IS sampled the list is genuinely
   * different, and narrower, which is where the speed comes from: composite
   * tile cost tracks scene count hard (76 scenes 2.4s/tile, 141 scenes 9.3s).
   */
  function compositeDates() {
    const list = state.scenes || [];
    if (!list.length || !list.some(cloudIsSampled)) return null;
    return list.map((s) => s.date);
  }
  // djb2; the day list is far too long to key a cache with verbatim
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function compositeDateSig() {
    const d = compositeDates();
    return d ? hashStr(d.join(',')) : '';
  }

  function layerCacheKey(suffix) {
    const P = state.params;
    // the cloud-mask gate changes which pixels classify, so it (and the cloud
    // thresholds while it is on) keys the mint
    return [state.engine.name, suffix, P.indexType, P.kelpThresh, P.b11Thresh,
            P.kelpPalette, P.paletteMin, P.paletteMax,
            cloudMaskOn() ? 'cm:' + cloudSig() : ''].join('|');
  }
  async function cachedLayer(suffix, make) {
    const key = layerCacheKey(suffix);
    const hit = layerCache.get(key);
    if (hit && Date.now() - hit.at < LAYER_TTL) return hit.url;
    const res = await make();
    if (typeof res === 'string') {
      if (layerCache.size > 60) layerCache.clear();
      layerCache.set(key, { url: res, at: Date.now() });
    }
    return res;
  }

  /*
   * While idle after a single-scene render, quietly mint the neighbours so the
   * scene steppers land on a warm cache. Skipped for the demo engine (nothing
   * to mint) and when the browser lacks requestIdleCallback.
   */
  function prefetchNeighbours() {
    if (state.engine.name === 'demo' || typeof requestIdleCallback === 'undefined') return;
    requestIdleCallback(() => {
      [state.idx - 1, state.idx + 1].forEach((i) => {
        const sc = state.scenes[i];
        if (!sc) return;
        const key = layerCacheKey('s|' + sc.date);
        if (layerCache.has(key)) return;
        state.engine.singleSceneLayer(sc.date, state.params)
          .then((res) => {
            if (typeof res === 'string') layerCache.set(key, { url: res, at: Date.now() });
          })
          .catch(() => { /* prefetch is best-effort by definition */ });
      });
    }, { timeout: 4000 });
  }

  /*
   * Engines return either a tile-URL template (Earth Engine) or a Leaflet layer
   * (demo).
   *
   * tileSize stays at Leaflet's 256 default ON PURPOSE. Earth Engine's tile
   * server only speaks the standard 256px z/x/y pyramid, so a smaller
   * tileSize misaligns the grid (Leaflet computes x/y for a 128px grid, the
   * server answers for a 256px one — every tile lands on the wrong patch of
   * ocean). The correct pairing (tileSize:128 + zoomOffset:1) would render
   * fine but quadruples tile requests per view against EE quota for pixels
   * EE renders identically anyway.
   *
   * keepBuffer + updateWhenIdle mirror cfg.DEPTH.tuning's rationale: hold
   * panned-past tiles so panning back is free, and wait for the map to
   * settle before requesting new ones — every kelp tile is an EE render.
   * updateWhenZooming joins them for the same reason: without it a multi-level
   * zoom fetches a full tile set at each level it passes through.
   *
   * bounds clips tile REQUESTS to the AOI: the imagery is AOI-filtered
   * server-side anyway, so tiles outside it are guaranteed-empty renders
   * that still cost an EE round trip each. This stops asking for them.
   */
  const AOI_BOUNDS = L.latLngBounds([[s, w], [n, e]]);
  /*
   * Sentinel-2's optical bands are 10 m/pixel. At this latitude z14 works out
   * to ~7.9 m per screen pixel, so z14 already resolves everything the source
   * holds and z15-19 are Earth Engine upsampling data it has already returned.
   * Capping the zoom we FETCH at 14 lets Leaflet stretch those tiles instead,
   * which turns a five-level zoom-in from five fresh tile sets per layer into
   * none. maxZoom stays at 19 so the map still zooms; only the fetching stops.
   */
  const EE_MAX_NATIVE_ZOOM = 14;

  /*
   * Expired-mint self-heal.
   *
   * A minted map id stops answering eventually, and when it does there is
   * nothing to bring the layer back on its own: the tile URL templates are
   * held in the caches above, so panning or zooming just asks the dead id
   * again and every tile 404s. Enough consecutive tile failures from an Earth
   * Engine layer are read as "the mint died" — every cached URL is dropped and
   * the visible layers rebuild from a fresh one.
   *
   * The threshold and the cooldown are both there because being offline looks
   * exactly like an expired mint from here, and an offline map must not sit in
   * a rebuild loop. This is the behaviour js/api-kelp.js's header has always
   * described; until now nothing implemented it.
   */
  let tileFailures = 0, lastRemint = 0;
  const REMINT_AFTER_FAILURES = 6;
  const REMINT_COOLDOWN_MS = 60 * 1000;
  function noteTileFailure() {
    if (++tileFailures < REMINT_AFTER_FAILURES) return;
    tileFailures = 0;
    if (Date.now() - lastRemint < REMINT_COOLDOWN_MS) return;
    lastRemint = Date.now();
    layerCache.clear();
    auxUrlCache.clear();
    turbBuiltKey = null; cloudBuiltKey = null; trueColorDate = null;
    say('Tile links expired — re-minting', 'warn');
    run();
    if (state.params.trueColorOpacity > 0) ensureTrueColor();
    if (state.params.turbidityOpacity > 0) ensureTurbidity();
    if (state.params.cloudOpacity > 0) ensureCloudMask();
  }

  function toLeafletLayer(res, opts) {
    if (typeof res === 'string') {
      const layer = L.tileLayer(res, Object.assign(
        { opacity: state.params.opacity, maxZoom: 19, pane: 'kelpPane',
          maxNativeZoom: EE_MAX_NATIVE_ZOOM, keepBuffer: 4,
          updateWhenIdle: true, updateWhenZooming: false, bounds: AOI_BOUNDS }, opts));
      // an empty patch of ocean comes back as a valid transparent PNG, so a
      // tile ERROR really is a failure rather than "nothing here"
      layer.on('tileerror', noteTileFailure);
      layer.on('load', () => { tileFailures = 0; });
      return layer;
    }
    return res; // already a Leaflet layer (demo overlay)
  }

  // ---- controls ----
  function setMode(mode) {
    state.params.mode = mode;
    $('mode-single').setAttribute('aria-pressed', mode === 'single');
    $('mode-composite').setAttribute('aria-pressed', mode === 'composite');
    updateDate(); run();
  }
  // The published thresholds run to seven decimals (KD 0.003216, NDVI -0.0003411),
  // so show enough digits to read them, without trailing-zero noise.
  function fmtIndex(v) {
    return (+v).toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  }

  function applyIndex(kind) {
    const spec = cfg.INDICES[kind];
    if (!spec) return null;
    state.params.indexType = kind;
    Object.keys(cfg.INDICES).forEach((k) => {
      const btn = $('idx-' + k.toLowerCase());
      if (btn) btn.setAttribute('aria-pressed', k === kind);
    });
    $('idx-hint').textContent = spec.hint;
    // Each index lives on its own scale, so rebuild the slider and snap back to
    // the value published for that index.
    const el = $('kelp');
    el.min = spec.min; el.max = spec.max; el.step = 0.0000001;
    el.value = spec.thresh;
    state.params.kelpThresh = spec.thresh;
    $('kelp-val').textContent = fmtIndex(spec.thresh);
    return spec;
  }

  function setIndex(kind) {
    if (applyIndex(kind)) setDirty(true);
  }

  $('mode-single').addEventListener('click', () => setMode('single'));
  $('mode-composite').addEventListener('click', () => setMode('composite'));
  Object.keys(cfg.INDICES).forEach((k) => {
    const btn = $('idx-' + k.toLowerCase());
    if (btn) btn.addEventListener('click', () => setIndex(k));
  });

  // Step the timeline. No-op in composite mode, matching the disabled ‹ › buttons.
  function stepScene(delta) {
    if (state.params.mode === 'composite') return false;
    const next = state.idx + delta;
    if (next < 0 || next >= state.scenes.length) return false;
    state.idx = next;
    updateDate(); run();
    return true;
  }
  $('prev').addEventListener('click', () => stepScene(-1));
  $('next').addEventListener('click', () => stepScene(1));

  /*
   * Left/right arrows step through scenes. Skipped while a form control has
   * focus, since sliders and date inputs use the arrow keys themselves.
   */
  document.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const el = document.activeElement;
    if (el && (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName) || el.isContentEditable)) return;
    if (ev.key === 'ArrowLeft' || ev.key === '[') { if (stepScene(-1)) ev.preventDefault(); return; }
    if (ev.key === 'ArrowRight' || ev.key === ']') { if (stepScene(1)) ev.preventDefault(); return; }
    if (ev.key === 'n' || ev.key === 'N') {
      // same deal as the + button: entering draw mode clears the panel
      // (declared later in this scope; hoisted, and this runs long after load)
      if (Paths.drawing) Paths.finishDrawing();
      else { Paths.startDrawing(); clearTheWayForDrawing(); }
      ev.preventDefault();
    }
  });

  // sliders: label live, act on release ('change')
  function bindSlider(id, valId, fmt, apply, onChange) {
    const el = $(id);
    el.addEventListener('input', () => { $(valId).textContent = fmt(el.value); apply(el.value); });
    el.addEventListener('change', onChange);
  }
  /*
   * The ceiling appears twice — in the console and inside the calendar — so both
   * write the same state and mirror each other. Filtering is now cache-backed,
   * so this can react live on 'input' instead of waiting for 'change'.
   */
  // The ceiling now lives only inside the date picker, where the days it filters
  // are visible right next to it.
  function setCloudCeiling(v, quiet) {
    state.params.maxCloud = +v;
    $('cal-cloud').value = v; $('cal-cloud-val').textContent = v + '%';
    if (!quiet) applyCloudCeiling();
  }
  $('cal-cloud').addEventListener('input', (ev) => setCloudCeiling(ev.target.value));
  bindSlider('kelp', 'kelp-val', fmtIndex,
    (v) => (state.params.kelpThresh = +v), () => setDirty(true));
  bindSlider('b11', 'b11-val', (v) => (+v).toFixed(3),
    (v) => (state.params.b11Thresh = +v), () => setDirty(true));
  // shares setKelpOpacity with the overlay picker so the two stay in step;
  // opacity restyles the existing layer, so no rerun is needed on release
  bindSlider('opacity', 'op-val', (v) => Math.round(v * 100) + '%',
    (v) => { setKelpOpacity(+v); syncOverlayPicker(); }, () => {});

  /*
   * Reset the kelp-model section to the published values. Settings persist
   * across visits now, so this is the way back to the paper's calibration
   * after experimenting. Scoped to this section's own controls — units,
   * gas planning, overlays and the rest are untouched.
   */
  $('kelp-defaults').addEventListener('click', () => {
    const d = cfg.DEFAULTS;
    applyIndex(d.indexType);            // index buttons + threshold slider + published value
    state.params.b11Thresh = d.b11Thresh;
    $('b11').value = d.b11Thresh;
    $('b11-val').textContent = d.b11Thresh.toFixed(3);
    state.params.opacity = d.opacity;
    $('opacity').value = d.opacity;
    $('op-val').textContent = Math.round(d.opacity * 100) + '%';
    if (state.layer && state.layer.setOpacity) state.layer.setOpacity(d.opacity);
    if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    setDirty(true);
    say('Kelp model reset to the published defaults');
  });

  /*
   * ---- Models tabs: cloud & turbidity tuning ----
   * One model per tab, same dirty->Rerun cycle as the kelp controls above.
   * Detection changes only mark the map stale while their overlay is showing:
   * a hidden overlay picks the new numbers up automatically the moment it is
   * enabled, because every mint key carries them — nothing to rerun yet.
   * "Show" checkboxes and opacity sliders are instant, exactly like the kelp
   * tab's own opacity slider.
   */
  document.querySelectorAll('.model-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.model-tabs button').forEach((b) => {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      ['kelp', 'cloud', 'turb'].forEach((k) => {
        $('mpanel-' + k).hidden = btn.dataset.mtab !== k;
      });
    });
  });

  const dirtyIfCloudShown = () => { if (cloudMaskOn()) setDirty(true); };
  const dirtyIfTurbShown = () => { if (state.params.turbidityOpacity > 0) setDirty(true); };
  const fmt3 = (v) => (+v).toFixed(3);
  const fmt2 = (v) => (+v).toFixed(2);

  bindSlider('cloud-vis', 'cloud-vis-val', fmt3,
    (v) => (state.params.cloudVisMin = +v), dirtyIfCloudShown);
  bindSlider('cloud-swir', 'cloud-swir-val', fmt3,
    (v) => (state.params.cloudSwirMin = +v), dirtyIfCloudShown);
  bindSlider('cloud-white', 'cloud-white-val', fmt2,
    (v) => (state.params.cloudWhiteness = +v), dirtyIfCloudShown);

  // The clarity stretch is a pair — cross-clamped so it can never invert,
  // same rule as the legend's palette range grips. Clamped values are rounded
  // back onto the sliders' 0.01 grid, or float noise (0.35 - 0.02 =
  // 0.32999...) would leave the thumb between steps.
  const CLARITY_GAP = 0.02;
  const onGrid = (x) => Math.round(x * 100) / 100;
  bindSlider('turb-cmin', 'turb-cmin-val', fmt2, (v) => {
    const val = onGrid(Math.min(+v, state.params.turbClarityMax - CLARITY_GAP));
    state.params.turbClarityMin = val;
    if (val !== +v) { $('turb-cmin').value = val; $('turb-cmin-val').textContent = fmt2(val); }
  }, dirtyIfTurbShown);
  bindSlider('turb-cmax', 'turb-cmax-val', fmt2, (v) => {
    const val = onGrid(Math.max(+v, state.params.turbClarityMin + CLARITY_GAP));
    state.params.turbClarityMax = val;
    if (val !== +v) { $('turb-cmax').value = val; $('turb-cmax-val').textContent = fmt2(val); }
  }, dirtyIfTurbShown);
  bindSlider('turb-nir', 'turb-nir-val', fmt3,
    (v) => (state.params.turbNirFloor = +v), dirtyIfTurbShown);
  bindSlider('turb-gain', 'turb-gain-val', (v) => (+v).toFixed(1) + '×',
    (v) => (state.params.turbGlintGain = +v), dirtyIfTurbShown);

  // glint on/off greys out its two sliders, so the dead controls read as dead
  function syncGlintEnabled() {
    const on = state.params.turbGlint !== false;
    $('turb-nir').disabled = !on;
    $('turb-gain').disabled = !on;
  }
  $('turb-glint').addEventListener('change', (ev) => {
    state.params.turbGlint = ev.target.checked;
    syncGlintEnabled();
    dirtyIfTurbShown();
  });

  function setTurbMode(mode) {
    if (mode === state.params.turbMode) return;
    state.params.turbMode = mode;
    $('turb-kd490').setAttribute('aria-pressed', mode === 'KD490' ? 'true' : 'false');
    $('turb-blue').setAttribute('aria-pressed', mode === 'BLUE_RATIO' ? 'true' : 'false');
    dirtyIfTurbShown();
  }
  $('turb-kd490').addEventListener('click', () => setTurbMode('KD490'));
  $('turb-blue').addEventListener('click', () => setTurbMode('BLUE_RATIO'));

  // "Show" checkboxes are the same switches as the corner ☁/💧 icons —
  // toggleOverlay owns the flip (and the cloud gate's rerun), the checkbox
  // state itself is re-synced by syncOverlayPicker
  $('cloud-show').addEventListener('change', (ev) => {
    if (ev.target.checked !== cloudMaskOn()) toggleOverlay('clouds');
  });
  $('turb-show').addEventListener('change', (ev) => {
    if (ev.target.checked !== (state.params.turbidityOpacity > 0)) toggleOverlay('turbidity');
  });

  // in-tab opacity sliders, mirroring the corner flyouts (as the kelp tab does)
  bindSlider('cloud-op', 'cloud-op-val', (v) => Math.round(v * 100) + '%',
    (v) => { setCloudOpacity(+v); syncOverlayPicker(); }, () => {});
  bindSlider('turb-op', 'turb-op-val', (v) => Math.round(v * 100) + '%',
    (v) => { setTurbidityOpacity(+v); syncOverlayPicker(); }, () => {});

  // one writer for every cloud/turbidity control, so restored sessions,
  // imports and the defaults buttons all land on the same code path
  function syncModelControls() {
    const P = state.params;
    $('cloud-vis').value = P.cloudVisMin;
    $('cloud-vis-val').textContent = fmt3(P.cloudVisMin);
    $('cloud-swir').value = P.cloudSwirMin;
    $('cloud-swir-val').textContent = fmt3(P.cloudSwirMin);
    $('cloud-white').value = P.cloudWhiteness;
    $('cloud-white-val').textContent = fmt2(P.cloudWhiteness);
    $('cloud-op').value = P.cloudOpacity;
    $('cloud-op-val').textContent = Math.round(P.cloudOpacity * 100) + '%';
    $('turb-cmin').value = P.turbClarityMin;
    $('turb-cmin-val').textContent = fmt2(P.turbClarityMin);
    $('turb-cmax').value = P.turbClarityMax;
    $('turb-cmax-val').textContent = fmt2(P.turbClarityMax);
    $('turb-nir').value = P.turbNirFloor;
    $('turb-nir-val').textContent = fmt3(P.turbNirFloor);
    $('turb-gain').value = P.turbGlintGain;
    $('turb-gain-val').textContent = (+P.turbGlintGain).toFixed(1) + '×';
    $('turb-glint').checked = P.turbGlint !== false;
    $('turb-kd490').setAttribute('aria-pressed', P.turbMode !== 'BLUE_RATIO' ? 'true' : 'false');
    $('turb-blue').setAttribute('aria-pressed', P.turbMode === 'BLUE_RATIO' ? 'true' : 'false');
    $('turb-op').value = P.turbidityOpacity;
    $('turb-op-val').textContent = Math.round(P.turbidityOpacity * 100) + '%';
    syncGlintEnabled();
  }
  syncModelControls();

  $('cloud-defaults').addEventListener('click', () => {
    const d = cfg.DEFAULTS;
    ['cloudVisMin', 'cloudSwirMin', 'cloudWhiteness'].forEach((k) => {
      state.params[k] = d[k];
    });
    syncModelControls();
    dirtyIfCloudShown();
    say('Cloud mask reset to defaults');
  });
  $('turb-defaults').addEventListener('click', () => {
    const d = cfg.DEFAULTS;
    ['turbMode', 'turbClarityMin', 'turbClarityMax',
     'turbGlint', 'turbNirFloor', 'turbGlintGain'].forEach((k) => {
      state.params[k] = d[k];
    });
    syncModelControls();
    dirtyIfTurbShown();
    say('Turbidity model reset to defaults');
  });

  /*
   * ---- undo toast ----
   * Delete is now a single keypress, so it gets a way back. One toast at a
   * time (a new delete replaces it); the stash lives in Paths.undoRemove.
   */
  /*
   * Ctrl+Z / Cmd+Z, for people who reach for it before they reach for the
   * toast — the toast only lives six seconds, and the stash outlives it.
   * Skipped while typing, where the browser's own text undo is what is wanted,
   * and while a session dialog is up, where the keystroke belongs to it.
   */
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'z' && ev.key !== 'Z') return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
              t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!$('session-modal').hidden || !$('share-modal').hidden) return;
    ev.preventDefault();
    if (Paths.undoRemove()) {
      say('Undone', 'ok');
      persistNow();
      const el = $('undo-toast');
      if (el) el.classList.remove('show');
    } else {
      say('Nothing to undo');
    }
  });

  let undoTimer = null;
  function showUndoToast(name) {
    let el = $('undo-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'undo-toast'; el.className = 'undo-toast';
      document.body.appendChild(el);
    }
    el.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = name + ' deleted';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Undo';
    btn.addEventListener('click', () => {
      if (Paths.undoRemove()) { say(name + ' restored', 'ok'); persistNow(); }
      el.classList.remove('show');
    });
    el.appendChild(msg); el.appendChild(btn);
    el.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }
  Paths.onRemoved = showUndoToast;

  /*
   * ---- map context menu ----
   * Right-click (long-press on touch) on open water: add a POI, start a path,
   * or copy the coordinates. Node markers, grips and the plot own their own
   * context menus and stop propagation, so this only fires on the map itself.
   */
  /*
   * Put a popup menu on screen near (cx, cy) and, above all, ON SCREEN.
   *
   * The old placement clamped only the right and bottom edges, so a menu
   * opened near the left or top could sit at a negative offset with its first
   * items off the screen. On touch it was worse for a reason clamping cannot
   * fix: the menu opened centred on the finger, so the hand that summoned it
   * was covering it. A finger is ~10mm of screen, so the menu is nudged clear
   * of the touch point and flipped to the other side when that would push it
   * off the edge — which is what a native context menu does.
   */
  function placeMenu(menu, cx, cy) {
    const pad = 8;
    const nudge = COARSE_POINTER ? 18 : 2;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let left = cx + nudge;
    if (left + mw > vw - pad) left = cx - nudge - mw;      // flip to the left
    left = Math.max(pad, Math.min(left, vw - mw - pad));

    let top = cy + nudge;
    if (top + mh > vh - pad) top = cy - nudge - mh;        // flip above
    top = Math.max(pad, Math.min(top, vh - mh - pad));

    /*
     * A menu taller than the screen cannot be flipped out of trouble; give it
     * the full height and let it scroll rather than running off the bottom.
     */
    if (mh > vh - pad * 2) {
      top = pad;
      menu.style.maxHeight = (vh - pad * 2) + 'px';
      menu.style.overflowY = 'auto';
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function openMapMenu(latlng, cx, cy, pathHit) {
    closePlotMenu();
    const menu = document.createElement('div');
    menu.className = 'plot-menu';
    const head = document.createElement('div');
    head.className = 'plot-menu-head';
    head.textContent = latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
    menu.appendChild(head);
    const item = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', () => { closePlotMenu(); fn(); });
      menu.appendChild(b);
    };
    /*
     * Pressed ON a path: that line's actions come first, because a press that
     * landed on a drawn object is asking about the object, not the water under
     * it. The open-water actions stay below — the press may have been a near
     * miss, and hiding them would make the menu depend on pixel luck.
     */
    if (pathHit) {
      head.textContent = pathHit.path.name + ' · ' + head.textContent;
      item('Add node to path', () => {
        Paths.insertNodeAt(pathHit.path.id, pathHit.at);
      });
      item('Open path', () => {
        if (window.MobileShell && MobileShell.active) {
          MobileShell.openSheet('paths');
        } else if (state.params.pathsMin) {
          state.params.pathsMin = false;
          syncDock(); syncDockWidth(); schedulePersist();
        }
        Paths.select(pathHit.path.id);
        Paths.setExpanded(pathHit.path.id, true);
        // the list is rebuilt by that change, so scroll after it lands
        setTimeout(() => {
          const row = document.querySelector('.pp-item[data-path="' + pathHit.path.id + '"]');
          if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        }, 80);
        say('Opened ' + pathHit.path.name);
      });
      const sep = document.createElement('div');
      sep.className = 'plot-menu-sep';
      menu.appendChild(sep);
    }

    item('Add POI here', () => {
      const name = window.prompt('Name for this point:', 'Marked spot');
      if (name === null) return;
      POI.upsert({ name: (name.trim() || 'Marked spot'), lat: latlng.lat, lng: latlng.lng,
                   symbol: 'marker', visible: true });
      say('POI added at ' + latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4), 'ok');
      persistNow();
    });
    item('Start path here', () => {
      if (!Paths.drawing) Paths.startDrawing();
      Paths.insertAt(Paths.selectedId, latlng);
      say('Path started — keep clicking to add nodes, Esc or ✓ to finish');
    });
    item('Copy coordinates', () => {
      const txt = latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
        .then(() => say('Copied ' + txt, 'ok'))
        .catch(() => toast(txt, false));   // clipboard blocked: show it instead
    });
    document.body.appendChild(menu);
    placeMenu(menu, cx, cy);
    plotMenuEl = menu;
  }
  // the line's own right-click, routed from paths.js
  Paths.onPathMenu = (p, latlng, cx, cy) => {
    if (Paths.drawing) return;
    openMapMenu(latlng, cx, cy, { path: p, at: latlng });
  };
  map.on('contextmenu', (ev) => {
    if (Paths.drawing) return;             // placing nodes; a menu would ambush
    L.DomEvent.preventDefault(ev.originalEvent);
    openMapMenu(ev.latlng, ev.originalEvent.clientX, ev.originalEvent.clientY);
  });
  /*
   * Touch long-press on the map. Leaflet no longer synthesises contextmenu for
   * tap-hold everywhere, so this is our own: 550ms still-finger on the map
   * container, tolerance 10px, skipped over markers and while drawing.
   */
  (function mapLongPress() {
    const el = map.getContainer();
    let t = null, sx = 0, sy = 0;
    const cancel = () => { if (t) { clearTimeout(t); t = null; } };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' || Paths.drawing) return;
      if (ev.target.closest('.leaflet-marker-icon, .poi-pin, .plot-menu')) return;
      sx = ev.clientX; sy = ev.clientY;
      cancel();
      t = setTimeout(() => {
        t = null;
        const pt = map.mouseEventToLatLng({ clientX: sx, clientY: sy });
        /*
         * A finger is wide, so "on the line" has to be judged generously —
         * and the line's own contextmenu never fires here anyway, because
         * this press is watched on the map container rather than the path.
         */
        const hit = Paths.pathNear ? Paths.pathNear(pt, COARSE_POINTER ? 26 : 14) : null;
        openMapMenu(hit ? hit.at : pt, sx, sy, hit);
        if (navigator.vibrate) navigator.vibrate(12);
      }, 550);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!t) return;
      if (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10) cancel();
    });
    ['pointerup', 'pointercancel'].forEach((k) => el.addEventListener(k, cancel));
  })();

  /*
   * ---- long-press == right-click ----
   * Touch has no secondary button, so every right-click menu in the app needs a
   * touch route to the same place. Rather than reimplement each menu's opening
   * logic for touch, a matured press SYNTHESISES a contextmenu event at the
   * finger: the element's existing right-click handler then runs unchanged, and
   * a menu added later inherits touch support without anyone remembering to
   * wire it. Mouse pointers are ignored — they already have the real button.
   *
   * Timings match the map/node presses (550ms, 10px) so no surface feels
   * different from its neighbour.
   */
  function longPressContextMenu(el, opts) {
    const o = opts || {};
    let timer = null, sx = 0, sy = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse') return;
      if (o.skip && ev.target.closest(o.skip)) return;
      sx = ev.clientX; sy = ev.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        ev.target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: sx, clientY: sy
        }));
        if (navigator.vibrate) navigator.vibrate(12);
      }, 550);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!timer) return;
      if (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((k) =>
      el.addEventListener(k, cancel));
    // and stop the OS text-selection callout riding along with it
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /*
   * ---- tap depth cursor (touch layouts) ----
   * The hover probe needs a cursor, which touch does not have — so on a phone a
   * TAP plants one: a draggable crosshair whose label reads the depth under it
   * from the same cached identify endpoint the hover uses. Tap elsewhere moves
   * it, drag it to fine-tune, tap the cursor itself to dismiss. Long-press
   * (map menu) and drawing mode are untouched: Leaflet only fires 'click' for
   * a genuine tap, and the handler stands down entirely while drawing.
   */
  let tapCursor = null;
  function tapCursorLabel(m, text) {
    if (m.getTooltip()) m.setTooltipContent(text);
    else m.bindTooltip(text, { permanent: true, direction: 'top', offset: [0, -12],
                               className: 'tap-cursor-label' }).openTooltip();
  }
  async function tapCursorRead(m, latlng) {
    tapCursorLabel(m, '…');
    try {
      const metres = await fetchDepth(latlng, true);
      if (metres === null || metres === undefined) { tapCursorLabel(m, 'no data'); return; }
      const ft = Math.round(Math.abs(metres) * M_TO_FT);
      tapCursorLabel(m, ft.toLocaleString() + ' ft ' + (metres < 0 ? 'depth' : 'elev.'));
    } catch (err) {
      if (err && err.name !== 'AbortError') tapCursorLabel(m, 'no data');
    }
  }
  function removeTapCursor() {
    if (tapCursor) { map.removeLayer(tapCursor); tapCursor = null; }
  }
  /*
   * Placing it takes a DOUBLE tap. A single tap is how you dismiss a menu,
   * finish looking at something, or just touch the map to bring it forward —
   * and every one of those moved the crosshair, so it wandered off constantly
   * and each move cost a depth lookup. Two taps is a deliberate act.
   *
   * Leaflet's own dblclick is bound to zoom and is suppressed here for touch,
   * so this counts taps itself: two within 320ms and 28px of each other. The
   * mouse never reaches this handler at all (see the breakpoint test).
   */
  let lastTapAt = 0, lastTapPt = null;
  map.on('click', (ev) => {
    if (!window.matchMedia(window.KELP_MOBILE_MQ).matches) return;  // touch layouts only
    if (Paths.drawing) return;                                     // taps place nodes there
    if (!depthEnabled()) return;                                   // nothing to read from

    const now = Date.now();
    const pt = ev.containerPoint;
    const quick = now - lastTapAt < 320;
    const near = lastTapPt && Math.abs(pt.x - lastTapPt.x) < 28 && Math.abs(pt.y - lastTapPt.y) < 28;
    lastTapAt = now; lastTapPt = pt;
    if (!(quick && near)) return;        // first tap: note it and do nothing
    lastTapAt = 0;                       // a third tap starts a fresh pair

    if (!tapCursor) {
      tapCursor = L.marker(ev.latlng, {
        draggable: true,
        icon: L.divIcon({ className: 'tap-cursor', html: '<span>+</span>',
                          iconSize: [26, 26], iconAnchor: [13, 13] })
      }).addTo(map);
      tapCursor.on('dragend', () => tapCursorRead(tapCursor, tapCursor.getLatLng()));
      tapCursor.on('click', removeTapCursor);   // tapping the cursor dismisses it
    } else {
      tapCursor.setLatLng(ev.latlng);
    }
    tapCursorRead(tapCursor, ev.latlng);
  });

  /*
   * ---- offline badge ----
   * On a boat, offline is the normal case, not an error. The badge names the
   * state; the NOAA service worker keeps cached bathymetry working through it.
   */
  // the event IS the state change; trusting it beats re-reading a property
  // that some browsers update after the handlers run
  function setOffline(off) { $('offline-badge').hidden = !off; }
  window.addEventListener('online', () => { setOffline(false); say('Back online', 'ok'); });
  window.addEventListener('offline', () => { setOffline(true); say('Offline — cached depth tiles still work', 'warn'); });
  setOffline(!navigator.onLine);

  // ---- date range ----
  // Read-only in the console; edited from the calendar's Start / End buttons.
  function showRange() {
    $('range-value').textContent = state.range.start + ' → ' + state.range.end;
  }
  function applyRange(start, end, keepCalendar) {
    if (!start || !end) { showRange(); return false; }
    if (start > end) {
      toast('Start date is after the end date.', true);
      showRange();
      return false;
    }
    if (start === state.range.start && end === state.range.end) { showRange(); return true; }
    state.range.start = start;
    state.range.end = end;
    showRange();
    if (!keepCalendar) setCalendar(false);
    state.idx = -1;      // the old scene index means nothing in a new window
    loadScenes();
    return true;
  }

  $('relief').addEventListener('change', (ev) => {
    state.params.showRelief = ev.target.checked;
    setDepthLayer('relief', ev.target.checked);
  });
  $('contours').addEventListener('change', (ev) => {
    state.params.showContours = ev.target.checked;
    setDepthLayer('contours', ev.target.checked);
  });
  bindSlider('depth-op', 'depth-op-val', (v) => Math.round(v * 100) + '%',
    (v) => setDepthOpacity(+v), () => {});

  /*
   * ---- overlay picker: kelp / true color / depth, "solo" style ----
   * Clicking an icon remembers every overlay's current opacity, then sets
   * this one to full and the rest to zero — click it again to put them all
   * back the way they were. Dragging a flyout slider by hand is a plain
   * opacity set and drops the "soloed" bookkeeping, since at that point the
   * user is composing their own mix rather than toggling between presets.
   *
   * The items are also drag-reorderable; see applyOverlayOrder below.
   */
  const OVERLAYS = {
    kelp:      { btn: 'ov-kelp',  slider: 'ov-kelp-slider',  param: 'opacity' },
    truecolor: { btn: 'ov-eye',   slider: 'ov-eye-slider',   param: 'trueColorOpacity' },
    depth:     { btn: 'ov-ruler', slider: 'ov-ruler-slider', param: 'depthOpacity' },
    turbidity: { btn: 'ov-turb',  slider: 'ov-turb-slider',  param: 'turbidityOpacity' },
    clouds:    { btn: 'ov-cloud', slider: 'ov-cloud-slider', param: 'cloudOpacity' }
  };
  /*
   * Each overlay is independent. Clicking an icon toggles only that overlay
   * between off and its last visible opacity — it does not touch the others.
   *
   * This replaces an earlier "solo" behaviour where clicking one icon set every
   * other overlay to 0. That made kelp opacity a hostage of the basemap
   * toggles: looking at true colour silently zeroed the kelp layer, and there
   * was no way to view both together.
   */
  const overlayLast = {};          // last non-zero opacity, per overlay key

  function setKelpOpacity(v) {
    state.params.opacity = v;
    attachOverlay(state.layer, v > 0);
    if (state.layer && state.layer.setOpacity) state.layer.setOpacity(v);
    if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    // one opacity, two controls — mirror the console slider (as depth does)
    $('opacity').value = v;
    $('op-val').textContent = Math.round(v * 100) + '%';
  }
  const OVERLAY_SETTERS = {
    kelp: setKelpOpacity,
    truecolor: setTrueColorOpacity,
    depth: setDepthOpacity,
    turbidity: setTurbidityOpacity,
    clouds: setCloudOpacity
  };

  // pressed simply means visible, which is what the icon now communicates
  function syncOverlayPicker() {
    Object.keys(OVERLAYS).forEach((key) => {
      const o = OVERLAYS[key];
      const v = state.params[o.param];
      $(o.btn).setAttribute('aria-pressed', v > 0 ? 'true' : 'false');
      $(o.slider).value = v;
      if (v > 0) overlayLast[key] = v;
    });
    // the Models tabs carry "show" checkboxes for the same two toggles
    $('cloud-show').checked = cloudMaskOn();
    $('turb-show').checked = state.params.turbidityOpacity > 0;
  }

  // the depth overlay is invisible unless its relief layer is actually on
  function ensureReliefOn() {
    if (state.params.showRelief) return;
    state.params.showRelief = true;
    $('relief').checked = true;
    setDepthLayer('relief', true);
  }

  const OVERLAY_FALLBACK = { kelp: 0.85, truecolor: 0.6, depth: 0.45, turbidity: 0.7, clouds: 0.55 };

  function toggleOverlay(which) {
    const cur = state.params[OVERLAYS[which].param];
    if (cur > 0) {
      overlayLast[which] = cur;              // remember where to come back to
      OVERLAY_SETTERS[which](0);
    } else {
      if (which === 'depth') ensureReliefOn();
      OVERLAY_SETTERS[which](overlayLast[which] || OVERLAY_FALLBACK[which]);
    }
    syncOverlayPicker();
  }

  Object.keys(OVERLAYS).forEach((key) => {
    const o = OVERLAYS[key];
    $(o.btn).addEventListener('click', () => toggleOverlay(key));
    $(o.slider).addEventListener('input', (ev) => {
      if (key === 'depth' && +ev.target.value > 0) ensureReliefOn();
      OVERLAY_SETTERS[key](+ev.target.value);
      syncOverlayPicker();
    });
  });

  /*
   * Drag an overlay icon left/right to restack the map layers. This is only a
   * pane z-index rewrite — no tiles are refetched and no layer is rebuilt, so
   * reordering is instant and costs nothing. Leftmost item = bottom of the
   * stack, matching the flyouts reading left to right.
   */
  const OVERLAY_PANES = {
    kelp: ['kelpPane'], truecolor: ['truecolor'], depth: ['depth', 'contour'],
    turbidity: ['turbidity'], clouds: ['cloudmask']
  };
  /*
   * Orders saved before turbidity/clouds existed lack them — slot each missing
   * overlay into its default position (turbidity under kelp, clouds on top)
   * rather than dumping both on top of the stack.
   */
  (function migrateOverlayOrder() {
    const DEF = cfg.DEFAULTS.overlayOrder || ['truecolor', 'depth', 'turbidity', 'kelp', 'clouds'];
    const cur = Array.isArray(state.params.overlayOrder)
      ? state.params.overlayOrder.filter((k) => OVERLAY_PANES[k])
      : DEF.slice();
    DEF.forEach((k, i) => {
      if (cur.indexOf(k) < 0) cur.splice(Math.min(i, cur.length), 0, k);
    });
    state.params.overlayOrder = cur;
  })();
  /*
   * Slots are 20 apart and start at 240, leaving each overlay room for its
   * second pane (depth carries its ENC contours) without any two landing on
   * the same z-index. Five slots top out at 240+80+5=325, still under the
   * custom-contour pane at 350 (set in contours.js) — hand-drawn reference
   * lines should never be buried under an opaque true-colour scene — and
   * paths stay on top at 380.
   */
  function applyOverlayOrder() {
    const order = state.params.overlayOrder || ['truecolor', 'depth', 'turbidity', 'kelp', 'clouds'];
    order.forEach((key, slot) => {
      (OVERLAY_PANES[key] || []).forEach((pane, i) => {
        const el = map.getPane(pane);
        if (el) el.style.zIndex = 240 + slot * 20 + i * 5;
      });
    });
  }
  (function initOverlayReorder() {
    const picker = document.querySelector('.overlay-picker');
    let dragKey = null;
    picker.querySelectorAll('.ov-item').forEach((item) => {
      /*
       * Only the icon is draggable, not the whole item: the flyout holds a
       * range slider, and with the item draggable the browser treated a
       * slider drag as the start of a reorder instead of moving the thumb.
       */
      item.querySelector('.ov-icon').addEventListener('dragstart', (ev) => {
        dragKey = item.dataset.overlay;
        item.classList.add('ov-dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', dragKey);   // Firefox needs a payload
      });
      item.addEventListener('dragend', () => {
        dragKey = null;
        picker.querySelectorAll('.ov-item').forEach((n) => n.classList.remove('ov-dragging', 'ov-drop-target'));
      });
      item.addEventListener('dragover', (ev) => {
        if (!dragKey || item.dataset.overlay === dragKey) return;
        ev.preventDefault();
        item.classList.add('ov-drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('ov-drop-target'));
      item.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const target = item.dataset.overlay;
        if (!dragKey || target === dragKey) return;
        const dragged = picker.querySelector('.ov-item[data-overlay="' + dragKey + '"]');
        // dropping onto an item to the right inserts after it, else before
        const after = Array.prototype.indexOf.call(picker.children, dragged) <
                      Array.prototype.indexOf.call(picker.children, item);
        picker.insertBefore(dragged, after ? item.nextSibling : item);
        state.params.overlayOrder = Array.prototype.map.call(
          picker.querySelectorAll('.ov-item'), (n) => n.dataset.overlay);
        applyOverlayOrder();
        say('Overlay order: ' + state.params.overlayOrder.join(' → ') + ' (bottom to top)');
      });
    });
    // restore a saved order by reordering the DOM to match
    const saved = state.params.overlayOrder;
    if (Array.isArray(saved)) {
      saved.forEach((key) => {
        const el = picker.querySelector('.ov-item[data-overlay="' + key + '"]');
        if (el) picker.appendChild(el);
      });
    }
    applyOverlayOrder();
  })();

  syncOverlayPicker();

  /*
   * ---- kelp colormap picker ----
   * Hovering the legend reveals one swatch per entry in cfg.KELP_PALETTES.
   * A palette is display-only, so switching restyles in place where possible
   * (the demo canvas redraws via setParams) and re-mints tiles otherwise —
   * no dirty-state / Rerun involvement, unlike the detection parameters.
   */
  const basePalette = () =>
    (cfg.KELP_PALETTES || {})[state.params.kelpPalette] || ['7a6a1f', 'd9a441', 'f2b134', 'ffd166'];
  const gradient = (stops, deg) =>
    'linear-gradient(' + deg + 'deg, ' + stops.map((s) => '#' + s).join(', ') + ')';

  // sample a palette at 0..1 by linear interpolation between its stops
  function sampleStops(stops, t) {
    const n = stops.length - 1;
    const x = Math.max(0, Math.min(1, t)) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    const a = stops[i], b = stops[i + 1];
    const mix = (o) => {
      const av = parseInt(a.substr(o, 2), 16), bv = parseInt(b.substr(o, 2), 16);
      return ('0' + Math.round(av + (bv - av) * f).toString(16)).slice(-2);
    };
    return mix(0) + mix(2) + mix(4);
  }

  /*
   * The palette actually handed to the renderers: the base colormap resampled
   * across [paletteMin, paletteMax]. Restricting the range is therefore a
   * pure colour change — it never touches the detection, only which part of
   * the ramp the same index values are painted with. Cached on state.params
   * so every engine (EE visualize, the demo canvas, the API) reads one field.
   */
  const PALETTE_STEPS = 8;
  function refreshPaletteStops() {
    const base = basePalette();
    const lo = state.params.paletteMin, hi = state.params.paletteMax;
    const out = [];
    for (let i = 0; i < PALETTE_STEPS; i++) {
      out.push(sampleStops(base, lo + (hi - lo) * (i / (PALETTE_STEPS - 1))));
    }
    state.params.paletteStops = out;
    return out;
  }

  function updateLegendRamp() {
    document.querySelector('.legend .ramp').style.background =
      gradient(state.params.paletteStops || basePalette(), 90);
    // the picker's vertical bar shows the FULL palette; the grips mark the slice
    $('legend-range-bar').style.background = gradient(basePalette(), 0);
  }

  function applyPaletteToLayer() {
    if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    else if (state.layer) run();
  }

  function setKelpPalette(key) {
    if (!(cfg.KELP_PALETTES || {})[key] || key === state.params.kelpPalette) return;
    state.params.kelpPalette = key;
    refreshPaletteStops();
    updateLegendRamp();
    $('legend-swatches').querySelectorAll('.legend-swatch').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.palette === key ? 'true' : 'false');
    });
    applyPaletteToLayer();
    say('Kelp colormap: ' + key);
  }

  Object.keys(cfg.KELP_PALETTES || {}).forEach((key) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-swatch';
    btn.dataset.palette = key;
    btn.title = key;
    btn.setAttribute('aria-pressed', key === state.params.kelpPalette ? 'true' : 'false');
    btn.style.background = gradient(cfg.KELP_PALETTES[key], 90);
    btn.addEventListener('click', () => setKelpPalette(key));
    $('legend-swatches').appendChild(btn);
  });

  /*
   * Range grips. The bar runs dark-at-bottom to bright-at-top, so a grip's
   * fraction is measured up from the bottom. The pair cannot cross: each is
   * clamped against the other with a small gap so the slice never inverts or
   * collapses to nothing.
   */
  const GRIP_GAP = 0.05;
  function syncRangeGrips() {
    $('legend-range-top').style.bottom = (state.params.paletteMax * 100) + '%';
    $('legend-range-bottom').style.bottom = (state.params.paletteMin * 100) + '%';
  }
  function bindRangeGrip(el, which) {
    let dragging = false;
    const setFrom = (clientY) => {
      const r = $('legend-range-bar').getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
      if (which === 'max') state.params.paletteMax = Math.max(frac, state.params.paletteMin + GRIP_GAP);
      else state.params.paletteMin = Math.min(frac, state.params.paletteMax - GRIP_GAP);
      state.params.paletteMax = Math.min(1, state.params.paletteMax);
      state.params.paletteMin = Math.max(0, state.params.paletteMin);
      refreshPaletteStops();
      syncRangeGrips();
      updateLegendRamp();
    };
    el.addEventListener('pointerdown', (ev) => {
      dragging = true;
      try { el.setPointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
      ev.preventDefault(); ev.stopPropagation();
    });
    el.addEventListener('pointermove', (ev) => { if (dragging) setFrom(ev.clientY); });
    el.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
      applyPaletteToLayer();   // re-mint once, on release — not per pixel of drag
    });
    // keyboard: the grips are sliders, so arrows should move them
    el.addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowUp' ? 0.05 : ev.key === 'ArrowDown' ? -0.05 : 0;
      if (!step) return;
      const key = which === 'max' ? 'paletteMax' : 'paletteMin';
      const other = which === 'max' ? state.params.paletteMin + GRIP_GAP : 0;
      const cap = which === 'max' ? 1 : state.params.paletteMax - GRIP_GAP;
      state.params[key] = Math.max(which === 'max' ? other : 0,
                                   Math.min(cap, state.params[key] + step));
      refreshPaletteStops(); syncRangeGrips(); updateLegendRamp(); applyPaletteToLayer();
      ev.preventDefault();
    });
  }
  bindRangeGrip($('legend-range-top'), 'max');
  bindRangeGrip($('legend-range-bottom'), 'min');

  refreshPaletteStops();
  syncRangeGrips();
  updateLegendRamp();

  /*
   * ---- depth colormap picker ----
   * The same flyout-swatch interface as the kelp picker above. NOAA ships only
   * two coloured relief renders, so the extra styles reuse one of those and
   * recolour it with a CSS filter on the depth tiles (config.DEPTH.reliefStyles
   * carries the filter). There is no range to restrict, so this keeps the swatch
   * column but not the range bar.
   */
  const activeDepthStyle = () => {
    const styles = cfg.DEPTH.reliefStyles || {};
    return styles[state.params.depthStyle] || styles.blue;
  };
  /*
   * Push the active style's recolour onto the depth pane — inherited by every
   * relief tile, per .leaflet-depth-pane img in styles.css — and onto the legend's
   * depth summary ramp, so both track the picker. A function declaration so
   * applyState (defined earlier in source) can call it.
   */
  function applyDepthFilter() {
    const style = activeDepthStyle();
    const pane = map.getPane('depth');
    if (pane) pane.style.setProperty('--depth-filter', style.filter || 'none');
    const ramp = $('depth-ramp');
    if (ramp) {
      ramp.style.background = gradient(style.swatch, 90);
      ramp.style.filter = style.filter || 'none';
    }
  }
  function setDepthStyle(key) {
    const styles = cfg.DEPTH.reliefStyles || {};
    if (!styles[key] || key === state.params.depthStyle) return;
    const prevLayers = reliefLayerName();
    state.params.depthStyle = key;
    $('depth-swatches').querySelectorAll('.legend-swatch').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.depthStyle === key ? 'true' : 'false');
    });
    applyDepthFilter();
    // Only re-mint tiles when the NOAA render actually changed; a filter-only
    // switch (same base layer) is a pure CSS recolour and needs no refetch.
    const newLayers = reliefLayerName();
    if (DEPTH_LAYERS.relief.layer && newLayers !== prevLayers &&
        DEPTH_LAYERS.relief.layer.setParams) {
      DEPTH_LAYERS.relief.layer.setParams({ layers: newLayers });
    }
    say('Depth colormap: ' + styles[key].label);
  }
  Object.keys(cfg.DEPTH.reliefStyles || {}).forEach((key) => {
    const style = cfg.DEPTH.reliefStyles[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-swatch';
    btn.dataset.depthStyle = key;
    btn.title = style.label;
    btn.setAttribute('aria-pressed', key === state.params.depthStyle ? 'true' : 'false');
    // the filter goes on an inner fill, not the button, so it never tints the
    // border/box-shadow that marks the selected swatch (grayscale(1) would
    // otherwise wash the selection ring out to grey on the Mono swatch)
    const fill = document.createElement('span');
    fill.className = 'sw-fill';
    fill.style.background = gradient(style.swatch, 90);
    fill.style.filter = style.filter || '';
    btn.appendChild(fill);
    btn.addEventListener('click', () => setDepthStyle(key));
    $('depth-swatches').appendChild(btn);
  });
  applyDepthFilter();   // seed the pane var + summary ramp for the default style

  /*
   * ---- turbidity & cloud-mask colormap pickers ----
   * Same flyout-swatch interface as kelp and depth. A palette here is
   * display-only, but these layers are minted server-side with the palette
   * baked in, so a switch re-mints the visible layer (cache-keyed, so
   * flipping back is instant). No range bar: neither layer has a slice to
   * restrict the way the kelp ramp does.
   */
  function buildSwatchGroup(elId, palettes, paramKey, onPick) {
    Object.keys(palettes || {}).forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend-swatch';
      btn.dataset.palette = key;
      btn.title = key;
      btn.setAttribute('aria-pressed', key === state.params[paramKey] ? 'true' : 'false');
      btn.style.background = gradient(palettes[key], 90);
      btn.addEventListener('click', () => onPick(key));
      $(elId).appendChild(btn);
    });
  }
  function syncSwatchGroup(elId, key) {
    $(elId).querySelectorAll('.legend-swatch').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.palette === key ? 'true' : 'false');
    });
  }
  function updateTurbRamp() {
    const stops = (cfg.TURBIDITY_PALETTES || {})[state.params.turbidityPalette];
    if (stops) $('turb-ramp').style.background = gradient(stops, 90);
  }
  function setTurbidityPalette(key) {
    if (!(cfg.TURBIDITY_PALETTES || {})[key] || key === state.params.turbidityPalette) return;
    state.params.turbidityPalette = key;
    syncSwatchGroup('turb-swatches', key);
    updateTurbRamp();
    if (state.params.turbidityOpacity > 0) ensureTurbidity();
    say('Turbidity colormap: ' + key);
  }
  function setCloudPalette(key) {
    if (!(cfg.CLOUD_PALETTES || {})[key] || key === state.params.cloudPalette) return;
    state.params.cloudPalette = key;
    syncSwatchGroup('cloud-swatches', key);
    if (state.params.cloudOpacity > 0) ensureCloudMask();
    say('Cloud mask tint: ' + key);
  }
  buildSwatchGroup('turb-swatches', cfg.TURBIDITY_PALETTES, 'turbidityPalette', setTurbidityPalette);
  buildSwatchGroup('cloud-swatches', cfg.CLOUD_PALETTES, 'cloudPalette', setCloudPalette);
  updateTurbRamp();

  /*
   * ---- custom contours: draggable depth ruler ----
   * A horizontal 0-200 ft ruler replaces the old numeric input. Click the bare
   * line to trace a new contour there; drag an existing marker to retarget it
   * (contour redraw — a DEM resample — only fires on release, not per pixel of
   * drag); click a marker for its colour picker; right-click to remove it.
   */
  const CC_MAX_FT = 200;

  function buildContourMarker(it) {
    const ruler = $('cc-ruler');
    const depth = Math.max(0, Math.min(CC_MAX_FT, Math.abs(it.feet)));

    const marker = document.createElement('div');
    marker.className = 'cc-marker';
    marker.style.left = (depth / CC_MAX_FT * 100) + '%';
    marker.style.background = it.color;
    marker.textContent = '⚙';
    marker.title = 'Drag to move, click for colour, right-click to remove';

    const label = document.createElement('span');
    label.className = 'cc-marker-label';
    label.textContent = Math.round(depth) + ' ft';
    marker.appendChild(label);

    const menu = document.createElement('div');
    menu.className = 'cc-menu';
    menu.hidden = true;
    const color = document.createElement('input');
    color.type = 'color'; color.value = it.color; color.title = 'Contour colour';
    color.addEventListener('change', () => {
      CustomContours.setColor(it.id, color.value);
      marker.style.background = color.value;
    });
    menu.appendChild(color);
    marker.appendChild(menu);

    let dragging = false, moved = false, startX = 0, startDepth = depth, pending = depth;

    marker.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true; moved = false;
      startX = ev.clientX;
      startDepth = Math.max(0, Math.min(CC_MAX_FT, Math.abs(it.feet)));
      pending = startDepth;
      try { marker.setPointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
      ev.preventDefault();   // a drag must never double as a text-selection
    });

    marker.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const rawDx = ev.clientX - startX;
      if (Math.abs(rawDx) > 3) moved = true;
      const scaledDx = rawDx * 0.1;                       // 1/10 sensitivity — fine control
      const ftPerPx = CC_MAX_FT / ruler.clientWidth;
      pending = Math.max(0, Math.min(CC_MAX_FT, startDepth + scaledDx * ftPerPx));
      marker.style.left = (pending / CC_MAX_FT * 100) + '%';
      label.textContent = Math.round(pending) + ' ft';    // live label; the contour itself waits for release
    });

    marker.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      try { marker.releasePointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
      if (moved) {
        const next = Math.round(pending);
        if (next !== Math.round(startDepth)) {
          CustomContours.setDepth(it.id, next);
          say(next + ' ft contour moved');
        } else {
          label.textContent = Math.round(startDepth) + ' ft';
        }
      } else {
        document.querySelectorAll('.cc-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      }
    });

    marker.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const ftLabel = Math.abs(it.feet);
      CustomContours.remove(it.id);
      renderContourRuler();
      say(ftLabel + ' ft contour removed');
    });

    return marker;
  }

  function renderContourRuler() {
    const ruler = $('cc-ruler');
    ruler.textContent = '';
    for (let ft = 0; ft <= CC_MAX_FT; ft += 10) {
      const tick = document.createElement('span');
      tick.className = 'cc-tick' + (ft % 50 === 0 ? ' cc-tick-major' : '');
      tick.style.left = (ft / CC_MAX_FT * 100) + '%';
      ruler.appendChild(tick);
    }
    CustomContours.items.forEach((it) => ruler.appendChild(buildContourMarker(it)));
  }

  $('cc-ruler').addEventListener('click', (ev) => {
    if (ev.target.closest('.cc-marker')) return;
    const r = $('cc-ruler').getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    // click-to-add snaps to a round 5 ft; dragging afterwards is deliberately
    // free-form (see the marker's pointermove handler), so coarse placement is
    // easy and fine adjustment stays possible
    const depth = Math.round(frac * CC_MAX_FT / 5) * 5;
    const it = CustomContours.add(depth);
    if (!it) return;
    renderContourRuler();
    say('Tracing the ' + depth + ' ft contour…');
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('.cc-marker')) return;
    $('cc-ruler').querySelectorAll('.cc-menu').forEach((m) => { m.hidden = true; });
  });
  renderContourRuler();

  /*
   * ---- model-dirty tracking ----
   * Index, kelp threshold and B11 no longer recompute on release; they mark the
   * map stale and light up Rerun instead. In live mode every run is an Earth
   * Engine request, so firing one per slider release was wasteful — and it also
   * meant the button could never usefully show a changed state. Layer opacity is
   * excluded: it restyles the existing layer and needs no recomputation.
   */
  function setDirty(on) {
    state.dirty = on;
    const btn = $('run');
    btn.disabled = !on;
    btn.className = 'btn run' + (on ? ' dirty' : '');
    $('run-hint').textContent = on
      ? 'Model settings changed — rerun to apply them.'
      : 'Up to date with the current settings.';
  }

  // ---- collapsible console sections ----
  document.querySelectorAll('.sect-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = $(btn.dataset.target);
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      body.hidden = open;
      btn.querySelector('.sect-caret').textContent = open ? '▸' : '▾';
    });
  });

  $('run').addEventListener('click', run);

  /*
   * ---- paths panel ----
   * Profiles are stored in metres and feet and converted only for display, so
   * changing units is a re-render and never touches the sampled data. The
   * exported spreadsheet keeps its fixed distance_m / depth_ft columns for the
   * same reason — the file schema shouldn't shift with a UI preference.
   */
  const DIST_UNITS = {
    mi: { label: 'mi', from: (m) => m / 1609.344, dp: 2 },
    km: { label: 'km', from: (m) => m / 1000, dp: 2 },
    m:  { label: 'm',  from: (m) => m, dp: 0 },
    ft: { label: 'ft', from: (m) => m * 3.280839895, dp: 0 }
  };
  const DEPTH_UNITS = {
    ft: { label: 'ft', from: (ft) => ft, dp: 0 },
    m:  { label: 'm',  from: (ft) => ft / 3.280839895, dp: 0 }
  };
  const distU = () => DIST_UNITS[state.params.distUnit] || DIST_UNITS.mi;
  const depthU = () => DEPTH_UNITS[state.params.depthUnit] || DEPTH_UNITS.ft;
  const fmtDist = (metres) => { const u = distU(); return u.from(metres).toFixed(u.dp) + ' ' + u.label; };
  const fmtDepth = (feet) => { const u = depthU(); return u.from(feet).toFixed(u.dp) + ' ' + u.label; };

  /*
   * Gas-planning units. Unlike dist/depth (sampled once, in fixed units, and
   * only ever formatted for display), SAC/speed are typed in directly — so
   * each unit needs a round trip, toBase for what the user types and fromBase
   * for what's shown back. Base units are the defaults: cuft/min, mi/hr.
   */
  const SAC_UNITS = {
    'cuft/min': { label: 'cuft/min', toBase: (v) => v, fromBase: (v) => v, dp: 2 },
    'L/min':    { label: 'L/min', toBase: (v) => v / 28.316846592, fromBase: (v) => v * 28.316846592, dp: 1 }
  };
  const SPEED_UNITS = {
    'mi/hr': { label: 'mi/hr', toBase: (v) => v, fromBase: (v) => v, dp: 2 },
    'm/s':   { label: 'm/s', toBase: (v) => v * 2.2369362921, fromBase: (v) => v / 2.2369362921, dp: 2 },
    'kts':   { label: 'kts', toBase: (v) => v * 1.15077945, fromBase: (v) => v / 1.15077945, dp: 2 },
    'km/hr': { label: 'km/hr', toBase: (v) => v * 0.62137119224, fromBase: (v) => v / 0.62137119224, dp: 2 }
  };
  const sacU = () => SAC_UNITS[state.params.sacUnit] || SAC_UNITS['cuft/min'];
  const speedU = () => SPEED_UNITS[state.params.speedUnit] || SPEED_UNITS['mi/hr'];

  const UNIT_TABLES = { dist: DIST_UNITS, depth: DEPTH_UNITS, sac: SAC_UNITS, speed: SPEED_UNITS };
  const UNIT_TITLES = {
    dist: 'Distance units', depth: 'Depth units',
    sac: 'SAC units', speed: 'Speed units'
  };
  function unitSelect(kind, current, onPick) {
    const sel = document.createElement('select');
    sel.className = 'pp-units';
    sel.title = UNIT_TITLES[kind];
    Object.keys(UNIT_TABLES[kind]).forEach((k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = k;
      if (k === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  }

  // Total path length in miles — the shared basis for the speed<->time conversion.
  const lengthMiles = (p) => Paths.lengthOf(p) / 1609.344;

  /*
   * Gas planning is one console for every path (see #pp-global-tools), not a
   * per-path setting: state.params.speed/time/timeMode drive it, and each
   * path only contributes its own length. Whichever of speed/time the diver
   * did NOT type in is derived from the other plus this path's length.
   */
  function effectiveTimeSpeed(p) {
    const miles = lengthMiles(p);
    if (state.params.timeMode === 'time') {
      const timeMin = state.params.time;
      const speedMiHr = timeMin > 0 ? miles / (timeMin / 60) : 0;
      return { timeMin: timeMin, speedMiHr: speedMiHr };
    }
    const speedMiHr = state.params.speed;
    const timeMin = speedMiHr > 0 ? (miles / speedMiHr) * 60 : 0;
    return { timeMin: timeMin, speedMiHr: speedMiHr };
  }

  /*
   * Cumulative gas consumption along a path, assuming constant swim speed
   * (so distance along the path maps directly to elapsed time) and SAC scaled
   * by ambient pressure at each sampled depth (1 atm at the surface, +1 atm
   * every 33 ft of seawater).
   */
  const ATA_DEPTH_FT = 33;
  function gasProfile(p) {
    const pts = (p.profile || []).filter((s) => s.feet !== null);
    const speedMiHr = effectiveTimeSpeed(p).speedMiHr;
    if (pts.length < 2 || !(speedMiHr > 0) || !(state.params.sac > 0)) return null;
    let cum = 0, prevMi = 0;
    const points = pts.map((s, i) => {
      /*
       * Clamp at the surface. A path can cross land or dry reef, where the
       * DEM reports elevation ABOVE sea level — a negative "depth". Left
       * unclamped that drives ATA below 1 (and negative for anything over
       * ~33 ft of elevation), so a leg would consume negative gas and the
       * running budget would refund itself. Surface pressure is the floor.
       */
      // gas burns at the PLANNED depth — bottom, capped by ceilings, pushed
      // back down by floors. One function shared with the plot and leg table.
      const depthFt = Paths.plannedFtAt(p, s.distance, Math.max(0, -s.feet));
      const ata = 1 + depthFt / ATA_DEPTH_FT;
      const mi = s.distance / 1609.344;
      const dtMin = i === 0 ? 0 : ((mi - prevMi) / speedMiHr) * 60;
      cum += state.params.sac * ata * dtMin;
      prevMi = mi;
      return { distance: s.distance, cuft: cum };
    });
    return { points: points, total: cum };
  }

  /*
   * ---- cylinders ----
   * A gas source's usable volume is its total minus whatever reserve the
   * diver declared. Reserve may be given as a volume, as a pressure, or
   * both; with both ticked the LARGER of the two wins, because two stated
   * minimums mean "at least this much left", not an average.
   */
  const PRESSURE_UNITS = { psi: { label: 'psi', from: (psi) => psi }, bar: { label: 'bar', from: (psi) => psi / 14.5038 } };
  const pressU = () => PRESSURE_UNITS[state.params.pressureUnit] || PRESSURE_UNITS.psi;
  const cylinders = () => state.params.cylinders || [];
  const cylinderById = (id) => cylinders().find((c) => c.id === id) || cylinders()[0] || null;
  /*
   * A stable colour per cylinder, by position in the cylinder list, shared by
   * the leg table, the per-cylinder budget list and the gas curve on the plot
   * — so "which tank am I on here?" is answered by colour alone everywhere.
   */
  const CYL_COLORS = ['#5ec6c9', '#f2b134', '#c78bd9', '#a6d95b', '#e2725b', '#6fb7bd'];
  function cylColour(id) {
    const i = cylinders().findIndex((c) => c.id === id);
    return i < 0 ? '#9dc3cc' : CYL_COLORS[i % CYL_COLORS.length];
  }

  function reserveCuft(cyl) {
    if (!cyl) return 0;
    const byVol = cyl.useReserveCuft ? (cyl.reserveCuft || 0) : 0;
    const byPsi = (cyl.useReservePsi && cyl.startPsi > 0)
      ? (cyl.reservePsi || 0) / cyl.startPsi * (cyl.totalCuft || 0) : 0;
    return Math.max(byVol, byPsi);
  }
  const usableCuft = (cyl) => Math.max(0, (cyl ? cyl.totalCuft || 0 : 0) - reserveCuft(cyl));
  // cuft -> the gauge reading that volume corresponds to on this cylinder
  function cuftToPressure(cyl, cuft) {
    if (!cyl || !(cyl.totalCuft > 0)) return null;
    return pressU().from(cuft / cyl.totalCuft * (cyl.startPsi || 0));
  }

  /*
   * ---- leg table ----
   * The slate view: one row per segment with the compass heading and distance
   * you would actually swim, plus the depths along it.
   *
   * Leg distances are shown in the DEPTH unit (ft/m) rather than distUnit —
   * legs are tens of metres, and "0.06 mi" is useless on a slate. Headings are
   * true bearings (see Paths.bearing); the note under the table says so,
   * because a diver's compass reads magnetic.
   */
  /*
   * One enriched row per segment, including the running gas budget. Legs are
   * walked in order so each cylinder's consumption accumulates: a leg is
   * "over" once the legs drawing on its source have used more than that
   * source's usable volume (total minus reserve).
   */
  function gasAt(gp, dist) {
    if (!gp) return null;
    let best = null, bestD = Infinity;
    gp.points.forEach((s) => {
      const d = Math.abs(s.distance - dist);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best ? best.cuft : null;
  }

  function legData(p) {
    const legs = Paths.legsOf(p.id);
    const cum = Paths.nodeDistances(p);
    const gp = p.showGas ? gasProfile(p) : null;
    const used = {};                      // cylinder id -> cuft drawn so far
    p.legGas = p.legGas || {};
    return legs.map((lg, i) => {
      const cylId = p.legGas[i] || (cylinders()[0] && cylinders()[0].id) || null;
      const cyl = cylinderById(cylId);
      const startCuft = gasAt(gp, cum[i]);
      const endCuft = gasAt(gp, cum[i + 1]);
      const spend = (startCuft !== null && endCuft !== null) ? endCuft - startCuft : null;
      /*
       * The table counts DOWN, the way a submersible pressure gauge does:
       * each row reports what is LEFT in that leg's cylinder once the leg is
       * finished, not what has been burned so far. A leg is over budget once
       * what remains has fallen past the declared reserve.
       */
      let over = false, drawn = null, remainCuft = null, remainPsi = null, empty = false;
      if (cyl && spend !== null) {
        used[cylId] = (used[cylId] || 0) + spend;
        drawn = used[cylId];
        const raw = (cyl.totalCuft || 0) - drawn;
        // A cylinder cannot hold less than nothing: the column mimics a gauge,
        // and a negative reading would be meaningless. Floor it at empty and
        // let the per-cylinder summary below carry the true shortfall.
        empty = raw <= 0;
        remainCuft = Math.max(0, raw);
        remainPsi = cuftToPressure(cyl, remainCuft);
        over = raw < reserveCuft(cyl);
      }
      return Object.assign({}, lg, {
        kicks: state.params.kickDistance > 0 ? Math.round(lg.metres / state.params.kickDistance) : null,
        startCuft: startCuft, endCuft: endCuft, drawn: drawn,
        remainCuft: remainCuft, remainPsi: remainPsi, empty: empty,
        cylId: cylId, cyl: cyl, over: over
      });
    });
  }

  /*
   * Both the DOM table and the CSV are generated from this one column
   * description, so the file can never drift from what is on screen.
   */
  // true -> magnetic. East declination is positive, so it subtracts.
  function magneticOf(trueDeg) {
    return ((trueDeg - (state.params.declination || 0)) % 360 + 360) % 360;
  }

  /*
   * Where does the first cylinder cross into its reserve? Walk the legs in
   * order, tracking gas drawn per cylinder; on the leg where a cylinder's
   * remaining falls past reserve, interpolate the distance at the crossing
   * and return it with the nearest profile sample's position.
   */
  function reserveCrossing(p, rows) {
    const gp = p.showGas ? gasProfile(p) : null;
    if (!gp) return null;
    const cum = Paths.nodeDistances(p);
    const used = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.cyl) continue;
      const startCuft = gasAt(gp, cum[i]);
      const endCuft = gasAt(gp, cum[i + 1]);
      if (startCuft === null || endCuft === null) continue;
      const spend = endCuft - startCuft;
      const before = used[r.cylId] || 0;
      used[r.cylId] = before + spend;
      const budget = (r.cyl.totalCuft || 0) - reserveCuft(r.cyl);
      if (before < budget && used[r.cylId] >= budget && spend > 0) {
        // fraction of this leg's spend at which the budget runs out
        const frac = (budget - before) / spend;
        const dist = cum[i] + frac * (cum[i + 1] - cum[i]);
        const pts = (p.profile || []).filter((sm) => sm.feet !== null);
        let best = pts[0];
        pts.forEach((sm) => {
          if (Math.abs(sm.distance - dist) < Math.abs(best.distance - dist)) best = sm;
        });
        if (!best) return null;
        return { dist: dist, latlng: { lat: best.lat, lng: best.lng }, cylName: r.cyl.name };
      }
    }
    return null;
  }

  function legColumns(p) {
    const u = depthU();
    const cols = [
      { key: 'leg', head: 'Leg', get: (r) => String(r.leg) },
      /*
       * Magnetic, not true: declination is applied here so the number can be
       * steered straight off a compass without the diver doing arithmetic on
       * a slate. magnetic = true - declination (east positive).
       */
      { key: 'heading', head: 'Heading (M)',
        get: (r) => Math.round(magneticOf(r.heading)) + '°' },
      // distance carries kick cycles alongside it when a kick length is set
      { key: 'dist',
        head: 'Distance ' + u.label + (state.params.kickDistance > 0 ? ' / kicks' : ''),
        get: (r) => {
          const d = u.from(r.metres * M_TO_FT).toFixed(u.dp === 0 ? 0 : 1);
          return r.kicks === null ? d : d + ' / ' + r.kicks;
        } }
    ];
    // max and average read together as one figure: "56 (48)"
    cols.push({
      key: 'depth', head: 'Depth max (avg) ' + u.label,
      get: (r) => {
        if (r.maxFt === null) return '—';
        const mx = u.from(r.maxFt).toFixed(u.dp);
        const av = r.avgFt === null ? '—' : u.from(r.avgFt).toFixed(u.dp);
        return mx + ' (' + av + ')';
      }
    });
    if (p.showGas) {
      // what is LEFT at the end of the leg, volume and gauge pressure together
      const pl = pressU().label;
      cols.push({
        key: 'gasLeft', head: 'Gas left cuft / ' + pl,
        get: (r) => {
          if (r.remainCuft === null) return '—';
          if (r.empty) return 'OUT';
          const psi = r.remainPsi === null ? '—' : Math.round(r.remainPsi).toString();
          return r.remainCuft.toFixed(1) + ' / ' + psi;
        }
      });
      if (cylinders().length > 1) {
        cols.push({ key: 'source', head: 'Gas source', get: (r) => (r.cyl ? r.cyl.name : '—') });
      }
    }
    return cols;
  }

  /*
   * Rows carry data-leg so hovering the profile can highlight the leg under
   * the cursor, and the gas-source cell becomes a live picker once more than
   * one cylinder exists.
   */
  function renderLegTable(p, host) {
    const rows = legData(p);
    const cols = legColumns(p);
    host.textContent = '';
    if (!rows.length) {
      const t = document.createElement('div');
      t.className = 'hint'; t.textContent = 'A leg table needs at least two nodes.';
      host.appendChild(t);
      return;
    }

    const tools = document.createElement('div');
    tools.className = 'legs-tools';
    /*
     * If a cylinder falls to its reserve mid-path, offer to drop a node at the
     * exact crossing so the plan can switch sources there: the new node splits
     * the leg, and the leg after it can be assigned the next cylinder.
     */
    const rp = reserveCrossing(p, rows);
    if (rp) {
      const resBtn = document.createElement('button');
      resBtn.type = 'button'; resBtn.className = 'menu-action reserve-node-btn';
      resBtn.textContent = '＋ node at reserve (' + fmtDist(rp.dist) + ')';
      resBtn.title = rp.cylName + ' reaches its reserve here — add a node to switch cylinders';
      resBtn.addEventListener('click', () => {
        Paths.insertAt(p.id, rp.latlng);
        say('Node added where ' + rp.cylName + ' hits reserve — assign the next leg a fresh cylinder');
      });
      tools.appendChild(resBtn);
    }
    const printBtn = document.createElement('button');
    printBtn.type = 'button'; printBtn.className = 'menu-action'; printBtn.textContent = 'Print';
    printBtn.addEventListener('click', () => printLegTable(p));
    const csvBtn = document.createElement('button');
    csvBtn.type = 'button'; csvBtn.className = 'menu-action'; csvBtn.textContent = 'Save CSV';
    csvBtn.addEventListener('click', () => saveLegCsv(p));
    tools.appendChild(printBtn); tools.appendChild(csvBtn);
    host.appendChild(tools);

    const scroller = document.createElement('div');
    scroller.className = 'legs-scroll';
    const table = document.createElement('table');
    table.className = 'legs-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    cols.forEach((c) => { const th = document.createElement('th'); th.textContent = c.head; htr.appendChild(th); });
    thead.appendChild(htr); table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.dataset.leg = String(i);
      if (r.over) tr.classList.add('over-budget');
      cols.forEach((c) => {
        const td = document.createElement('td');
        if (c.key === 'source' && cylinders().length > 1) {
          const dot = document.createElement('span');
          dot.className = 'cyl-dot';
          dot.style.background = cylColour(r.cylId);
          td.appendChild(dot);
          const sel = document.createElement('select');
          sel.className = 'pp-units';
          cylinders().forEach((cy) => {
            const o = document.createElement('option');
            o.value = String(cy.id); o.textContent = cy.name;
            if (cy.id === r.cylId) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('change', () => {
            p.legGas[i] = +sel.value;
            renderLegTable(p, host);      // every budget downstream of this leg shifts
          });
          td.appendChild(sel);
        } else if (c.key === 'source' && r.cyl) {
          const dot = document.createElement('span');
          dot.className = 'cyl-dot';
          dot.style.background = cylColour(r.cylId);
          td.appendChild(dot);
          td.appendChild(document.createTextNode(c.get(r)));
        } else {
          td.textContent = c.get(r);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const totalM = rows.reduce((a, r) => a + r.metres, 0);
    const last = rows[rows.length - 1];
    const tfoot = document.createElement('tfoot');
    const ftr = document.createElement('tr');
    cols.forEach((c) => {
      const td = document.createElement('td');
      if (c.key === 'leg') td.textContent = 'Total';
      else if (c.key === 'dist') {
        const d = depthU().from(totalM * M_TO_FT).toFixed(depthU().dp === 0 ? 0 : 1);
        td.textContent = state.params.kickDistance > 0
          ? d + ' / ' + Math.round(totalM / state.params.kickDistance) : d;
      }
      else if (c.key === 'gasLeft') {
        // the surfacing figure: what is left when the last leg is done
        td.textContent = last.remainCuft === null ? '—'
          : last.empty ? 'OUT'
          : last.remainCuft.toFixed(1) + ' / ' +
            (last.remainPsi === null ? '—' : Math.round(last.remainPsi));
        if (last.over) td.classList.add('over-budget-cell');
      }
      ftr.appendChild(td);
    });
    tfoot.appendChild(ftr); table.appendChild(tfoot);
    scroller.appendChild(table);
    host.appendChild(scroller);

    // per-cylinder verdict: what each source is asked for against what it has
    if (p.showGas && cylinders().length) {
      const drawnBy = {};
      rows.forEach((r) => { if (r.cyl && r.drawn !== null) drawnBy[r.cylId] = r.drawn; });
      const sum = document.createElement('div');
      sum.className = 'legs-budget-list';
      cylinders().forEach((cy) => {
        const need = drawnBy[cy.id];
        if (need === undefined) return;
        const left = (cy.totalCuft || 0) - need;
        const short = left < reserveCuft(cy);
        const line = document.createElement('div');
        line.className = 'legs-budget' + (short ? ' over-budget-cell' : '');
        const dot = document.createElement('span');
        dot.className = 'cyl-dot';
        dot.style.background = cylColour(cy.id);
        line.appendChild(dot);
        line.appendChild(document.createTextNode(left < 0
          ? cy.name + ': SHORT BY ' + (-left).toFixed(1) + ' cuft — needs ' +
            need.toFixed(1) + ' of ' + (cy.totalCuft || 0) + ' available'
          : cy.name + ': ' + left.toFixed(1) + ' cuft left of ' + (cy.totalCuft || 0) +
            ', reserve ' + reserveCuft(cy).toFixed(1) + (short ? ' — INTO RESERVE' : '')));
        sum.appendChild(line);
      });
      host.appendChild(sum);
    }

    const note = document.createElement('div');
    note.className = 'legs-note';
    const bits = ['Headings are MAGNETIC — true bearings corrected by the ' + state.params.declination + '° E declination set in Path options, so they can be steered directly on a compass.'];
    if (!p.profile) bits.push('Depths are blank until the profile finishes reading.');
    if (state.params.kickDistance <= 0) bits.push('Set a kick distance in Path options to add a kick-cycle column.');
    if (!p.showGas) bits.push('Turn gas tracking on in this path’s menu to budget cylinders across its legs.');
    note.textContent = bits.join(' ');
    host.appendChild(note);
  }

  function legCsv(p) {
    const rows = legData(p);
    const cols = legColumns(p);
    const all = [cols.map((c) => c.head)].concat(rows.map((r) => cols.map((c) => c.get(r))));
    return all.map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  function saveLegCsv(p) {
    const url = URL.createObjectURL(new Blob([legCsv(p)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = p.name.replace(/[^\w-]+/g, '_') + '_legs.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('Leg table saved for ' + p.name, 'ok');
  }

  /*
   * Printing marks the one table to print; the @media print rules hide
   * everything else. Without the mark, every open leg table would print.
   */
  function printLegTable(p) {
    document.querySelectorAll('.legs-panel').forEach((el) => el.classList.remove('printing'));
    const host = document.querySelector('.pp-item[data-path="' + p.id + '"] .legs-panel');
    if (host) host.classList.add('printing');
    window.print();
  }

  // ---- paths panel ----
  // Depth-vs-distance sparkline. Depth increases downward, which is the way a
  // profile is conventionally read.
  function profileSvg(p, pxWidth) {
    const pts = (p.profile || []).filter((s) => s.feet !== null);
    if (pts.length < 2) return null;
    // The viewBox width is matched to the actual rendered pixel width (measured
    // by the caller) rather than fixed, so 1 viewBox unit == 1 CSS px and text
    // never needs non-uniform scaling to fill the panel — see the comment on
    // preserveAspectRatio below.
    /*
     * Height tracks the panel's width at a fixed aspect ratio (so widening
     * the dock makes the profile genuinely taller, not just wider), capped
     * so a very wide dock does not hand one path the whole column. Dragging
     * the resize grip opts a path out of that and pins its own height.
     */
    const W = Math.max(120, Math.round(pxWidth) || 240);
    const H = p.plotHeightManual
      ? Math.max(32, Math.round(p.plotHeight) || 62)
      : Math.round(Math.max(62, Math.min(240, W / 3.2)));
    const PADL = 26, PADB = 12, PADT = 4;
    const fullMax = Math.max.apply(null, pts.map((s) => -s.feet));
    /*
     * Wheel over the plot zooms the DEPTH axis: shallow structure — the part a
     * diver actually plans around — is unreadable when one deep sounding sets
     * the scale. Zoom is per path, capped 8x, double-click resets, and it
     * anchors on the depth UNDER THE CURSOR, so the feature being inspected
     * stays put while the scale changes. depthPan is the depth at the top of
     * the view (0 until zoomed); drag the axis gutter to slide it. Both are
     * session state, like the zoom always was. Deeper values clip at the plot
     * edge rather than smearing over the axis labels.
     */
    p.depthZoom = Math.max(1, Math.min(8, p.depthZoom || 1));
    const maxD = fullMax / p.depthZoom;
    const plotH = H - PADT - PADB;
    p.depthPan = Math.max(0, Math.min(fullMax - maxD, p.depthPan || 0));
    const panD = p.depthPan;
    const maxX = pts[pts.length - 1].distance || 1;
    const x = (d) => PADL + (W - PADL - 4) * (d / maxX);
    const y = (ft) => PADT + plotH * ((ft - panD) / (maxD || 1));

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.style.height = H + 'px';

    // series are clipped to the plot box so zoomed-off depths don't smear
    const clipId = 'ppclip' + p.id;
    const defs = document.createElementNS(NS, 'defs');
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', clipId);
    const cr = document.createElementNS(NS, 'rect');
    cr.setAttribute('x', 0); cr.setAttribute('y', 0);
    cr.setAttribute('width', W); cr.setAttribute('height', H - PADB + 1);
    clip.appendChild(cr); defs.appendChild(clip); svg.appendChild(defs);

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = Math.max(1, Math.min(8, (p.depthZoom || 1) * factor));
      if (next === p.depthZoom) return;
      // anchor on the cursor: the depth under it before the zoom is put back
      // under it after, so zooming in walks toward the point being examined
      const r = svg.getBoundingClientRect();
      const vy = r.height ? ((ev.clientY - r.top) / r.height) * H : PADT;
      const frac = Math.max(0, Math.min(1, (vy - PADT) / plotH));
      // p.depthPan, not the render-time panD: an axis pan may not have
      // re-rendered yet when the wheel arrives
      const ftAtCursor = (p.depthPan || 0) + frac * maxD;
      p.depthZoom = next;
      const newMaxD = fullMax / next;
      p.depthPan = Math.max(0, Math.min(fullMax - newMaxD, ftAtCursor - frac * newMaxD));
      renderPaths();
    }, { passive: false });
    svg.addEventListener('dblclick', () => {
      if ((p.depthZoom || 1) !== 1 || (p.depthPan || 0) !== 0) {
        p.depthZoom = 1; p.depthPan = 0; renderPaths();
      }
    });   // draggable per path (p.plotHeight) — see the resize handle below
    /*
     * No preserveAspectRatio="none" here (unlike before): since W now matches
     * the container's real width and H matches the CSS height, the viewBox
     * aspect ratio already equals the rendered box's, so the default uniform
     * scale (1:1) applies and text/strokes never stretch horizontally when the
     * panel or window is resized.
     */

    /*
     * Two depth series. `eff` is the planned depth — the bottom, capped by any
     * ceiling covering that distance. The solid line and fill draw eff; where a
     * ceiling actually bites, the true bottom is added back as a dotted line so
     * the cap can never be misread as bathymetry.
     */
    const effFt = (smp) => Paths.plannedFtAt(p, smp.distance, -smp.feet);
    const capped = (smp) => effFt(smp) < -smp.feet - 1e-9;

    const area = document.createElementNS(NS, 'path');
    let d = 'M' + x(0) + ',' + y(0);
    pts.forEach((s) => { d += 'L' + x(s.distance).toFixed(1) + ',' + y(effFt(s)).toFixed(1); });
    d += 'L' + x(maxX) + ',' + y(0) + 'Z';
    area.setAttribute('d', d);
    area.setAttribute('fill', p.color);
    area.setAttribute('fill-opacity', '0.22');
    area.setAttribute('clip-path', 'url(#' + clipId + ')');
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.map((s) => x(s.distance).toFixed(1) + ',' + y(effFt(s)).toFixed(1)).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', p.color);
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('clip-path', 'url(#' + clipId + ')');
    svg.appendChild(line);

    /*
     * The seabed's grab band. Invisible, exactly as wide as the hit test that
     * starts an offset drag, and carrying touch-action:none — which is the
     * whole point of it existing as an element at all.
     *
     * The plot as a whole is touch-action:pan-y so the sheet can still be
     * scrolled by dragging over it. An offset drag is VERTICAL, so the browser
     * read the first few pixels of one as a scroll, took the gesture, and the
     * page moved instead of the seabed. touch-action is only consulted where
     * the gesture BEGINS, so the exemption has to be a real element under the
     * finger rather than a flag set once the drag is under way.
     *
     * Scoping it to the band means the rest of the plot still scrolls the
     * sheet normally: the only place you cannot scroll from is the one place
     * a downward drag already means something else.
     */
    const seabedGrab = document.createElementNS(NS, 'polyline');
    seabedGrab.setAttribute('points', line.getAttribute('points'));
    seabedGrab.setAttribute('fill', 'none');
    seabedGrab.setAttribute('stroke', 'transparent');
    seabedGrab.setAttribute('stroke-width', String(SEABED_GRAB_PX * 2));
    seabedGrab.setAttribute('stroke-linejoin', 'round');
    seabedGrab.setAttribute('class', 'seabed-grab');
    seabedGrab.setAttribute('clip-path', 'url(#' + clipId + ')');
    svg.appendChild(seabedGrab);

    /*
     * Each ceiling/floor gets an invisible fat grab-line over its span: drag it
     * vertically to adjust the bound's depth, right-click it to remove just
     * that one. The visible flat segment is part of the planned polyline, so
     * this hit target is what makes the bound feel like an object.
     */
    const addBoundGrip = (bound, kind) => {
      const x1 = x(Math.max(0, bound.start)), x2 = x(Math.min(maxX, bound.end));
      if (x2 - x1 < 4) return;
      const grip = document.createElementNS(NS, 'line');
      grip.setAttribute('x1', x1); grip.setAttribute('x2', x2);
      grip.setAttribute('y1', y(bound.feet)); grip.setAttribute('y2', y(bound.feet));
      grip.setAttribute('stroke', 'transparent');
      grip.setAttribute('stroke-width', COARSE_POINTER ? '26' : '12');
      grip.setAttribute('class', 'bound-grip');
      grip.style.cursor = 'ns-resize';
      let dragging = false, preview = null, label = null;
      /*
       * grabDy holds the gap between where the finger landed and the bound's
       * own line, so the line keeps that gap for the rest of the drag. Without
       * it the bound teleported so its centre sat under the touch point the
       * instant it was grabbed — on a fingertip, which covers ~30px of water
       * column, that meant every adjustment began by throwing the value
       * several feet away from where it was.
       */
      let grabDy = 0;
      const ftFromY = (clientY) => {
        const r = svg.getBoundingClientRect();
        const vy = ((clientY - grabDy - r.top) / r.height) * H;
        return Math.max(1, Math.round(panD + ((vy - PADT) / plotH) * (maxD || 1)));
      };
      grip.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        dragging = true;
        const gr = svg.getBoundingClientRect();
        grabDy = ev.clientY - (gr.top + (y(bound.feet) / H) * gr.height);
        // capture keeps the drag when the pointer outruns the thin hit line;
        // it can throw for an already-released pointer, and losing capture is
        // a degraded drag rather than an error, so it must not abort setup
        try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* degrade */ }
        preview = document.createElementNS(NS, 'line');
        preview.setAttribute('x1', x1); preview.setAttribute('x2', x2);
        preview.setAttribute('stroke', p.color); preview.setAttribute('stroke-width', '1');
        preview.setAttribute('stroke-dasharray', '4 3');
        label = document.createElementNS(NS, 'text');
        label.setAttribute('class', 'pp-axis');
        label.setAttribute('x', (x1 + x2) / 2); label.setAttribute('text-anchor', 'middle');
        svg.appendChild(preview); svg.appendChild(label);
        ev.stopPropagation(); ev.preventDefault();
      });
      grip.addEventListener('pointermove', (ev) => {
        if (!dragging || !preview) return;
        const ft = ftFromY(ev.clientY);
        const yy = y(ft);
        preview.setAttribute('y1', yy); preview.setAttribute('y2', yy);
        label.setAttribute('y', yy - 3);
        label.textContent = fmtDepth(ft);
        // the in-plot label is small and sits under the hand on touch
        showDragReadout((kind === 'ceiling' ? 'Ceiling ' : 'Floor ') + fmtDepth(ft),
                        ev.clientX, ev.clientY);
      });
      grip.addEventListener('pointerup', (ev) => {
        if (!dragging) return;
        dragging = false;
        hideDragReadout();
        bound.feet = ftFromY(ev.clientY);
        say((kind === 'ceiling' ? 'Ceiling' : 'Floor') + ' moved to ' + fmtDepth(bound.feet));
        renderPaths();
        persistNow();
      });
      grip.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const list = kind === 'ceiling' ? p.ceilings : p.floors;
        const i = list.indexOf(bound);
        if (i >= 0) {
          list.splice(i, 1);
          say((kind === 'ceiling' ? 'Ceiling' : 'Floor') + ' removed from ' + p.name);
          renderPaths();
          persistNow();
        }
      });
      /*
       * Same removal by touch. Hold still to delete, drag to move: the press
       * cancels itself past 10px of travel, so the two gestures cannot be
       * confused by anything except a hand that grabs the grip and then waits
       * half a second without moving — which is what a long press IS.
       */
      longPressContextMenu(grip);
      svg.appendChild(grip);

      /*
       * Endpoint handles: each end of the span is a draggable node. Dragging
       * moves that end in BOTH axes — x re-scopes the span, y retunes the
       * bound's depth — and right-clicking an endpoint deletes the bound.
       */
      [['start', x1], ['end', x2]].forEach(([which, hx]) => {
        const h = document.createElementNS(NS, 'circle');
        h.setAttribute('cx', hx); h.setAttribute('cy', y(bound.feet));
        // the drawn dot stays small so it does not hide the line it marks;
        // stroke-width is what a pointer actually has to hit, and a fingertip
        // needs far more of it than a cursor
        h.setAttribute('r', 5);
        h.setAttribute('class', 'bound-end');
        h.setAttribute('fill', p.color);
        h.setAttribute('stroke', '#05161c');
        h.setAttribute('stroke-width', COARSE_POINTER ? '14' : '1.5');
        if (COARSE_POINTER) h.setAttribute('paint-order', 'stroke');
        h.style.cursor = 'ew-resize';
        let dragging2 = false, grabDx = 0;
        const distFromX = (clientX) => {
          const r = svg.getBoundingClientRect();
          const vx = ((clientX - grabDx - r.left) / r.width) * W;
          return Math.max(0, Math.min(maxX, ((vx - PADL) / (W - PADL - 4)) * maxX));
        };
        h.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          dragging2 = true;
          // hold the gap between finger and handle, so the span edge does not
          // leap to the touch point before the drag has even begun
          const r = svg.getBoundingClientRect();
          grabDx = ev.clientX - (r.left + (hx / W) * r.width);
          try { h.setPointerCapture(ev.pointerId); } catch (e) { /* degrade */ }
          ev.stopPropagation(); ev.preventDefault();
        });
        h.addEventListener('pointermove', (ev) => {
          if (!dragging2) return;
          // x only: endpoints re-scope the span. Depth belongs to the segment
          // drag — a diagonal endpoint drag made accidental depth nudges too
          // easy while aiming for a distance.
          const r = svg.getBoundingClientRect();
          h.setAttribute('cx', Math.max(PADL, Math.min(W - 4,
            ((ev.clientX - grabDx - r.left) / r.width) * W)));
          showDragReadout(fmtDist(distFromX(ev.clientX)), ev.clientX, ev.clientY);
        });
        h.addEventListener('pointerup', (ev) => {
          if (!dragging2) return;
          dragging2 = false;
          hideDragReadout();
          const d = distFromX(ev.clientX);
          const MIN_SPAN = 20;   // metres — a bound needs somewhere to apply
          if (which === 'start') bound.start = Math.min(d, bound.end - MIN_SPAN);
          else bound.end = Math.max(d, bound.start + MIN_SPAN);
          bound.start = Math.max(0, bound.start);
          bound.end = Math.min(maxX, bound.end);
          say((kind === 'ceiling' ? 'Ceiling' : 'Floor') + ' ' + which + ' moved — ' +
              fmtDist(bound.start) + '→' + fmtDist(bound.end));
          renderPaths();
          persistNow();
        });
        h.addEventListener('contextmenu', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const list = kind === 'ceiling' ? p.ceilings : p.floors;
          const i = list.indexOf(bound);
          if (i >= 0) {
            list.splice(i, 1);
            say((kind === 'ceiling' ? 'Ceiling' : 'Floor') + ' removed from ' + p.name);
            renderPaths();
            persistNow();
          }
        });
        svg.appendChild(h);
      });
    };
    (p.ceilings || []).forEach((c) => addBoundGrip(c, 'ceiling'));
    (p.floors || []).forEach((f) => addBoundGrip(f, 'floor'));
    /*
     * A flat capped segment looks the same whichever bound produced it, so
     * each span carries a small ≤ / ≥ tag at its left edge — enough to tell a
     * "no deeper than" from a "no shallower than" at a glance.
     */
    const tagBound = (b, glyph) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'pp-axis');
      t.setAttribute('x', x(Math.max(0, b.start)) + 2);
      t.setAttribute('y', Math.max(PADT + 6, y(b.feet) - 2));
      t.textContent = glyph + Math.round(depthU().from(b.feet));
      svg.appendChild(t);
    };
    (p.floors || []).forEach((f) => tagBound(f, '≤'));     // max depth
    (p.ceilings || []).forEach((c) => tagBound(c, '≥'));   // min depth
    /*
     * Offsets tag differently because their number is a CLEARANCE, not a
     * depth: tagBound would put "10" at the 10 ft gridline and read as a bound
     * at that depth. Anchor it to the planned line instead, where the diver
     * actually is, and mark it ↑ for "off the bottom".
     */
    (p.offsets || []).forEach((b) => {
      let near = null;
      pts.forEach((s) => {
        if (!near || Math.abs(s.distance - b.start) < Math.abs(near.distance - b.start)) near = s;
      });
      if (!near) return;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'pp-axis pp-offset-tag');
      t.setAttribute('x', x(Math.max(0, b.start)) + 2);
      t.setAttribute('y', Math.max(PADT + 6, y(effFt(near)) - 2));
      // the unit, not just a bare number: "↑10" beside a depth axis reads as a
      // depth, which is the one thing this number is not
      t.textContent = '↑' + Math.round(depthU().from(b.feet)) + ' ' + depthU().label;
      svg.appendChild(t);
    });

    // dotted true bottom, drawn only over the capped stretches — an offset
    // lifts the diver off the seabed, so seeing the seabed is the whole point
    if ((p.ceilings || []).length || (p.floors || []).length || (p.offsets || []).length) {
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          const dot = document.createElementNS(NS, 'polyline');
          dot.setAttribute('points', run.join(' '));
          dot.setAttribute('fill', 'none');
          dot.setAttribute('stroke', p.color);
          dot.setAttribute('stroke-width', '1');
          dot.setAttribute('class', 'pp-true-bottom');
          dot.setAttribute('stroke-dasharray', '2 3');
          dot.setAttribute('opacity', '0.75');
          svg.appendChild(dot);
        }
        run = [];
      };
      pts.forEach((s) => {
        if (capped(s)) run.push(x(s.distance).toFixed(1) + ',' + y(-s.feet).toFixed(1));
        else flush();
      });
      flush();
    }

    // pan-aware axis: the top label reads the panned-to depth, not always 0
    const axisTopLabel = panD > 0 ? fmtDepth(panD) : '0';
    const axisMaxLabel = fmtDepth(panD + maxD) +
      (p.depthZoom > 1 ? ' ×' + (Math.round(p.depthZoom * 10) / 10) : '');
    [[panD, axisTopLabel], [panD + maxD, axisMaxLabel]].forEach(([v, label], i) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'pp-axis');
      t.setAttribute('x', '2');
      t.setAttribute('y', (i === 0 ? y(v) + 3 : y(v)));
      t.textContent = label;
      svg.appendChild(t);
    });
    const dist = document.createElementNS(NS, 'text');
    dist.setAttribute('class', 'pp-axis');
    dist.setAttribute('x', W - 4); dist.setAttribute('y', H - 2);
    dist.setAttribute('text-anchor', 'end');
    dist.textContent = fmtDist(maxX);
    svg.appendChild(dist);

    if (p.showGas) {
      const gp = gasProfile(p);
      if (gp && gp.total > 0) {
        const yG = (cuft) => PADT + (H - PADT - PADB) * (cuft / gp.total);
        const rows = legData(p);
        const cum = Paths.nodeDistances(p);
        const multiCyl = new Set(rows.map((r) => r.cylId)).size > 1;
        const drawGas = (samples, colour) => {
          if (samples.length < 2) return;
          const gl = document.createElementNS(NS, 'polyline');
          gl.setAttribute('points', samples.map((s) => x(s.distance).toFixed(1) + ',' + yG(s.cuft).toFixed(1)).join(' '));
          gl.setAttribute('fill', 'none');
          if (colour) gl.setAttribute('stroke', colour);
          else gl.style.stroke = 'var(--foam)';
          gl.setAttribute('stroke-width', multiCyl ? '1.4' : '1');
          gl.setAttribute('stroke-dasharray', '3 2');
          gl.setAttribute('opacity', '0.85');
          svg.appendChild(gl);
        };
        if (multiCyl) {
          /*
           * More than one cylinder in play: the gas curve takes each leg's
           * cylinder colour (matching the leg table's swatches), so where the
           * plan switches tanks is visible on the profile itself.
           */
          rows.forEach((r, i) => {
            const a = cum[i], b = cum[i + 1];
            const seg = gp.points.filter((s) => s.distance >= a - 1e-6 && s.distance <= b + 1e-6);
            drawGas(seg, cylColour(r.cylId));
          });
        } else {
          drawGas(gp.points, null);   // single tank keeps the signature foam dash
        }

        const gLabel = document.createElementNS(NS, 'text');
        gLabel.setAttribute('class', 'pp-axis');
        gLabel.style.fill = 'var(--foam)';
        gLabel.setAttribute('x', W - 4); gLabel.setAttribute('y', PADT + 7);
        gLabel.setAttribute('text-anchor', 'end');
        gLabel.textContent = gp.total.toFixed(1) + ' cuft';
        svg.appendChild(gLabel);

        /*
         * Reserve crossing, drawn where it happens. The leg table already
         * offers "add a node here"; the plot is where the eye actually reads
         * the dive, so the crossing is marked on it too: an amber line at the
         * distance where the first cylinder falls to its declared reserve.
         */
        const rp = reserveCrossing(p, rows);
        if (rp && rp.dist <= maxX) {
          const wl = document.createElementNS(NS, 'line');
          wl.setAttribute('x1', x(rp.dist).toFixed(1)); wl.setAttribute('x2', x(rp.dist).toFixed(1));
          wl.setAttribute('y1', PADT); wl.setAttribute('y2', H - PADB);
          wl.setAttribute('stroke', '#e2725b');
          wl.setAttribute('stroke-width', '1');
          wl.setAttribute('stroke-dasharray', '4 3');
          wl.setAttribute('opacity', '0.9');
          svg.appendChild(wl);
          const wt = document.createElementNS(NS, 'text');
          wt.setAttribute('class', 'pp-axis');
          wt.setAttribute('fill', '#e2725b');
          wt.style.fill = '#e2725b';
          const wx = x(rp.dist);
          wt.setAttribute('x', wx < W / 2 ? wx + 3 : wx - 3);
          wt.setAttribute('text-anchor', wx < W / 2 ? 'start' : 'end');
          wt.setAttribute('y', H - PADB - 3);
          wt.textContent = '⚠ reserve';
          const wtTitle = document.createElementNS(NS, 'title');
          wtTitle.textContent = rp.cylName + ' falls to its declared reserve at ' + fmtDist(rp.dist) +
                                ' — right-click to add a node here';
          wt.appendChild(wtTitle);
          svg.appendChild(wt);

          /*
           * Right-click the line itself to drop a node at the crossing. This is
           * the gesture the plot already answers everywhere else, and it is
           * where the eye is: seeing where the gas runs out and wanting a
           * cylinder switch there is one thought, so it should be one action
           * rather than a hunt through the leg table for the same button.
           *
           * The hit target is a wide transparent line over the visible one —
           * a 1px dashed stroke is far too thin to aim at, especially on a
           * phone where the same handler runs off a long press.
           */
          const hit = document.createElementNS(NS, 'line');
          hit.setAttribute('x1', x(rp.dist).toFixed(1)); hit.setAttribute('x2', x(rp.dist).toFixed(1));
          hit.setAttribute('y1', PADT); hit.setAttribute('y2', H - PADB);
          hit.setAttribute('stroke', 'transparent');
          hit.setAttribute('stroke-width', '10');
          hit.style.cursor = 'context-menu';
          const addNodeAtReserve = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            Paths.insertAt(p.id, rp.latlng);
            say('Node added where ' + rp.cylName + ' hits reserve — give the next leg a fresh cylinder', 'ok');
            renderPaths();
            persistNow();
          };
          hit.addEventListener('contextmenu', addNodeAtReserve);
          let press = null;
          hit.addEventListener('pointerdown', (ev) => {
            if (ev.pointerType === 'mouse') return;
            press = setTimeout(() => { press = null; addNodeAtReserve(ev); }, 450);
          });
          ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach((t) =>
            hit.addEventListener(t, () => { if (press) { clearTimeout(press); press = null; } }));
          svg.appendChild(hit);
        }
      }
    }

    /*
     * Node markers: where each drawn node falls along the profile. Each node's
     * cumulative distance is matched to the nearest sample so the dot sits on
     * the depth curve rather than floating beside it.
     */
    if (p.showNodes) {
      Paths.nodeDistances(p).forEach((d) => {
        if (d > maxX) return;
        let best = pts[0], bestD = Infinity;
        pts.forEach((s) => {
          const gap = Math.abs(s.distance - d);
          if (gap < bestD) { bestD = gap; best = s; }
        });
        // dropline first so the dot sits on top of it
        const drop = document.createElementNS(NS, 'line');
        drop.setAttribute('class', 'pp-node-line');
        drop.setAttribute('x1', x(d).toFixed(1)); drop.setAttribute('x2', x(d).toFixed(1));
        drop.setAttribute('y1', PADT); drop.setAttribute('y2', H - PADB);
        drop.setAttribute('stroke', p.color);
        svg.appendChild(drop);

        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('class', 'pp-node-dot');
        dot.setAttribute('cx', x(d).toFixed(1));
        dot.setAttribute('cy', y(-best.feet).toFixed(1));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', p.color);
        svg.appendChild(dot);
      });
    }

    /*
     * Hovering the plot drops a dot on the map at the matching point along the
     * path, so a feature in the profile can be located on the water. The svg is
     * preserveAspectRatio="none", so a fraction across the element maps straight
     * onto a fraction across the viewBox.
     */
    const guide = document.createElementNS(NS, 'line');
    guide.setAttribute('stroke', p.color);
    guide.setAttribute('stroke-width', '1');
    guide.setAttribute('stroke-dasharray', '2 2');
    guide.setAttribute('y1', PADT); guide.setAttribute('y2', H - PADB);
    guide.setAttribute('opacity', '0');
    svg.appendChild(guide);

    const readout = document.createElementNS(NS, 'text');
    readout.setAttribute('class', 'pp-axis');
    readout.setAttribute('y', PADT + 7);
    readout.setAttribute('opacity', '0');
    svg.appendChild(readout);

    svg.addEventListener('mousemove', (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const vx = ((ev.clientX - r.left) / r.width) * W;
      const dm = ((vx - PADL) / (W - PADL - 4)) * maxX;
      let best = 0, bestD = Infinity;
      pts.forEach((s, i) => {
        const d = Math.abs(s.distance - dm);
        if (d < bestD) { bestD = d; best = i; }
      });
      const s = pts[best];
      const sx = x(s.distance);
      guide.setAttribute('x1', sx); guide.setAttribute('x2', sx);
      guide.setAttribute('opacity', '0.8');
      readout.setAttribute('x', sx < W / 2 ? sx + 4 : sx - 4);
      readout.setAttribute('text-anchor', sx < W / 2 ? 'start' : 'end');
      readout.setAttribute('opacity', '1');
      const plannedHere = Paths.plannedFtAt(p, s.distance, -s.feet);
      readout.textContent = (plannedHere < -s.feet - 1e-9
        ? fmtDepth(plannedHere) + ' (bottom ' + fmtDepth(-s.feet) + ')'
        : fmtDepth(-s.feet)) + ' @ ' + fmtDist(s.distance);
      Paths.hoverAt(p.id, s, fmtDepth(-s.feet));
    });
    svg.addEventListener('mouseleave', () => {
      guide.setAttribute('opacity', '0');
      readout.setAttribute('opacity', '0');
      Paths.hoverOff();
    });

    /*
     * Right-click (long-press on touch) anywhere on the plot for actions at
     * that distance along the path. The click's x gives the distance, its y a
     * depth — which is what makes "set ceiling" natural: point at where the
     * cap should sit and the depth is read straight off the axis.
     */
    const plotPoint = (clientX, clientY) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return null;
      const vx = ((clientX - r.left) / r.width) * W;
      const vy = ((clientY - r.top) / r.height) * H;
      const dm = Math.max(0, Math.min(maxX, ((vx - PADL) / (W - PADL - 4)) * maxX));
      const ft = Math.max(0, panD + ((vy - PADT) / plotH) * (maxD || 1));
      let best = pts[0];
      pts.forEach((smp) => { if (Math.abs(smp.distance - dm) < Math.abs(best.distance - dm)) best = smp; });
      return { dist: dm, feet: ft, sample: best };
    };
    svg.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const at = plotPoint(ev.clientX, ev.clientY);
      if (at) openPlotMenu(p, at, ev.clientX, ev.clientY);
    });
    /*
     * Touch: long-press for the same menu. Two things make this actually work
     * on a phone where the naive version did not:
     *   - a 10px movement tolerance, because a resting fingertip jitters a few
     *     pixels and a zero-tolerance cancel meant the press almost never
     *     matured;
     *   - touch-action: pan-y on the svg (see CSS), so a still finger is ours
     *     to time while vertical sheet-scrolling stays native — a real scroll
     *     fires pointercancel, which correctly abandons the press.
     */
    let plotPress = null, pressX = 0, pressY = 0;
    const cancelPlotPress = () => { if (plotPress) { clearTimeout(plotPress); plotPress = null; } };
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse') return;
      /*
       * The bound grips and their endpoint handles sit ON the plot and carry
       * their own right-click action (remove this bound). Without this guard
       * the plot's press swallowed theirs, so a long-press on a ceiling grip
       * offered to ADD a bound at that depth instead of removing the one the
       * finger was actually on.
       */
      if (ev.target.closest('.bound-grip, .bound-end, .pp-ax-pan')) return;
      pressX = ev.clientX; pressY = ev.clientY;
      cancelPlotPress();
      plotPress = setTimeout(() => {
        plotPress = null;
        const at = plotPoint(pressX, pressY);
        if (at) openPlotMenu(p, at, pressX, pressY);
        if (navigator.vibrate) navigator.vibrate(12);
      }, 450);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!plotPress || ev.pointerType === 'mouse') return;
      if (Math.abs(ev.clientX - pressX) > 10 || Math.abs(ev.clientY - pressY) > 10) cancelPlotPress();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
      svg.addEventListener(t, cancelPlotPress));
    // the OS long-press callout would race our menu
    svg.addEventListener('contextmenu', (ev) => ev.preventDefault());

    /*
     * Depth-axis pan: an invisible strip over the y-axis gutter. When zoomed,
     * grab it and drag to slide the view up/down the water column. Listeners
     * go on the DOCUMENT for the drag itself — renderPaths() rebuilds this
     * svg on every frame of the pan, which would kill a capture-based drag —
     * and the render is rAF-coalesced so a fast pointer doesn't queue a
     * rebuild per event.
     */
    const gutter = document.createElementNS(NS, 'rect');
    gutter.setAttribute('x', 0); gutter.setAttribute('y', 0);
    gutter.setAttribute('width', PADL - 2); gutter.setAttribute('height', H - PADB);
    gutter.setAttribute('fill', 'transparent');
    gutter.setAttribute('class', 'pp-ax-pan');
    if (p.depthZoom > 1) {
      gutter.style.cursor = 'grab';
      const gt = document.createElementNS(NS, 'title');
      gt.textContent = 'Drag to pan the depth axis · double-click resets';
      gutter.appendChild(gt);
    }
    gutter.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (p.depthZoom || 1) <= 1) return;
      const startY = ev.clientY, startPan = p.depthPan || 0;
      const r = svg.getBoundingClientRect();
      // client px -> viewBox px -> feet of depth
      const pxToFt = (maxD / plotH) * (r.height ? H / r.height : 1);
      let raf = 0;
      const onMove = (e) => {
        // drag down pulls the column down: shallower water scrolls into view
        const next = Math.max(0, Math.min(fullMax - maxD,
          startPan - (e.clientY - startY) * pxToFt));
        if (next === p.depthPan) return;
        p.depthPan = next;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderPaths(); });
        e.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      ev.preventDefault(); ev.stopPropagation();   // not a long-press, not a hover
    });
    svg.appendChild(gutter);

    /*
     * Dragging on the plot body itself. Two gestures, told apart by where the
     * press lands:
     *
     *   - starting ON the drawn seabed and dragging up sets an offset over
     *     that leg — the direct twin of the menu's start/end pair, for when
     *     you can see the stretch you want to fly over and just want to lift
     *     off it. The live band is pushed straight onto the path and re-render
     *     is the preview, so what you drag is exactly what you get.
     *   - starting anywhere else pans the depth axis, which until now needed
     *     the thin gutter strip over the y-axis. Only when zoomed: at 1x the
     *     whole column is already on screen and there is nothing to pan to.
     *
     * The touch long-press menu shares this element and starts its timer first,
     * but it cancels itself past 10px of movement — so a real drag never also
     * opens a menu, while a tap still does.
     */
    const legSpanAt = (dist) => {
      const cum = Paths.nodeDistances(p);
      for (let i = 0; i < cum.length - 1; i++) {
        if (dist >= cum[i] && dist <= cum[i + 1]) return [cum[i], cum[i + 1]];
      }
      return [0, maxX];
    };
    const dragEnd = (onMove, onUp) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
    const NEAR_PX = SEABED_GRAB_PX;   // shared with the no-scroll band above
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const at = plotPoint(ev.clientX, ev.clientY);
      if (!at) return;
      const r = svg.getBoundingClientRect();
      if (!r.height) return;
      const vy = ((ev.clientY - r.top) / r.height) * H;
      const pxToFt = (maxD / plotH) * (H / r.height);
      const onSeabed = Math.abs(vy - y(effFt(at.sample))) < NEAR_PX;

      if (onSeabed) {
        const bottomFt = -at.sample.feet;
        if (!p.offsets) p.offsets = [];
        /*
         * Adjusting an offset that is already here, rather than stacking a new
         * one on top of it. offsetFtAt takes the LARGEST band covering a
         * point, so pushing a fresh band at 0 ft left the old one still
         * winning: the line did not move until the drag passed the previous
         * value, and it could never be brought back down. That read as "this
         * section cannot be adjusted again" — and every attempt quietly left
         * another dead band on the path.
         */
        const existing = (p.offsets || []).find(
          (b) => at.dist >= b.start && at.dist <= b.end);
        const band = existing || { start: legSpanAt(at.dist)[0], end: legSpanAt(at.dist)[1], feet: 0 };
        const startFeet = band.feet || 0;
        if (!existing) p.offsets.push(band);

        let raf = 0, moved = false;
        const onMove = (e) => {
          /*
           * Measured from where the finger STARTED and added to what the band
           * already was, so the line stays under the finger instead of
           * jumping to it — re-grabbing a 20 ft offset used to snap it to 0
           * and start over from wherever the press landed.
           */
          const lifted = startFeet + (ev.clientY - e.clientY) * pxToFt;   // up is positive
          const next = Math.max(0, Math.min(bottomFt, lifted));
          if (Math.abs(next - band.feet) > 0.01) moved = true;
          band.feet = next;
          showDragReadout(fmtDepth(band.feet) + ' off the bottom', e.clientX, e.clientY);
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderPaths(); });
          e.preventDefault();
        };
        const onUp = () => {
          dragEnd(onMove, onUp);
          hideDragReadout();
          band.feet = Math.round(band.feet);   // whole feet is the planning unit
          const i = p.offsets.indexOf(band);
          if (band.feet <= 0) {
            // dragged to nothing, or pressed without dragging: either way the
            // path should end up exactly as if this had not happened
            if (i >= 0) p.offsets.splice(i, 1);
            if (existing && moved) { say('Offset cleared'); persistNow(); }
          } else if (moved) {
            say('Offset: ' + fmtDepth(band.feet) + ' off the bottom from ' +
                fmtDist(band.start) + ' to ' + fmtDist(band.end), 'ok');
            persistNow();
          }
          renderPaths();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        ev.preventDefault();
        return;
      }

      if ((p.depthZoom || 1) <= 1) return;
      const startY = ev.clientY, startPan = p.depthPan || 0;
      let raf = 0;
      const onMove = (e) => {
        const next = Math.max(0, Math.min(fullMax - maxD,
          startPan - (e.clientY - startY) * pxToFt));
        if (next === p.depthPan) return;
        p.depthPan = next;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderPaths(); });
        e.preventDefault();
      };
      const onUp = () => dragEnd(onMove, onUp);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      ev.preventDefault();
    });

    return svg;
  }

  /*
   * ---- plot context menu ----
   * One floating menu, rebuilt per opening. pendingCeil holds a "ceiling start"
   * waiting for its end, per path — kept OUTSIDE the path object so an
   * abandoned half-gesture never persists or exports.
   */
  /*
   * ---- popped-out profile ----
   * One floating window, reused. The plot is rendered INTO it by renderPaths
   * rather than copied there, so there is still exactly one renderer and one
   * SVG per path — a copy would drift the moment a bound moved, and every
   * hover, drag and right-click on the plot would have to be wired twice.
   *
   * Sized by the browser's own resize handle (CSS `resize: both`) and dragged
   * by its header. The profile measures whatever container it lands in, so it
   * fills the window at whatever size it is left at.
   */
  let popoutEl = null;
  function popoutBody(p) {
    if (!popoutEl) {
      popoutEl = document.createElement('div');
      popoutEl.className = 'plot-popout';
      const head = document.createElement('div');
      head.className = 'plot-popout-head';
      const title = document.createElement('span');
      title.className = 'plot-popout-title';
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'sm-x';
      close.textContent = '×';
      close.title = 'Put the graph back in the panel';
      close.setAttribute('aria-label', 'Close the graph window');
      close.addEventListener('click', () => {
        Paths.list.forEach((o) => { o.popped = false; });
        renderPaths();
      });
      head.appendChild(title); head.appendChild(close);
      const body = document.createElement('div');
      body.className = 'plot-popout-body';
      popoutEl.appendChild(head); popoutEl.appendChild(body);
      document.body.appendChild(popoutEl);
      // drag by the header only, so the resize corner stays the browser's
      makeDraggable(popoutEl, 'button, input, select, textarea, a, svg', head);
      popoutEl._title = title;
      popoutEl._body = body;
    }
    popoutEl.hidden = false;
    popoutEl._title.textContent = p.name;
    popoutEl._body.textContent = '';
    return popoutEl._body;
  }
  // called at the end of every render: with nothing popped, the window goes away
  function syncPopout() {
    if (!popoutEl) return;
    if (!Paths.list.some((p) => p.popped)) popoutEl.hidden = true;
  }

  let pendingCeil = null;   // {pathId, dist, feet}
  let pendingFloor = null;  // same shape, for the mirror gesture
  let pendingOffset = null; // {pathId, dist, feet} — feet is a CLEARANCE, not a depth
  let plotMenuEl = null;

  function closePlotMenu() {
    if (plotMenuEl) { plotMenuEl.remove(); plotMenuEl = null; }
  }
  document.addEventListener('click', (ev) => {
    if (plotMenuEl && !plotMenuEl.contains(ev.target)) closePlotMenu();
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePlotMenu(); });

  function openPlotMenu(p, at, cx, cy) {
    closePlotMenu();
    const menu = document.createElement('div');
    menu.className = 'plot-menu';
    const item = (label, fn, disabled, hint) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (hint) b.title = hint;
      b.disabled = !!disabled;
      b.addEventListener('click', () => { closePlotMenu(); fn(); });
      menu.appendChild(b);
      return b;
    };
    const head = document.createElement('div');
    head.className = 'plot-menu-head';
    head.textContent = fmtDist(at.dist) + ' · ' + fmtDepth(at.feet);
    menu.appendChild(head);

    item('Add node here', () => {
      Paths.insertAt(p.id, { lat: at.sample.lat, lng: at.sample.lng });
      say('Node inserted at ' + fmtDist(at.dist) + ' along ' + p.name);
    }, false, 'Insert a path node at this distance along the line');

    const pendingHere = pendingCeil && pendingCeil.pathId === p.id;
    const pendingFloorHere = pendingFloor && pendingFloor.pathId === p.id;
    const pendingOffsetHere = pendingOffset && pendingOffset.pathId === p.id;

    /*
     * One row per bound, two buttons on it: start and end.
     *
     * They used to be four separate full-width entries, which read as four
     * unrelated commands and buried the pairing — "Set floor end (no start
     * yet)" only makes sense next to the thing that starts it. Side by side,
     * the shape of the gesture is visible: pick a start, right-click again,
     * pick the end.
     */
    const pairRow = (label, startText, startFn, startOff, endText, endFn, endOff, hint) => {
      const row = document.createElement('div');
      row.className = 'plot-menu-pair';
      const lab = document.createElement('span');
      lab.className = 'plot-menu-pair-label';
      lab.textContent = label;
      if (hint) lab.title = hint;
      row.appendChild(lab);
      const mk = (text, fn, off) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.disabled = !!off;
        if (hint) b.title = hint;
        b.addEventListener('click', () => { closePlotMenu(); fn(); });
        row.appendChild(b);
      };
      mk(startText, startFn, startOff);
      mk(endText, endFn, endOff);
      menu.appendChild(row);
    };

    /*
     * An offset is a CLEARANCE, so it is read as the gap between the seabed
     * here and where you clicked — click 10 ft above the bottom and you get
     * "fly 10 ft off it". Profile samples carry elevation, so the bottom in
     * positive feet is -sample.feet.
     */
    const bottomHere = -at.sample.feet;
    const clearHere = Math.max(0, Math.round(bottomHere - at.feet));

    pairRow('Floor  max ' + fmtDepth(at.feet),
      'start', () => {
        pendingFloor = { pathId: p.id, dist: at.dist, feet: at.feet };
        say('Floor started at ' + fmtDist(at.dist) + ', max ' + fmtDepth(at.feet) +
            ' — right-click the plot again to set the end');
      }, false,
      pendingFloorHere ? 'end · max ' + fmtDepth(pendingFloor.feet) : 'end',
      () => {
        if (!pendingFloorHere) return;
        if (Paths.addFloor(p.id, pendingFloor.dist, at.dist, pendingFloor.feet)) {
          say('Floor: max ' + fmtDepth(pendingFloor.feet) + ' from ' +
              fmtDist(Math.min(pendingFloor.dist, at.dist)) + ' to ' +
              fmtDist(Math.max(pendingFloor.dist, at.dist)), 'ok');
          pendingFloor = null;
          renderPaths();
          persistNow();
        } else {
          toast('Could not set that floor — zero-length span?', true);
        }
      }, !pendingFloorHere,
      'Deepest allowed over a span. Its depth is where you click the start.');

    pairRow('Ceiling  min ' + fmtDepth(at.feet),
      'start', () => {
        pendingCeil = { pathId: p.id, dist: at.dist, feet: at.feet };
        say('Ceiling started at ' + fmtDist(at.dist) + ', min ' + fmtDepth(at.feet) +
            ' — right-click the plot again to set the end');
      }, false,
      pendingHere ? 'end · min ' + fmtDepth(pendingCeil.feet) : 'end',
      () => {
        if (!pendingHere) return;
        if (Paths.addCeiling(p.id, pendingCeil.dist, at.dist, pendingCeil.feet)) {
          say('Ceiling: stay deeper than ' + fmtDepth(pendingCeil.feet) + ' from ' +
              fmtDist(Math.min(pendingCeil.dist, at.dist)) + ' to ' +
              fmtDist(Math.max(pendingCeil.dist, at.dist)), 'ok');
          pendingCeil = null;
          renderPaths();
          persistNow();
        }
      }, !pendingHere,
      'Shallowest allowed over a span — stay deeper than this.');

    pairRow(clearHere > 0 ? 'Offset  ' + fmtDepth(clearHere) + ' off the bottom'
                          : 'Offset  (click above the seabed)',
      'start', () => {
        pendingOffset = { pathId: p.id, dist: at.dist, feet: clearHere };
        say('Offset started at ' + fmtDist(at.dist) + ', ' + fmtDepth(clearHere) +
            ' off the bottom — right-click the plot again to set the end');
      }, clearHere <= 0,
      pendingOffsetHere ? 'end · ' + fmtDepth(pendingOffset.feet) : 'end',
      () => {
        if (!pendingOffsetHere) return;
        if (Paths.addOffset(p.id, pendingOffset.dist, at.dist, pendingOffset.feet)) {
          say('Offset: ' + fmtDepth(pendingOffset.feet) + ' off the bottom from ' +
              fmtDist(Math.min(pendingOffset.dist, at.dist)) + ' to ' +
              fmtDist(Math.max(pendingOffset.dist, at.dist)), 'ok');
          pendingOffset = null;
          renderPaths();
          persistNow();
        } else {
          toast('Could not set that offset — zero-length span?', true);
        }
      }, !pendingOffsetHere,
      'Swim a fixed height above the seabed. Ceilings and floors still override it. ' +
      'You can also drag up off the seabed on the plot.');

    if ((p.ceilings || []).length) {
      item('Clear ceilings (' + p.ceilings.length + ')', () => {
        Paths.clearCeilings(p.id);
        say('Ceilings cleared from ' + p.name);
        renderPaths();
        persistNow();
      });
    }
    if ((p.floors || []).length) {
      item('Clear floors (' + p.floors.length + ')', () => {
        Paths.clearFloors(p.id);
        say('Floors cleared from ' + p.name);
        renderPaths();
        persistNow();
      });
    }
    if ((p.offsets || []).length) {
      item('Clear offsets (' + p.offsets.length + ')', () => {
        Paths.clearOffsets(p.id);
        say('Offsets cleared from ' + p.name);
        renderPaths();
        persistNow();
      });
    }

    item('Export plot as PNG', () => exportPlotPng(p),
      false, 'Save this depth profile as an image, for a briefing or a slate');

    document.body.appendChild(menu);
    // keep it on screen
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(cx, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(cy, window.innerHeight - mh - 8) + 'px';
    plotMenuEl = menu;
  }

  /*
   * Rasterise a path's profile SVG. The SVG is serialised with an injected
   * dark background (the on-screen one is transparent over the panel), drawn
   * to a 2x canvas for crispness, and downloaded. No library: Blob -> Image ->
   * canvas is enough for our own well-formed SVG.
   */
  function exportPlotPng(p) {
    const svg = document.querySelector('.pp-profile svg');
    if (!svg) { toast('Open the path’s profile first.', true); return; }
    const clone = svg.cloneNode(true);
    const vb = svg.getAttribute('viewBox').split(' ');
    const w = +vb[2], h = +vb[3];
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', w); bg.setAttribute('height', h);
    bg.setAttribute('fill', '#0a2830');
    clone.insertBefore(bg, clone.firstChild);
    /*
     * Axis text is styled by a CSS class on the page, which does not survive
     * serialisation — so inline what the raster needs. The size is read off a
     * live label rather than hardcoded, or an exported plot would ignore the
     * label-size setting and come out at the default 8px.
     */
    const live = svg.querySelector('.pp-axis');
    const liveSize = live ? getComputedStyle(live).fontSize.replace('px', '') : '8';
    clone.querySelectorAll('.pp-axis').forEach((t) => {
      t.setAttribute('fill', '#4d868b');
      t.setAttribute('font-family', 'monospace');
      t.setAttribute('font-size', liveSize);
    });
    const blob = new Blob([new XMLSerializer().serializeToString(clone)],
                          { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((png2) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(png2);
        a.download = p.name.replace(/[^\w-]+/g, '_') + '-profile.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        say('Profile exported as PNG', 'ok');
      });
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('PNG export failed.', true); };
    img.src = url;
  }

  /*
   * renderPaths rebuilds every row from scratch — fine at five paths, wasteful
   * when a drag fires it per pointer event. Calls coalesce onto one frame; the
   * Now variant exists for the rare caller that must read the DOM immediately.
   */
  let renderPathsQueued = false;
  function renderPaths() {
    if (renderPathsQueued) return;
    renderPathsQueued = true;
    /*
     * rAF for the normal case, with a timeout backstop: rAF does not tick in a
     * hidden or backgrounded tab, and without the fallback a session import or
     * restore finishing while the tab is hidden would leave the panel stale
     * until the next repaint. Whichever fires first wins.
     */
    const go = () => {
      if (!renderPathsQueued) return;
      renderPathsQueued = false;
      renderPathsNow();
    };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  }
  /*
   * The panel is rebuilt wholesale on every change, which momentarily collapses
   * its content to zero height — and a scroll container whose content vanishes
   * is scrolled back to 0 by the browser. So expanding a path you had scrolled
   * down to threw you back to the top of the list, exactly when you wanted to
   * look at what you just opened. Capture the offset around the rebuild and put
   * it back. Whichever ancestor actually scrolls is found at run time, because
   * that differs by breakpoint: the sheet itself on a phone, .pp-inner on the
   * desktop dock.
   */
  function scrollKeeper(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY)) {
          const top = node.scrollTop;
          return () => { node.scrollTop = top; };
        }
      }
      node = node.parentElement;
    }
    return () => {};
  }

  function renderPathsNow() {
    const box = $('pp-list');
    const restoreScroll = scrollKeeper(box);
    box.textContent = '';
    const list = Paths.list;
    $('pp-add').setAttribute('aria-pressed', Paths.drawing ? 'true' : 'false');
    $('pp-add').textContent = Paths.drawing ? '✓' : '+';
    $('pp-add').title = Paths.drawing ? 'Finish this path' : 'Draw a new path';
    $('pp-save').disabled = !Paths.selectedId;
    $('pp-note').textContent = !list.length
      ? 'No paths yet — press + or Ctrl-click the map.'
      : (Paths.drawing ? 'Click the map to add nodes. Esc or ✓ to finish.'
                       : (matchMedia(window.KELP_MOBILE_MQ).matches
                            ? 'Drag a node to move it; long-press one for coordinates and delete.'
                            : 'Drag a node to move it; right-click or hover one for coordinates and delete.'));

    list.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'pp-item' + (p.id === Paths.selectedId ? ' sel' : '');
      item.dataset.path = String(p.id);   // printLegTable finds its panel by this

      const row = document.createElement('div');
      row.className = 'pp-row';
      row.addEventListener('click', (ev) => {
        /*
         * Every control on the row owns its own click, so the row only acts on
         * bare space. This is a structural test, not a list of class names:
         * the old enumerated list silently rotted when the settings button was
         * renamed .pp-cog -> .pp-menu-btn, after which tapping Settings ALSO
         * ran the row handler — the re-render from toggleExpand tore down the
         * menu that the button had just opened, so Settings only ever looked
         * like a graph collapse toggle.
         */
        if (ev.target.closest('button, input, select, label, .pp-menu')) return;
        // The row is the graph's title bar, so it opens and closes the plot —
        // the caret is still there for keyboard use, and is excluded above so
        // a click on it toggles once rather than twice.
        Paths.select(p.id);
        Paths.toggleExpand(p.id);
      });

      const sw = document.createElement('span');
      sw.className = 'pp-swatch'; sw.style.background = p.color;

      const nameWrap = document.createElement('span');
      nameWrap.className = 'pp-name-wrap';

      const name = document.createElement('span');
      name.className = 'pp-name'; name.textContent = p.name;

      // rename in place; the name is also the export filename
      const pencil = document.createElement('button');
      pencil.className = 'pp-pencil'; pencil.type = 'button';
      pencil.textContent = '✎'; pencil.title = 'Rename this path';

      function startRename() {
        const input = document.createElement('input');
        input.className = 'pp-name-input'; input.type = 'text'; input.value = p.name;
        nameWrap.replaceChild(input, name);
        input.focus(); input.select();

        function commit() {
          const clean = input.value.trim();
          input.removeEventListener('blur', commit);
          if (!clean || clean === p.name) { renderPaths(); return; }
          Paths.rename(p.id, clean);
          say('Renamed to ' + clean);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          else if (ev.key === 'Escape') { input.removeEventListener('blur', commit); renderPaths(); }
        });
      }
      pencil.addEventListener('click', startRename);
      name.addEventListener('dblclick', startRename);

      nameWrap.appendChild(name); nameWrap.appendChild(pencil);

      const meta = document.createElement('span');
      meta.className = 'pp-meta';
      meta.textContent = p.nodes.length + 'n · ' + fmtDist(Paths.lengthOf(p));
      /*
       * Depth stats ride in the meta once a profile exists — planned depth,
       * so ceilings, floors and offsets are reflected. The row shows only the
       * max; the average lives in the tooltip to keep the line short.
       */
      const prof = (p.profile || []).filter((sm) => sm.feet !== null);
      if (prof.length > 1) {
        const planned = prof.map((sm) => Paths.plannedFtAt(p, sm.distance, -sm.feet));
        const mx = Math.max.apply(null, planned);
        const avg = planned.reduce((a, b) => a + b, 0) / planned.length;
        meta.textContent += ' · ⌄' + fmtDepth(mx);
        meta.title = 'planned max ' + fmtDepth(mx) + ' · avg ' + fmtDepth(avg);
      }

      const caret = document.createElement('button');
      caret.className = 'pp-caret'; caret.type = 'button';
      caret.textContent = p.expanded ? '▾' : '▸';
      caret.title = p.expanded ? 'Collapse' : 'Show depth profile';
      caret.addEventListener('click', () => Paths.toggleExpand(p.id));

      // re-enter draw mode on THIS path — click the map to append nodes
      // after the last one, same click-to-extend flow as a brand new path
      const drawingThis = Paths.drawingId === p.id;
      const extendBtn = document.createElement('button');
      extendBtn.className = 'pp-mirror'; extendBtn.type = 'button';
      extendBtn.textContent = drawingThis ? '✓' : '+';
      extendBtn.title = drawingThis ? 'Finish adding nodes' : 'Continue drawing — add nodes after the last one';
      extendBtn.setAttribute('aria-pressed', drawingThis ? 'true' : 'false');
      extendBtn.addEventListener('click', () => Paths.resumeDrawing(p.id));

      /*
       * Pop the profile into its own resizable window. Deliberately on the row
       * and not inside the menu: it is the one control you reach for while
       * looking at the graph, and burying it under a dropdown would mean
       * opening a menu to get a better view of the thing the menu covers.
       */
      const popBtn = document.createElement('button');
      popBtn.className = 'pp-mirror'; popBtn.type = 'button';
      popBtn.textContent = '⤢';
      popBtn.title = p.popped ? 'Put the graph back in the panel'
                              : 'Open this depth profile in a resizable window';
      popBtn.setAttribute('aria-pressed', p.popped ? 'true' : 'false');
      popBtn.addEventListener('click', () => {
        Paths.list.forEach((o) => { if (o !== p) o.popped = false; });   // one at a time
        p.popped = !p.popped;
        if (p.popped) p.expanded = true;
        renderPaths();
      });

      /*
       * A labelled dropdown rather than a row of glyphs. ⇄ and 👁 next to ⚙ and
       * ⧉ told you nothing about what they did, and there is no room on the row
       * for words — so the words go in the menu and the row keeps only what you
       * reach for mid-task.
       */
      const cog = document.createElement('button');
      cog.className = 'pp-menu-btn'; cog.type = 'button';
      cog.setAttribute('aria-haspopup', 'true');
      cog.setAttribute('aria-expanded', 'false');
      cog.title = 'Path settings';
      const cogLabel = document.createElement('span');
      cogLabel.textContent = 'Settings';
      const cogCaret = document.createElement('span');
      cogCaret.className = 'sect-caret';
      cogCaret.textContent = '▾';
      cog.appendChild(cogLabel); cog.appendChild(cogCaret);

      const menu = document.createElement('div');
      menu.className = 'pp-menu'; menu.hidden = true;

      // a labelled row that reads as on or off at a glance
      const menuToggle = (label, on, fn, hint, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pp-menu-item pp-menu-toggle';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.disabled = !!disabled;
        if (hint) b.title = hint;
        const tick = document.createElement('span');
        tick.className = 'pp-menu-tick';
        tick.textContent = on ? '✓' : '';
        const txt = document.createElement('span');
        txt.textContent = label;
        b.appendChild(tick); b.appendChild(txt);
        b.addEventListener('click', fn);
        menu.appendChild(b);
        return b;
      };
      const menuItem = (label, fn, hint, danger) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pp-menu-item' + (danger ? ' danger' : '');
        if (hint) b.title = hint;
        const tick = document.createElement('span');
        tick.className = 'pp-menu-tick';
        const txt = document.createElement('span');
        txt.textContent = label;
        b.appendChild(tick); b.appendChild(txt);
        b.addEventListener('click', fn);
        menu.appendChild(b);
        return b;
      };

      const colorRow = document.createElement('label');
      colorRow.className = 'pp-menu-item pp-menu-color';
      const colorTick = document.createElement('span');
      colorTick.className = 'pp-menu-tick';
      const colorTxt = document.createElement('span');
      colorTxt.textContent = 'Path colour';
      const color = document.createElement('input');
      color.type = 'color'; color.value = p.color;
      color.addEventListener('change', () => { Paths.setColor(p.id, color.value); });
      colorRow.appendChild(colorTick); colorRow.appendChild(colorTxt); colorRow.appendChild(color);
      menu.appendChild(colorRow);

      menuToggle('Show node markers', p.showNodes,
        () => Paths.toggleShowNodes(p.id), 'Mark each drawn node on the depth profile');
      menuToggle('Mirror out and back', p.mirrored,
        () => Paths.setMirrored(p.id, !p.mirrored),
        'Append the path reversed, so the plan returns to its start',
        !p.mirrored && p.nodes.length < 2);
      menuToggle('Track gas on this path', p.showGas,
        () => Paths.toggleShowGas(p.id),
        'Budget cylinders across this path’s legs, using the diver settings below');

      const sep = document.createElement('div');
      sep.className = 'pp-menu-sep';
      menu.appendChild(sep);

      /*
       * Zoom to. The row already tells you the path exists; this answers
       * "where IS it", which the list on its own never can. Same contract as a
       * point's Zoom to: get the panel out of the way FIRST, then move the
       * map, because on a phone the panel is the screen and fitting bounds
       * behind it looks like nothing happened.
       */
      menuItem('Zoom to', () => {
        toggleMenu(false);
        if (window.MobileShell) MobileShell.closeSheet();
        if (!p.nodes.length) return;
        map.fitBounds(L.latLngBounds(p.nodes.map((n) => [n.lat, n.lng])).pad(0.25));
        Paths.select(p.id);
        say('Zoomed to ' + p.name);
      }, 'Fit the map to this path');

      menuItem('Reverse direction', () => Paths.reverse(p.id),
        'Run the line from the other end — headings, legs and bounds all follow');
      menuItem('Duplicate path', () => Paths.duplicate(p.id),
        'Plan a variant without touching this one');
      menuItem('Copy share code', () => Session.copyText(Session.shareCode('path', p), p.name),
        'Copy this path — nodes and bounds — for someone else to paste');
      menuItem('Delete path', () => { Paths.remove(p.id); say(p.name + ' deleted'); },
        'Remove this path', true);

      const unitCell = (labelText, sel) => {
        const cell = document.createElement('label');
        cell.className = 'pp-unit-cell';
        const lab = document.createElement('span');
        lab.textContent = labelText;
        cell.appendChild(lab); cell.appendChild(sel);
        return cell;
      };
      const du = unitSelect('dist', state.params.distUnit, (v) => {
        state.params.distUnit = v; renderPaths();
      });
      const zu = unitSelect('depth', state.params.depthUnit, (v) => {
        state.params.depthUnit = v; renderPaths();
      });
      const su = unitSelect('sac', state.params.sacUnit, (v) => {
        state.params.sacUnit = v; syncGasBar(); renderPaths();
      });
      const pu = unitSelect('speed', state.params.speedUnit, (v) => {
        state.params.speedUnit = v; syncGasBar(); renderPaths();
      });
      /*
       * Two labelled zones instead of seven bare widgets in a row: which of
       * five identical dropdowns was "speed" was anyone's guess.
       */
      const unitsRow = document.createElement('div');
      unitsRow.className = 'pp-menu-units';
      unitsRow.appendChild(unitCell('dist', du));
      unitsRow.appendChild(unitCell('depth', zu));
      unitsRow.appendChild(unitCell('sac', su));
      unitsRow.appendChild(unitCell('speed', pu));
      menu.appendChild(unitsRow);
      const toggleMenu = (open) => {
        box.querySelectorAll('.pp-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
        menu.hidden = (open === undefined) ? !menu.hidden : !open;
        cog.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
      };
      cog.addEventListener('click', () => toggleMenu());
      /*
       * Right-click anywhere on the title bar opens the same menu. The row is
       * the path's header, and a right-click on a header asking "what can I do
       * with this" is the expectation everywhere else — reaching for the small
       * Settings button was the only way to answer it.
       */
      row.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.pp-name-input, input, select')) return;
        ev.preventDefault(); ev.stopPropagation();
        toggleMenu(true);
      });
      // touch route to that same menu — the row's controls keep their own taps
      longPressContextMenu(row, { skip: 'button, input, select, label' });

      caret.classList.add('pp-caret-big');   // primary affordance: open the plot
      row.appendChild(sw); row.appendChild(nameWrap); row.appendChild(meta);
      row.appendChild(extendBtn); row.appendChild(popBtn);
      row.appendChild(cog); row.appendChild(caret);
      item.appendChild(row); item.appendChild(menu);

      let wrap = null;
      if (p.expanded) {
        wrap = document.createElement('div');
        wrap.className = 'pp-profile';
        // a popped-out plot is rendered into its own window instead of the row
        if (p.popped) popoutBody(p).appendChild(wrap);
        else item.appendChild(wrap);
      }
      box.appendChild(item);

      if (wrap) {
        // Measure the plot's actual rendered width (now that it's laid out in
        // the document) so the SVG viewBox can match it 1:1 — see profileSvg().
        const probe = document.createElement('div');
        probe.style.cssText = 'width:100%; height:0;';
        wrap.appendChild(probe);
        const pxWidth = probe.clientWidth || box.clientWidth || 240;
        wrap.removeChild(probe);

        const svg = profileSvg(p, pxWidth);
        if (svg) wrap.appendChild(svg);
        else if (p.nodes.length >= 2 && p.profileLoading) {
          /*
           * Skeleton plot while alongPath is in flight — same height the real
           * plot will take (so nothing jumps when it lands), with a shimmer
           * and a placeholder waveline instead of a bare text row.
           */
          const skel = document.createElement('div');
          skel.className = 'pp-skel';
          skel.style.height = (p.plotHeightManual
            ? Math.max(32, Math.round(p.plotHeight) || 62)
            : Math.round(Math.max(62, Math.min(240, pxWidth / 3.2)))) + 'px';
          skel.innerHTML = '<svg viewBox="0 0 100 32" preserveAspectRatio="none">' +
            '<path d="M0 8 C 15 26, 30 12, 45 20 S 75 28, 100 14" fill="none" ' +
            'stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
            '<span>Reading depth…</span>';
          wrap.appendChild(skel);
        } else {
          const t = document.createElement('div');
          t.className = 'hint';
          t.textContent = p.nodes.length < 2 ? 'Add at least two nodes.' : 'Reading depth…';
          wrap.appendChild(t);
        }

        // time/speed/distance readout — driven by the global gas-planning bar,
        // just applied against this path's own length
        const { timeMin, speedMiHr } = effectiveTimeSpeed(p);
        const readout = document.createElement('div');
        readout.className = 'pp-readout';
        readout.appendChild(document.createTextNode(fmtDist(Paths.lengthOf(p)) + ' · '));
        readout.appendChild(document.createTextNode((timeMin > 0 ? timeMin.toFixed(1) + ' min' : '—') + ' · '));
        const speedSpan = document.createElement('span');
        const warnFast = state.params.timeMode === 'time' && speedMiHr > 1.2;
        speedSpan.className = 'pp-readout-speed' + (warnFast ? ' warn' : '');
        speedSpan.textContent = speedMiHr > 0
          ? (+speedU().fromBase(speedMiHr).toFixed(speedU().dp)) + ' ' + speedU().label : '—';
        readout.appendChild(speedSpan);
        if (p.showGas) {
          const gp = gasProfile(p);
          readout.appendChild(document.createTextNode(' · ' + (gp ? gp.total.toFixed(1) + ' cuft' : '—')));
        }
        wrap.appendChild(readout);

        if (svg) {
          /*
           * Drag to resize. Height is written straight to p.plotHeight and
           * the SVG is rebuilt in place on every pointermove for a smooth
           * drag — Paths.setPlotHeight() (which fires onChange -> a full
           * renderPaths()) is only called once, on release, to persist it.
           */
          const resizeHandle = document.createElement('div');
          resizeHandle.className = 'pp-plot-resize';
          resizeHandle.title = 'Drag to resize this plot';
          let dragH = null;
          resizeHandle.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return;
            // dragging pins this path's height, opting it out of the
            // width-derived aspect ratio from then on
            p.plotHeightManual = true;
            dragH = { startY: ev.clientY, startH: svg.getBoundingClientRect().height || 62 };
            try { resizeHandle.setPointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
            ev.preventDefault();
          });
          resizeHandle.addEventListener('pointermove', (ev) => {
            if (!dragH) return;
            p.plotHeight = Math.max(32, Math.min(320, dragH.startH + (ev.clientY - dragH.startY)));
            const currentSvg = wrap.querySelector('svg');
            const freshWidth = currentSvg ? currentSvg.getBoundingClientRect().width : pxWidth;
            const newSvg = profileSvg(p, freshWidth);
            if (newSvg && currentSvg) wrap.replaceChild(newSvg, currentSvg);
          });
          resizeHandle.addEventListener('pointerup', (ev) => {
            if (!dragH) return;
            dragH = null;
            try { resizeHandle.releasePointerCapture(ev.pointerId); } catch (err) { /* best-effort */ }
            Paths.setPlotHeight(p.id, p.plotHeight);
          });
          wrap.appendChild(resizeHandle);
        }

        /*
         * Leg table, expanded in place beneath its own graph rather than in a
         * modal — so the profile stays visible while the numbers are read,
         * and hovering the graph can highlight the leg under the cursor.
         */
        const legsToggle = document.createElement('button');
        legsToggle.className = 'pp-legs-toggle'; legsToggle.type = 'button';
        legsToggle.textContent = (p.showLegs ? '▾' : '▸') + ' 🧭 Leg table';
        legsToggle.title = 'Headings, distances, depths and gas per segment';
        legsToggle.disabled = p.nodes.length < 2;
        legsToggle.setAttribute('aria-expanded', p.showLegs ? 'true' : 'false');
        legsToggle.addEventListener('click', () => {
          p.showLegs = !p.showLegs;
          renderPaths();
        });
        wrap.appendChild(legsToggle);

        if (p.showLegs) {
          const panel = document.createElement('div');
          panel.className = 'legs-panel';
          renderLegTable(p, panel);
          wrap.appendChild(panel);

          /*
           * Tie the graph to the table: whichever leg the cursor is over on
           * the profile gets highlighted in the rows below it. Uses the same
           * distance-under-cursor the depth readout already computes.
           */
          if (svg) {
            const cum = Paths.nodeDistances(p);
            const pts = (p.profile || []).filter((s) => s.feet !== null);
            const maxX = pts.length ? pts[pts.length - 1].distance : 0;
            svg.addEventListener('mousemove', (ev) => {
              const r = svg.getBoundingClientRect();
              if (!r.width || !maxX) return;
              const frac = (ev.clientX - r.left) / r.width;
              const dist = frac * maxX;
              let leg = -1;
              for (let i = 0; i < cum.length - 1; i++) {
                if (dist >= cum[i] && dist <= cum[i + 1]) { leg = i; break; }
              }
              panel.querySelectorAll('tbody tr').forEach((tr) => {
                tr.classList.toggle('leg-active', +tr.dataset.leg === leg);
              });
            });
            svg.addEventListener('mouseleave', () => {
              panel.querySelectorAll('tbody tr').forEach((tr) => tr.classList.remove('leg-active'));
            });
          }
        }
      }
    });
    syncPopout();
    restoreScroll();
  }

  /*
   * The plot viewBox is matched to the panel's pixel width at render time
   * (see renderPaths/profileSvg), so anything that changes that width — a
   * corner-drag, the panel's own max-width:70vw hitting a narrow window, or a
   * plain window resize — needs a re-render to stay matched. Debounced so a
   * drag doesn't thrash the DOM on every pointermove.
   *
   * Three triggers feed the same debounce rather than relying on one: a
   * ResizeObserver alone would cover every case, but it just missed a manual
   * panel.style.width change in testing, so the corner-drag handler and a
   * plain window listener call it directly too — belt and suspenders.
   */
  let ppResizeTimer = null;
  function schedulePathsRerender() {
    clearTimeout(ppResizeTimer);
    ppResizeTimer = setTimeout(renderPaths, 120);
  }
  // Held in a module-scoped const, not a local, because an unreferenced
  // ResizeObserver is eligible for GC, which would silently stop delivering.
  const ppResizeObserver = new ResizeObserver(schedulePathsRerender);
  ppResizeObserver.observe(document.querySelector('.paths-panel'));
  window.addEventListener('resize', schedulePathsRerender);

  /*
   * Corner resizing. CSS `resize` only ever gives you the bottom-right, so the
   * other three corners are done by hand. The panel is anchored top-right, so on
   * the first drag it is pinned to explicit left/top and the anchor dropped —
   * otherwise dragging a west or north edge would fight the anchor.
   */
  /*
   * Publish the dock's effective width as a CSS var. Anything that must stay
   * clear of the panel (the bottom-right controls, the sign-in notice) offsets
   * by it, so they follow a resize without their own listeners. A hidden or
   * collapsed dock reports 0 — it is not occupying the right edge, so nothing
   * needs to dodge it.
   */
  function syncDockWidth() {
    const panel = document.querySelector('.paths-panel');
    const occupying = !panel.classList.contains('view-hidden') &&
                      !panel.classList.contains('collapsed');
    const w = occupying ? (state.params.dockWidth || 360) : 0;
    document.documentElement.style.setProperty('--dock-w', w + 'px');
  }

  (function initPanelChrome() {
    const panel = document.querySelector('.paths-panel');
    const MIN_W = 240;
    let drag = null;

    /*
     * The panel is docked (fixed to the right edge, full height), so the only
     * geometry it owns is its width — dragged from its inboard edge. The CSS
     * var is what actually sizes it, so the bottom-right controls and the
     * sign-in notice, which offset by the same var, move with it for free.
     */
    function onMove(ev) {
      if (!drag) return;
      const w = Math.max(MIN_W, Math.min(window.innerWidth * 0.7, drag.w - (ev.clientX - drag.x)));
      state.params.dockWidth = w;
      syncDockWidth();
      schedulePathsRerender();   // the profile plots track the panel's width
      ev.preventDefault();
    }
    function onUp() {
      drag = null;
      panel.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }
    const edge = panel.querySelector('.pp-edge');
    if (edge) {
      edge.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        drag = { x: ev.clientX, w: panel.getBoundingClientRect().width };
        panel.classList.add('dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        ev.preventDefault();
      });
    }
    syncDockWidth();
  })();

  /*
   * Drag-only chrome for the Console and Activity panels — the same
   * "drag from any non-interactive background area" pattern as the Paths
   * panel's initPanelChrome above, minus the corner resize (their content
   * sizes itself; only their position needs to move).
   */
  /*
   * `handle` limits where a drag can START. It defaults to the whole panel,
   * which is right for the sheets — but this handler preventDefaults its
   * pointerdown, and the browser's own `resize: both` corner is part of the
   * element rather than a child, so on a resizable box "drag from anywhere"
   * eats the resize gesture entirely. Give such a box a header to drag by.
   */
  function makeDraggable(panel, interactiveSelector, handle) {
    let drag = null;
    function unpin() {
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      return r;
    }
    function onMove(ev) {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      const maxL = window.innerWidth - 60, maxT = window.innerHeight - 40;
      panel.style.left = Math.max(60 - drag.w, Math.min(maxL, drag.left + dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(maxT, drag.top + dy)) + 'px';
      ev.preventDefault();
    }
    function onUp() {
      drag = null;
      panel.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }
    (handle || panel).addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      // On a phone these panels are bottom sheets, not floating boxes. Dragging
      // would write inline left/top that overrides the sheet layout.
      if (window.matchMedia(window.KELP_MOBILE_MQ).matches) return;
      if (ev.target.closest(interactiveSelector)) return;
      const r = unpin();
      drag = { x: ev.clientX, y: ev.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
      panel.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      ev.preventDefault();
    });
  }
  makeDraggable($('console-toggle').closest('.console'),
    'button, input, select, textarea, a, .cc-marker, .cc-ruler, .cc-menu');
  makeDraggable($('act-toggle').closest('.activity'), 'button, input, select, textarea, a');

  function collapseToggle(panel, headBtn, expandedTitle, collapsedTitle) {
    headBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      headBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      headBtn.title = collapsed ? collapsedTitle : expandedTitle;
    });
  }
  collapseToggle($('console-toggle').closest('.console'), $('console-toggle'),
    'Collapse this panel', 'Expand this panel');
  collapseToggle($('act-toggle').closest('.activity'), $('act-toggle'),
    'Collapse this panel', 'Expand this panel');

  /*
   * The Paths panel gets mobile-specific behaviour instead of the plain
   * collapseToggle the other two panels use: on a phone-width viewport the
   * floating box is too small to work in, so tapping its name expands it to
   * fill the screen (.mobile-full) rather than just revealing the body in
   * place, and it starts collapsed on load rather than open.
   */
  const mobileQuery = window.matchMedia(window.KELP_MOBILE_MQ);
  const pathsPanel = $('pp-collapse').closest('.paths-panel');

  /*
   * ---- dock view: Paths / POI tabs + split ----
   * The right-hand dock holds two panes — the paths list and the POI list —
   * shown one at a time (tabs) or stacked (split), all desktop-only: on a
   * phone POI is its own bottom sheet. body[data-dock] drives the CSS; the
   * one geometric fact, where the seam sits, is published as --dock-divide
   * (px up from the viewport bottom) so both panes read the same number.
   */
  /*
   * The two panes are ALWAYS stacked. They used to be tabs with a split toggle,
   * which meant the common case — glance at a point while planning a path —
   * cost a mode switch, and the toggle itself had to be explained. Now each
   * header minimises its own pane to a strip, so both are reachable at once and
   * either can be got out of the way without hiding the other.
   */
  function headStrip(el) {
    return el ? Math.round(el.getBoundingClientRect().height) + 12 : 34;
  }
  function syncDockDivide() {
    const vh = window.innerHeight;
    const dockTop = pathsPanel.getBoundingClientRect().top;
    const pathsMin = !!state.params.pathsMin;
    const poiMin = !!state.params.poiMin;
    let divide;
    if (poiMin) {
      // POI keeps its header only; paths take everything above it
      divide = headStrip(document.querySelector('.poi-head'));
    } else if (pathsMin) {
      // the mirror image: paths keep their header, POI takes the rest
      divide = Math.max(0, vh - dockTop - headStrip(pathsPanel.querySelector('.pp-head')));
    } else {
      const frac = Math.max(0.15, Math.min(0.85, state.params.dockSplit || 0.55));
      state.params.dockSplit = frac;
      divide = (vh - dockTop) * (1 - frac);
    }
    document.documentElement.style.setProperty('--dock-divide', Math.round(divide) + 'px');
  }
  function syncDock() {
    document.body.dataset.pathsMin = state.params.pathsMin ? '1' : '0';
    document.body.dataset.poiMin = state.params.poiMin ? '1' : '0';
    const pc = $('pp-collapse'), qc = $('poi-collapse');
    pc.setAttribute('aria-expanded', state.params.pathsMin ? 'false' : 'true');
    pc.title = state.params.pathsMin ? 'Expand the paths list' : 'Minimise the paths list';
    if (qc) {
      qc.setAttribute('aria-expanded', state.params.poiMin ? 'false' : 'true');
      qc.title = state.params.poiMin ? 'Expand the points list' : 'Minimise the points list';
    }
    syncDockDivide();
  }

  $('pp-collapse').addEventListener('click', () => {
    if (mobileQuery.matches) {
      // strict two-state toggle on mobile: collapsed strip <-> full screen
      const goingFull = !pathsPanel.classList.contains('mobile-full');
      pathsPanel.classList.toggle('mobile-full', goingFull);
      pathsPanel.classList.toggle('collapsed', !goingFull);
      $('pp-collapse').setAttribute('aria-expanded', goingFull ? 'true' : 'false');
      $('pp-collapse').title = goingFull ? 'Shrink this panel' : 'Expand this panel';
    } else {
      state.params.pathsMin = !state.params.pathsMin;
      // both minimised leaves two header strips and a lot of nothing; opening
      // one always gives the other the room it needs
      if (state.params.pathsMin && state.params.poiMin) state.params.poiMin = false;
      syncDock();
      schedulePersist();
    }
    syncDockWidth();
  });
  if ($('poi-collapse')) {
    $('poi-collapse').addEventListener('click', () => {
      if (mobileQuery.matches) return;   // POI is its own sheet on a phone
      state.params.poiMin = !state.params.poiMin;
      if (state.params.poiMin && state.params.pathsMin) state.params.pathsMin = false;
      syncDock();
      schedulePersist();
      syncDockWidth();
    });
  }

  // the split seam: drag to rebalance; the fraction persists with the params
  $('poi-divider').addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const divider = $('poi-divider');
    divider.classList.add('dragging');
    const dockTop = pathsPanel.getBoundingClientRect().top;
    const onMove = (e) => {
      const vh = window.innerHeight;
      // keep both panes usable: paths >= 140px, POI >= 90px
      const yPos = Math.max(dockTop + 140, Math.min(vh - 90, e.clientY));
      const divide = vh - yPos;
      state.params.dockSplit = Math.max(0.15, Math.min(0.85, divide / (vh - dockTop)));
      document.documentElement.style.setProperty('--dock-divide', Math.round(divide) + 'px');
      e.preventDefault();
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      schedulePathsRerender();   // the profile plots track the paths pane height
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    ev.preventDefault();
  });
  window.addEventListener('resize', syncDockDivide);
  syncDock();          // restore which panes were minimised

  if (mobileQuery.matches) {
    pathsPanel.classList.add('collapsed');
    $('pp-collapse').setAttribute('aria-expanded', 'false');
  }
  mobileQuery.addEventListener('change', (ev) => {
    if (!ev.matches) pathsPanel.classList.remove('mobile-full');
  });

  // ---- View menu: show/hide whole panels, independent of their own collapse state ----
  // POI has no entry of its own: it is a tab of the paths dock, so the
  // Paths toggle hides both (the dock CSS ties .poi-panel to the dock).
  const VIEW_TARGETS = {
    'view-console': '.console',
    'view-paths': '.paths-panel',
    'view-activity': '.activity',
    'view-legend': '.legend'
  };
  Object.keys(VIEW_TARGETS).forEach((id) => {
    $(id).addEventListener('change', () => {
      document.querySelector(VIEW_TARGETS[id]).classList.toggle('view-hidden', !$(id).checked);
      if (id === 'view-paths') syncDockWidth();   // the dock stopped/started occupying the edge
    });
  });
  /*
   * Header dropdowns (View, Settings) share one rule: opening one closes the
   * others, and a click anywhere outside closes them all. Wired by scanning
   * .hdr-menu rather than by id, so a third menu needs no JS.
   */
  function closeHeaderMenus(except) {
    document.querySelectorAll('.hdr-menu').forEach((menu) => {
      if (menu === except) return;
      const list = menu.querySelector('.hdr-menu-list');
      const btn = menu.querySelector('button[aria-haspopup]');
      if (list) list.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }
  document.querySelectorAll('.hdr-menu').forEach((menu) => {
    const btn = menu.querySelector('button[aria-haspopup]');
    const list = menu.querySelector('.hdr-menu-list');
    if (!btn || !list) return;
    btn.addEventListener('click', () => {
      const opening = list.hidden;
      closeHeaderMenus(menu);
      list.hidden = !opening;
      btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('.hdr-menu')) return;
    closeHeaderMenus();
  });

  /*
   * ---- global gas-planning bar ----
   * One SAC/speed-or-time/gas setup for every path, rather than repeating it
   * per path — see effectiveTimeSpeed()/gasProfile() for how each path's own
   * length turns these into its own numbers.
   */
  function syncGasBar() {
    $('pp-sac-input').value = +sacU().fromBase(state.params.sac).toFixed(sacU().dp);
    $('pp-sac-unit').textContent = sacU().label;

    const isTime = state.params.timeMode === 'time';
    $('pp-time-btn').setAttribute('aria-pressed', isTime ? 'true' : 'false');
    $('pp-speed-btn').setAttribute('aria-pressed', isTime ? 'false' : 'true');
    $('pp-mode-input').value = isTime
      ? (+state.params.time.toFixed(1))
      : (+speedU().fromBase(state.params.speed).toFixed(speedU().dp));
    $('pp-mode-input').title = isTime
      ? 'Target time for each path (speed is derived from this and each path\'s length)'
      : 'Swim speed, assumed constant (time is derived from this and each path\'s length)';
    $('pp-mode-unit').textContent = isTime ? 'min' : speedU().label;

    // kick distance is stored in metres; the input shows it in the chosen unit
    $('pp-decl-input').value = state.params.declination;
    $('pp-kick-unit').value = state.params.kickUnit;
    const kickM = state.params.kickDistance;
    $('pp-kick-input').value = kickM > 0
      ? +(state.params.kickUnit === 'ft' ? kickM * M_TO_FT : kickM).toFixed(2)
      : '';
  }
  $('pp-sac-input').addEventListener('change', () => {
    const v = parseFloat($('pp-sac-input').value);
    if (isFinite(v) && v > 0) state.params.sac = sacU().toBase(v);
    syncGasBar();
    renderPaths();
  });
  $('pp-time-btn').addEventListener('click', () => {
    state.params.timeMode = 'time';
    syncGasBar();
    renderPaths();
  });
  $('pp-speed-btn').addEventListener('click', () => {
    state.params.timeMode = 'speed';
    syncGasBar();
    renderPaths();
  });
  $('pp-mode-input').addEventListener('change', () => {
    const v = parseFloat($('pp-mode-input').value);
    if (isFinite(v) && v > 0) {
      if (state.params.timeMode === 'time') state.params.time = v;
      else state.params.speed = speedU().toBase(v);
    }
    syncGasBar();
    renderPaths();
  });
  $('pp-kick-input').addEventListener('change', () => {
    const v = parseFloat($('pp-kick-input').value);
    // blank or nonsense means "no kick column", not an error
    state.params.kickDistance = (isFinite(v) && v > 0)
      ? (state.params.kickUnit === 'ft' ? v / M_TO_FT : v)
      : 0;
    syncGasBar();
  });
  $('pp-kick-unit').addEventListener('change', () => {
    state.params.kickUnit = $('pp-kick-unit').value;   // same distance, restated
    syncGasBar();
  });

  /*
   * ---- path options: diver + cylinders ----
   * Collapsed by default so the panel opens on the paths themselves; the
   * numbers behind the planning live one disclosure away.
   */
  $('pp-opts-toggle').addEventListener('click', () => {
    const open = $('pp-opts').hidden;
    $('pp-opts').hidden = !open;
    $('pp-opts-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('pp-opts-toggle').querySelector('.sect-caret').textContent = open ? '▾' : '▸';
  });

  function numField(labelText, value, dp, title, onCommit) {
    const wrap = document.createElement('label');
    wrap.className = 'pp-field'; wrap.title = title || '';
    const lab = document.createElement('span');
    lab.className = 'pp-opts-label'; lab.textContent = labelText;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'pp-num'; inp.min = '0';
    inp.value = isFinite(value) ? String(+(+value).toFixed(dp)) : '';
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (isFinite(v) && v >= 0) onCommit(v);
      renderCylinders(); renderPaths();
    });
    wrap.appendChild(lab); wrap.appendChild(inp);
    return wrap;
  }

  function checkField(labelText, checked, onToggle) {
    const wrap = document.createElement('label');
    wrap.className = 'check pp-cyl-check';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = !!checked;
    box.addEventListener('change', () => { onToggle(box.checked); renderCylinders(); renderPaths(); });
    const lab = document.createElement('span');
    lab.className = 'label'; lab.textContent = labelText;
    wrap.appendChild(box); wrap.appendChild(lab);
    return wrap;
  }

  /*
   * Declination from the path's mean position.
   *
   * Computed locally from WMM 2025 (js/wmm.js) rather than fetched: NOAA's
   * calculator now needs a registered API key, which cannot stay secret in a
   * static page, and a boat is exactly where the network isn't. The model
   * expires 2029-12-31, so an out-of-date answer says so instead of pretending.
   */
  function autoDeclination() {
    const p = Paths.list.find((x) => x.id === Paths.selectedId) || Paths.list[0];
    if (!p || !p.nodes.length) { toast('Draw or select a path first.', true); return; }
    const mean = p.nodes.reduce((a, n) => ({ lat: a.lat + n.lat, lng: a.lng + n.lng }),
                                { lat: 0, lng: 0 });
    mean.lat /= p.nodes.length; mean.lng /= p.nodes.length;

    const dec = WMM.declination(mean.lat, mean.lng);
    state.params.declination = Math.round(dec * 10) / 10;
    $('pp-decl-input').value = state.params.declination;
    // no explicit save needed: the debounced writer fires on this click

    const where = mean.lat.toFixed(4) + ', ' + mean.lng.toFixed(4);
    say('Declination ' + state.params.declination + '°E at ' + p.name +
        ' mean position ' + where + ' (WMM ' + WMM.EPOCH + ')', 'ok');
    if (WMM.isExpired()) {
      toast('WMM 2025 expired after ' + (WMM.VALID_UNTIL - 1) + ' — declination may be stale.', true);
      say('WMM model out of date — coefficients need replacing', 'warn');
    }
    renderPaths();
  }
  $('pp-decl-auto').addEventListener('click', autoDeclination);

  $('pp-decl-input').addEventListener('change', () => {
    const v = parseFloat($('pp-decl-input').value);
    if (isFinite(v)) state.params.declination = v;
    $('pp-decl-input').value = state.params.declination;
    renderPaths();
  });

  function renderCylinders() {
    const host = $('pp-cyl-list');
    host.textContent = '';
    cylinders().forEach((cyl) => {
      const card = document.createElement('div');
      card.className = 'pp-cyl';

      const head = document.createElement('div');
      head.className = 'pp-cyl-head';
      const name = document.createElement('input');
      name.type = 'text'; name.className = 'pp-cyl-name'; name.value = cyl.name;
      name.setAttribute('aria-label', 'Gas source name');
      name.addEventListener('change', () => {
        cyl.name = name.value.trim() || 'Cylinder';
        renderCylinders(); renderPaths();
      });
      head.appendChild(name);

      /*
       * Preset picker: fills the numbers in from a common cylinder. The name
       * stays a free-text field, so a preset is a starting point rather than
       * a constraint — actual fills vary (LP steels are routinely filled past
       * their rating).
       */
      const presetWrap = document.createElement('div');
      presetWrap.className = 'pp-cyl-preset';
      const presetBtn = document.createElement('button');
      presetBtn.type = 'button'; presetBtn.className = 'pp-cyl-preset-btn';
      presetBtn.textContent = '▾'; presetBtn.title = 'Pick a common cylinder';
      const presetList = document.createElement('div');
      presetList.className = 'pp-cyl-preset-list'; presetList.hidden = true;
      (cfg.CYLINDERS || []).forEach((spec) => {
        const opt = document.createElement('button');
        opt.type = 'button'; opt.className = 'pp-cyl-preset-opt';
        opt.textContent = spec.name + ' · ' + spec.totalCuft + ' cuft @ ' + spec.startPsi;
        opt.addEventListener('click', () => {
          /*
           * Two AL80s must stay tellable apart: the ids are already unique, but
           * identical NAMES in the leg dropdown and the budget summary made it
           * look like one tank being drained by everything. Number duplicates.
           */
          const taken = cylinders().filter((c) => c.id !== cyl.id)
            .map((c) => c.name)
            .filter((n) => n === spec.name || n.indexOf(spec.name + ' #') === 0).length;
          cyl.name = taken ? spec.name + ' #' + (taken + 1) : spec.name;
          cyl.totalCuft = spec.totalCuft;
          cyl.startPsi = spec.startPsi;
          presetList.hidden = true;
          renderCylinders(); renderPaths();
          say('Gas source set to ' + cyl.name);
        });
        presetList.appendChild(opt);
      });
      presetBtn.addEventListener('click', () => {
        // one open at a time
        host.querySelectorAll('.pp-cyl-preset-list').forEach((l) => { if (l !== presetList) l.hidden = true; });
        presetList.hidden = !presetList.hidden;
      });
      presetWrap.appendChild(presetBtn); presetWrap.appendChild(presetList);
      head.appendChild(presetWrap);

      // the last cylinder cannot be removed — legs must have somewhere to draw from
      if (cylinders().length > 1) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'pp-cyl-del'; del.textContent = '×';
        del.title = 'Remove this gas source';
        del.addEventListener('click', () => {
          state.params.cylinders = cylinders().filter((c) => c.id !== cyl.id);
          // legs pointing at the removed source fall back to the first one
          Paths.list.forEach((p) => {
            if (!p.legGas) return;
            Object.keys(p.legGas).forEach((k) => { if (p.legGas[k] === cyl.id) delete p.legGas[k]; });
          });
          renderCylinders(); renderPaths();
          say(cyl.name + ' removed');
        });
        head.appendChild(del);
      }
      card.appendChild(head);

      /*
       * One line per unit: what the cylinder holds, and what is held back in
       * that same unit, side by side. They used to be four stacked rows — two
       * totals, then two reserve checkboxes far below them — so reading "how
       * much psi do I actually have" meant pairing numbers across the card by
       * eye. Reserve reads as a qualifier on the number beside it now.
       *
       * The reserve word is the switch. A checkbox for something that already
       * greys out when off is one control too many, and the grey is the state
       * you read at a glance anyway. Reserve by volume, by pressure, or both —
       * the larger wins; see reserveCuft.
       */
      const specLine = (unitLabel, totalVal, dp, totalTitle, onTotal,
                        resOn, resVal, resTitle, onToggle, onRes) => {
        const line = document.createElement('div');
        line.className = 'pp-cyl-line';
        line.appendChild(numField(unitLabel, totalVal, dp, totalTitle, onTotal));

        const res = document.createElement('div');
        res.className = 'pp-cyl-res' + (resOn ? '' : ' off');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pp-cyl-res-btn';
        btn.textContent = 'reserve';
        btn.setAttribute('aria-pressed', resOn ? 'true' : 'false');
        btn.title = resOn ? 'Counted against usable gas — click to ignore it'
                          : 'Ignored — click to hold this back';
        btn.addEventListener('click', () => {
          onToggle(!resOn); renderCylinders(); renderPaths();
        });
        const val = numField('', resVal, dp, resTitle, onRes);
        // an ignored reserve keeps its number, so turning it back on does not
        // cost the diver the figure they typed
        val.querySelector('input').disabled = !resOn;
        res.appendChild(btn); res.appendChild(val);
        line.appendChild(res);
        return line;
      };

      card.appendChild(specLine('cuft', cyl.totalCuft, 1, 'Rated volume of the cylinder',
        (v) => { cyl.totalCuft = v; },
        cyl.useReserveCuft, cyl.reserveCuft, 'Volume held back',
        (on) => { cyl.useReserveCuft = on; }, (v) => { cyl.reserveCuft = v; }));
      card.appendChild(specLine(pressU().label, cyl.startPsi, 0, 'Pressure it is filled to',
        (v) => { cyl.startPsi = v; },
        cyl.useReservePsi, cyl.reservePsi, 'Gauge pressure held back',
        (on) => { cyl.useReservePsi = on; }, (v) => { cyl.reservePsi = v; }));

      const summary = document.createElement('div');
      summary.className = 'pp-cyl-summary';
      summary.textContent = usableCuft(cyl).toFixed(1) + ' cuft usable · ' +
        reserveCuft(cyl).toFixed(1) + ' cuft reserve';
      card.appendChild(summary);

      host.appendChild(card);
    });
  }

  $('pp-cyl-add').addEventListener('click', () => {
    const nextId = cylinders().reduce((a, c) => Math.max(a, c.id), 0) + 1;
    const base = cylinders()[0];
    state.params.cylinders = cylinders().concat([{
      id: nextId, name: 'Cylinder ' + nextId,
      totalCuft: base ? base.totalCuft : 77.4, startPsi: base ? base.startPsi : 3000,
      useReserveCuft: false, reserveCuft: 15,
      useReservePsi: true, reservePsi: 500
    }]);
    renderCylinders(); renderPaths();
    say('Added a gas source — assign legs to it in the leg table');
  });

  renderCylinders();
  syncGasBar();

  /*
   * Starting a path is a request to work on the MAP, so the panel that was
   * used to ask for it gets out of the way in the same action — otherwise the
   * button puts you in draw mode and then leaves you looking at the list you
   * have to dismiss before you can place a single node. On a phone that panel
   * IS the screen, so it is the whole interaction.
   *
   * Only on the way in. Finishing a path is when you want the list back, and
   * the panel is one tap away either way (a tab on a phone, the header strip
   * on the desktop dock).
   *
   * POI's pane is deliberately left as the user set it: they asked for the
   * paths dialog to move, not for their dock layout to be rearranged.
   */
  function clearTheWayForDrawing() {
    if (window.MobileShell && MobileShell.active) { MobileShell.closeSheet(); return; }
    if (state.params.pathsMin) return;               // already out of the way
    state.params.pathsMin = true;
    syncDock();
    syncDockWidth();
    schedulePersist();
  }

  $('pp-add').addEventListener('click', () => {
    if (Paths.drawing) { Paths.finishDrawing(); return; }
    Paths.startDrawing();
    clearTheWayForDrawing();
  });
  $('pp-save').addEventListener('click', () => Paths.exportPath(Paths.selectedId));
  $('pp-load').addEventListener('click', () => $('pp-file').click());
  $('pp-file').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) Paths.importFile(f);
    ev.target.value = '';
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('.pp-item')) return;
    $('pp-list').querySelectorAll('.pp-menu').forEach((m) => { m.hidden = true; });
  });

  /*
   * ---- Earth Engine connect ----
   * Deliberately NOT an async function. Browsers only allow window.open from
   * inside a user gesture, and that grant is lost across an await — so the popup
   * has to be kicked off in the same tick as the click, before any awaiting.
   */
  /*
   * The notice persists until the visitor signs in or closes it — it is an
   * invitation to use their own quota, not a transient error, so it does not
   * auto-dismiss. Dismissal is remembered for the session only.
   */
  let noticeDismissed = false;
  function updateSigninUi() {
    const signedIn = !!state.engine && state.engine.name === 'earth-engine';
    $('connect').style.display = signedIn ? 'none' : '';
    $('connect').className = 'btn ghost' + (signedIn ? '' : ' disconnected');
    $('signin-notice').hidden = signedIn || noticeDismissed;
  }
  $('signin-dismiss').addEventListener('click', () => {
    noticeDismissed = true;
    updateSigninUi();
  });

  function connectEE() {
    if (!cfg.CLIENT_ID || cfg.CLIENT_ID.indexOf('<') === 0) {
      toast('Add your OAuth client ID and project in js/config.js first.', true);
      return;
    }
    if (typeof ee === 'undefined') {
      // idle load hasn't finished (or failed): fetch it now, then sign in.
      // The GIS flow tolerates this await — see the loader's comment.
      say('Loading sign-in library…');
      busy(true);
      (window.__loadEE ? window.__loadEE() : Promise.reject(new Error('loader missing')))
        .then(() => { busy(false); connectEE(); })
        .catch((err) => {
          busy(false);
          say('Sign-in unavailable — ' + err.message, 'warn');
          toast('Could not load the sign-in library — check the connection.', true);
        });
      return;
    }

    let pending;
    try {
      pending = KelpEngine.login();       // first thing, still inside the gesture
    } catch (err) {
      console.warn(err);
      say('Sign-in could not start — ' + err.message, 'warn');
      toast('Sign-in could not start — see console.', true);
      return;
    }
    say('Opening Google sign-in…');
    busy(true);
    pending.then((ok) => {
      if (ok) {
        activateEngine(KelpEngine);
        say('Earth Engine connected — live Sentinel-2', 'ok');
        toast('Connected to Earth Engine — live imagery.');
      } else {
        say('Sign-in did not complete', 'warn');
        toast('Sign-in did not complete.', true);
      }
    }).catch((err) => {
      console.warn(err);
      const msg = String(err && err.message || err);
      // the two failures that actually happen, named plainly
      const hint = /origin/i.test(msg)
        ? 'This origin is not registered on the OAuth client.'
        : (/popup/i.test(msg) ? 'The sign-in popup was blocked.' : msg);
      say('Sign-in failed — ' + hint, 'warn');
      toast('Sign-in failed: ' + hint, true);
    }).then(() => busy(false));
  }
  $('connect').addEventListener('click', connectEE);
  $('signin-cta').addEventListener('click', connectEE);

  function activateEngine(engine) {
    state.engine = engine;
    /*
     * Three states, not two. "live" (real imagery) and "signed in" (using the
     * visitor's own Earth Engine quota) are different things: the shared backend
     * is live but public, so the invitation to sign in still applies. Only a
     * personal sign-in retires the Connect button and the notice.
     */
    const live = engine.name !== 'demo';
    $('status').className = 'status ' + (live ? 'is-live' : 'is-demo');
    $('status-label').textContent = live ? 'LIVE · SENTINEL-2' : 'DEMO DATA';
    updateSigninUi();
    clearSceneCache();   // demo and live scene lists are not interchangeable
    state.scenes = []; state.allScenes = [];
    state.idx = -1;
    syncSampleUi();      // engines differ on whether they can measure a box
    loadScenes();
  }

  /*
   * ---- persistence: the save side ----
   * One debounced writer, triggered by the tail end of any interaction
   * (click / input / pointerup) rather than instrumenting every setter —
   * all mutations here start from a user gesture, so this catches them
   * all for the cost of one JSON serialisation per burst of activity.
   * beforeunload does a final synchronous flush.
   */
  let persistDisabled = false;
  function persistNow() {
    if (persistDisabled) return;
    try {
      // stamp the version with every write — data without its version key
      // would be discarded as stale on the next load
      localStorage.setItem('kelp.v', STORE_V);
      localStorage.setItem('kelp.boundsv', '2');
      localStorage.setItem('kelp.params', JSON.stringify(state.params));
      Session.savePois();          // POIs persist alongside settings and paths
      localStorage.setItem('kelp.paths', JSON.stringify(Paths.list.map((p) => ({
        name: p.name, color: p.color, mirrored: p.mirrored,
        preMirrorNodes: p.preMirrorNodes
          ? p.preMirrorNodes.map((n) => ({ lat: n.lat, lng: n.lng })) : null,
        plotHeight: p.plotHeight, plotHeightManual: p.plotHeightManual,
        expanded: p.expanded, showNodes: p.showNodes, showLegs: p.showLegs,
        legGas: p.legGas, ceilings: p.ceilings || [], floors: p.floors || [],
        offsets: p.offsets || [],
        nodes: p.nodes.map((n) => ({ lat: n.lat, lng: n.lng }))
      }))));
      const sc = state.scenes[state.idx];
      sessionStorage.setItem('kelp.session', JSON.stringify({
        start: state.range.start, end: state.range.end, scene: sc ? sc.date : null
      }));
    } catch (err) { /* storage blocked or full — run stateless, never break */ }
  }
  let persistTimer = null;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 500);
  }
  document.addEventListener('click', schedulePersist);
  document.addEventListener('input', schedulePersist);
  document.addEventListener('pointerup', schedulePersist);
  window.addEventListener('beforeunload', persistNow);

  /*
   * Forget everything this app has stored, then reload into a first-visit
   * state. Persistence is switched off FIRST and the pending write cancelled:
   * otherwise the debounced writer — or the beforeunload flush that the
   * reload itself triggers — would put the in-memory state straight back, and
   * the cleared data would reappear on the next load.
   */
  $('clear-data').addEventListener('click', () => {
    if (!window.confirm(
      'Clear saved settings and paths?\n\nYour drawn paths and preferences will be forgotten and the page will reload. This cannot be undone.'
    )) return;
    persistDisabled = true;
    clearTimeout(persistTimer);
    try {
      ['kelp.v', 'kelp.params', 'kelp.paths', 'kelp.pois'].forEach((k) => localStorage.removeItem(k));
      ['kelp.session', 'kelp.tcUsed'].forEach((k) => sessionStorage.removeItem(k));
    } catch (err) { console.warn('clearing stored data failed:', err); }
    location.reload();
  });

  // ---- boot ----
  (async function boot() {
    // Point the controls at whichever index config.js defaults to, so the slider
    // scale and the published threshold always agree.
    applyIndex(state.params.indexType);
    $('b11').value = state.params.b11Thresh;
    $('b11-val').textContent = state.params.b11Thresh.toFixed(3);

    const [rs, re] = defaultRange();
    state.range.start = rs; state.range.end = re;
    // a reload mid-session keeps its place; a fresh visit starts at the default window
    try {
      const sess = JSON.parse(sessionStorage.getItem('kelp.session') || 'null');
      if (sess && sess.start && sess.end) {
        state.range.start = sess.start;
        state.range.end = sess.end;
        if (sess.scene) pendingPick = sess.scene;
      }
    } catch (err) { console.warn('session restore skipped:', err); }
    showRange();

    // mode is restored with the rest of params; the seg buttons need to agree
    $('mode-single').setAttribute('aria-pressed', state.params.mode === 'single');
    $('mode-composite').setAttribute('aria-pressed', state.params.mode === 'composite');

    setCloudCeiling(state.params.maxCloud, true);   // sync both sliders, no refilter yet
    // a restored box may be from an older build, or absent entirely — and so
    // may its companions, if a cached config.js predates them
    if (!clampSample(state.params.cloudSample)) {
      state.params.cloudSample = defaultSampleBox();
    }
    if (state.params.useAoiCloud === undefined) state.params.useAoiCloud = true;
    if (!(state.params.minCoverage >= 0)) state.params.minCoverage = 60;
    syncSampleUi();
    setDirty(false);

    $('depth-op').value = state.params.depthOpacity;
    $('depth-op-val').textContent = Math.round(state.params.depthOpacity * 100) + '%';
    $('relief').checked = !!state.params.showRelief;
    $('contours').checked = !!state.params.showContours;
    if (state.params.showRelief) setDepthLayer('relief', true);
    if (state.params.showContours) setDepthLayer('contours', true);

    DemSampler.init(cfg);
    CustomContours.init(cfg, L, map, say);
    Paths.init(cfg, L, map, say, toast, renderPaths);
    // POI edits had no route to storage of their own: renaming, hiding or
    // deleting a point survived only if some unrelated change happened to
    // trigger a write before the tab closed
    POI.init(cfg, L, map, say, toast, schedulePersist);

    /*
     * Session: export/import plus POI persistence. applyState is the single
     * point where imported settings land — it writes params, then re-syncs the
     * controls that read them, so the UI can never disagree with state.
     */
    Session.init({
      cfg: cfg, say: say, toast: toast,
      getState: () => state,
      applyState: (settings) => {
        Object.assign(state.params, settings);
        /*
         * applyIndex resets the threshold to that index's published value, which
         * is right when a human switches index but wrong here — it would discard
         * the threshold the file just supplied. Re-apply it afterwards.
         */
        applyIndex(state.params.indexType);
        if ('kelpThresh' in settings) {
          state.params.kelpThresh = settings.kelpThresh;
          $('kelp').value = settings.kelpThresh;
          $('kelp-val').textContent = fmtIndex(settings.kelpThresh);
        }
        $('b11').value = state.params.b11Thresh;
        $('b11-val').textContent = Number(state.params.b11Thresh).toFixed(3);
        setKelpOpacity(state.params.opacity);
        setDepthOpacity(state.params.depthOpacity);
        setTrueColorOpacity(state.params.trueColorOpacity);
        // may flip the cloud gate, which re-runs the kelp map — correct: the
        // imported state asked for a differently-masked computation
        setTurbidityOpacity(state.params.turbidityOpacity);
        setCloudOpacity(state.params.cloudOpacity);
        syncSwatchGroup('turb-swatches', state.params.turbidityPalette);
        syncSwatchGroup('cloud-swatches', state.params.cloudPalette);
        updateTurbRamp();
        syncModelControls();   // the Models tabs' cloud/turbidity tuning sliders
        syncDock();          // imported pane arrangement
        // an imported box describes different water; drop the numbers measured
        // over the old one rather than showing them against the new outline
        if (!clampSample(state.params.cloudSample)) {
          state.params.cloudSample = defaultSampleBox();
        }
        syncSampleUi();
        resetSampledCloud();
        setCloudCeiling(state.params.maxCloud, true);
        $('relief').checked = !!state.params.showRelief;
        $('contours').checked = !!state.params.showContours;
        setDepthLayer('relief', !!state.params.showRelief);
        setDepthLayer('contours', !!state.params.showContours);
        // setDepthLayer only builds a fresh layer when none exists yet, so an
        // imported depthStyle needs its own push onto an already-built relief
        // layer, same as the picker's own click handler does
        if (DEPTH_LAYERS.relief.layer && DEPTH_LAYERS.relief.layer.setParams) {
          DEPTH_LAYERS.relief.layer.setParams({ layers: reliefLayerName() });
        }
        document.querySelectorAll('#depth-swatches .legend-swatch').forEach((b) => {
          b.setAttribute('aria-pressed', b.dataset.depthStyle === state.params.depthStyle ? 'true' : 'false');
        });
        applyDepthFilter();    // imported depthStyle may be a filter-only recolour
        syncOverlayPicker();
        syncGasBar();          // SAC, speed/time, declination, kick distance
        renderCylinders && renderCylinders();
        renderPaths();
        setDirty(true);
        persistNow();
      }
    });
    SessionUI.init({
      onLocate: (kind, rec) => {
        if (!rec) return;
        if (kind === 'pois') map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 14));
        else if (rec.nodes && rec.nodes.length) {
          map.fitBounds(L.latLngBounds(rec.nodes.map((n) => [n.lat, n.lng])).pad(0.3));
        }
      }
    });

    const savedPois = Session.loadPois();
    if (savedPois.length) {
      POI.restore(savedPois);
      say(savedPois.length + ' saved point' + (savedPois.length === 1 ? '' : 's') + ' restored');
    }

    /*
     * ---- text scale ----
     * Every font-size in the stylesheet is calc(Npx * var(--fs-ui)), so these
     * two numbers move all of them; --fs-plot multiplies the depth-profile
     * labels a second time. Applied to the root rather than re-rendering
     * anything — the profile SVG picks it up because its labels are styled by
     * a class, not by an attribute.
     */
    function applyTextScale() {
      const clampScale = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 1));
      state.params.fsUi = clampScale(state.params.fsUi, 0.8, 1.6);
      state.params.fsPlot = clampScale(state.params.fsPlot, 0.8, 2.5);
      const root = document.documentElement;
      root.style.setProperty('--fs-ui', state.params.fsUi);
      root.style.setProperty('--fs-plot', state.params.fsPlot);
      $('fs-ui').value = state.params.fsUi;
      $('fs-plot').value = state.params.fsPlot;
      $('fs-ui-val').textContent = Math.round(state.params.fsUi * 100) + '%';
      $('fs-plot-val').textContent = Math.round(state.params.fsPlot * 100) + '%';
    }
    $('fs-ui').addEventListener('input', (ev) => {
      state.params.fsUi = Number(ev.target.value);
      applyTextScale();
      schedulePersist();
    });
    $('fs-plot').addEventListener('input', (ev) => {
      state.params.fsPlot = Number(ev.target.value);
      applyTextScale();
      // the plot's own layout is measured in JS, so it has to be redrawn for
      // bigger labels to get the room they now need
      renderPaths();
      schedulePersist();
    });
    applyTextScale();

    /*
     * ---- share codes ----
     * A pasted code is decoded and then handed to exactly the same review
     * screen a session file gets. Nothing arrives on the map until the reader
     * has seen what it is and said yes.
     */
    const shareModal = $('share-modal');
    const shareErr = $('share-err');
    function openShare() {
      shareErr.hidden = true;
      $('share-input').value = '';
      shareModal.hidden = false;
      $('share-input').focus();
    }
    const closeShare = () => { shareModal.hidden = true; };
    $('share-paste').addEventListener('click', openShare);
    $('share-close').addEventListener('click', closeShare);
    shareModal.addEventListener('click', (ev) => { if (ev.target === shareModal) closeShare(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !shareModal.hidden) closeShare();
    });
    $('share-go').addEventListener('click', () => {
      try {
        const data = Session.readShareCode($('share-input').value);
        closeShare();
        SessionUI.open(Session.diff(data), 'shared code');
      } catch (err) {
        shareErr.textContent = 'Could not read that — ' + err.message + '.';
        shareErr.hidden = false;
      }
    });

    $('session-export').addEventListener('click', () => Session.exportFile());
    $('session-import').addEventListener('click', () => $('session-file').click());
    $('session-file').addEventListener('change', async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try {
        const data = Session.parse(await f.text());
        SessionUI.open(Session.diff(data), f.name);
      } catch (err) {
        console.warn(err);
        toast('Could not read that session file — ' + err.message, true);
        say('Session import failed — ' + err.message, 'warn');
      }
    });
    // map-hover depth labels borrow the console's unit formatting
    Paths.setDepthFormatter((s) => fmtDepth(-s.feet));
    try {
      const saved = JSON.parse(localStorage.getItem('kelp.paths') || 'null');
      /*
       * One-time migration: stored bounds predating the ceiling/floor meaning
       * correction have the arrays the wrong way round. Swap once and flag it.
       */
      if (Array.isArray(saved) && localStorage.getItem('kelp.boundsv') !== '2') {
        saved.forEach((p) => {
          const c = p.ceilings; p.ceilings = p.floors || []; p.floors = c || [];
        });
        try { localStorage.setItem('kelp.boundsv', '2'); } catch (e) { /* best effort */ }
      }
      if (Array.isArray(saved) && saved.length) Paths.restore(saved);
    } catch (err) { console.warn('path restore skipped:', err); }
    renderPaths();

    /*
     * Earth Engine client, loaded during idle time rather than shipped with
     * the page: 341 KB that only the sign-in flow uses, and most visits never
     * sign in. By the time a human reaches the Connect button it is warm; if
     * they somehow beat it, connectEE awaits this same promise. The GIS-based
     * auth flow does not depend on the click's gesture window (that is why it
     * could open a picker at boot, unprompted, before that was fixed), so
     * awaiting the load inside the click handler is safe.
     */
    window.__eeLoad = null;
    const loadEE = () => {
      if (window.__eeLoad) return window.__eeLoad;
      window.__eeLoad = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = 'https://unpkg.com/@google/earthengine@0.1.404/build/ee_api_js.js';
        tag.onload = () => resolve();
        tag.onerror = () => { window.__eeLoad = null; reject(new Error('Earth Engine library failed to load')); };
        document.head.appendChild(tag);
      });
      return window.__eeLoad;
    };
    window.__loadEE = loadEE;
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => { loadEE().catch(() => {}); }, { timeout: 6000 });
    } else {
      setTimeout(() => { loadEE().catch(() => {}); }, 3000);
    }

    /*
     * Service worker: cache-first for the NOAA hosts, which send
     * cache-control:private with no freshness signal and so re-download every
     * relief and contour tile on every visit. Registration is best-effort —
     * file:// and older browsers simply skip it.
     */
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw skipped:', e));
    }

    /*
     * NOAA tile warmup. Once the service worker is caching NOAA tiles, the
     * cheapest time to pay for the zoom levels around the home view is while
     * a fresh visit sits idle: warm zoom ±1 over the default AOI (a few dozen
     * tiles) and the first pinch-zoom paints from cache instead of waiting
     * ~500 ms per tile on NOAA's servers. Skipped for returning visitors
     * (cache already has depth) and when no worker controls the page (the
     * fetches would warm nothing — NOAA's cache-control:private makes the
     * browser's own cache useless).
     */
    function warmNoaaTiles() {
      if (!('caches' in window) || !navigator.serviceWorker ||
          !navigator.serviceWorker.controller) return;
      caches.open('kelp-noaa-v1').then((c) => c.keys()).then((keys) => {
        if (keys.length > 60) return;   // returning visitor — already warm
        const layers = [DEPTH_LAYERS.relief.layer, DEPTH_LAYERS.contours.layer]
          .filter((ly) => ly && ly._map);
        if (!layers.length) return;
        const urls = [];
        /*
         * Zooms are derived from the AOI, not map.getZoom(): the AOI spans a
         * ~1200 px viewport at z10-11 and a phone at z8-9, so 8..11 covers the
         * first pinch in or out from any device's home view. (Also sidesteps
         * environments where the map reports zoom 0 before its first layout.)
         */
        const urlsSeen = new Set();
        [8, 9, 10, 11].forEach((z) => {
          layers.forEach((ly) => {
            const size = ly.getTileSize().x;
            const nw = map.project(L.latLng(n, w), z);
            const se = map.project(L.latLng(s, e), z);
            for (let ty = Math.floor(nw.y / size); ty <= Math.floor(se.y / size); ty++) {
              for (let tx = Math.floor(nw.x / size); tx <= Math.floor(se.x / size); tx++) {
                const c = L.point(tx, ty); c.z = z;
                const u = ly.getTileUrl(c);
                if (!urlsSeen.has(u)) { urlsSeen.add(u); urls.push(u); }
              }
            }
          });
        });
        // politeness cap + gentle pacing: NOAA is a shared public service
        const batch = urls.slice(0, 48);
        (function next() {
          const chunk = batch.splice(0, 4);
          if (!chunk.length) return;
          Promise.allSettled(chunk.map((u) => fetch(u, { mode: 'no-cors' })))
            .then(() => setTimeout(next, 250));
        })();
      }).catch(() => { /* warmup is never worth an error */ });
    }
    setTimeout(() => {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(warmNoaaTiles, { timeout: 10000 });
      } else warmNoaaTiles();
    }, 8000);

    say('Starting up…');
    /*
     * Engine preference, best first:
     *   1. the visitor's own Earth Engine session — their quota, not the project's
     *   2. the public backend — live imagery for everyone else, no sign-in
     *   3. demo — synthetic, always works
     *
     * The silent-auth probe is raced against a timeout: when Google's popup is
     * blocked its callbacks can simply never fire, and without this the page
     * would sit at boot forever instead of falling through to the backend.
     */
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((res) => setTimeout(() => res(false), ms))
    ]);

    let engine = DemoEngine;
    busy(true);
    try {
      if (await withTimeout(KelpEngine.init(cfg), 2500)) {
        engine = KelpEngine;
      } else if (localStorage.getItem('kelp.apiok') === '1') {
        /*
         * The backend answered on a previous visit, so trust it now and
         * revalidate in the background: awaiting /health at boot cost 4.2s
         * when Cloud Run was cold-starting, and that wait bought nothing —
         * if the API has actually died, the first real call fails and the
         * engine demotes to demo then.
         */
        ApiKelpEngine.assumeReady(cfg);
        engine = ApiKelpEngine;
        ApiKelpEngine.init(cfg).then((ok) => {
          try { localStorage.setItem('kelp.apiok', ok ? '1' : '0'); } catch (e) { /* best effort */ }
          if (!ok && state.engine === ApiKelpEngine) {
            say('Backend unreachable — switching to demo data', 'warn');
            DemoEngine.init(cfg, L).then(() => activateEngine(DemoEngine));
          }
        });
      } else if (await ApiKelpEngine.init(cfg)) {
        engine = ApiKelpEngine;
        try { localStorage.setItem('kelp.apiok', '1'); } catch (e) { /* best effort */ }
      }
    } catch (err) { console.warn('engine probe skipped:', err); }
    finally { busy(false); }

    say(engine === KelpEngine ? 'Signed in — using your Earth Engine account'
      : engine === ApiKelpEngine ? 'Live Sentinel-2 via the shared backend — sign in to use your own quota'
      : 'Demo mode — synthetic kelp', 'ok');
    if (engine === DemoEngine) await DemoEngine.init(cfg, L);
    // a restored true-color opacity is meaningless in demo mode (no imagery) —
    // zero it quietly rather than greeting the user with an error toast
    if (engine === DemoEngine && state.params.trueColorOpacity > 0) {
      state.params.trueColorOpacity = 0;
      syncOverlayPicker();
    }
    activateEngine(engine);
    /*
     * No sign-in nag on load. There used to be a toast here, from when boot
     * attempted authentication and could report that it had failed — but boot no
     * longer attempts anything, so there is nothing to report. The Connect
     * button and the dismissible notice are invitation enough; a popup and a
     * toast before the visitor has asked for either is what made the page feel
     * like it demanded an account to look at a map.
     */
  })();
})();
