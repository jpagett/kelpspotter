/* KelpSpotter app wiring. Talks to whichever engine is available
   (KelpEngine when Earth Engine is connected, else DemoEngine) through
   one shared interface: listScenes / singleSceneLayer / compositeLayer. */
(function () {
  const cfg = window.KELP_CONFIG;
  const $ = (id) => document.getElementById(id);

  const state = {
    engine: null,
    scenes: [],
    idx: -1,
    layer: null,
    params: Object.assign({}, cfg.DEFAULTS)
  };

  // ---- map ----
  const [w, s, e, n] = cfg.AOI;
  const map = L.map('map', { zoomControl: true, attributionControl: true })
    .fitBounds([[s, w], [n, e]]);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, subdomains: 'abcd'
  }).addTo(map);

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

  function dateRangeISO() {
    const end = new Date(Date.now() + 86400000);
    const start = new Date(Date.now() - cfg.LOOKBACK_DAYS * 86400000);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  }

  // ---- scenes + scrubber ----
  async function loadScenes() {
    const [start, end] = dateRangeISO();
    let scenes = [];
    try { scenes = await state.engine.listScenes(start, end, state.params.maxCloud); }
    catch (err) { console.warn(err); toast('Could not list scenes — check the console.', true); }
    state.scenes = scenes;
    if (!scenes.length) {
      state.idx = -1;
      $('date-big').textContent = '—';
      $('date-meta').textContent = 'no clear scenes';
      $('scrub-range').textContent = '0 scenes';
      renderTicks();
      toast('No scenes under ' + state.params.maxCloud + '% cloud. Raise the ceiling.', true);
      clearLayer();
      return;
    }
    if (state.idx < 0 || state.idx >= scenes.length) state.idx = scenes.length - 1;
    renderTicks();
    updateDate();
    run();
  }

  function renderTicks() {
    const box = $('ticks');
    box.querySelectorAll('.tick').forEach((t) => t.remove());
    const nS = state.scenes.length;
    $('scrub-range').textContent = nS + (nS === 1 ? ' scene' : ' scenes');
    state.scenes.forEach((sc, i) => {
      const tick = document.createElement('button');
      tick.className = 'tick' + (i === state.idx ? ' active' : '');
      tick.style.left = (nS === 1 ? 50 : (i / (nS - 1)) * 100) + '%';
      tick.title = sc.date + ' · ' + sc.cloud + '% cloud';
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
      $('date-meta').textContent = sc.cloud + '% cloud · ' + (state.idx + 1) + '/' + state.scenes.length;
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
    sweep(true);
    try {
      clearLayer();
      let layer;
      if (state.params.mode === 'composite') {
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
    } catch (err) {
      console.warn(err);
      toast('Kelp computation failed — see console.', true);
    } finally {
      setTimeout(() => sweep(false), 350);
    }
  }

  // Engines return either a tile-URL template (Earth Engine) or a Leaflet layer (demo).
  function toLeafletLayer(res) {
    if (typeof res === 'string') {
      return L.tileLayer(res, { opacity: state.params.opacity, maxZoom: 19 });
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
  function setIndex(kind) {
    state.params.indexType = kind;
    $('idx-ndvi').setAttribute('aria-pressed', kind === 'NDVI');
    $('idx-fai').setAttribute('aria-pressed', kind === 'FAI');
    $('idx-hint').textContent = kind === 'FAI'
      ? 'FAI: floating-algae index, tolerant of sun glint.'
      : 'NDVI: canopy vs. dark water. Simple and robust.';
    // sensible default threshold per index scale
    const def = kind === 'FAI' ? 0.02 : 0.10;
    $('kelp').value = def; state.params.kelpThresh = def; $('kelp-val').textContent = def.toFixed(2);
    run();
  }

  $('mode-single').addEventListener('click', () => setMode('single'));
  $('mode-composite').addEventListener('click', () => setMode('composite'));
  $('idx-ndvi').addEventListener('click', () => setIndex('NDVI'));
  $('idx-fai').addEventListener('click', () => setIndex('FAI'));

  $('prev').addEventListener('click', () => { if (state.idx > 0) { state.idx--; updateDate(); renderTicks(); run(); } });
  $('next').addEventListener('click', () => { if (state.idx < state.scenes.length - 1) { state.idx++; updateDate(); renderTicks(); run(); } });

  // sliders: label live, act on release ('change')
  function bindSlider(id, valId, fmt, apply, onChange) {
    const el = $(id);
    el.addEventListener('input', () => { $(valId).textContent = fmt(el.value); apply(el.value); });
    el.addEventListener('change', onChange);
  }
  bindSlider('cloud', 'cloud-val', (v) => v + '%',
    (v) => (state.params.maxCloud = +v), () => loadScenes());
  bindSlider('kelp', 'kelp-val', (v) => (+v).toFixed(2),
    (v) => (state.params.kelpThresh = +v), () => run());
  bindSlider('water', 'water-val', (v) => (+v).toFixed(2),
    (v) => (state.params.waterThresh = +v), () => run());
  bindSlider('opacity', 'op-val', (v) => Math.round(v * 100) + '%',
    (v) => {
      state.params.opacity = +v;
      if (state.layer && state.layer.setOpacity) state.layer.setOpacity(+v);
      if (state.layer && state.layer.setParams) state.layer.setParams(state.params);
    }, () => run());

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
    state.idx = -1;
    loadScenes();
  }

  // ---- boot ----
  (async function boot() {
    let engine = DemoEngine;
    try {
      const live = await KelpEngine.init(cfg);
      if (live) engine = KelpEngine;
    } catch (err) { console.warn('EE init skipped:', err); }
    if (engine === DemoEngine) await DemoEngine.init(cfg, L);
    activateEngine(engine);
    if (engine === DemoEngine && !(cfg.CLIENT_ID.indexOf('<') === 0)) {
      // creds present but silent auth failed → offer popup
      toast('Sign in with the Connect button to load live imagery.');
    }
  })();
})();
