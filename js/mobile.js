/*
 * Mobile shell — the tab bar and bottom sheets.
 *
 * The layout itself is CSS (see the MOBILE SHELL block in css/styles.css); this
 * file only holds the state that CSS cannot: which sheet is open, and the
 * handful of desktop interactions that have no touch equivalent.
 *
 * Deliberately does not move any DOM. The panels stay where they are, so every
 * handler in app.js keeps working and desktop is entirely unaffected.
 */
(function () {
  const MOBILE = '(max-width: 820px)';
  const mq = window.matchMedia(MOBILE);
  const $ = (id) => document.getElementById(id);
  const bar = $('tabbar');
  if (!bar) return;

  const SHEETS = {
    console: '.console',
    paths: '.paths-panel',
    legend: '.legend',
    poi: '.poi-panel',
    activity: '.activity'
  };

  /* ---------------------------------------------------------------- sheets */

  function openSheet(name) {
    const current = document.body.dataset.sheet || '';
    const next = current === name ? '' : name;
    if (next) {
      const panel = document.querySelector(SHEETS[next]);
      if (panel) {
        /*
         * A sheet the user just asked for must actually be usable, whatever
         * state the desktop controls left it in: the View menu may have hidden
         * it, and its own header may have collapsed it.
         */
        panel.classList.remove('view-hidden');
        panel.classList.remove('collapsed');
        panel.scrollTop = 0;
      }
    }
    document.body.dataset.sheet = next;
    bar.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-pressed', t.dataset.sheet === next ? 'true' : 'false');
    });
  }

  bar.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => openSheet(tab.dataset.sheet));
  });

  // The map is the hero: touching it dismisses whatever is open.
  const mapEl = $('map');
  if (mapEl) {
    mapEl.addEventListener('pointerdown', () => {
      if (mq.matches && document.body.dataset.sheet) openSheet(document.body.dataset.sheet);
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.dataset.sheet) {
      openSheet(document.body.dataset.sheet);
    }
  });

  /* ------------------------------------------------------- entering mobile */

  /*
   * Panel dragging and edge-resizing write inline left/top/width/height. Those
   * beat any stylesheet, so a panel dragged on desktop would land somewhere
   * arbitrary once the viewport narrows. Clear them on the way in.
   */
  function stripInlineGeometry() {
    Object.keys(SHEETS).forEach((k) => {
      const el = document.querySelector(SHEETS[k]);
      if (!el) return;
      ['left', 'top', 'right', 'bottom', 'width', 'height'].forEach((p) => {
        el.style.removeProperty(p);
      });
    });
  }

  function applyMode() {
    if (mq.matches) {
      stripInlineGeometry();
      document.documentElement.style.setProperty('--dock-w', '0px');  // no side dock on a phone
    } else {
      document.body.dataset.sheet = '';
      bar.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', 'false'));
    }
    // Leaflet re-reads its container on window resize; the map box just changed.
    window.dispatchEvent(new Event('resize'));
  }

  mq.addEventListener('change', applyMode);
  applyMode();

  /* --------------------------------------------------- draw a path on the map
   * The desktop control for this is the Paths panel's + button, which lives
   * behind a tab on a phone — too far away when the thing you are drawing on is
   * the map. This is the same Paths.startDrawing(), surfaced as a map control.
   */
  const drawBtn = $('map-draw-path');
  if (drawBtn && window.Paths) {
    /*
     * Inline SVG rather than a glyph: the arrow characters available all carry
     * a lot of built-in side bearing, so the mark ended up small and floating
     * in the middle of the button. Drawing it lets the zigzag run edge to edge.
     */
    const ZIGZAG = '<svg viewBox="0 0 22 22" aria-hidden="true">' +
      '<polyline points="2,17 7.5,8.5 12,15 17,5.5"/>' +
      '<polyline points="12.6,6.6 17.4,5.2 18.6,10"/></svg>';
    const CHECK = '<svg viewBox="0 0 22 22" aria-hidden="true">' +
      '<polyline points="4,12 9,17 18,5"/></svg>';
    const syncDraw = () => {
      const on = Paths.drawing;
      drawBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      drawBtn.innerHTML = on ? CHECK : ZIGZAG;
      drawBtn.title = on ? 'Finish this path' : 'Draw a path';
    };
    drawBtn.addEventListener('click', () => {
      if (Paths.drawing) Paths.finishDrawing(); else Paths.startDrawing();
      // Drawing needs the map, so make sure no sheet is covering it.
      if (document.body.dataset.sheet) openSheet(document.body.dataset.sheet);
      syncDraw();
    });
    // Finishing can also happen from Esc or the panel; keep the button honest.
    document.addEventListener('click', syncDraw, true);
    document.addEventListener('keydown', () => setTimeout(syncDraw, 0));
    syncDraw();
  }

  /* ------------------------------------------------ swipe a sheet closed
   * A downward drag on the top strip of an open sheet dismisses it — the
   * gesture every bottom sheet teaches. Limited to the top 34px (the grab-
   * handle zone) so it never fights the sheet's own scrolling, and to a
   * mostly-vertical 48px travel so a horizontal fidget does nothing.
   */
  Object.values(SHEETS).forEach((sel) => {
    const panel = document.querySelector(sel);
    if (!panel) return;
    let sy = null, sx = null;
    panel.addEventListener('pointerdown', (ev) => {
      if (!mq.matches || ev.pointerType === 'mouse') return;
      const r = panel.getBoundingClientRect();
      if (ev.clientY - r.top > 34) return;      // below the grab zone
      sy = ev.clientY; sx = ev.clientX;
    });
    panel.addEventListener('pointermove', (ev) => {
      if (sy === null) return;
      const dy = ev.clientY - sy, dx = Math.abs(ev.clientX - sx);
      if (dy > 48 && dy > dx * 2) {
        sy = null;
        if (document.body.dataset.sheet) openSheet(document.body.dataset.sheet);
      }
    });
    ['pointerup', 'pointercancel'].forEach((t) =>
      panel.addEventListener(t, () => { sy = null; }));
  });

  /* ------------------------------------------- touch substitutes for hover */

  /*
   * The overlay opacity sliders live in hover flyouts. On touch, first tap opens
   * the flyout, and the button's own aria-pressed toggle still runs — so a tap
   * both toggles the layer and reveals its slider, which is what you want.
   */
  document.querySelectorAll('.ov-item').forEach((item) => {
    const icon = item.querySelector('.ov-icon');
    if (!icon) return;
    icon.addEventListener('click', () => {
      if (!mq.matches) return;
      document.querySelectorAll('.ov-item').forEach((o) => {
        if (o !== item) o.classList.remove('open');
      });
      item.classList.add('open');
    });
  });
  document.addEventListener('click', (ev) => {
    if (!mq.matches) return;
    if (ev.target.closest && ev.target.closest('.ov-item')) return;
    document.querySelectorAll('.ov-item.open').forEach((o) => o.classList.remove('open'));
  });
})();
