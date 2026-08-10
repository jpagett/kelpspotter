/* KelpSpotter app wiring. Talks to whichever engine is available
   (KelpEngine when Earth Engine is connected, else DemoEngine) through
   one shared interface: listScenes / singleSceneLayer / compositeLayer. */
(function () {
  const cfg = window.KELP_CONFIG;
  const $ = (id) => document.getElementById(id);

  const state = {
    engine: null,
    scenes: [],        // filtered to the current cloud ceiling
    allScenes: [],     // every pass in range, cached per date range
    idx: -1,
    layer: null,
    range: { start: null, end: null }, // filled in at boot from LOOKBACK_DAYS
    params: Object.assign({}, cfg.DEFAULTS)
  };

  // ---- map ----
  const [w, s, e, n] = cfg.AOI;
  const map = L.map('map', { zoomControl: true, attributionControl: true })
    .fitBounds([[s, w], [n, e]]);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, subdomains: 'abcd'
  }).addTo(map);

  /*
   * Stacking order. The basemap is an opaque dark layer in the default tilePane
   * (z-index 200), so anything sent behind it is invisible — the depth overlay
   * needs its own pane above it, and the kelp needs a pane above that. The demo
   * engine's canvas lives in Leaflet's overlayPane (400) and stays on top.
   */
  map.createPane('depth').style.zIndex = 250;
  map.createPane('contour').style.zIndex = 260;
  map.createPane('kelpPane').style.zIndex = 350;

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
   * ---- NOAA depth overlays ----
   * Two independent WMS layers, each in its own pane so they toggle separately
   * and always sit under the kelp.
   *
   * Turning a layer off hides its pane instead of calling map.removeLayer, which
   * would destroy the tile container and force a full refetch on the next toggle.
   * Hiding keeps the tiles in the DOM, so switching back is instant. Layers are
   * still created lazily, so an overlay the user never enables costs nothing.
   */
  const DEPTH_LAYERS = {
    relief:   { cfgKey: 'relief',   pane: 'depth',   label: 'NOAA depth relief', layer: null },
    contours: { cfgKey: 'contours', pane: 'contour', label: 'NOAA depth contours', layer: null }
  };

  function setDepthLayer(key, on) {
    const rec = DEPTH_LAYERS[key];
    const pane = map.getPane(rec.pane);
    if (!on) {
      if (rec.layer) pane.style.display = 'none';
      if (!depthEnabled()) hideProbe();   // nothing left to read a depth from
      say(rec.label + ' off');
      return;
    }
    pane.style.display = '';
    if (rec.layer) return;   // already built; tiles are still there

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
      layers: src.layers, format: 'image/png', transparent: true,
      version: '1.1.1', attribution: src.attribution, pane: rec.pane,
      opacity: state.params.depthOpacity
    }, cfg.DEPTH.tuning));
    rec.layer.on('load', () => done(rec.label + ' ready', 'ok'));
    rec.layer.on('tileerror', () => done(rec.label + ' — some tiles failed', 'warn'));
    rec.layer.addTo(map);
  }

  function setDepthOpacity(v) {
    state.params.depthOpacity = v;
    if (DEPTH_LAYERS.relief.layer) DEPTH_LAYERS.relief.layer.setOpacity(v);
  }

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

  const depthEnabled = () => state.params.showRelief || state.params.showContours;

  function moveProbe(ev) {
    const el = $('depth-probe');
    el.style.left = ev.clientX + 'px';
    el.style.top = ev.clientY + 'px';
  }
  function hideProbe() {
    $('depth-probe').className = 'depth-probe';
    clearTimeout(probeTimer);
    if (probeAbort) { probeAbort.abort(); probeAbort = null; }
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

  async function fetchDepth(latlng) {
    const key = latlng.lat.toFixed(4) + ',' + latlng.lng.toFixed(4);
    if (probeCache.has(key)) return probeCache.get(key);

    if (probeAbort) probeAbort.abort();
    probeAbort = new AbortController();
    const geom = JSON.stringify({ x: latlng.lng, y: latlng.lat, spatialReference: { wkid: 4326 } });
    const url = cfg.DEPTH.probe.url + '/identify?f=json&geometryType=esriGeometryPoint' +
                '&returnGeometry=false&returnCatalogItems=false&geometry=' + encodeURIComponent(geom);

    const res = await fetch(url, { signal: probeAbort.signal });
    if (!res.ok) throw new Error('identify ' + res.status);
    const json = await res.json();
    const v = parseFloat(json.value);            // "NoData" parses to NaN
    const metres = isFinite(v) ? v : null;
    if (probeCache.size > 800) probeCache.clear();
    probeCache.set(key, metres);
    return metres;
  }

  map.on('mousemove', (ev) => {
    if (!depthEnabled()) { hideProbe(); return; }
    moveProbe(ev.originalEvent);

    const key = ev.latlng.lat.toFixed(4) + ',' + ev.latlng.lng.toFixed(4);
    if (probeCache.has(key)) {           // already known — no network, no flicker
      clearTimeout(probeTimer);
      renderProbe(probeCache.get(key));
      return;
    }
    const el = $('depth-probe');
    el.className = 'depth-probe' + (el.textContent ? ' show pending' : '');

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

  function clearSceneCache() { rawScenes.clear(); filtScenes.clear(); }

  async function fetchAllScenes(start, end) {
    const key = start + '|' + end;
    if (rawScenes.has(key)) return rawScenes.get(key);
    say('Listing scenes ' + start + ' → ' + end + '…');
    busy(true);
    try {
      const list = await state.engine.listScenes(start, end, 100);
      rawScenes.set(key, list);
      say(list.length + ' pass' + (list.length === 1 ? '' : 'es') + ' in range', 'ok');
      return list;
    } finally { busy(false); }
  }

  function scenesAtCeiling(ceiling) {
    const [start, end] = dateRangeISO();
    const key = start + '|' + end + '|' + ceiling;
    if (filtScenes.has(key)) return filtScenes.get(key);
    const out = (state.allScenes || []).filter((s) => s.cloud <= ceiling);
    filtScenes.set(key, out);
    return out;
  }

  async function loadScenes() {
    const [start, end] = dateRangeISO();
    try { state.allScenes = await fetchAllScenes(start, end); }
    catch (err) {
      console.warn(err);
      state.allScenes = [];
      say('Scene listing failed — see console', 'warn');
      toast('Could not list scenes — check the console.', true);
    }
    applyCloudCeiling();
  }

  /*
   * Re-filter the cached scenes for the current ceiling and refresh everything
   * that depends on it. Keeps the user on the same date when that pass survives
   * the new ceiling, so nudging the slider doesn't jump them somewhere else.
   */
  function applyCloudCeiling(preferDate) {
    const was = state.scenes[state.idx] && state.scenes[state.idx].date;
    const want = preferDate || was;
    const scenes = scenesAtCeiling(state.params.maxCloud);
    state.scenes = scenes;

    if (!scenes.length) {
      state.idx = -1;
      $('date-big').textContent = '—';
      $('date-meta').textContent = 'no clear scenes';
      $('scrub-range').textContent = '0 scenes';
      renderTicks();
      renderCalendar();
      say('No passes at or under ' + state.params.maxCloud + '% cloud', 'warn');
      toast('No scenes under ' + state.params.maxCloud + '% cloud. Raise the ceiling.', true);
      clearLayer();
      return;
    }
    const at = want ? scenes.findIndex((s) => s.date === want) : -1;
    state.idx = at >= 0 ? at : scenes.length - 1;
    renderTicks();
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

  const ymd = (y, m, d) =>
    y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();
  const parseISO = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  function calOpen() { return !$('cal').hasAttribute('hidden'); }

  function renderCalendar() {
    if (!calOpen()) return;
    const grid = $('cal-grid');
    grid.textContent = '';

    // every pass in range, by date, whatever the ceiling
    const byDate = {};
    (state.allScenes || []).forEach((s) => { byDate[s.date] = s; });
    const selected = state.scenes[state.idx] && state.scenes[state.idx].date;
    const ceiling = state.params.maxCloud;

    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('cal-title').textContent = MONTHS[m] + ' ' + y;

    // Monday-first column offset
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < lead; i++) {
      const b = document.createElement('span');
      b.className = 'cal-day blank';
      grid.appendChild(b);
    }
    let usable = 0;
    for (let d = 1; d <= days; d++) {
      const date = ymd(y, m, d);
      const sc = byDate[date];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = d;
      if (!sc) {
        btn.className = 'cal-day';
        btn.disabled = true;
      } else if (sc.cloud > ceiling) {
        btn.className = 'cal-day over';
        btn.disabled = true;      // only ceiling-passing dates are clickable
        btn.title = date + ' · ' + pct(sc.cloud) + '% cloud — above the ceiling';
      } else {
        usable++;
        btn.className = 'cal-day has' + (date === selected ? ' sel' : '');
        btn.title = date + ' · ' + pct(sc.cloud) + '% cloud';
        btn.addEventListener('click', () => pickDate(date));
      }
      grid.appendChild(btn);
    }

    const [rs, re] = dateRangeISO();
    $('cal-prev').disabled = monthKey(calMonth) <= monthKey(parseISO(rs));
    $('cal-next').disabled = monthKey(calMonth) >= monthKey(parseISO(re));
    $('cal-note').textContent = usable
      ? usable + ' selectable pass' + (usable === 1 ? '' : 'es') + ' this month'
      : 'No passes this month under ' + ceiling + '% cloud';
    $('cal-cloud').value = ceiling;
    $('cal-cloud-val').textContent = ceiling + '%';
  }

  function pickDate(date) {
    const at = state.scenes.findIndex((s) => s.date === date);
    if (at < 0) return;
    if (state.params.mode !== 'single') setMode('single');
    state.idx = at;
    updateDate(); renderTicks();
    setCalendar(false);
    run();
  }

  function setCalendar(on) {
    const cal = $('cal');
    if (on) {
      const sel = state.scenes[state.idx];
      const [rs] = dateRangeISO();
      calMonth = parseISO(sel ? sel.date : rs);
      calMonth.setDate(1);
      cal.removeAttribute('hidden');
      $('date-big').setAttribute('aria-expanded', 'true');
      renderCalendar();
    } else {
      cal.setAttribute('hidden', '');
      $('date-big').setAttribute('aria-expanded', 'false');
    }
  }

  function shiftMonth(delta) {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
    renderCalendar();
  }

  $('date-big').addEventListener('click', () => setCalendar(!calOpen()));
  $('cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('cal-next').addEventListener('click', () => shiftMonth(1));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && calOpen()) setCalendar(false);
  });
  document.addEventListener('click', (ev) => {
    if (!calOpen()) return;
    if ($('cal').contains(ev.target) || $('date-big').contains(ev.target)) return;
    setCalendar(false);
  });

  function renderTicks() {
    const box = $('ticks');
    box.querySelectorAll('.tick').forEach((t) => t.remove());
    const nS = state.scenes.length;
    $('scrub-range').textContent = nS + (nS === 1 ? ' scene' : ' scenes');
    state.scenes.forEach((sc, i) => {
      const tick = document.createElement('button');
      tick.className = 'tick' + (i === state.idx ? ' active' : '');
      tick.style.left = (nS === 1 ? 50 : (i / (nS - 1)) * 100) + '%';
      tick.title = sc.date + ' · ' + pct(sc.cloud) + '% cloud';
      tick.setAttribute('aria-label', 'Scene ' + sc.date);
      tick.addEventListener('click', () => {
        if (state.params.mode !== 'single') setMode('single');
        state.idx = i; updateDate(); renderTicks(); run();
      });
      box.appendChild(tick);
    });
  }

  function updateDate() {
    const sc = state.scenes[state.idx];
    if (!sc) return;
    if (state.params.mode === 'composite') {
      $('date-big').textContent = 'Composite';
      $('date-meta').textContent = state.scenes[0].date + ' → ' + state.scenes[state.scenes.length - 1].date;
    } else {
      $('date-big').textContent = sc.date;
      $('date-meta').textContent = pct(sc.cloud) + '% cloud · ' + (state.idx + 1) + '/' + state.scenes.length;
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
      clearLayer();
      let layer;
      if (composite) {
        const [start, end] = dateRangeISO();
        const res = await state.engine.compositeLayer(start, end, state.params.maxCloud, state.params);
        layer = toLeafletLayer(res);
      } else {
        const res = await state.engine.singleSceneLayer(state.scenes[state.idx].date, state.params);
        layer = toLeafletLayer(res);
      }
      state.layer = layer;
      layer.addTo(map);
      if (layer.setOpacity) layer.setOpacity(state.params.opacity);
      // Earth Engine returns tiles that stream in; the demo layer draws immediately.
      if (layer.on && layer.getContainer) {
        let announced = false;
        layer.on('load', () => { if (!announced) { announced = true; say('Kelp tiles rendered', 'ok'); } });
      } else {
        say('Kelp layer drawn', 'ok');
      }
    } catch (err) {
      console.warn(err);
      say('Kelp computation failed — see console', 'warn');
      toast('Kelp computation failed — see console.', true);
    } finally {
      busy(false);
      setTimeout(() => sweep(false), 350);
    }
  }

  // Engines return either a tile-URL template (Earth Engine) or a Leaflet layer (demo).
  function toLeafletLayer(res) {
    if (typeof res === 'string') {
      return L.tileLayer(res, { opacity: state.params.opacity, maxZoom: 19, pane: 'kelpPane' });
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
    if (applyIndex(kind)) run();
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
    updateDate(); renderTicks(); run();
    return true;
  }
  $('prev').addEventListener('click', () => stepScene(-1));
  $('next').addEventListener('click', () => stepScene(1));

  /*
   * Left/right arrows step through scenes. Skipped while a form control has
   * focus, since sliders and date inputs use the arrow keys themselves.
   */
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const el = document.activeElement;
    if (el && (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName) || el.isContentEditable)) return;
    if (stepScene(ev.key === 'ArrowLeft' ? -1 : 1)) ev.preventDefault();
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
  function setCloudCeiling(v, quiet) {
    state.params.maxCloud = +v;
    $('cloud').value = v; $('cloud-val').textContent = v + '%';
    $('cal-cloud').value = v; $('cal-cloud-val').textContent = v + '%';
    if (!quiet) applyCloudCeiling();
  }
  $('cloud').addEventListener('input', (ev) => setCloudCeiling(ev.target.value));
  $('cal-cloud').addEventListener('input', (ev) => setCloudCeiling(ev.target.value));
  bindSlider('kelp', 'kelp-val', fmtIndex,
    (v) => (state.params.kelpThresh = +v), () => run());
  bindSlider('b11', 'b11-val', (v) => (+v).toFixed(3),
    (v) => (state.params.b11Thresh = +v), () => run());
  bindSlider('opacity', 'op-val', (v) => Math.round(v * 100) + '%',
    (v) => {
      state.params.opacity = +v;
      if (state.layer && state.layer.setOpacity) state.layer.setOpacity(+v);
      if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    }, () => run());

  // ---- date range ----
  function showRange() {
    $('date-start').value = state.range.start;
    $('date-end').value = state.range.end;
  }
  function applyRange(start, end) {
    if (!start || !end) { showRange(); return; }
    if (start > end) {
      toast('Start date is after the end date.', true);
      showRange();   // put the inputs back to the window we're actually showing
      return;
    }
    state.range.start = start;
    state.range.end = end;
    showRange();
    setCalendar(false);  // its month may fall outside the new window
    state.idx = -1;      // the old scene index means nothing in a new window
    loadScenes();
  }
  $('date-start').addEventListener('change', () => applyRange($('date-start').value, state.range.end));
  $('date-end').addEventListener('change', () => applyRange(state.range.start, $('date-end').value));
  $('range-reset').addEventListener('click', () => applyRange.apply(null, defaultRange()));

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

  $('run').addEventListener('click', run);

  // ---- Earth Engine connect ----
  $('connect').addEventListener('click', async () => {
    if (!cfg.CLIENT_ID || cfg.CLIENT_ID.indexOf('<') === 0) {
      toast('Add your OAuth client ID and project in js/config.js first.', true);
      return;
    }
    if (typeof ee === 'undefined') { toast('Earth Engine library did not load.', true); return; }
    toast('Opening Google sign-in…');
    try {
      const ok = await KelpEngine.login();
      if (ok) { activateEngine(KelpEngine); toast('Connected to Earth Engine — live imagery.'); }
      else toast('Sign-in did not complete.', true);
    } catch (err) { console.warn(err); toast('Sign-in failed — see console.', true); }
  });

  function activateEngine(engine) {
    state.engine = engine;
    const live = engine.name === 'earth-engine';
    $('status').className = 'status ' + (live ? 'is-live' : 'is-demo');
    $('status-label').textContent = live ? 'LIVE · SENTINEL-2' : 'DEMO DATA';
    $('connect').style.display = live ? 'none' : '';
    clearSceneCache();   // demo and live scene lists are not interchangeable
    state.scenes = []; state.allScenes = [];
    state.idx = -1;
    loadScenes();
  }

  // ---- boot ----
  (async function boot() {
    // Point the controls at whichever index config.js defaults to, so the slider
    // scale and the published threshold always agree.
    applyIndex(state.params.indexType);
    $('b11').value = state.params.b11Thresh;
    $('b11-val').textContent = state.params.b11Thresh.toFixed(3);

    const [rs, re] = defaultRange();
    state.range.start = rs; state.range.end = re;
    $('date-start').value = rs; $('date-end').value = re;

    setCloudCeiling(state.params.maxCloud, true);   // sync both sliders, no refilter yet

    $('depth-op').value = state.params.depthOpacity;
    $('depth-op-val').textContent = Math.round(state.params.depthOpacity * 100) + '%';
    $('relief').checked = !!state.params.showRelief;
    $('contours').checked = !!state.params.showContours;
    if (state.params.showRelief) setDepthLayer('relief', true);
    if (state.params.showContours) setDepthLayer('contours', true);

    say('Starting up…');
    let engine = DemoEngine;
    try {
      busy(true);
      const live = await KelpEngine.init(cfg);
      if (live) engine = KelpEngine;
    } catch (err) { console.warn('EE init skipped:', err); }
    finally { busy(false); }
    say(engine === DemoEngine ? 'Demo mode — synthetic kelp' : 'Earth Engine connected — live Sentinel-2', 'ok');
    if (engine === DemoEngine) await DemoEngine.init(cfg, L);
    activateEngine(engine);
    if (engine === DemoEngine && !(cfg.CLIENT_ID.indexOf('<') === 0)) {
      // creds present but silent auth failed → offer popup
      toast('Sign in with the Connect button to load live imagery.');
    }
  })();
})();
