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
  function renderProbe(result) {
    const el = $('depth-probe');
    const metres = result && result.metres;
    el.textContent = '';
    const main = document.createElement('span');
    const sub = document.createElement('span');
    sub.className = 'dp-sub';
    if (!result || metres === null || metres === undefined) {
      main.textContent = '—';
      sub.textContent = 'no data';
    } else {
      const ft = Math.round(Math.abs(metres) * M_TO_FT);
      main.textContent = ft.toLocaleString() + ' ft';
      // flag the 0.2 m survey grids — they only cover a few percent of the coast
      sub.textContent = (metres < 0 ? 'depth' : 'elev.') + (result.fine ? ' · survey' : '');
    }
    el.appendChild(main); el.appendChild(sub);
    el.className = 'depth-probe show';
  }

  async function fetchDepth(latlng) {
    const key = latlng.lat.toFixed(4) + ',' + latlng.lng.toFixed(4);
    if (probeCache.has(key)) return probeCache.get(key);

    if (probeAbort) probeAbort.abort();
    probeAbort = new AbortController();
    // DemSampler queries the survey grid and the mosaic together and reports
    // which answered, so the readout can mark the high-resolution hits.
    const result = await DemSampler.identify(latlng.lat, latlng.lng, probeAbort.signal);
    if (probeCache.size > 800) probeCache.clear();
    probeCache.set(key, result);
    return result;
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
   * index of every pass we have ever heard about, filled in a month at a time as
   * the user navigates. Without this, browsing to a month outside the window
   * showed no passes at all — not because there were none, but because nothing
   * had ever asked for them.
   */
  const sceneIndex = new Map();   // 'YYYY-MM-DD' -> {date, cloud}
  const loadedMonths = new Map(); // 'YYYY-MM'    -> true once fetched

  function mergeScenes(list) {
    (list || []).forEach((s) => {
      const cur = sceneIndex.get(s.date);
      if (!cur || s.cloud < cur.cloud) sceneIndex.set(s.date, s);   // keep the clearest
    });
  }

  // Pull a month's passes on demand, then redraw. Fire-and-forget by design:
  // the calendar renders immediately with whatever is known and fills in after.
  async function ensureMonth(y, m) {
    const key = y + '-' + String(m + 1).padStart(2, '0');
    if (loadedMonths.has(key)) return;
    loadedMonths.set(key, true);
    const last = new Date(y, m + 1, 0).getDate();
    try {
      const list = await state.engine.listScenes(ymd(y, m, 1), ymd(y, m, last), 100);
      mergeScenes(list);
      renderCalendar();
    } catch (err) {
      loadedMonths.delete(key);         // let it retry next time
      console.warn(err);
    }
  }

  function clearSceneCache() {
    rawScenes.clear(); filtScenes.clear();
    sceneIndex.clear(); loadedMonths.clear();
  }

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
    const want = preferDate || pendingPick || was;
    pendingPick = null;
    const scenes = scenesAtCeiling(state.params.maxCloud);
    state.scenes = scenes;

    if (!scenes.length) {
      state.idx = -1;
      $('date-big').textContent = '—';
      $('date-meta').textContent = 'no clear scenes';
      renderCalendar();
      say('No passes at or under ' + state.params.maxCloud + '% cloud', 'warn');
      toast('No scenes under ' + state.params.maxCloud + '% cloud. Raise the ceiling.', true);
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
    ensureMonth(y, m);      // fills in and redraws if this month is new to us

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
          (date === rs || date === re ? ' sel' : (sc && sc.cloud <= ceiling ? ' has' : ''));
        btn.title = 'Set the range ' + calMode + ' to ' + date;
        btn.addEventListener('click', () => setRangeEdge(date));
      } else if (!sc) {
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
   * Setting one edge advances to the other, so the natural flow after opening the
   * picker is: click a start, click an end, done. Setting the end drops back to
   * scene picking. Picking a start also pushes the end out if it would otherwise
   * be left behind, so the intermediate state is never invalid.
   */
  function setRangeEdge(date) {
    const [rs, re] = dateRangeISO();
    const next = calMode === 'start'
      ? [date, date > re ? date : re]
      : [date < rs ? date : rs, date];
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
      applyRange(date < rs ? date : rs, date > re ? date : re, true);
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
      calMode = 'start';                 // opens armed to set the range start
      calMonth = parseISO(sel ? sel.date : rs);
      calMonth.setDate(1);
      cal.removeAttribute('hidden');
      $('date-big').setAttribute('aria-expanded', 'true');
      renderCalendar();
    } else {
      calMode = 'scene';
      cal.setAttribute('hidden', '');
      setYearList(false);
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
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && calOpen()) setCalendar(false);
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
      setDirty(false);        // whatever just rendered now matches the settings
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
  bindSlider('opacity', 'op-val', (v) => Math.round(v * 100) + '%',
    (v) => {
      state.params.opacity = +v;
      if (state.layer && state.layer.setOpacity) state.layer.setOpacity(+v);
      if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    }, () => run());

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

  // ---- custom contours ----
  function renderContourTiles() {
    const box = $('cc-list');
    box.textContent = '';
    CustomContours.items.forEach((it) => {
      const tile = document.createElement('div');
      tile.className = 'cc-tile';

      const sw = document.createElement('span');
      sw.className = 'cc-swatch';
      sw.style.background = it.color;

      const label = document.createElement('span');
      label.textContent = Math.abs(it.feet) + ' ft';

      const cog = document.createElement('button');
      cog.className = 'cc-cog';
      cog.type = 'button';
      cog.textContent = '⚙';
      cog.title = 'Settings';

      const menu = document.createElement('div');
      menu.className = 'cc-menu';
      menu.hidden = true;

      const color = document.createElement('input');
      color.type = 'color';
      color.value = it.color;
      color.title = 'Contour colour';
      // 'change', not 'input': commit on release rather than restyling on every
      // pixel the user drags through the picker
      color.addEventListener('change', () => {
        CustomContours.setColor(it.id, color.value);
        sw.style.background = color.value;
      });

      const rm = document.createElement('button');
      rm.className = 'cc-remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove this contour';
      rm.addEventListener('click', () => {
        CustomContours.remove(it.id);
        renderContourTiles();
        say(Math.abs(it.feet) + ' ft contour removed');
      });

      cog.addEventListener('click', () => {
        // one menu at a time
        box.querySelectorAll('.cc-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      });

      menu.appendChild(color); menu.appendChild(rm);
      tile.appendChild(sw); tile.appendChild(label); tile.appendChild(cog); tile.appendChild(menu);
      box.appendChild(tile);
    });
  }

  function addContour() {
    const raw = parseFloat($('cc-depth').value);
    if (!isFinite(raw)) { toast('Enter a depth in feet first.', true); return; }
    const it = CustomContours.add(raw);
    if (!it) return;
    $('cc-depth').value = '';
    renderContourTiles();
    say('Tracing the ' + Math.abs(it.feet) + ' ft contour…');
  }
  $('cc-add').addEventListener('click', addContour);
  $('cc-depth').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addContour(); }
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('.cc-tile')) return;
    $('cc-list').querySelectorAll('.cc-menu').forEach((m) => { m.hidden = true; });
  });

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

  function unitSelect(kind, current, onPick) {
    const sel = document.createElement('select');
    sel.className = 'pp-units';
    sel.title = kind === 'dist' ? 'Distance units' : 'Depth units';
    Object.keys(kind === 'dist' ? DIST_UNITS : DEPTH_UNITS).forEach((k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = k;
      if (k === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  }

  // ---- paths panel ----
  // Depth-vs-distance sparkline. Depth increases downward, which is the way a
  // profile is conventionally read.
  function profileSvg(p) {
    const pts = (p.profile || []).filter((s) => s.feet !== null);
    if (pts.length < 2) return null;
    const W = 240, H = 62, PADL = 26, PADB = 12, PADT = 4;
    const maxD = Math.max.apply(null, pts.map((s) => -s.feet));
    const maxX = pts[pts.length - 1].distance || 1;
    const x = (d) => PADL + (W - PADL - 4) * (d / maxX);
    const y = (ft) => PADT + (H - PADT - PADB) * (ft / (maxD || 1));

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');

    const area = document.createElementNS(NS, 'path');
    let d = 'M' + x(0) + ',' + y(0);
    pts.forEach((s) => { d += 'L' + x(s.distance).toFixed(1) + ',' + y(-s.feet).toFixed(1); });
    d += 'L' + x(maxX) + ',' + y(0) + 'Z';
    area.setAttribute('d', d);
    area.setAttribute('fill', p.color);
    area.setAttribute('fill-opacity', '0.22');
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.map((s) => x(s.distance).toFixed(1) + ',' + y(-s.feet).toFixed(1)).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', p.color);
    line.setAttribute('stroke-width', '1.4');
    svg.appendChild(line);

    [[0, '0'], [maxD, fmtDepth(maxD)]].forEach(([v, label], i) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'pp-axis');
      t.setAttribute('x', '2');
      t.setAttribute('y', (i === 0 ? y(0) + 3 : y(maxD)));
      t.textContent = label;
      svg.appendChild(t);
    });
    const dist = document.createElementNS(NS, 'text');
    dist.setAttribute('class', 'pp-axis');
    dist.setAttribute('x', W - 4); dist.setAttribute('y', H - 2);
    dist.setAttribute('text-anchor', 'end');
    dist.textContent = fmtDist(maxX);
    svg.appendChild(dist);

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
      readout.textContent = fmtDepth(-s.feet) + ' @ ' + fmtDist(s.distance);
      Paths.hoverAt(p.id, s);
    });
    svg.addEventListener('mouseleave', () => {
      guide.setAttribute('opacity', '0');
      readout.setAttribute('opacity', '0');
      Paths.hoverOff();
    });
    return svg;
  }

  function renderPaths() {
    const box = $('pp-list');
    box.textContent = '';
    const list = Paths.list;
    $('pp-add').setAttribute('aria-pressed', Paths.drawing ? 'true' : 'false');
    $('pp-add').textContent = Paths.drawing ? '✓' : '+';
    $('pp-add').title = Paths.drawing ? 'Finish this path' : 'Draw a new path';
    $('pp-save').disabled = !Paths.selectedId;
    $('pp-note').textContent = !list.length
      ? 'No paths yet — press + and click the map.'
      : (Paths.drawing ? 'Click the map to add nodes. Esc or ✓ to finish.'
                       : 'Drag a node to move it; right-click a node to delete it.');

    list.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'pp-item' + (p.id === Paths.selectedId ? ' sel' : '');

      const row = document.createElement('div');
      row.className = 'pp-row';
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.pp-cog, .pp-menu, .pp-caret, .pp-pencil')) return;
        Paths.select(p.id);
      });

      const sw = document.createElement('span');
      sw.className = 'pp-swatch'; sw.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'pp-name'; name.textContent = p.name;

      // rename in place; the name is also the export filename
      const pencil = document.createElement('button');
      pencil.className = 'pp-pencil'; pencil.type = 'button';
      pencil.textContent = '✎'; pencil.title = 'Rename this path';
      pencil.addEventListener('click', () => {
        const next = window.prompt('Rename path', p.name);
        if (next === null) return;
        const clean = next.trim();
        if (!clean) { toast('A path needs a name.', true); return; }
        Paths.rename(p.id, clean);
        say('Renamed to ' + clean);
      });

      const meta = document.createElement('span');
      meta.className = 'pp-meta';
      meta.textContent = p.nodes.length + 'n · ' + fmtDist(Paths.lengthOf(p));

      const caret = document.createElement('button');
      caret.className = 'pp-caret'; caret.type = 'button';
      caret.textContent = p.expanded ? '▾' : '▸';
      caret.title = p.expanded ? 'Collapse' : 'Show depth profile';
      caret.addEventListener('click', () => Paths.toggleExpand(p.id));

      const cog = document.createElement('button');
      cog.className = 'pp-cog'; cog.type = 'button'; cog.textContent = '⚙'; cog.title = 'Settings';

      const menu = document.createElement('div');
      menu.className = 'pp-menu'; menu.hidden = true;
      const color = document.createElement('input');
      color.type = 'color'; color.value = p.color; color.title = 'Path colour';
      color.addEventListener('change', () => { Paths.setColor(p.id, color.value); });
      const del = document.createElement('button');
      del.className = 'pp-del'; del.type = 'button'; del.textContent = '×'; del.title = 'Delete path';
      del.addEventListener('click', () => { Paths.remove(p.id); say(p.name + ' deleted'); });
      const du = unitSelect('dist', state.params.distUnit, (v) => {
        state.params.distUnit = v; renderPaths();
      });
      const zu = unitSelect('depth', state.params.depthUnit, (v) => {
        state.params.depthUnit = v; renderPaths();
      });
      menu.appendChild(color); menu.appendChild(du); menu.appendChild(zu); menu.appendChild(del);
      cog.addEventListener('click', () => {
        box.querySelectorAll('.pp-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      });

      row.appendChild(sw); row.appendChild(name); row.appendChild(pencil);
      row.appendChild(meta); row.appendChild(caret); row.appendChild(cog);
      item.appendChild(row); item.appendChild(menu);

      if (p.expanded) {
        const wrap = document.createElement('div');
        wrap.className = 'pp-profile';
        const svg = profileSvg(p);
        if (svg) wrap.appendChild(svg);
        else {
          const t = document.createElement('div');
          t.className = 'hint';
          t.textContent = p.nodes.length < 2 ? 'Add at least two nodes.' : 'Reading depth…';
          wrap.appendChild(t);
        }
        item.appendChild(wrap);
      }
      box.appendChild(item);
    });
  }

  /*
   * Corner resizing. CSS `resize` only ever gives you the bottom-right, so the
   * other three corners are done by hand. The panel is anchored top-right, so on
   * the first drag it is pinned to explicit left/top and the anchor dropped —
   * otherwise dragging a west or north edge would fight the anchor.
   */
  (function initPanelChrome() {
    const panel = document.querySelector('.paths-panel');
    const MIN_W = 240, MIN_H = 120;
    let drag = null;

    // Anything that does its own thing on a press is not a drag handle.
    const INTERACTIVE = 'button, input, select, textarea, a, svg, .pp-grip, .pp-row, .pp-menu';

    // Switch from the top-right anchor to explicit left/top on the first
    // interaction; otherwise moving or resizing a west/north edge fights it.
    function unpin() {
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      return r;
    }

    function onMove(ev) {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;

      if (drag.corner) {
        const west = drag.corner === 'nw' || drag.corner === 'sw';
        const north = drag.corner === 'nw' || drag.corner === 'ne';
        const w = Math.max(MIN_W, Math.min(window.innerWidth * 0.7, drag.w + (west ? -dx : dx)));
        const h = Math.max(MIN_H, Math.min(window.innerHeight * 0.8, drag.h + (north ? -dy : dy)));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
        if (west) panel.style.left = (drag.left + (drag.w - w)) + 'px';
        if (north) panel.style.top = (drag.top + (drag.h - h)) + 'px';
      } else {
        // Keep a grabbable strip on screen rather than allowing it to be lost.
        const maxL = window.innerWidth - 60, maxT = window.innerHeight - 40;
        panel.style.left = Math.max(60 - drag.w, Math.min(maxL, drag.left + dx)) + 'px';
        panel.style.top = Math.max(0, Math.min(maxT, drag.top + dy)) + 'px';
      }
      ev.preventDefault();
    }

    function onUp() {
      drag = null;
      panel.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    function begin(ev, corner) {
      const r = unpin();
      drag = { x: ev.clientX, y: ev.clientY, w: r.width, h: r.height,
               left: r.left, top: r.top, corner: corner };
      panel.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      ev.preventDefault();
    }

    panel.querySelectorAll('.pp-grip').forEach((grip) => {
      grip.addEventListener('pointerdown', (ev) => begin(ev, grip.dataset.corner));
    });

    // Drag from any background area — the padding, the header bar behind its
    // buttons, the note, the gaps between path rows.
    panel.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(INTERACTIVE)) return;
      begin(ev, null);
    });
  })();

  $('pp-add').addEventListener('click', () => {
    if (Paths.drawing) Paths.finishDrawing(); else Paths.startDrawing();
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
    if (typeof ee === 'undefined') { toast('Earth Engine library did not load.', true); return; }

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
    showRange();

    setCloudCeiling(state.params.maxCloud, true);   // sync both sliders, no refilter yet
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
    renderPaths();

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
      } else if (await ApiKelpEngine.init(cfg)) {
        engine = ApiKelpEngine;
      }
    } catch (err) { console.warn('engine probe skipped:', err); }
    finally { busy(false); }

    say(engine === KelpEngine ? 'Signed in — using your Earth Engine account'
      : engine === ApiKelpEngine ? 'Live Sentinel-2 via the shared backend — sign in to use your own quota'
      : 'Demo mode — synthetic kelp', 'ok');
    if (engine === DemoEngine) await DemoEngine.init(cfg, L);
    activateEngine(engine);
    if (engine === DemoEngine && !(cfg.CLIENT_ID.indexOf('<') === 0)) {
      // creds present but silent auth failed → offer popup
      toast('Sign in with the Connect button to load live imagery.');
    }
  })();
})();
