/**
 * The sheet kit — the one vocabulary every right-side timeline sheet
 * speaks. It was born the day the History sheet absorbed the trash: the
 * two features were the same shape wearing two outfits (a timestamped
 * copy of a note, carrying identity, shown on a day-anchored timeline,
 * with a restore and a two-step-arm destructive action), and every
 * difference between them was hand-copied — four arm/disarm machines,
 * two day groupers, two title/preview derivations, two full row
 * skeletons. The sibling look was enforced by comments; comments drift.
 *
 * The kit owns the shared bones:
 *
 *  • ROW — one model, one renderer. [clock][rail][what] grid, the
 *    title line (name + note chip + Current + the row's chip), one
 *    preview line, the optional diffstat, and an in-place detail card
 *    that owns the actions. Rows are PROVIDER-AGNOSTIC: the manager
 *    maps its data (a snapshot, a trashed note) onto the model and the
 *    kit does the rest — escaping, search highlighting, day runs,
 *    group trims, the accordion, the flash.
 *  • DAYS — one grouper, always anchored (a run of entries needs its
 *    Today / Yesterday / date label even when every entry is from
 *    today), rows newest-first, the rail's line breaking only at day
 *    boundaries.
 *  • CONFIRM — one two-step arm (tap arms, the label turns the
 *    question, the second tap commits, a click elsewhere or a few
 *    seconds of silence disarms). Every destructive button in a sheet
 *    — a row's Delete forever, the footer's Delete all / Empty trash —
 *    is an instance of this, never a dialog stacked over the sheet.
 *
 * The kit renders; it never decides. What a restore means, what a
 * purge sweeps, which rows exist — the provider's call, through the
 * model and the two callbacks (onAction, and the segment the manager
 * keeps for itself).
 */

// ---------------------------------------------------------------------------
// Escaping + highlighting
// ---------------------------------------------------------------------------

/** Escapes the five characters HTML cares about. */
export function escapeHtmlText(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes text, then wraps every literal match of the search term in a
 * <mark> — the eye needs to land on WHY a row answered the query. Both
 * the text and the term are HTML-escaped before matching, so the search
 * can never inject markup through the query.
 */
export function highlightMatches(text: string, term: string): string {
  const escaped = escapeHtmlText(text);
  const needle = escapeHtmlText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!needle) {
    return escaped;
  }
  return escaped.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`);
}

// ---------------------------------------------------------------------------
// Day anchoring
// ---------------------------------------------------------------------------

/**
 * The local calendar day a timestamp falls on, as 'YYYY-MM-DD'. Day
 * grouping keys on this — two entries on the same local day share a
 * header no matter how close to midnight they were taken.
 */
export function sheetDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The day group's label: 'Today', 'Yesterday', else the calendar date
 * ('October 24', with the year appended when it is not this year — a
 * long-lived history can hold entries from previous years, and a bare
 * 'October 24' next to 'Today' would read as a recent day that simply
 * is not today). English only, matching every other string in the app.
 */
export function sheetDayLabel(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (timestamp >= startOfToday) {
    return 'Today';
  }
  if (timestamp >= startOfToday - dayMs) {
    return 'Yesterday';
  }
  const sameYear = date.getFullYear() === nowDate.getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export interface SheetDayGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/**
 * The day runs a timeline renders — newest first (the caller's order),
 * one group per local day, ALWAYS anchored: a same-day history still
 * gets its 'Today' (a run of entries needs its label even when nothing
 * is older), and the anchor is real information the moment anything
 * from yesterday exists.
 */
export function sheetDayGroups<T extends { timestamp: number }>(
  rows: T[],
  now: number = Date.now(),
): SheetDayGroup<T>[] {
  const groups: SheetDayGroup<T>[] = [];
  for (const row of rows) {
    const key = sheetDayKey(row.timestamp);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.rows.push(row);
    } else {
      groups.push({ key, label: sheetDayLabel(row.timestamp, now), rows: [row] });
    }
  }
  return groups;
}

/** The row's clock — HH:MM; the day header above it carries the day. */
export function formatSheetClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// The row model
// ---------------------------------------------------------------------------

/** A chip on the title line — the trash retention countdown today. */
export interface SheetChip {
  text: string;
  /** Danger dress — the retention's last days. */
  danger?: boolean;
  /** Tooltip explaining what the chip counts. */
  title?: string;
}

/** The diffstat under the preview — a version's change against its predecessor. */
export interface SheetDelta {
  delta: number;
  unit: string;
}

export interface SheetRowAction {
  /** The action id the provider's onAction receives. */
  kind: 'restore' | 'copy' | 'delete';
  label: string;
  title?: string;
}

/**
 * One timeline row, provider-agnostic. Everything is PLAIN TEXT — the
 * kit escapes (and highlights) at render, so no caller can smuggle
 * markup in, and every row kind gets the same treatment for free.
 */
export interface SheetRowModel {
  /** Unique row key (dataset.rowKey) — the provider's stable id. */
  key: string;
  timestamp: number;
  title: string;
  /** The source note's NAME, when the row has one worth showing. */
  noteChip?: string;
  preview?: string;
  /** Title-line chip after Current. */
  chip?: SheetChip;
  current?: boolean;
  /** A trash row: the rail dot dresses danger, the row never wears Current. */
  trash?: boolean;
  delta?: SheetDelta;
  /** The detail card's readable text (the kit caps it). */
  detailText?: string;
  /** The detail card's meta segments — [full date, type label]. */
  detailMeta?: string[];
  /** Where the action lands, spelled before the click. */
  hint?: string;
  actions?: SheetRowAction[];
}

/** How much of the readable text the detail card shows. */
const SHEET_DETAIL_CAP = 2000;

/**
 * The preview usually opens with the note's own first line — the title
 * the row already shows. The echo spends the row's one preview line
 * saying the same thing twice; strip the title (and the markup glue
 * before it) so the line starts at NEW text. A preview that is
 * entirely its title collapses away.
 */
function previewForDisplay(preview: string, title: string): string {
  const raw = preview.trimStart();
  const cleaned = raw.replace(/^[#>\-*•\s]+/, '');
  const plainTitle = title.trim();
  if (plainTitle && cleaned.toLowerCase().startsWith(plainTitle.toLowerCase())) {
    const rest = cleaned
      .slice(plainTitle.length)
      .replace(/^[\s:：\-–—•*]+/, '')
      .trimStart();
    return rest;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The two-step confirm
// ---------------------------------------------------------------------------

/** Every live confirm — the click-elsewhere disarm walks this set. */
const liveConfirms = new Set<TwoStepConfirm>();

if (typeof document !== 'undefined') {
  // ONE document listener disarms every armed confirm whose button the
  // click did not land in — the confirm is a gesture on the button, not
  // a state to wander away from. (Runs in the bubble phase, alongside
  // the sheets' own delegated handlers; arming and committing both
  // happen in earlier listeners on the same click.)
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    for (const confirm of liveConfirms) {
      confirm.disarmUnlessTargetInside(target);
    }
  });
}

function isInside(node: HTMLElement | null, element: HTMLElement | null): boolean {
  if (!node || !element) {
    return false;
  }
  return element === node || element.contains(node);
}

/**
 * The two-step inline confirm: the first tap arms (the button's label
 * turns the question, the button dresses danger), the second tap on the
 * same key commits, a tap elsewhere or a few seconds of silence
 * disarms. One armed key at a time — arming another row disarms this
 * one. No dialog ever stacks over the sheet.
 */
export class TwoStepConfirm {
  private armedKey: string | null = null;
  private armedButton: HTMLElement | null = null;
  private quietLabel: string | null = null;
  private timer: number | null = null;

  constructor(
    private readonly opts: {
      /** How long silence keeps the arm alive. */
      ttlMs?: number;
    } = {},
  ) {
    liveConfirms.add(this);
  }

  /** The gesture: true when this tap is the COMMIT. */
  tap(key: string, button: HTMLElement, armedLabel: string): boolean {
    if (this.armedKey === key) {
      this.disarm();
      return true;
    }
    this.arm(key, button, armedLabel);
    return false;
  }

  /** The document's click-elsewhere walk calls this — internal. */
  disarmUnlessTargetInside(target: HTMLElement | null): void {
    if (!isInside(target, this.armedButton)) {
      this.disarm();
    }
  }

  /** The provider re-rendered underneath — drop the arm quietly. */
  disarm(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.armedButton) {
      this.armedButton.classList.remove('is-armed');
      const label = this.armedButton.querySelector(
        '.confirm-label, .snap-act-delete-label, .snap-delete-all-label',
      );
      // Icon+label buttons carry their text in a span; a bare text
      // button IS its label.
      if (label instanceof HTMLElement) {
        if (this.quietLabel !== null) {
          label.textContent = this.quietLabel;
        }
      } else if (this.quietLabel !== null) {
        this.armedButton.textContent = this.quietLabel;
      }
    }
    this.armedKey = null;
    this.armedButton = null;
    this.quietLabel = null;
  }

  private arm(key: string, button: HTMLElement, armedLabel: string): void {
    this.disarm();
    this.armedKey = key;
    this.armedButton = button;
    const label = button.querySelector(
      '.confirm-label, .snap-act-delete-label, .snap-delete-all-label',
    );
    if (label instanceof HTMLElement) {
      this.quietLabel = label.textContent ?? '';
      label.textContent = armedLabel;
    } else {
      this.quietLabel = button.textContent ?? '';
      button.textContent = armedLabel;
    }
    button.classList.add('is-armed');
    this.timer = window.setTimeout(() => this.disarm(), this.opts.ttlMs ?? 4000);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderSheetOptions {
  /** The live search term — matches highlight in title and preview. */
  term?: string;
  /** The row that just landed — it flashes once and scrolls into view. */
  flashKey?: string | null;
}

/** The action glyph for the kit's icon-only buttons. */
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

/** Renders one row's action buttons — styled by kind, keyed by data. */
function renderActions(actions: SheetRowAction[] | undefined, rowKey: string): string {
  if (!actions || actions.length === 0) {
    return '';
  }
  const buttons = actions.map((action) => {
    const title = action.title ? ` title="${escapeHtmlText(action.title)}"` : '';
    if (action.kind === 'restore') {
      return `<button type="button" class="snap-act restore" data-sheet-action="restore" data-row-key="${escapeHtmlText(rowKey)}"${title}>${escapeHtmlText(action.label)}</button>`;
    }
    if (action.kind === 'copy') {
      return `<button type="button" class="snap-act copy" data-sheet-action="copy" data-row-key="${escapeHtmlText(rowKey)}"${title} aria-label="${escapeHtmlText(action.label)}">${COPY_ICON}</button>`;
    }
    return `<button type="button" class="snap-act delete" data-sheet-action="delete" data-row-key="${escapeHtmlText(rowKey)}"${title}><span class="confirm-label">${escapeHtmlText(action.label)}</span></button>`;
  });
  return `<div class="snap-detail-actions">${buttons.join('')}</div>`;
}

/** Builds one timeline entry's DOM — the skeleton every sheet shares. */
function buildItem(row: SheetRowModel, term: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `snap-item${row.trash ? ' is-trash' : ''}${row.current ? ' is-current' : ''}`;
  li.dataset.rowKey = row.key;

  const titleHtml = term ? highlightMatches(row.title, term) : escapeHtmlText(row.title);
  const noteChip =
    row.noteChip && row.noteChip !== row.title
      ? `<span class="snap-note" title="From the note \u201c${escapeHtmlText(row.noteChip)}\u201d">${highlightMatches(row.noteChip, term)}</span>`
      : '';
  const chipHtml = row.chip
    ? `<span class="snap-chip${row.chip.danger ? ' is-danger' : ''}"${row.chip.title ? ` title="${escapeHtmlText(row.chip.title)}"` : ''}>${escapeHtmlText(row.chip.text)}</span>`
    : '';
  const currentHtml = row.current
    ? '<span class="snap-current" title="This version is what the note holds right now"><span class="snap-current-dot" aria-hidden="true"></span>Current</span>'
    : '';
  const preview = row.preview ? previewForDisplay(row.preview, row.title) : '';
  const previewHtml = term ? highlightMatches(preview, term) : escapeHtmlText(preview);
  const deltaHtml = row.delta
    ? `<span class="snap-delta ${row.delta.delta > 0 ? 'is-up' : row.delta.delta < 0 ? 'is-down' : 'is-flat'}" title="Change since the previous snapshot of this note">${row.delta.delta > 0 ? '+' : row.delta.delta < 0 ? '\u2212' : '\u00b1'}${Math.abs(row.delta.delta)} ${escapeHtmlText(row.delta.unit)}</span>`
    : '';

  const detailText = (row.detailText ?? '').trim();
  const capped =
    detailText.length > SHEET_DETAIL_CAP
      ? `${detailText.slice(0, SHEET_DETAIL_CAP)}\u2026`
      : detailText;
  const detailId = `sheet-detail-${row.key}`;
  const metaHtml = (row.detailMeta ?? [])
    .map((segment) => `<span>${escapeHtmlText(segment)}</span>`)
    .join('<span class="snap-detail-sep" aria-hidden="true">\u00b7</span>');
  const hintHtml = row.hint ? `<p class="snap-detail-hint">${escapeHtmlText(row.hint)}</p>` : '';

  li.innerHTML = `
    <button type="button" class="snap-row" aria-expanded="false" aria-controls="${detailId}" title="Show details">
      <span class="snap-when">${escapeHtmlText(formatSheetClock(row.timestamp))}</span>
      <span class="snap-rail" aria-hidden="true"></span>
      <span class="snap-what">
        <span class="snap-line">
          <span class="snap-name" title="${escapeHtmlText(row.title)}">${titleHtml}</span>
          ${noteChip}
          ${currentHtml}
          ${chipHtml}
        </span>
        <span class="snap-preview" title="${escapeHtmlText(preview)}">${previewHtml}</span>
        ${deltaHtml}
      </span>
    </button>
    <div class="snap-detail" id="${detailId}" role="region" aria-label="Details" hidden>
      <div class="snap-detail-text">${escapeHtmlText(capped) || 'No content'}</div>
      ${metaHtml ? `<div class="snap-detail-meta">${metaHtml}</div>` : ''}
      ${renderActions(row.actions, row.key)}
      ${hintHtml}
    </div>
  `;
  return li;
}

/**
 * Renders the whole timeline: day runs (always anchored), the group
 * trims that break the rail's line at day boundaries, the flash on the
 * just-landed row, and the scroll that brings it into view. Rows carry
 * no listeners of their own — wireSheetTimeline's one delegated pair
 * covers every row a render can produce.
 */
export function renderSheetTimeline(
  list: HTMLElement,
  rows: SheetRowModel[],
  opts: RenderSheetOptions = {},
): void {
  const term = (opts.term ?? '').trim().toLowerCase();
  list.textContent = '';

  let flashed = false;
  for (const group of sheetDayGroups(rows)) {
    const dayHeader = document.createElement('li');
    dayHeader.className = 'snap-day';
    dayHeader.textContent = group.label;
    list.appendChild(dayHeader);

    group.rows.forEach((row, index) => {
      const li = buildItem(row, term);
      if (index === 0) {
        li.classList.add('group-start');
      }
      if (index === group.rows.length - 1) {
        li.classList.add('group-end');
      }
      if (!flashed && opts.flashKey != null && row.key === opts.flashKey) {
        li.classList.add('is-new');
        flashed = true;
      }
      list.appendChild(li);
    });
  }

  if (flashed) {
    list.querySelector('.snap-item.is-new')?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }
}

export interface SheetTimelineHandlers {
  /** An action button was tapped — restore / copy / delete. */
  onAction: (key: string, kind: string, button: HTMLElement) => void;
}

/**
 * The one delegated pair every sheet's list needs: the row button
 * toggles its detail card (accordion — one open at a time), the action
 * buttons dispatch. Install once per list element; renders can come and
 * go underneath.
 */
export function wireSheetTimeline(list: HTMLElement, handlers: SheetTimelineHandlers): void {
  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    const action = target.closest<HTMLElement>('[data-sheet-action]');
    if (action) {
      const key = action.dataset.rowKey ?? '';
      handlers.onAction(key, action.dataset.sheetAction ?? '', action);
      return;
    }

    const rowButton = target.closest<HTMLElement>('.snap-row');
    if (!rowButton) {
      return;
    }
    const item = rowButton.closest<HTMLElement>('.snap-item');
    if (!item) {
      return;
    }
    list.querySelectorAll('.snap-item.is-open').forEach((other) => {
      if (other !== item) {
        other.classList.remove('is-open');
        other.querySelector('.snap-row')?.setAttribute('aria-expanded', 'false');
        other.querySelector('.snap-detail')?.setAttribute('hidden', '');
      }
    });
    const open = !item.classList.contains('is-open');
    item.classList.toggle('is-open', open);
    rowButton.setAttribute('aria-expanded', String(open));
    item.querySelector('.snap-detail')?.toggleAttribute('hidden', !open);
  });
}
