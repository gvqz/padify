// History sheet DOM audit — measures geometry of every region so a
// vision-less session can still find layout defects.
// Usage: agent-browser eval "$(cat scripts/history-audit.js)"
(() => {
  const out = {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      fs: cs.fontSize,
      fw: cs.fontWeight,
      color: cs.color,
      display: cs.display,
      overflow: cs.overflow,
    };
  };
  const modal = $('#snapshotsModal');
  out.open = modal?.classList.contains('in');
  const dlg = $('.snapshots-sheet');
  out.sheet = box(dlg);
  const vp = { w: innerWidth, h: innerHeight };
  out.viewport = vp;
  out.sheetDockedRight = dlg ? Math.abs(dlg.getBoundingClientRect().right - vp.w) < 2 : null;
  out.sheetFullHeight = dlg ? Math.abs(dlg.getBoundingClientRect().height - vp.h) < 2 : null;

  out.head = {
    title: box($('.snap-title')),
    subtitle: box($('.snap-subtitle')),
    subtitleText: $('.snap-subtitle')?.textContent,
    close: box($('.snap-head .close')),
  };

  out.toolbar = {
    row1: box($('.snap-toolbar-row')),
    search: box($('.snap-search')),
    input: box($('.snap-search-input')),
    inputW: $('.snap-search-input')?.getBoundingClientRect().width,
    meta: { hidden: $('#snapshotSearchMeta')?.hidden, text: $('#snapshotSearchMeta')?.textContent },
    row2: box($$('.snap-toolbar-row')[1]),
    seg: box($('.snap-seg')),
    segBtns: $$('.snap-seg-btn').map((b) => ({
      seg: b.dataset.seg,
      active: b.classList.contains('is-active'),
      w: +b.getBoundingClientRect().width.toFixed(1),
      text: b.textContent.trim(),
    })),
    take: box($('.snap-take')),
  };

  // Rows
  const rows = $$('.snap-item');
  out.rows = {
    count: rows.length,
    dayLabels: $$('.snap-day').map((d) => d.textContent.trim()),
    sample: rows.slice(0, 4).map((r) => {
      const row = r.querySelector('.snap-row');
      const when = r.querySelector('.snap-when');
      const what = r.querySelector('.snap-what');
      const name = r.querySelector('.snap-name');
      const chips = [...r.querySelectorAll('.snap-chip')].map((c) => c.textContent.trim());
      const current = !!r.querySelector('.snap-current');
      const preview = r.querySelector('.snap-preview');
      const delta = r.querySelector('.snap-delta');
      return {
        key: r.dataset.rowKey,
        rowH: +row.getBoundingClientRect().height.toFixed(1),
        whenX: +when.getBoundingClientRect().x.toFixed(1),
        whenW: +when.getBoundingClientRect().width.toFixed(1),
        whatX: +what.getBoundingClientRect().x.toFixed(1),
        name: name?.textContent,
        nameW: +name.getBoundingClientRect().width.toFixed(1),
        noteChip: r.querySelector('.snap-note')?.textContent,
        chips,
        current,
        preview: preview?.textContent?.slice(0, 40),
        previewEmpty: preview ? getComputedStyle(preview).display === 'none' : null,
        delta: delta?.textContent,
        trash: r.classList.contains('is-trash'),
      };
    }),
  };

  // Vertical rhythm: gap between consecutive rows (should be consistent)
  const rects = rows.map((r) => r.querySelector('.snap-row').getBoundingClientRect());
  out.rowGaps = rects.slice(1).map((r, i) => +(r.y - (rects[i].y + rects[i].height)).toFixed(1));

  // Scroll area + footer
  out.scroll = {
    ...box($('.snap-scroll')),
    listDisplay: $('#snapshotsList')?.style.display,
    emptyDisplay: $('#noSnapshots')?.style.display,
  };
  out.footer = {
    el: box($('.snap-foot')),
    countText: $('#snapshotsCount')?.textContent,
    deleteLabel: $('.snap-delete-all-label')?.textContent,
    deleteHidden: $('#historyScopeDeleteBtn')?.hidden,
    deleteDisabled: $('#historyScopeDeleteBtn')?.disabled,
  };

  // Rail geometry: does the dot align with the rail line? are day labels aligned with rows?
  if (rows[0]) {
    const first = rows[0].getBoundingClientRect();
    const dot = getComputedStyle(rows[0], '::after');
    out.rail = {
      firstRowX: +first.x.toFixed(1),
      timeCol: getComputedStyle($('.snap-timeline')).getPropertyValue('--snap-time'),
    };
  }

  return JSON.stringify(out, null, 1);
})();
