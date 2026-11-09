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

// ---------------------------------------------------------------------------
// The line diff — what the detail card shows a version AGAINST
// ---------------------------------------------------------------------------

/** One aligned line of a diff. Context lines are shared text. */
export interface SheetDiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** A run of lines the card collapsed away — unchanged context, or the
 *  tail of a change run too long to read at a glance. */
export interface SheetDiffGap {
  kind: 'gap';
  count: number;
  /** What the folded lines were: shared context (default), removals,
   *  or additions — the note the row renders says so. */
  tone?: 'ctx' | 'del' | 'add';
}

export type SheetDiffEntry = SheetDiffLine | SheetDiffGap;

/** The diff a version's detail card renders, previous → current. */
export interface SheetDiff {
  entries: SheetDiffEntry[];
  added: number;
  removed: number;
  /** The rendered body stopped at the line cap. */
  truncated: boolean;
}

/** Any side larger than this declines the diff — the LCS table is
 *  O(n·m) and the card is a glance, not a merge tool. The caller falls
 *  back to the full text. */
const DIFF_MAX_SIDE_LINES = 600;

/** Unchanged lines kept on each side of a change run. */
const DIFF_CONTEXT = 2;

/** Rendered lines the card holds before it truncates. */
const DIFF_RENDER_CAP = 160;

/** How many consecutive same-kind change lines render before the run
 *  folds its tail into a counted note. A whole-note replacement is a
 *  wall of one color — the card is a glance, and Copy still carries
 *  every line out. Twelve lines: the run's shape reads, the fold note
 *  and the additions after it stay inside the card's 240px window. */
const DIFF_RUN_CAP = 12;

/**
 * The line diff of two readable projections — additions and deletions
 * aligned against their shared lines (longest-common-subsequence on
 * lines; word-level granularity is a merge tool's job, and this is a
 * card). Null when the texts share every line (nothing to show — the
 * caller renders the full text instead) or when either side is too
 * large to diff honestly.
 *
 * Pure and exported: the unit tests pin the alignment, the collapse
 * and the caps without the manager's DOM wiring.
 */
export function sheetDiff(oldText: string, newText: string): SheetDiff | null {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > DIFF_MAX_SIDE_LINES || b.length > DIFF_MAX_SIDE_LINES) {
    return null;
  }

  // The LCS table, bottom-up. Int32Array over a sparse structure: a
  // 600×600 worst case is 1.4MB that dies at the end of this call.
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  // Walk the alignment: on a tie the deletion leads (the old text's
  // line leaves before the new one arrives — the order every diff
  // reader already knows).
  const ops: SheetDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i++;
      removed++;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j++;
      added++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i] });
    i++;
    removed++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j] });
    j++;
    added++;
  }

  if (added === 0 && removed === 0) {
    // Same lines: the difference lives below the line level (a type
    // switch, a drawing whose bytes moved without its text). The card
    // has nothing to say that the full text doesn't say better.
    return null;
  }

  // Long same-kind runs fold their tails FIRST — 37 straight deletions
  // become the first DIFF_RUN_CAP and a counted note. Folding before
  // the context pass keeps every count honest (a fold applied after a
  // render-cap truncation would undercount the tail it summarizes).
  // The stat above the body already speaks the whole truth (+2 −37);
  // the body is for the eye, and the eye wants the shape, not the wall.
  const stream: SheetDiffEntry[] = [];
  let runKind: 'add' | 'del' | null = null;
  let runLen = 0;
  const foldRun = (): void => {
    if (runKind && runLen > DIFF_RUN_CAP) {
      const excess = runLen - DIFF_RUN_CAP;
      stream.length -= excess;
      stream.push({ kind: 'gap', count: excess, tone: runKind });
    }
    runKind = null;
    runLen = 0;
  };
  for (const op of ops) {
    if (op.kind === 'add' || op.kind === 'del') {
      if (op.kind !== runKind) {
        foldRun();
        runKind = op.kind;
      }
      runLen++;
      stream.push(op);
    } else {
      foldRun();
      stream.push(op);
    }
  }
  foldRun();

  // Collapse the context: keep ±DIFF_CONTEXT lines around each change
  // (a folded gap counts as context — it exists to summarize, and only
  // beside its run), fold longer unchanged runs into a counted gap.
  // The card is a window onto WHAT MOVED, not a reprint of the note.
  const keep = new Array<boolean>(stream.length).fill(false);
  let lastChange = -1;
  for (let k = 0; k < stream.length; k++) {
    if (stream[k].kind !== 'ctx' && stream[k].kind !== 'gap') {
      for (
        let c = Math.max(0, k - DIFF_CONTEXT);
        c <= Math.min(stream.length - 1, k + DIFF_CONTEXT);
        c++
      ) {
        keep[c] = true;
      }
      lastChange = k;
    }
  }
  // A change near the head or tail can leave trailing kept context
  // beyond the last change — trim it so the card ends where the story
  // does (context exists to orient a change, not to pad it).
  const keepEnd = Math.min(stream.length - 1, lastChange + DIFF_CONTEXT);

  const entries: SheetDiffEntry[] = [];
  let rendered = 0;
  let truncated = false;
  let gapRun = 0;
  const flushGap = (): void => {
    if (gapRun > 0) {
      entries.push({ kind: 'gap', count: gapRun });
      gapRun = 0;
    }
  };
  for (let k = 0; k <= keepEnd; k++) {
    if (!keep[k] && stream[k].kind === 'ctx') {
      gapRun++;
      continue;
    }
    if (!keep[k] && stream[k].kind === 'gap') {
      // A fold note outside the kept window: its run's survivors were
      // also dropped, so the note would summarize lines the card never
      // shows — drop the note with them.
      continue;
    }
    flushGap();
    if (rendered >= DIFF_RENDER_CAP) {
      truncated = true;
      break;
    }
    entries.push(stream[k]);
    rendered++;
  }
  return { entries, added, removed, truncated };
}

/** The diff card's caption — who the version is diffed against. */
export interface SheetRowDiff {
  diff: SheetDiff;
  /** 'Changed since Nov 8, 4:12 PM' — the previous capture's clock. */
  caption: string;
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
  /** The line diff against this row's predecessor — when present it
   *  REPLACES the full text in the detail card: the card answers “what
   *  changed here?”, and Copy still carries the whole version out. */
  diff?: SheetRowDiff;
}

/** How much of the readable text the detail card holds. The card is a
 *  240px scrolling window (see 11-snapshots.css) — the cap is a DOM
 *  ceiling, not a visible one, and it sits at the same height as the
 *  search cap so the card never shows less than the search can find.
 *  2000 proved too tight the day the WELCOME note itself outgrew it
 *  (2013 readable chars): the words a user just typed — the ones at
 *  the END — were the first thing the card cut. */
const SHEET_DETAIL_CAP = 20_000;

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
  /** The row that should render EXPANDED — its detail card open, its
   *  row button aria-expanded. A re-render must not snap shut the row
   *  the user is reading: the caller reads the open row's key off the
   *  old DOM and hands it back, so a background refresh (a save that
   *  lands under an open sheet) rebuilds the list around the reader
   *  instead of collapsing it. A key that no longer exists (the row
   *  was purged) quietly renders everything closed. */
  openKey?: string | null;
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

/** Builds one timeline entry's DOM — the skeleton every sheet shares.
 *  `open` renders the entry expanded (the state wireSheetTimeline's row
 *  click toggles): the accordion is one-open-at-a-time by construction,
 *  so a re-render carrying the open key restores exactly that state. */
function buildItem(row: SheetRowModel, term: string, open = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `snap-item${row.trash ? ' is-trash' : ''}${row.current ? ' is-current' : ''}${open ? ' is-open' : ''}`;
  // A grave in its last days — the rail dot dresses danger to match
  // the retention chip beside the title. Red on this rail means
  // "leaving soon"; a plain trash row keeps the neutral dot (see
  // 11-snapshots.css).
  if (row.trash && row.chip?.danger) {
    li.classList.add('is-expiring');
  }
  li.dataset.rowKey = row.key;

  const titleHtml = term ? highlightMatches(row.title, term) : escapeHtmlText(row.title);
  const noteChip =
    row.noteChip && row.noteChip !== row.title
      ? `<span class="snap-note" title="From the note \u201c${escapeHtmlText(row.noteChip)}\u201d">${highlightMatches(row.noteChip, term)}</span>`
      : '';
  const chipHtml = row.chip
    ? `<span class="snap-chip${row.chip.danger ? ' is-danger' : ''}"${row.chip.title ? ` title="${escapeHtmlText(row.chip.title)}"` : ''}>${escapeHtmlText(row.chip.text)}</span>`
    : '';
  // Current keeps its text pill; the rail's green ring is the scan
  // line. A second dot inside the pill encoded the same fact twice.
  const currentHtml = row.current
    ? '<span class="snap-current" title="This version is what the note holds right now">Current</span>'
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

  // The card's body: the DIFF when there is one to show (a version
  // with a predecessor — the question the card exists to answer), else
  // the full readable text (a first version, a trashed note).
  const bodyHtml = row.diff
    ? renderDiff(row.diff)
    : `<div class="snap-detail-text">${escapeHtmlText(capped) || 'No content'}</div>`;

  li.innerHTML = `
    <button type="button" class="snap-row" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${detailId}" title="${open ? 'Hide details' : 'Show details'}">
      <span class="snap-when">${escapeHtmlText(formatSheetClock(row.timestamp))}</span>
      <span class="snap-rail" aria-hidden="true"></span>
      <span class="snap-what">
        <span class="snap-line">
          <span class="snap-name" title="${escapeHtmlText(row.title)}">${titleHtml}</span>
          ${noteChip}
          ${currentHtml}
          ${chipHtml}
        </span>
        <span class="snap-subline">
          <span class="snap-preview" title="${escapeHtmlText(preview)}">${previewHtml}</span>
          ${deltaHtml}
        </span>
      </span>
      <span class="snap-caret" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
    </button>
    <div class="snap-detail" id="${detailId}" role="region" aria-label="Details"${open ? '' : ' hidden'}>
      ${bodyHtml}
      ${metaHtml ? `<div class="snap-detail-meta">${metaHtml}</div>` : ''}
      ${renderActions(row.actions, row.key)}
      ${hintHtml}
    </div>
  `;
  return li;
}

/** The diff card's body — the caption, then the aligned lines. ins/del
 *  carry the semantics for assistive tech; the classes carry the dress. */
function renderDiff(rowDiff: SheetRowDiff): string {
  const { diff, caption } = rowDiff;
  const body = diff.entries
    .map((entry) => {
      if (entry.kind === 'gap') {
        const unit = entry.count === 1 ? 'line' : 'lines';
        const what =
          entry.tone === 'del'
            ? `more removed ${unit}`
            : entry.tone === 'add'
              ? `more added ${unit}`
              : `unchanged ${unit}`;
        return `<div class="snap-diff-gap" aria-hidden="true">\u22ef ${entry.count} ${what}</div>`;
      }
      const tag = entry.kind === 'add' ? 'ins' : entry.kind === 'del' ? 'del' : 'div';
      const sign = entry.kind === 'add' ? '+' : entry.kind === 'del' ? '\u2212' : '';
      const cls = entry.kind === 'ctx' ? 'is-ctx' : entry.kind === 'add' ? 'is-add' : 'is-del';
      const text = entry.text === '' ? '\u00a0' : escapeHtmlText(entry.text);
      return `<${tag} class="snap-diff-line ${cls}"><span class="snap-diff-sign" aria-hidden="true">${sign}</span><span class="snap-diff-text">${text}</span></${tag}>`;
    })
    .join('');
  const stat = `<span class="snap-diff-stat"><span class="is-up">+${diff.added}</span> <span class="is-down">\u2212${diff.removed}</span></span>`;
  return `
    <div class="snap-diff">
      <div class="snap-diff-cap">${escapeHtmlText(caption)} ${stat}</div>
      <div class="snap-diff-body" role="region" aria-label="Changes since the previous version">${body}</div>
      ${diff.truncated ? '<div class="snap-diff-gap is-end">Diff truncated \u2014 restore or copy for the full text.</div>' : ''}
    </div>
  `;
}

/**
 * Renders the whole timeline: day runs (always anchored), the group
 * trims that break the rail's line at day boundaries, the flash on the
 * just-landed row, and the scroll that brings it into view. Rows carry
 * no listeners of their own — wireSheetTimeline's one delegated pair
 * covers every row a render can produce. `opts.openKey` re-opens the
 * row that was open before the rebuild (see RenderSheetOptions).
 */
export function renderSheetTimeline(
  list: HTMLElement,
  rows: SheetRowModel[],
  opts: RenderSheetOptions = {},
): void {
  const term = (opts.term ?? '').trim().toLowerCase();
  const openKey = opts.openKey ?? null;

  // A rebuild replaces the very nodes that hold focus — a Restore
  // click, a capture, a background persist — and focus used to fall to
  // <body>, killing the keyboard reader's place mid-sheet (Enter-Enter
  // no longer went anywhere). Remember WHERE the focus was (the row,
  // and the action button inside it) and put it back on the
  // counterpart the rebuild painted.
  const active =
    document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
      ? document.activeElement
      : null;
  const focusKey = active?.closest<HTMLElement>('.snap-item')?.dataset.rowKey ?? null;
  const focusAction = active?.dataset.sheetAction ?? null;

  list.textContent = '';

  let flashed = false;
  for (const group of sheetDayGroups(rows)) {
    const dayHeader = document.createElement('li');
    dayHeader.className = 'snap-day';
    dayHeader.textContent = group.label;
    list.appendChild(dayHeader);

    group.rows.forEach((row, index) => {
      const li = buildItem(row, term, row.key === openKey);
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

  if (focusKey) {
    const target = focusAction
      ? list.querySelector<HTMLElement>(
          `[data-sheet-action="${CSS.escape(focusAction)}"][data-row-key="${CSS.escape(focusKey)}"]`,
        )
      : list.querySelector<HTMLElement>(
          `.snap-item[data-row-key="${CSS.escape(focusKey)}"] .snap-row`,
        );
    // No scroll: the flash's scroll below owns motion when it is
    // wanted; the reader's row is already where it was.
    target?.focus({ preventScroll: true });
  }

  if (flashed) {
    list.querySelector('.snap-item.is-new')?.scrollIntoView({
      block: 'nearest',
      // Smooth is a motion; the reduced-motion preference owns it (CSS
      // cannot reach a JS scrollIntoView).
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
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
        const otherRow = other.querySelector<HTMLElement>('.snap-row');
        otherRow?.setAttribute('aria-expanded', 'false');
        otherRow?.setAttribute('title', 'Show details');
        other.querySelector('.snap-detail')?.setAttribute('hidden', '');
      }
    });
    const open = !item.classList.contains('is-open');
    item.classList.toggle('is-open', open);
    rowButton.setAttribute('aria-expanded', String(open));
    // The tooltip tells the truth about the NEXT click — a row that
    // already shows its card promising "Show details" is a tooltip
    // lying half the time.
    rowButton.setAttribute('title', open ? 'Hide details' : 'Show details');
    item.querySelector('.snap-detail')?.toggleAttribute('hidden', !open);
  });
}
