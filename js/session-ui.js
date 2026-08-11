/*
 * Session import review — the diff shown before anything is applied.
 *
 * Importing someone else's session is destructive if it just overwrites, so
 * nothing is applied until the user has seen what would change and ticked it.
 * Four sections, each with its own mode:
 *
 *   POIs, Paths          per-row add / change / remove, expandable, clickable
 *                        to see the record on the map before deciding
 *   View settings        one global tick for the whole block — they are only
 *                        meaningful together, and a checkbox per threshold
 *                        would be noise
 *   Diver settings       per-row, because SAC without the matching cylinder set
 *                        is worse than neither
 *
 * Mode is merge by default everywhere. Replace is opt-in per section and is the
 * only thing that honours removals, so a merge can never delete your work.
 */
const SessionUI = (function () {
  let onLocate = null;          // (kind, record) -> show it on the map
  let current = null;           // {diff, modes, selection}

  function init(opts) {
    onLocate = (opts && opts.onLocate) || function () {};
    build();
  }

  function build() {
    if (document.getElementById('session-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'session-modal';
    wrap.className = 'session-modal';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="sm-sheet" role="dialog" aria-label="Import session">' +
        '<div class="sm-head">' +
          '<span class="eyebrow">Import session</span>' +
          '<span id="sm-file" class="sm-file"></span>' +
          '<button id="sm-close" class="sm-x" type="button" aria-label="Cancel">×</button>' +
        '</div>' +
        '<div id="sm-body" class="sm-body"></div>' +
        '<div class="sm-foot">' +
          '<span id="sm-summary" class="hint"></span>' +
          '<button id="sm-cancel" class="btn ghost" type="button">Cancel</button>' +
          '<button id="sm-apply" class="btn" type="button">Import</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.getElementById('sm-close').addEventListener('click', close);
    document.getElementById('sm-cancel').addEventListener('click', close);
    document.getElementById('sm-apply').addEventListener('click', applyNow);
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !wrap.hidden) close();
    });
  }

  const SECTIONS = [
    { key: 'pois', label: 'Points of interest', perRow: true },
    { key: 'paths', label: 'Paths', perRow: true },
    { key: 'view', label: 'View settings', perRow: false },
    { key: 'user', label: 'Diver settings', perRow: true }
  ];

  const fmt = (v) => {
    if (v === undefined) return '—';
    if (Array.isArray(v)) return '[' + v.length + ' items]';
    if (v && typeof v === 'object') return '{…}';
    return String(v);
  };

  function open(diff, fileName) {
    current = {
      diff: diff,
      modes: { pois: 'merge', paths: 'merge', view: 'merge', user: 'merge' },
      selection: {},
      // survives the re-render that a mode or select-all change triggers,
      // so a section you opened does not fold shut under you
      expanded: {}
    };
    SECTIONS.forEach((s) => {
      current.selection[s.key] = {};
      diff[s.key].forEach((row) => {
        /*
         * View settings default to OFF: they are personal display preferences,
         * and silently adopting someone else's palette and thresholds is the
         * surprise this whole screen exists to prevent. Everything else follows
         * the row's own default — additions and changes on, removals off.
         */
        current.selection[s.key][row.uid] = (s.key === 'view') ? false : !!row.selected;
      });
    });
    document.getElementById('sm-file').textContent = fileName || '';
    render();
    document.getElementById('session-modal').hidden = false;
  }

  function close() {
    document.getElementById('session-modal').hidden = true;
    current = null;
  }

  function countSelected() {
    if (!current) return 0;
    return SECTIONS.reduce((n, s) =>
      n + current.diff[s.key].filter((r) => current.selection[s.key][r.uid]).length, 0);
  }

  function render() {
    const body = document.getElementById('sm-body');
    body.textContent = '';
    const d = current.diff;

    SECTIONS.forEach((sec) => {
      const rows = d[sec.key];
      const box = document.createElement('div');
      box.className = 'sm-sect';

      const head = document.createElement('div');
      head.className = 'sm-sect-head';

      const caret = document.createElement('button');
      caret.type = 'button'; caret.className = 'sm-caret';
      caret.textContent = rows.length ? '▸' : '·';
      caret.disabled = !rows.length;

      const title = document.createElement('span');
      title.className = 'sm-title';
      title.textContent = sec.label;

      const tally = document.createElement('span');
      tally.className = 'sm-tally';
      const adds = rows.filter((r) => r.kind === 'add').length;
      const chg = rows.filter((r) => r.kind === 'change').length;
      const rem = rows.filter((r) => r.kind === 'remove').length;
      tally.textContent = rows.length
        ? [adds && ('+' + adds), chg && ('~' + chg), rem && ('−' + rem)].filter(Boolean).join('  ')
        : 'no differences';

      head.appendChild(caret); head.appendChild(title); head.appendChild(tally);

      // one global tick for view settings; per-row sections get theirs inline
      if (!sec.perRow && rows.length) {
        const all = document.createElement('label');
        all.className = 'sm-allcheck';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = rows.every((r) => current.selection[sec.key][r.uid]);
        cb.addEventListener('change', () => {
          rows.forEach((r) => { current.selection[sec.key][r.uid] = cb.checked; });
          render();
        });
        all.appendChild(cb);
        all.appendChild(document.createTextNode('import all'));
        head.appendChild(all);
      }

      if (rows.length) {
        const mode = document.createElement('label');
        mode.className = 'sm-mode';
        mode.title = 'Replace also applies removals, so this section ends up matching the file';
        const mcb = document.createElement('input');
        mcb.type = 'checkbox';
        mcb.checked = current.modes[sec.key] === 'replace';
        mcb.addEventListener('change', () => {
          current.modes[sec.key] = mcb.checked ? 'replace' : 'merge';
          // replace makes removals meaningful, so pre-tick them; merge un-ticks
          rows.filter((r) => r.kind === 'remove').forEach((r) => {
            current.selection[sec.key][r.uid] = mcb.checked;
          });
          render();
        });
        mode.appendChild(mcb);
        mode.appendChild(document.createTextNode('replace'));
        head.appendChild(mode);
      }
      box.appendChild(head);

      const list = document.createElement('div');
      list.className = 'sm-rows';
      list.hidden = !current.expanded[sec.key];
      if (rows.length) caret.textContent = list.hidden ? '▸' : '▾';
      caret.addEventListener('click', () => {
        current.expanded[sec.key] = list.hidden;
        list.hidden = !list.hidden;
        caret.textContent = list.hidden ? '▸' : '▾';
      });

      rows.forEach((row) => {
        const r = document.createElement('div');
        r.className = 'sm-row k-' + row.kind;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!current.selection[sec.key][row.uid];
        cb.addEventListener('change', () => {
          current.selection[sec.key][row.uid] = cb.checked;
          updateSummary();
        });

        const sign = document.createElement('span');
        sign.className = 'sm-sign';
        sign.textContent = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '~';

        const name = document.createElement('span');
        name.className = 'sm-name';
        name.textContent = row.name;

        const detail = document.createElement('span');
        detail.className = 'sm-detail';
        if (sec.key === 'view' || sec.key === 'user') {
          detail.textContent = fmt(row.from) + ' → ' + fmt(row.to);
        } else if (row.kind === 'change') {
          detail.textContent = row.fields.map((f) => f.key).join(', ');
        } else if (row.kind === 'add' && row.incoming && row.incoming.lat !== undefined) {
          detail.textContent = row.incoming.lat.toFixed(4) + ', ' + row.incoming.lng.toFixed(4);
        }

        r.appendChild(cb); r.appendChild(sign); r.appendChild(name); r.appendChild(detail);

        // clicking the row shows the record on the map behind the sheet
        if (sec.perRow && (sec.key === 'pois' || sec.key === 'paths')) {
          r.classList.add('locatable');
          r.addEventListener('click', (ev) => {
            if (ev.target === cb) return;
            onLocate(sec.key, row.incoming || row.current);
          });
        }
        list.appendChild(r);
      });

      box.appendChild(list);
      body.appendChild(box);
    });
    updateSummary();
  }

  function updateSummary() {
    const n = countSelected();
    document.getElementById('sm-summary').textContent =
      n ? n + ' change' + (n === 1 ? '' : 's') + ' selected' : 'nothing selected';
    document.getElementById('sm-apply').textContent = n ? 'Import ' + n : 'Import';
    document.getElementById('sm-apply').disabled = !n;
  }

  function applyNow() {
    if (!current) return;
    Session.apply(current.diff, current.modes, current.selection);
    close();
  }

  return { init: init, open: open, close: close };
})();

window.SessionUI = SessionUI;
