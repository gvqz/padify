/**
 * Snapshots — safety copies of notes, one store, keyed to their note.
 *
 * The structural contract (rebuilt after the timeline reskin made it
 * obvious the wiring underneath was still the old wiring):
 *
 *  • IDENTITY — a snapshot records the note it came from (noteId + the
 *    note's NAME). Restore uses that identity: it brings the SOURCE
 *    note on stage and restores THERE — or, when the note is gone,
 *    resurrects it as its own note. A restore must never overwrite an
 *    unrelated note just because it happened to be open. Rows with no
 *    noteId (records from before attribution) still restore into the
 *    active note — the only target they can name.
 *  • DUPLICATES — an identical capture against ANY of that note's
 *    existing snapshots is declined, not just the latest: the restore
 *    loop (v1 → v2 → restore v1 → capture) used to file the same bytes
 *    twice. Identity is CONTENT identity — drawings compare their
 *    canonical scene, so the envelope's volatile savedAt stamp never
 *    makes the same drawing twice (snapshotContentIdentity). Captures
 *    serialize through a queue so two rapid Ctrl+U presses cannot both
 *    pass the check.
 *  • EMPTINESS — judged per content kind (see snapshotHasContent), so
 *    an image-bearing note is not "empty" because its text projection
 *    is blank.
 *  • SEARCH — matches what a row shows (title, note name, preview,
 *    type label) plus the readable projection capped at a few
 *    thousand characters — never raw markup or JSON braces. The field
 *    carries its own trailing chrome: a live result count, a clear
 *    button (Escape works too), a "/" focus shortcut, and highlighted
 *    matches in the rows. A capture that lands while ANY filter (text
 *    or type) would hide it clears that filter, so the flash the user
 *    is promised is a flash they can see.
 *  • DATES — formatted at render time from the timestamp; the stored
 *    formattedDate field is written for older builds only.
 *  • THE TYPE FILTER — the toolbar's way to see ONE kind's history
 *    (Notes / Markdown / Drawings …) without breaking chronology: it
 *    narrows the timeline, it never reorders it. The Current chip is
 *    also unique by fiat — several snapshots can hold the same bytes
 *    as the open note (a restore chain guarantees it), but only the
 *    NEWEST of them wears the chip; an older twin is just history.
 *  • THE MENU — a right-side History sheet, NOT a centered dialog, and
 *    ONE continuous timeline: time is the only axis, day runs anchor
 *    the rail (Today / Yesterday / the date), and note type organizes
 *    nothing (it identifies — the detail card says what kind a version
 *    is). Each entry carries the clock, the source note's name when it
 *    has one, one line of preview and the version's change badge
 *    (words / tasks / shapes) against the previous snapshot of its
 *    note — two snapshots whose difference lives past the preview's
 *    100 characters are otherwise twins. Clicking an entry expands it
 *    IN PLACE into a detail card (the readable text, the full date,
 *    the type, and the actions) — nothing in this menu opens a second
 *    dialog. The footer reports the filtered count while a query runs,
 *    the store's size against its cap otherwise.
 *  • RESTORE — one click, no confirmation dialog: the pre-restore
 *    safety copy (saved automatically right before the apply) is the
 *    undo path, so the ask would be theater. The menu STAYS OPEN
 *    afterwards: the list re-renders, the restored row picks up the
 *    Current chip, the pre-restore copy lands on top with its flash,
 *    and the next version is right there. Closing is the user's move.
 *    A capture taken while a search filter would hide it clears that
 *    filter, so the flash the user is promised is a flash they can
 *    see.
 *  • DELETES — one row or all of them: a two-step INLINE confirm
 *    (arm, then confirm) on the button itself. The menu never stacks
 *    a confirmation dialog over itself.
 */
import { $ } from './lib/q';
import { openModal } from './ui/behavior/modal';
import { getActiveNoteContent, getEditorText, getTabManager, htmlToText } from './tabs';
import {
  DEFAULT_NOTE_TYPE,
  NOTE_TYPES,
  isHtmlContent,
  normalizeNoteType,
  noteTypeLabel,
  type NoteType,
} from './editor/note-types';
import {
  drawingSceneContentIdentity,
  drawingScenePlainText,
  parseDrawingScene,
} from './editor/drawing/scene';
import { parseTaskNoteContent, taskNotePlainText } from './editor/tasks/content';
import { showToast } from './ui/toast';
import { updateWordCountPill } from './word-count-pill';

interface Snapshot {
  id?: number;
  /** The source note's tab id — scopes duplicate detection and targets
   *  restores. Absent on records written before attribution; those
   *  restore into the active note. */
  noteId?: string;
  /** The source note's tab NAME at capture (unnamed notes store nothing).
   *  The row shows it; a resurrected note is reborn with it. */
  noteName?: string;
  title: string;
  content: string;
  /** The note's type at capture time; absent = html (the classic note). */
  noteType?: string;
  /** The theme the content's ink colors were written under; absent on
   *  records written before this field existed (treated as current). */
  colorTheme?: 'light' | 'dark';
  preview: string;
  timestamp: number;
  /** Legacy: written for older builds that still read it. Never read. */
  formattedDate: string;
}

/** The shape compared for duplicate detection. */
interface SnapshotState {
  content: string;
  noteType?: string;
}

/**
 * The CONTENT identity of a capture — what "the same snapshot twice"
 * compares. Drawings canonicalize through the scene module (their stored
 * envelope carries a volatile savedAt stamp that refreshes on every save,
 * so byte-comparing two saves of the SAME drawing answers "different" —
 * see drawingSceneContentIdentity); every other kind is its bytes, which
 * its surface serializes deterministically. Normalizing the note type
 * here would be wrong — a content/type pair is the identity, and the
 * callers normalize types themselves (isSameSnapshotState) or specialize
 * (isCurrentSnapshotState).
 */
function snapshotContentIdentity(content: string, noteType?: string): string {
  if (noteType === 'drawing') {
    return drawingSceneContentIdentity(content);
  }
  return content;
}

/**
 * Snapshots are safety copies, not an archive: every Ctrl+U, every
 * delete-safety capture adds one, and an unbounded store grows forever on
 * a long-lived install. The cap keeps the oldest history — the newest
 * MAX_SNAPSHOTS entries stay, older ones go (the timestamp index's
 * ascending order is the deletion order).
 */
export const MAX_SNAPSHOTS = 200;

/** The store's schema version. 1 — the original (timestamp + title
 *  indexes); 2 adds the noteId index the per-note reads query. */
const SNAPSHOTS_DB_VERSION = 2;

/**
 * Opens (creating or upgrading as needed) the snapshots database — the
 * schema owner, extracted from the manager so the upgrade path is
 * testable against a raw database without the manager's DOM wiring.
 *
 * Upgrading an existing store adds the index IN PLACE: rows are never
 * touched. Records that predate the noteId field simply stay out of the
 * index — IndexedDB skips records lacking the key path — which is
 * exactly the attribution rule the readers want: a legacy row was never
 * attributed to any note.
 */
export function openSnapshotsDatabase(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, SNAPSHOTS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // Create indexes for efficient querying
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('noteId', 'noteId', { unique: false });
        return;
      }
      const upgrade = request.transaction;
      if (!upgrade) {
        return;
      }
      const store = upgrade.objectStore(storeName);
      if (!store.indexNames.contains('noteId')) {
        store.createIndex('noteId', 'noteId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * One note's snapshots, NEWEST FIRST — the duplicate check's read.
 * Queries the noteId index (one note's rows, not the whole store);
 * legacy records without the field are invisible to it, which is the
 * attribution rule: they were never this note's. Exported so the
 * per-note read is pinned against a raw database.
 */
export function readSnapshotsForNote(
  db: IDBDatabase,
  storeName: string,
  noteId: string,
): Promise<Snapshot[]> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction([storeName], 'readonly')
      .objectStore(storeName)
      .index('noteId')
      .getAll(noteId);
    request.onsuccess = () => {
      const rows = (request.result as Snapshot[]).slice();
      // Index order is storage order; the callers want time order — and
      // on a tie the higher id is the later write and leads.
      rows.sort((a, b) => b.timestamp - a.timestamp || (b.id ?? 0) - (a.id ?? 0));
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Deletes the oldest snapshots beyond the cap. Resolves with the number
 * pruned once the transaction commits; 0 when under the cap. Exported so
 * the cap is testable against a raw database without the manager's DOM
 * dependencies.
 */
export function pruneSnapshots(
  db: IDBDatabase,
  storeName: string,
  cap: number = MAX_SNAPSHOTS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let excess = 0;
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      excess = Math.max(0, countRequest.result - cap);
      if (excess === 0) {
        return; // under the cap — nothing to delete in this transaction
      }
      // Oldest first: ascending timestamp order is exactly the eviction
      // order a capped history wants.
      const cursorRequest = store.index('timestamp').openCursor();
      let deleted = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= excess) {
          return;
        }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    };
    countRequest.onerror = () => reject(countRequest.error);
    transaction.oncomplete = () => resolve(excess);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

// ---------------------------------------------------------------------------
// Pure helpers — the decision layer, exported so tests pin it without the
// manager's DOM wiring.
// ---------------------------------------------------------------------------

/**
 * Whether a note's content is worth a snapshot, judged by its kind.
 * Html notes read their TEXT PROJECTION — the storage subset holds
 * words and formatting only (images are rendered as chips, never stored
 * as <img> — see editor/markdown/nodes.ts), so an html note without
 * words is empty, full stop. Drawings and task lists are JSON envelopes
 * whose bytes are never empty — their MEANING is: a scene with no
 * elements (a stroke undone away) and a list with no rows are nothing a
 * safety copy adds. Drawing bytes this build cannot parse (a newer
 * build's scene) stay real content — the app refuses to edit them but
 * keeps them, and a safety copy of exactly those bytes is the point.
 * Text/json/opaque kinds are their raw bytes.
 */
export function snapshotHasContent(content: string, noteType?: string): boolean {
  if (isHtmlContent(noteType)) {
    return htmlToText(content).trim() !== '';
  }
  if (noteType === 'drawing') {
    const scene = parseDrawingScene(content);
    if (scene !== null) {
      return scene.elements.some(
        (element) => (element as { isDeleted?: boolean } | null)?.isDeleted !== true,
      );
    }
    return content.trim() !== '';
  }
  if (noteType === 'tasks') {
    return parseTaskNoteContent(content).tasks.length > 0;
  }
  return content.trim() !== '';
}

/** Two captures are the same snapshot when their CONTENT IDENTITY and
 *  note type match — with the type NORMALIZED: 'standard' and absent are
 *  the same note. For drawings the identity is the canonical scene (the
 *  savedAt stamp never makes a drawing "new"), so the undo loop — draw,
 *  snapshot, undo, redo, snapshot — still files one row. */
export function isSameSnapshotState(a: SnapshotState, b: SnapshotState): boolean {
  return (
    snapshotContentIdentity(a.content, a.noteType) ===
      snapshotContentIdentity(b.content, b.noteType) &&
    normalizeNoteType(a.noteType) === normalizeNoteType(b.noteType)
  );
}

/**
 * What a row is searched by: the copy it shows — title, the source
 * note's NAME, preview, type label — plus the readable projection of
 * the note capped at a few thousand characters (see
 * snapshotReadableText). Computed once per load and cached on the row,
 * so each keystroke filters strings.
 */
export function snapshotSearchText(snapshot: Snapshot): string {
  const label = snapshot.noteType ? snapshotTypeBadgeLabel(snapshot.noteType) : '';
  // The readable projection — searching what a person would read, never
  // the storage bytes (searching 'div' must not answer every html row,
  // and a drawing's JSON braces are not its words).
  const text = snapshotReadableText(snapshot.content, snapshot.noteType).slice(
    0,
    SNAPSHOT_SEARCH_CAP,
  );
  return `${snapshot.title}\n${snapshot.noteName ?? ''}\n${snapshot.preview}\n${label}\n${text}`.toLowerCase();
}

/** How much of the readable text is searchable. The cache holds one
 *  search string per row in memory — a 100KB note must not become a
 *  100KB lowercase copy of itself. Matches deeper than the cap are a
 *  fair loss for a menu that previews 100 characters. */
const SNAPSHOT_SEARCH_CAP = 2000;

/**
 * The short chip a row shows — 'Markdown', 'Rich Text' — matching the
 * shortcuts reference's badges. Unknown future types fall back to the
 * registry's full label; the chip matters when restoring switches the
 * note's type.
 */
export function snapshotTypeBadgeLabel(noteType: string): string {
  if (noteType === 'markdown') {
    return 'Markdown';
  }
  if (noteType === 'rich') {
    return 'Rich Text';
  }
  return noteTypeLabel(noteType as NoteType);
}

/** Render-time date — the row always speaks the user's current locale. */
export function formatSnapshotTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The row's clock — HH:MM; the day header above it carries the day. */
export function formatSnapshotClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The local calendar day a timestamp falls on, as 'YYYY-MM-DD'. Day
 * grouping keys on this — two snapshots on the same local day share a
 * header no matter how close to midnight they were taken.
 */
export function snapshotDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The day group's label: 'Today', 'Yesterday', else the calendar date
 * ('October 24', with the year appended when it is not this year — a
 * long-lived store can hold snapshots from previous years, and a bare
 * 'October 24' next to 'Today' would read as a recent day that simply
 * is not today). English only, matching every other string in the app.
 */
export function formatSnapshotDayLabel(timestamp: number, now: number = Date.now()): string {
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

/**
 * The day groups a SECTION renders — the timeline inside one type.
 * Suppressed entirely when every row is from TODAY: a type header above
 * five of-today rows followed by a 'TODAY' bar repeats what the clock
 * and the row order already say, and a menu of five sections each
 * wearing their own 'TODAY' stuttered (the reskin's own audit). The
 * moment a section holds anything older, its day headers come back —
 * 'Yesterday' next to 'Today' is real information a scanner wants, and
 * a lone old section keeps its calendar label instead of hiding it in
 * a tooltip. Rows arrive newest-first and leave that way.
 */
export interface SnapshotDayGroup {
  key: string;
  label: string;
  rows: Snapshot[];
}

export function snapshotDayGroups(rows: Snapshot[], now: number = Date.now()): SnapshotDayGroup[] {
  if (rows.length === 0) {
    return [];
  }
  const todayKey = snapshotDayKey(now);
  const spansBeyondToday = rows.some((row) => snapshotDayKey(row.timestamp) !== todayKey);
  if (!spansBeyondToday) {
    return [];
  }
  const groups: SnapshotDayGroup[] = [];
  for (const row of rows) {
    const key = snapshotDayKey(row.timestamp);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.rows.push(row);
    } else {
      groups.push({ key, label: formatSnapshotDayLabel(row.timestamp, now), rows: [row] });
    }
  }
  return groups;
}

/**
 * What a row says about its version — the signed change against the
 * PREVIOUS snapshot of the same note (the row below it on the
 * timeline), the way a commit carries its diffstat. Two snapshots of a
 * long note whose difference lives past the preview's 100 characters
 * are otherwise twins: same title, same preview, same clock minute.
 * Words for text kinds, tasks for task lists, shapes for drawings —
 * the unit each kind counts, not a byte size a person cannot read.
 * A note's FIRST snapshot is the baseline and carries no badge.
 */
export interface SnapshotChangeBadge {
  /** Signed change in the unit — +3, -2, 0 (a rewording, same size). */
  delta: number;
  /** The unit, already singular/plural: 'word', 'words', 'task', 'tasks', 'shape', 'shapes'. */
  unit: string;
}

function snapshotUnitCount(content: string, noteType?: string): { count: number; unit: string } {
  if (noteType === 'tasks') {
    return { count: parseTaskNoteContent(content).tasks.length, unit: 'task' };
  }
  if (noteType === 'drawing') {
    const scene = parseDrawingScene(content);
    const elements = scene?.elements.filter(
      (element) => (element as { isDeleted?: boolean } | null)?.isDeleted !== true,
    );
    return { count: elements?.length ?? 0, unit: 'shape' };
  }
  const words = snapshotReadableText(content, noteType).trim();
  return { count: words === '' ? 0 : words.split(/\s+/).length, unit: 'word' };
}

export function snapshotChangeBadge(
  current: { content: string; noteType?: string },
  previous: { content: string; noteType?: string } | null,
): SnapshotChangeBadge | null {
  if (!previous) {
    return null;
  }
  const now = snapshotUnitCount(current.content, current.noteType);
  const then = snapshotUnitCount(previous.content, previous.noteType);
  const magnitude = Math.abs(now.count - then.count);
  return {
    delta: now.count - then.count,
    unit: `${now.unit}${magnitude === 1 ? '' : 's'}`,
  };
}

/**
 * What a row's expandable panel and the readable previews show: html
 * kinds read their text projection; drawings read their text elements'
 * plain projection; task lists read their rows' titles. Markdown and
 * unknown kinds are their raw bytes — a markdown note's source IS its
 * text. Unparseable drawing/tasks bytes (corrupt or hand-edited) fall
 * back to the raw content rather than an empty panel.
 */
export function snapshotReadableText(content: string, noteType?: string): string {
  if (isHtmlContent(noteType)) {
    return htmlToText(content);
  }
  // Both projections carry their own fallbacks: a corrupt scene/list
  // answers its raw bytes, an empty one answers '' (which the preview
  // renders as 'No content' — not a wall of JSON braces).
  if (noteType === 'drawing') {
    return drawingScenePlainText(content);
  }
  if (noteType === 'tasks') {
    return taskNotePlainText(parseTaskNoteContent(content));
  }
  return content;
}

/**
 * Whether a row survives the toolbar's note-type filter. null means no
 * filter — every row survives. Types normalize 'standard' and absent to
 * the same thing (a legacy snapshot without a type IS a plain note), the
 * same rule the Current chip and the type sections apply.
 */
export function snapshotMatchesTypeFilter(
  snapshot: { noteType?: string },
  type: string | null,
): boolean {
  if (type === null) {
    return true;
  }
  return (normalizeNoteType(snapshot.noteType) ?? 'standard') === type;
}

/**
 * Whether a snapshot is byte-identical to a note's current state — the
 * 'Current' chip. Types normalize 'standard' and absent to the same
 * thing: a legacy snapshot without a type and a plain note are the same
 * kind, and pretending otherwise would hide the chip on the one row it
 * matters most for (an unchanged note's newest snapshot).
 */
export function isCurrentSnapshotState(
  snapshot: { content: string; noteType?: string },
  active: { content: string; noteType?: string } | null,
): boolean {
  if (!active) {
    return false;
  }
  const normalize = (type: string | undefined) => (type === 'standard' ? undefined : type);
  return (
    snapshotContentIdentity(snapshot.content, snapshot.noteType) ===
      snapshotContentIdentity(active.content, active.noteType) &&
    normalize(snapshot.noteType) === normalize(active.noteType)
  );
}

/**
 * Prefixes a kind's readable first line carries that are NOT part of its
 * meaning: markdown's leading hashes (the editor renders '# Trail log'
 * as the words 'Trail log') and a task row's checkbox ('- [x] call the
 * dentist' is the task 'call the dentist'). Stripped for titles only —
 * previews keep the syntax, the way the note's source reads.
 */
const SNAPSHOT_TITLE_PREFIX: Partial<Record<string, RegExp>> = {
  markdown: /^#{1,6}\s+/,
  tasks: /^- \[[ xX]\]\s+/,
};

/**
 * The row's title: the first meaningful line of the note's READABLE
 * projection — every kind, not just html ones. A section where every row
 * is titled 'Markdown note' or 'Drawing' (the old per-kind label rule)
 * forces the preview to do all the identifying; a title that quotes the
 * note names the version at a glance. Kinds whose projection answers
 * nothing (an empty scene, a blank source) fall back to the type's
 * label, then to the untitled default. Capped at 50 characters.
 */
export function deriveSnapshotTitle(content: string, noteType?: string): string {
  const readable = snapshotReadableText(content, noteType);
  let firstLine = readable.split('\n').find((line) => line.trim() !== '');
  if (firstLine) {
    firstLine = firstLine.trim().replace(SNAPSHOT_TITLE_PREFIX[noteType ?? ''] ?? /^/, '');
    if (firstLine.trim() === '') {
      firstLine = undefined;
    } else {
      firstLine = firstLine.trim();
    }
  }
  const title =
    firstLine || (noteType ? noteTypeLabel(noteType as NoteType) : '') || 'Untitled Snapshot';
  return title.length > 50 ? `${title.substring(0, 47)}...` : title;
}

/** 100 characters of what the row should show of the note. */
export function deriveSnapshotPreview(content: string, noteType?: string): string {
  const preview = snapshotReadableText(content, noteType).replace(/\s+\n/g, '\n').trim();
  if (preview.length > 100) {
    return `${preview.substring(0, 97)}...`;
  }
  return preview || 'No content';
}

/**
 * The rail icon a row leads with — the note's kind at a glance.
 * Standard and unknown kinds share the note glyph; the special kinds
 * get their own. Inline SVG strings (stroke currentColor), scoped by
 * nothing — they are painted inside the row's rail.
 */
const SNAPSHOT_TYPE_ICONS: Record<string, string> = {
  // note glyph — the classic document with lines
  standard:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
  // markdown — the hash
  markdown:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/></svg>',
  // rich text — the type glyph
  rich: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>',
  // drawing — the pencil
  drawing:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  // tasks — the checked list
  tasks:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 7 2 2 4-4"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
};

function snapshotTypeIcon(noteType?: string): string {
  return SNAPSHOT_TYPE_ICONS[noteType ?? 'standard'] ?? SNAPSHOT_TYPE_ICONS.standard;
}

/** The type menu's "All types" row — a stack, the whole store. */
const SNAPSHOT_ALL_TYPES_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 4.9-9 4.9-9-4.9L12 2z"/><path d="m3 11.9 9 4.9 9-4.9"/><path d="m3 16.9 9 4.9 9-4.9"/></svg>';

/** How much of the readable text the expand panel shows. */
const SNAPSHOT_EXPAND_CAP = 2000;

/** A menu section: one note type's snapshots. */
export interface SnapshotTypeSection {
  /** The type id; 'standard' also swallows absent (legacy) and junk ids. */
  key: string;
  /** The header's label — plural and short ('Notes', 'Drawings'). */
  label: string;
  /** The header's rail icon (an inline SVG string). */
  icon: string;
  /** The section's rows, NEWEST FIRST. */
  rows: Snapshot[];
}

/** Section labels — plurals of the registry's labels. Unknown ids fall
 *  back to noteTypeLabel (the id itself) at render time. */
const SNAPSHOT_SECTION_LABELS: Record<string, string> = {
  standard: 'Notes',
  rich: 'Rich Text',
  markdown: 'Markdown',
  tasks: 'Task Lists',
  drawing: 'Drawings',
};

/**
 * Sections the menu renders, one per note type PRESENT in the rows.
 * Section order is the registry's menu order — the "sort by note type"
 * the menu owes — with unknown types trailing alphabetically; recency
 * never reorders sections, so the menu's shape is stable between visits.
 * Rows inside a section are newest-first (the timeline within the type).
 */
export function groupSnapshotsByType(snapshots: Snapshot[]): SnapshotTypeSection[] {
  const buckets = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    // 'standard', absent and junk ids all read as the classic note —
    // the same normalization every type comparison here applies.
    const key = normalizeNoteType(snapshot.noteType) ?? 'standard';
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(snapshot);
    } else {
      buckets.set(key, [snapshot]);
    }
  }
  const orderOf = (key: string): number => {
    const index = NOTE_TYPES.findIndex((def) => def.id === key);
    return index === -1 ? NOTE_TYPES.length : index;
  };
  return [...buckets.keys()]
    .sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b))
    .map((key) => ({
      key,
      label: SNAPSHOT_SECTION_LABELS[key] ?? noteTypeLabel(key as NoteType),
      icon: snapshotTypeIcon(key === 'standard' ? undefined : key),
      rows: (buckets.get(key) ?? []).sort(
        (a, b) => b.timestamp - a.timestamp || (b.id ?? 0) - (a.id ?? 0),
      ),
    }));
}

/**
 * Escapes text, then wraps every literal match of the search term in a
 * <mark> — the eye needs to land on WHY a row answered the query. Both
 * the text and the term are HTML-escaped before matching, so the search
 * can never inject markup through the query.
 */
function highlightMatches(text: string, term: string): string {
  const escaped = escapeHtmlText(text);
  const needle = escapeHtmlText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!needle) {
    return escaped;
  }
  return escaped.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`);
}

/** The escaping half of highlightMatches, shared with plain-HTML callers. */
function escapeHtmlText(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export class SnapshotsManager {
  dbName: string;
  storeName: string;
  db: IDBDatabase | null;

  /** The last read, with each row's search text precomputed — keystrokes
   *  filter this array instead of re-reading IndexedDB. */
  private cache: { snapshot: Snapshot; searchText: string }[] = [];

  /** The just-created snapshot's id — renderRows flashes exactly this
   *  row (and scrolls it into view) once, then clears the flag. */
  private pendingHighlightId: number | null = null;

  /** Captures serialize through here: two rapid Ctrl+U presses must see
   *  each other's writes, or both pass the duplicate check and both
   *  land. The chain swallows errors so one failed write cannot wedge
   *  the next; the caller still observes its own capture's outcome. */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Resolves once the IndexedDB open completes (or rejects if it errors).
   * Callers that need a snapshot before boot finishes — like the Ctrl+Shift+
   * Delete safety snapshot in utils.deleteNotes — can `await` this so the
   * snapshot isn't silently dropped when the IDB open hasn't completed yet.
   */
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: unknown) => void;

  /** The row-delete confirm is a two-step INLINE arm on the button
   *  itself: the first click arms (the button turns "Confirm"), the
   *  second commits. This holds the armed row's id so a second armed
   *  click elsewhere disarms the first, and so a re-render can reset
   *  the state. Auto-disarms after a few seconds. */
  private armedDeleteId: number | null = null;
  private armedDeleteTimer: number | null = null;

  /** Same two-step contract for Delete all — arming lives on the
   *  footer button (its label swaps to "Really delete all?"). */
  private deleteAllArmed = false;
  private deleteAllTimer: number | null = null;

  /** The toolbar's note-type filter — a normalized type id ('markdown',
   *  'drawing' …) or null for all types. Narrows the timeline, never
   *  reorders it; persists across close/open like the search query. */
  private typeFilter: string | null = null;

  /** Whether the type menu hangs open (drives aria-expanded and the
   *  outside-click close). */
  private typeMenuOpen = false;

  constructor() {
    this.dbName = 'NotepadSnapshotsDB';
    this.storeName = 'snapshots';
    this.db = null;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.initializeDB();
    this.setupEventListeners();
  }

  /** Resolves once the IndexedDB connection is open. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  // Initialize IndexedDB
  initializeDB(): void {
    // Same hardening the main storage layer uses (storage/idb.ts
    // openDatabase): in environments where `indexedDB` is undefined or
    // throws synchronously (Firefox with dom.indexedDB.enabled=false,
    // hardened WebViews), the constructor must not throw — it runs inside
    // bootPadify BEFORE initApp, and an uncaught throw there kills the
    // whole boot into a dead shell. Rejecting ready() is the tolerated
    // failure: every caller catches and the app boots without snapshots.
    if (typeof indexedDB === 'undefined') {
      this.rejectReady(new Error('IndexedDB unavailable in this environment'));
      return;
    }
    // The schema (version, indexes, upgrade path) lives in
    // openSnapshotsDatabase — the only place that owns it.
    openSnapshotsDatabase(this.dbName, this.storeName).then(
      (db) => {
        this.db = db;
        void this.updateSnapshotsCount();
        void this.loadSnapshots(this.currentSearchTerm());
        this.resolveReady();
      },
      (error) => {
        console.error('Error opening database', error);
        this.rejectReady(error);
      },
    );
  }

  // Setup event listeners
  setupEventListeners(): void {
    // Open snapshots modal
    document.getElementById('snapshotsButton')?.addEventListener('click', () => {
      openModal($('#snapshotsModal').get(0));
      // Honor the search field's leftover text — reopening used to show the
      // unfiltered list under a stale query.
      const query = (document.getElementById('searchSnapshots') as HTMLInputElement | null)?.value;
      void this.loadSnapshots(query ?? '');
      // The delete-all affordance re-reads the store on every open — its
      // enabled state was last written at boot (or at the last capture),
      // and a store that changed underneath must not show a stale gray.
      void this.updateSnapshotsCount();
    });

    // Create snapshot button
    document.getElementById('createSnapshotBtn')?.addEventListener('click', () => {
      void this.createSnapshot();
    });

    // Delete all snapshots — arm on the first press, commit on the
    // second. The button's own label carries the confirm; no dialog
    // stacks over the sheet.
    document.getElementById('deleteAllSnapshotsBtn')?.addEventListener('click', () => {
      if (this.deleteAllArmed) {
        this.disarmDeleteAll();
        this.deleteAllSnapshots();
        return;
      }
      this.armDeleteAll();
    });

    // A click anywhere else disarms whatever is armed — the confirm is
    // a gesture on the button, not a state to wander away from.
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('#deleteAllSnapshotsBtn')) {
        return;
      }
      if (this.deleteAllArmed) {
        this.disarmDeleteAll();
      }
      if (this.armedDeleteId !== null && !target?.closest('.snap-act.delete')) {
        this.disarmDelete();
      }
    });

    // The type filter's trigger — a toggle: open rebuilds the menu (its
    // counts must read the store as it is now), open again closes it.
    document.getElementById('snapshotTypeFilter')?.addEventListener('click', () => {
      if (this.typeMenuOpen) {
        this.closeTypeMenu();
      } else {
        this.openTypeMenu();
      }
    });

    // A click anywhere else closes the type menu — same gesture rule the
    // armed deletes follow. Runs in the bubble phase alongside them.
    document.addEventListener('click', (event) => {
      if (this.typeMenuOpen && !(event.target as HTMLElement | null)?.closest('.snap-type-wrap')) {
        this.closeTypeMenu();
      }
    });

    // Escape with the menu open closes THE MENU, not the sheet — the
    // capture phase outruns the modal layer's document listener, so the
    // first press is the menu's, and only a second press (menu already
    // shut) reaches the sheet. With the menu shut but a TYPE filter in
    // force (and no text query — the field owns that case), Escape
    // clears the filter first, by the same muscle memory: the narrowest
    // state gives way before the sheet itself closes.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') {
          return;
        }
        if (this.typeMenuOpen) {
          e.stopPropagation();
          e.preventDefault();
          this.closeTypeMenu();
          (document.getElementById('snapshotTypeFilter') as HTMLButtonElement | null)?.focus();
          return;
        }
        const modal = document.getElementById('snapshotsModal');
        const search = document.getElementById('searchSnapshots') as HTMLInputElement | null;
        if (
          this.typeFilter !== null &&
          modal?.classList.contains('in') &&
          (search?.value.trim() ?? '') === ''
        ) {
          e.stopPropagation();
          e.preventDefault();
          this.setTypeFilter(null);
        }
      },
      true,
    );

    // Search snapshots — filters the cached rows; no store read per keystroke.
    document.getElementById('searchSnapshots')?.addEventListener('input', (e) => {
      this.renderRows((e.target as HTMLInputElement).value);
    });

    // The search field's clear button — the visible twin of the Escape
    // shortcut. Hidden while the field is empty; clicking resets the list
    // and hands the focus back so typing continues where it left off.
    document.getElementById('clearSnapshotSearch')?.addEventListener('click', () => {
      const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
      if (!input) {
        return;
      }
      input.value = '';
      this.renderRows('');
      input.focus();
    });

    // Escape in the search field clears the filters first — the input has a
    // clear button now, but the reset muscle memory from every other search
    // box still applies. A text query goes first; an empty field with a
    // type filter active clears THAT. stopPropagation keeps the
    // document-level Escape handler from closing the modal under the same
    // press (the type menu's capture listener has already had its turn).
    document.getElementById('searchSnapshots')?.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (e.key === 'Escape' && input.value !== '') {
        e.stopPropagation();
        input.value = '';
        this.renderRows('');
      } else if (e.key === 'Escape' && this.typeFilter !== null) {
        e.stopPropagation();
        this.setTypeFilter(null);
      }
    });

    // "/" focuses the search — the list browsers' convention. The
    // listener rides on document because focus can sit on the body (the
    // dialog is open but nothing inside it holds focus); the guard keeps
    // the shortcut scoped to the open menu, and typing inside any field
    // must not loop back into the field.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const modal = document.getElementById('snapshotsModal');
      if (!modal || !modal.classList.contains('in')) {
        return;
      }
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
      if (input) {
        e.preventDefault();
        input.focus();
      }
    });

    // The no-match empty state's recovery action — clears whatever
    // filtered the list into that dead end (the query, the type
    // filter, or both) without making the user find the tiny ×.
    document.getElementById('clearSearchFromEmpty')?.addEventListener('click', () => {
      const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
      if (input) {
        input.value = '';
      }
      this.setTypeFilter(null);
      this.renderRows('');
    });

    // Keyboard shortcut: the platform's primary modifier + U
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyU') {
        e.preventDefault();
        void this.createSnapshot();
      }
    });
  }

  // Create a new snapshot of the ACTIVE note — or decline politely when
  // it adds nothing.
  async createSnapshot(title?: string): Promise<void> {
    // Capture from the note itself, not the editor DOM: a non-html note's
    // editor shows a placeholder card — its real content lives in the model.
    const captured = getActiveNoteContent();
    if (!captured) {
      return;
    }
    const activeTab = getTabManager()?.getActive();
    await this.createSnapshotFromCapture(
      captured.content,
      captured.noteType,
      activeTab?.id,
      title,
      { emptyToast: true, duplicateToast: true },
      activeTab?.colorTheme,
      activeTab?.name ?? undefined,
    );
  }

  /**
   * Safety snapshot of a note that is NOT (or no longer) the active one —
   * the close-tab path. Content comes from the tab's model (the note is
   * not mounted in the editor), and declines stay silent: the caller
   * promised "a snapshot is saved before it closes", which an identical
   * existing snapshot already satisfies.
   */
  async createSnapshotFromNote(
    content: string,
    noteType: NoteType | undefined,
    noteId: string,
    title: string,
    colorTheme?: 'light' | 'dark',
    noteName?: string,
  ): Promise<void> {
    await this.createSnapshotFromCapture(
      content,
      noteType,
      noteId,
      title,
      {
        emptyToast: false,
        duplicateToast: false,
        // Silent by contract — the caller already owns the confirmation
        // toast ("Tab closed", "Notes deleted"), and a background "Snapshot
        // created!" landing after it would replace the user-facing message.
        successToast: false,
      },
      colorTheme,
      noteName,
    );
  }

  // The one writer — every path funnels here, QUEUED so concurrent
  // captures re-check duplicates against each other's writes.
  private async createSnapshotFromCapture(
    noteContent: string,
    noteType: NoteType | undefined,
    noteId: string | undefined,
    title: string | undefined,
    options: {
      emptyToast: boolean;
      duplicateToast: boolean;
      /** Success toast — silent safety copies opt out (default: show). */
      successToast?: boolean;
    },
    colorTheme?: 'light' | 'dark',
    noteName?: string,
  ): Promise<void> {
    const capture = this.writeQueue.then(() =>
      this.writeSnapshotFromCapture(
        noteContent,
        noteType,
        noteId,
        title,
        options,
        colorTheme,
        noteName,
      ),
    );
    // The chain itself never rejects — a failed write must not poison the
    // next capture. The caller still gets THIS capture's outcome.
    this.writeQueue = capture.then(
      () => undefined,
      () => undefined,
    );
    await capture;
  }

  // The queued capture body — runs strictly after the previous capture
  // landed, so the duplicate check sees every write before it.
  private async writeSnapshotFromCapture(
    noteContent: string,
    noteType: NoteType | undefined,
    noteId: string | undefined,
    title: string | undefined,
    options: {
      emptyToast: boolean;
      duplicateToast: boolean;
      /** Success toast — silent safety copies opt out (default: show). */
      successToast?: boolean;
    },
    colorTheme?: 'light' | 'dark',
    noteName?: string,
  ): Promise<void> {
    if (!this.db) {
      // Wait for the IDB open to finish instead of silently dropping the
      // snapshot. Previously the safety snapshot in utils.deleteNotes was
      // lost if the user hit Ctrl+Shift+Delete within the first ~50 ms of
      // boot — the note was deleted without a backup.
      try {
        await this.ready();
      } catch {
        console.error('Snapshots database unavailable — cannot create snapshot.');
        return;
      }
    }
    if (!this.db) {
      // ready() resolved but the DB is still null (defensive — should not happen).
      console.error('Snapshots database not initialized after ready().');
      return;
    }

    if (!snapshotHasContent(noteContent, noteType)) {
      if (options.emptyToast) {
        showToast('Note is empty. Nothing to save as snapshot.');
      }
      return;
    }

    // The same bytes as ANY of this note's snapshots add nothing —
    // decline. Comparing only the newest used to let the restore loop
    // (v1 → v2 → restore v1 → capture) file v1 twice; the whole history
    // of THIS note is the check, read through the noteId index (never
    // the whole store). Unattributed captures (no noteId — a legacy
    // caller) cannot be scoped, so they skip the check.
    if (noteId) {
      const rows = await readSnapshotsForNote(this.db, this.storeName, noteId);
      const duplicate = rows.find((row) =>
        isSameSnapshotState(row, { content: noteContent, noteType }),
      );
      if (duplicate) {
        if (options.duplicateToast) {
          // Two honest declines: nothing changed since the last one, or
          // this exact version already exists deeper in the history.
          const isLatest = rows[0] !== undefined && duplicate.id === rows[0].id;
          showToast(
            isLatest ? 'No changes since the last snapshot.' : 'This version is already saved.',
          );
        }
        return;
      }
    }

    // Generate a title from the first line of the note if not provided
    const noteTitle = title || deriveSnapshotTitle(noteContent, noteType);

    const timestamp = Date.now();
    const snapshot: Snapshot = {
      ...(noteId ? { noteId } : {}),
      ...(noteName ? { noteName } : {}),
      title: noteTitle,
      content: noteContent,
      ...(noteType ? { noteType } : {}),
      ...(colorTheme ? { colorTheme } : {}),
      preview: deriveSnapshotPreview(noteContent, noteType),
      timestamp: timestamp,
      // Written for older builds' sake; this module renders from timestamp.
      formattedDate: formatSnapshotTimestamp(timestamp),
    };

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    // The prune call below needs a stable reference after this callback
    // returns — `this.db` narrowing does not survive into event callbacks.
    const database = this.db;
    const showCreatedToast = options.successToast !== false;

    // The function is async and callers await it to ORDER effects (the
    // restore path's "Snapshot restored!" must not be clobbered by this
    // write's own toast landing a microtask later) — so the promise must
    // settle when the WRITE settles, not when the handlers are attached.
    // Resolves on error too: a failed safety write must not wedge the
    // caller's flow (the restore/close already has the user's consent).
    await new Promise<void>((resolve) => {
      const request = store.add(snapshot);

      request.onsuccess = () => {
        // The new row flashes once when the list next renders — this is
        // that row's id (the store's auto-increment key).
        this.pendingHighlightId = request.result as number;
        if (showCreatedToast) {
          showToast('Snapshot created!', 'success');
        }

        // A filter that would hide the row the user JUST created is a
        // trap — the flash would land on a row the list refuses to show.
        // Clearing it is the least-surprise move: the new snapshot is the
        // thing the user asked for, the filter was yesterday's context.
        // (The text check reuses the row's own searchable text; the type
        // check the same normalization every comparison here applies.)
        const term = this.currentSearchTerm().trim().toLowerCase();
        if (term !== '' && !snapshotSearchText(snapshot).includes(term)) {
          const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
          if (input) {
            input.value = '';
          }
        }
        if (this.typeFilter !== null && !snapshotMatchesTypeFilter(snapshot, this.typeFilter)) {
          this.typeFilter = null;
        }

        // A store that only ever grows is a slow leak: retire the oldest
        // snapshots beyond the cap so safety copies stay bounded.
        pruneSnapshots(database, this.storeName)
          .then((pruned) => {
            if (pruned > 0) {
              void this.loadSnapshots(this.currentSearchTerm());
              void this.updateSnapshotsCount();
            }
          })
          .catch((error) => {
            console.warn(
              '[snapshots] prune failed — the cap will retry on the next snapshot',
              error,
            );
          });

        void this.loadSnapshots(this.currentSearchTerm());
        void this.updateSnapshotsCount();
        resolve();
      };

      request.onerror = (event) => {
        console.error('Error creating snapshot', event);
        showToast('Error creating snapshot');
        resolve();
      };
    });
  }

  /** The search field's live value — what any re-render must honor. A
   *  capture or delete that refreshed the list while a filter was active
   *  used to re-render unfiltered, leaving rows that defy the query still
   *  sitting under it. */
  private currentSearchTerm(): string {
    return (document.getElementById('searchSnapshots') as HTMLInputElement | null)?.value ?? '';
  }

  /** Every snapshot, newest first (the read order the UI wants). Waits for
   *  the database open — a menu opened in the first moments of boot must
   *  not read a null database and declare an existing store empty. */
  private async readAllSnapshots(): Promise<Snapshot[]> {
    await this.ready().catch(() => undefined);
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }
      const request = this.db
        .transaction([this.storeName], 'readonly')
        .objectStore(this.storeName)
        .getAll();
      request.onsuccess = () => {
        const rows = (request.result as Snapshot[]).slice();
        // getAll returns key order (insertion); the UI wants time order —
        // and on a timestamp tie (two captures in one millisecond, legacy
        // stores), the HIGHER id is the later write and leads.
        rows.sort((a, b) => b.timestamp - a.timestamp || (b.id ?? 0) - (a.id ?? 0));
        resolve(rows);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Load all snapshots into the list, filtered by the search term. One
  // store read per load; keystrokes re-filter the cached rows.
  async loadSnapshots(searchTerm: string = ''): Promise<void> {
    const snapshots = await this.readAllSnapshots();
    this.cache = snapshots.map((snapshot) => ({
      snapshot,
      searchText: snapshotSearchText(snapshot),
    }));
    this.renderRows(searchTerm);
  }

  /** The change badge of every row that has one — computed against the
   *  UNFILTERED timeline, so a search that hides the previous snapshot of
   *  a note still reports the honest delta against the true previous
   *  version, not whichever neighbor survived the filter. Keyed by the
   *  row's store id. Rows group by their NOTE (the version chain lives
   *  inside a note, not inside a note type) — cache order is already
   *  newest-first, so the first earlier row with the same noteId is the
   *  previous version. */
  private computeChangeBadges(): Map<number, SnapshotChangeBadge> {
    const badges = new Map<number, SnapshotChangeBadge>();
    const rows = this.cache.map((row) => row.snapshot);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.noteId || row.id === undefined) {
        continue;
      }
      const previous = rows.slice(i + 1).find((candidate) => candidate.noteId === row.noteId);
      if (!previous) {
        continue; // the note's first snapshot — the baseline, no badge
      }
      const badge = snapshotChangeBadge(row, previous);
      if (badge) {
        badges.set(row.id, badge);
      }
    }
    return badges;
  }

  // Render the cached rows through the current search term — ONE
  // continuous timeline: day runs anchor the rail (Today / Yesterday /
  // the date — always present, a run of entries needs its anchor even
  // when every entry is from today), entries inside a run stay
  // newest-first, and the rail's line breaks only at day boundaries.
  private renderRows(searchTerm: string = ''): void {
    const snapshotsList = document.getElementById('snapshotsList');
    const noSnapshots = document.getElementById('noSnapshots');
    if (!snapshotsList || !noSnapshots) {
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const filtering = term !== '';
    const typeFiltering = this.typeFilter !== null;
    const rows: Snapshot[] = this.cache
      .filter((row) => !filtering || row.searchText.includes(term))
      .filter((row) => snapshotMatchesTypeFilter(row.snapshot, this.typeFilter))
      .map((row) => row.snapshot);

    // The 'Current' chip answers one question — is this row the note I
    // have open, byte for byte? Read once per render; typing can't race
    // it (the sheet covers the editor).
    const active = getActiveNoteContent();
    const badges = this.computeChangeBadges();

    // ONE Current, ever. Several snapshots can hold the note's exact
    // bytes — a restore chain (restore → safety copy → capture) sees to
    // it — but a chip on each of them answers "which version am I in?"
    // twice, which is no answer. The newest identical row wears the
    // chip; its older twins stay plain history. Rows are newest-first,
    // so the first match IS the newest.
    const currentRowId = rows.find((row) => isCurrentSnapshotState(row, active))?.id;

    // Day runs — the pure helper suppresses itself when every row is
    // from today (a behavior pinned to the old sectioned menu); the
    // timeline wants its anchor regardless, so a same-day list becomes
    // one synthesized run.
    let dayGroups = snapshotDayGroups(rows);
    if (rows.length > 0 && dayGroups.length === 0) {
      dayGroups = [{ key: snapshotDayKey(rows[0].timestamp), label: 'Today', rows }];
    }

    snapshotsList.innerHTML = '';
    let highlighted = false;
    for (const group of dayGroups) {
      const dayHeader = document.createElement('li');
      dayHeader.className = 'snap-day';
      dayHeader.setAttribute('aria-hidden', 'false');
      dayHeader.textContent = group.label;
      snapshotsList.appendChild(dayHeader);

      group.rows.forEach((snapshot, index) => {
        const li = this.createTimelineItem(
          snapshot,
          badges.get(snapshot.id ?? -1),
          filtering ? term : '',
        );
        li.classList.toggle(
          'is-current',
          snapshot.id !== undefined && snapshot.id === currentRowId,
        );
        if (index === 0) {
          li.classList.add('group-start');
        }
        if (index === group.rows.length - 1) {
          li.classList.add('group-end');
        }
        if (snapshot.id !== undefined && snapshot.id === this.pendingHighlightId) {
          li.classList.add('is-new');
          this.pendingHighlightId = null;
          highlighted = true;
        }
        snapshotsList.appendChild(li);
      });
    }

    // A just-taken snapshot lands at the top of a long list — bring it
    // into view so the flash is not wasted off-screen.
    if (highlighted) {
      snapshotsList.querySelector('.snap-item.is-new')?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }

    // The empty state has two faces: nothing stored yet, or nothing that
    // matched the search. They share the icon; the copy must not lie —
    // and the miss face carries a recovery action, a one-click way out of
    // the dead end the query built.
    const hasAny = this.cache.length > 0;
    const hasRows = rows.length > 0;
    snapshotsList.style.display = hasRows ? 'block' : 'none';
    noSnapshots.style.display = hasRows ? 'none' : 'flex';
    const showMiss = hasAny && !hasRows;
    document.getElementById('noSnapshotsEmpty')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsHint')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsMiss')?.toggleAttribute('hidden', !showMiss);
    document.getElementById('clearSearchFromEmpty')?.toggleAttribute('hidden', !showMiss);

    // The search field's trailing chrome tracks the query: the live result
    // count sits beside the text it describes (the footer is a glance
    // away, the count is not), and the clear button appears only when
    // there is something to clear.
    const searchMeta = document.getElementById('snapshotSearchMeta');
    if (searchMeta) {
      searchMeta.textContent = filtering
        ? `${rows.length} ${rows.length === 1 ? 'hit' : 'hits'}`
        : '';
      searchMeta.toggleAttribute('hidden', !filtering);
    }
    const clearBtn = document.getElementById('clearSnapshotSearch');
    clearBtn?.toggleAttribute('hidden', !filtering);
    // The "/" hint retires while a query runs — the × and the count own
    // the field's trailing edge then.
    document.querySelector('.snap-search')?.classList.toggle('has-query', filtering);

    // The footer tells the truth about what is on stage: the filtered
    // count against the whole store while any filter runs (query or
    // type), the store's size against its cap otherwise.
    const countElement = document.getElementById('snapshotsCount');
    if (countElement) {
      countElement.textContent =
        filtering || typeFiltering
          ? `${rows.length} of ${this.cache.length}`
          : `${this.cache.length} of ${MAX_SNAPSHOTS}`;
    }

    // The type button mirrors the state it owns: its label, its active
    // dress, and whether there is anything to filter at all.
    this.renderTypeButton();
  }

  /** The type filter's trigger button — label, active dress, and
   *  disabled while the store is empty (a menu of one empty row is not
   *  a control). */
  private renderTypeButton(): void {
    const button = document.getElementById('snapshotTypeFilter') as HTMLButtonElement | null;
    const label = document.getElementById('snapshotTypeLabel');
    if (!button || !label) {
      return;
    }
    label.textContent =
      this.typeFilter === null
        ? 'All types'
        : (SNAPSHOT_SECTION_LABELS[this.typeFilter] ?? noteTypeLabel(this.typeFilter as NoteType));
    button.classList.toggle('is-active', this.typeFilter !== null);
    button.disabled = this.cache.length === 0;
  }

  /** The type menu, rebuilt on every open so its counts read the store
   *  as it is NOW. "All types" leads; then each type PRESENT in the
   *  store, in the registry's order (unknown ids trailing), each with
   *  its live count and the check on the active one. Types the store
   *  has never heard of get no rows — a filter that matches nothing is
   *  a dead end the menu should not offer. */
  private renderTypeMenu(): void {
    const menu = document.getElementById('snapshotTypeMenu');
    if (!menu) {
      return;
    }
    const counts = new Map<string, number>();
    for (const row of this.cache) {
      const key = normalizeNoteType(row.snapshot.noteType) ?? 'standard';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const orderOf = (key: string): number => {
      const index = NOTE_TYPES.findIndex((def) => def.id === key);
      return index === -1 ? NOTE_TYPES.length : index;
    };
    const present = [...counts.keys()].sort(
      (a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b),
    );

    const option = (key: string, labelText: string, icon: string, count: number): string => {
      const value = key === '' ? '' : key;
      const selected = (key === '' && this.typeFilter === null) || this.typeFilter === key;
      return `
                <button type="button" class="snap-type-opt${selected ? ' is-selected' : ''}" role="menuitemradio" aria-checked="${selected}" data-type="${value}">
                    <span class="snap-type-opt-ico" aria-hidden="true">${icon}</span>
                    <span class="snap-type-opt-label">${this.escapeHtml(labelText)}</span>
                    <span class="snap-type-opt-count">${count}</span>
                    <span class="snap-type-opt-check" aria-hidden="true">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    </span>
                </button>`;
    };

    const rowsHtml = [
      option('', 'All types', SNAPSHOT_ALL_TYPES_ICON, this.cache.length),
      ...present.map((key) =>
        option(
          key,
          SNAPSHOT_SECTION_LABELS[key] ?? noteTypeLabel(key as NoteType),
          snapshotTypeIcon(key === 'standard' ? undefined : key),
          counts.get(key) ?? 0,
        ),
      ),
    ].join('');

    menu.innerHTML = rowsHtml;
    menu.querySelectorAll('.snap-type-opt').forEach((el) => {
      el.addEventListener('click', () => {
        const value = (el as HTMLElement).dataset.type || null;
        this.setTypeFilter(value);
        this.closeTypeMenu();
      });
    });
  }

  /** Applies a type choice and re-renders. null is "all types". */
  private setTypeFilter(type: string | null): void {
    this.typeFilter = type;
    this.renderRows(this.currentSearchTerm());
  }

  private openTypeMenu(): void {
    const menu = document.getElementById('snapshotTypeMenu');
    const button = document.getElementById('snapshotTypeFilter');
    if (!menu || !button) {
      return;
    }
    this.renderTypeMenu();
    menu.removeAttribute('hidden');
    button.setAttribute('aria-expanded', 'true');
    this.typeMenuOpen = true;
  }

  private closeTypeMenu(): void {
    const menu = document.getElementById('snapshotTypeMenu');
    const button = document.getElementById('snapshotTypeFilter');
    if (menu) {
      menu.setAttribute('hidden', '');
    }
    if (button) {
      button.setAttribute('aria-expanded', 'false');
    }
    this.typeMenuOpen = false;
  }

  // Build one timeline entry — a button row (clock + rail dot + the
  // version's headline) over an in-place detail card. The row expands;
  // the card owns the actions: Restore (one click), Copy, and Delete
  // (two-step inline confirm). Under an active query, the title and
  // preview carry the highlighted matches.
  createTimelineItem(
    snapshot: Snapshot,
    change?: SnapshotChangeBadge,
    highlightTerm?: string,
  ): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'snap-item';
    li.dataset.snapshotId = String(snapshot.id ?? '');

    // The source note's NAME — the identity a mixed timeline owes the
    // reader. Unnamed notes store nothing (their first line IS their
    // label, which the name line already shows); a name that merely
    // repeats the title adds noise, not identity.
    const noteChip =
      snapshot.noteName && snapshot.noteName !== snapshot.title
        ? `<span class="snap-note" title="From the note \u201c${this.escapeHtml(snapshot.noteName)}\u201d">${this.escapeHtml(snapshot.noteName)}</span>`
        : '';

    // The detail card's text — the readable projection, capped so a
    // giant note cannot turn the card into a wall.
    const readable = snapshotReadableText(snapshot.content, snapshot.noteType).trim();
    const expandText =
      readable.length > SNAPSHOT_EXPAND_CAP
        ? `${readable.slice(0, SNAPSHOT_EXPAND_CAP)}\u2026`
        : readable;
    const detailId = `snapshot-detail-${snapshot.id ?? 'x'}`;

    // The version's diffstat — what changed since the previous snapshot
    // of this note. A note's first snapshot carries nothing (it is the
    // baseline); a rewording that keeps the count carries an honest ±0.
    const delta = change
      ? `<span class="snap-delta ${change.delta > 0 ? 'is-up' : change.delta < 0 ? 'is-down' : 'is-flat'}" title="Change since the previous snapshot of this note">${change.delta > 0 ? '+' : change.delta < 0 ? '\u2212' : '\u00b1'}${Math.abs(change.delta)} ${this.escapeHtml(change.unit)}</span>`
      : '';

    const titleHtml = highlightTerm
      ? highlightMatches(snapshot.title, highlightTerm)
      : this.escapeHtml(snapshot.title);

    // The preview usually opens with the note's own first line — the
    // title the row already shows. The echo spends the row's one
    // preview line saying the same thing twice; strip the title (and
    // the markup glue before it) so the line starts at NEW text. A
    // preview that is entirely its title collapses away.
    const previewForDisplay = ((): string => {
      const raw = snapshot.preview.trimStart();
      const cleaned = raw.replace(/^[#>\-*•\s]+/, '');
      const title = snapshot.title.trim();
      if (title && cleaned.toLowerCase().startsWith(title.toLowerCase())) {
        const rest = cleaned
          .slice(title.length)
          .replace(/^[\s:：\-–—•*]+/, '')
          .trimStart();
        return rest;
      }
      return raw;
    })();
    const previewHtml = highlightTerm
      ? highlightMatches(previewForDisplay, highlightTerm)
      : this.escapeHtml(previewForDisplay);

    // Where restore sends this version — the card says the target's
    // name before the click, not a dialog's after it.
    const manager = getTabManager();
    const source = snapshot.noteId
      ? manager?.allTabs.find((tab) => tab.id === snapshot.noteId)
      : undefined;
    const resurrect = !snapshot.noteId ? false : !source;
    const targetName =
      snapshot.noteName ||
      snapshot.title ||
      deriveSnapshotTitle(snapshot.content, snapshot.noteType);
    const restoreHint = resurrect
      ? `Recreates \u201c${this.escapeHtml(targetName)}\u201d as its own note \u2014 your current text is saved first.`
      : `Restores into \u201c${this.escapeHtml(targetName)}\u201d \u2014 your current text is saved first.`;

    li.innerHTML = `
            <button type="button" class="snap-row" aria-expanded="false" aria-controls="${detailId}" title="Show this version">
                <span class="snap-when" title="${this.escapeHtml(formatSnapshotTimestamp(snapshot.timestamp))}">${this.escapeHtml(formatSnapshotClock(snapshot.timestamp))}</span>
                <span class="snap-rail" aria-hidden="true"></span>
                <span class="snap-what">
                    <span class="snap-line">
                        <span class="snap-name" title="${this.escapeHtml(snapshot.title)}">${titleHtml}</span>
                        ${noteChip}
                        <span class="snap-current" title="This version is what the note holds right now"><span class="snap-current-dot" aria-hidden="true"></span>Current</span>
                    </span>
                    <span class="snap-preview" title="${this.escapeHtml(previewForDisplay)}">${previewHtml}</span>
                    ${delta}
                </span>
            </button>
            <div class="snap-detail" id="${detailId}" role="region" aria-label="Snapshot details" hidden>
                <div class="snap-detail-text">${this.escapeHtml(expandText) || 'No content'}</div>
                <div class="snap-detail-meta">
                    <span>${this.escapeHtml(formatSnapshotTimestamp(snapshot.timestamp))}</span>
                    <span class="snap-detail-sep" aria-hidden="true">\u00b7</span>
                    <span>${this.escapeHtml(snapshotTypeBadgeLabel(snapshot.noteType ?? 'standard'))}</span>
                </div>
                <div class="snap-detail-actions">
                    <button type="button" class="snap-act restore">Restore</button>
                    <button type="button" class="snap-act copy" title="Copy content" aria-label="Copy snapshot content">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <span class="snap-detail-spacer" aria-hidden="true"></span>
                    <button type="button" class="snap-act delete" title="Delete this snapshot">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11V17"></path><path d="M14 11V17"></path><path d="M4 7H20"></path><path d="M6 7H12H18V18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18V7Z"></path><path d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V7H9V5Z"></path></svg>
                        <span class="snap-act-delete-label">Delete</span>
                    </button>
                </div>
                <p class="snap-detail-hint">${restoreHint}</p>
            </div>
        `;

    // The row's button expands the detail card — accordion style: one
    // open entry at a time keeps the sheet tidy and the rail readable.
    const rowBtn = li.querySelector<HTMLElement>('.snap-row')!;
    rowBtn.addEventListener('click', () => {
      const wasOpen = li.classList.contains('is-open');
      document
        .getElementById('snapshotsList')
        ?.querySelectorAll('.snap-item.is-open')
        .forEach((other) => {
          if (other !== li) {
            other.classList.remove('is-open');
            other.querySelector('.snap-row')?.setAttribute('aria-expanded', 'false');
            other.querySelector('.snap-detail')?.setAttribute('hidden', '');
          }
        });
      const open = !wasOpen;
      li.classList.toggle('is-open', open);
      rowBtn.setAttribute('aria-expanded', String(open));
      li.querySelector('.snap-detail')?.toggleAttribute('hidden', !open);
    });

    // Actions
    const restoreBtn = li.querySelector('.restore')!;
    const copyBtn = li.querySelector('.copy')!;
    const deleteBtn = li.querySelector<HTMLElement>('.delete')!;

    // Restore needs no dialog: the pre-restore safety copy is the undo
    // path, so one click applies and the list re-renders with feedback.
    restoreBtn.addEventListener('click', () => this.restoreSnapshot(snapshot.id));
    copyBtn.addEventListener('click', () => this.copySnapshot(snapshot.id, copyBtn));

    // Delete — arm, then confirm, on the button itself. A legacy row
    // with no store id cannot be armed (there is nothing to key the
    // armed state on) — it deletes on the confirming second press of
    // the arm path only, so here it goes straight through.
    deleteBtn.addEventListener('click', () => {
      if (snapshot.id === undefined) {
        this.deleteSnapshot(snapshot.id);
        return;
      }
      if (this.armedDeleteId !== null && this.armedDeleteId !== snapshot.id) {
        this.disarmDelete();
      }
      if (this.armedDeleteId === snapshot.id) {
        this.disarmDelete();
        this.deleteSnapshot(snapshot.id);
        return;
      }
      this.armDelete(snapshot.id, deleteBtn);
    });

    return li;
  }

  /** Arms a row-delete button: the label swaps to "Confirm", the button
   *  turns danger, and a few seconds of silence disarms it. One armed
   *  delete at a time — arming another row disarms this one. */
  private armDelete(id: number, button: HTMLElement): void {
    this.disarmDelete();
    this.armedDeleteId = id;
    button.classList.add('is-armed');
    const label = button.querySelector('.snap-act-delete-label');
    if (label) {
      label.textContent = 'Confirm';
    }
    this.armedDeleteTimer = window.setTimeout(() => this.disarmDelete(), 4000);
  }

  /** Returns a delete button to its quiet state (idempotent). */
  private disarmDelete(): void {
    if (this.armedDeleteTimer !== null) {
      window.clearTimeout(this.armedDeleteTimer);
      this.armedDeleteTimer = null;
    }
    if (this.armedDeleteId === null) {
      return;
    }
    this.armedDeleteId = null;
    document.querySelectorAll('.snap-act.delete.is-armed').forEach((button) => {
      button.classList.remove('is-armed');
      const label = button.querySelector('.snap-act-delete-label');
      if (label) {
        label.textContent = 'Delete';
      }
    });
  }

  // Restore a snapshot — into THE NOTE IT CAME FROM.
  //
  // A snapshot records its source note; restore honors that identity:
  //   • the note is open → bring it on stage and restore THERE;
  //   • the note is gone → resurrect it as its own note (its recorded
  //     name, the snapshot's type and content);
  //   • a legacy row with no noteId → the active note, the only target
  //     it can name.
  // A restore must never overwrite an unrelated note just because it
  // happened to be the one on screen — that was the old behavior, and
  // it ate notes.
  //
  // There is NO confirmation dialog: the safety copy taken right before
  // the apply preserves whatever the target held, so the destructive
  // part is undoable by construction and the ask would be theater. The
  // detail card already named the target before the click.
  restoreSnapshot(snapshotId: number | undefined): void {
    if (snapshotId === undefined || !this.db) {
      return;
    }

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.get(snapshotId);

    request.onsuccess = async (event) => {
      const snapshot = (event.target as IDBRequest).result as Snapshot | undefined;
      const manager = getTabManager();
      if (!snapshot || !manager) {
        return;
      }
      const snapshotState = {
        content: snapshot.content,
        noteType: snapshot.noteType as NoteType | undefined,
      };

      // 1. Resolve the target: the snapshot's source note.
      const source = snapshot.noteId
        ? manager.allTabs.find((tab) => tab.id === snapshot.noteId)
        : undefined;
      // Rows from before attribution can only name the active note.
      const legacy = !snapshot.noteId;
      // A recorded note that no longer exists — restore resurrects it.
      const resurrect = legacy ? false : !source;

      // 2. Bring the target on stage — both restore seams (the safety
      //    copy and applySnapshotToActive) speak "active note". A
      //    resurrected note is born empty: nothing to lose.
      const active = manager.getActive();
      if (source && source.id !== active?.id) {
        manager.switchTo(source.id, false);
      }
      if (resurrect) {
        const revived = manager.addBackgroundNote(
          snapshot.noteName ?? '',
          snapshot.noteType ?? DEFAULT_NOTE_TYPE,
          '',
        );
        if (!revived) {
          showToast('Cannot restore — the notes list is at its cap.');
          return;
        }
        manager.switchTo(revived.id, false);
      }

      // 3. Safety copy of what the target holds RIGHT NOW (post-switch
      //    truth), attributed to the target note: this copy IS the undo
      //    path that makes the restore safe without a confirm dialog.
      //    Declines (empty / identical) are silent — an identical
      //    existing snapshot already satisfies the promise.
      const preRestore = getActiveNoteContent();
      if (
        preRestore &&
        snapshotHasContent(preRestore.content, preRestore.noteType) &&
        !isSameSnapshotState(preRestore, snapshotState)
      ) {
        const targetTab = manager.getActive();
        try {
          await this.createSnapshotFromCapture(
            preRestore.content,
            preRestore.noteType,
            targetTab?.id,
            `Before restoring "${snapshot.title}"`,
            // Silent: the "Snapshot restored!" toast below is the
            // user-facing message for this action — the safety copy
            // is a background detail and must not replace it.
            { emptyToast: false, duplicateToast: false, successToast: false },
            targetTab?.colorTheme,
            targetTab?.name ?? undefined,
          );
        } catch {
          /* the restore still proceeds — the safety copy is best-effort */
        }
      }

      // 4. The one restore path: it moves the note's type with the
      //    content and re-announces the active note so the chrome
      //    (toolbar, editor port, tab badge) follows the restored kind.
      //    Old snapshots hold plain text on the html path — the editor
      //    renders it faithfully, newlines and all.
      manager.applySnapshotToActive(
        snapshot.content,
        snapshot.noteType as NoteType | undefined,
        snapshot.colorTheme,
      );
      updateWordCountPill(getEditorText());

      showToast('Snapshot restored!', 'success');

      // The menu STAYS OPEN — the restore is mid-conversation, not the
      // end of one: the next version to compare (or restore) is right
      // there, the row that now matches the note picks up the Current
      // chip as direct feedback, and the pre-restore copy lands on top
      // with its flash. Closing is the user's move.
      this.pendingHighlightId = null;
      void this.loadSnapshots(this.currentSearchTerm());
    };

    request.onerror = (event) => {
      console.error('Error restoring snapshot', event);
      showToast('Error restoring snapshot');
    };
  }

  // Copy a snapshot content to clipboard
  copySnapshot(snapshotId: number | undefined, buttonElement: Element): void {
    if (snapshotId === undefined || !this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.get(snapshotId);

    request.onsuccess = (event) => {
      const snapshot = (event.target as IDBRequest).result as Snapshot | undefined;
      if (snapshot) {
        // Use the Clipboard API
        navigator.clipboard
          .writeText(snapshot.content)
          .then(() => {
            this.showCopySuccess(buttonElement);
          })
          .catch((err) => {
            console.error('Failed to copy text: ', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = snapshot.content;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);

            this.showCopySuccess(buttonElement);
          });
      }
    };

    request.onerror = (event) => {
      console.error('Error copying snapshot', event);
      showToast('Error copying snapshot');
    };
  }

  // Show copy success feedback
  showCopySuccess(button: Element): void {
    const originalHTML = button.innerHTML;
    button.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <polyline points="20 6 9 17 4 12"></polyline> </g></svg>';

    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 700);
  }

  // Delete a snapshot — the confirm lives on the BUTTON (arm, then
  // confirm), so this method is only the commit: no dialog stacks over
  // the sheet.
  deleteSnapshot(snapshotId: number | undefined): void {
    if (snapshotId === undefined || !this.db) {
      return;
    }
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.delete(snapshotId);

    request.onsuccess = () => {
      void this.loadSnapshots(this.currentSearchTerm());
      void this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting snapshot', event);
      showToast('Error deleting snapshot');
    };
  }

  /** The footer's Delete all — same two-step contract as the row
   *  delete: the first click arms the button (its label becomes "Really
   *  delete all?"), the second commits. Silence or a click elsewhere
   *  disarms it. */
  private armDeleteAll(): void {
    const button = document.getElementById('deleteAllSnapshotsBtn');
    if (!button) {
      return;
    }
    this.deleteAllArmed = true;
    button.classList.add('is-armed');
    const label = button.querySelector('.snap-delete-all-label');
    if (label) {
      label.textContent = 'Really delete all?';
    }
    this.deleteAllTimer = window.setTimeout(() => this.disarmDeleteAll(), 4000);
  }

  /** Returns the footer button to its quiet state (idempotent). */
  private disarmDeleteAll(): void {
    if (this.deleteAllTimer !== null) {
      window.clearTimeout(this.deleteAllTimer);
      this.deleteAllTimer = null;
    }
    if (!this.deleteAllArmed) {
      return;
    }
    this.deleteAllArmed = false;
    const button = document.getElementById('deleteAllSnapshotsBtn');
    if (button) {
      button.classList.remove('is-armed');
      const label = button.querySelector('.snap-delete-all-label');
      if (label) {
        label.textContent = 'Delete all';
      }
    }
  }

  // Delete all snapshots
  deleteAllSnapshots(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.clear();

    request.onsuccess = () => {
      this.disarmDeleteAll();
      void this.loadSnapshots(this.currentSearchTerm());
      void this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      this.disarmDeleteAll();
      showToast('Error deleting snapshots');
    };
  }

  /** The store's size, against the footer and the delete-all affordance.
   *  The count TEXT itself is renderRows' to write — it knows whether a
   *  search is filtering the list ('12 results' vs '7 of 200') — so this
   *  owns only the button's enabled state. Waits for the database open
   *  like every read: a boot-moment call must not read a null database
   *  and leave the button stuck disabled. */
  async updateSnapshotsCount(): Promise<void> {
    await this.ready().catch(() => undefined);
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const deleteAllBtn = document.getElementById(
        'deleteAllSnapshotsBtn',
      ) as HTMLButtonElement | null;
      if (deleteAllBtn) {
        deleteAllBtn.disabled = countRequest.result === 0;
      }
    };
  }

  // Helper to escape HTML
  escapeHtml(unsafe: string | null | undefined): string {
    if (!unsafe) return '';
    return escapeHtmlText(unsafe.toString());
  }
}

/**
 * Wires the snapshots feature: constructs the manager when the snapshots
 * button exists and exposes the window.createSnapshot hook. Called by
 * boot.ts; used to register itself on DOMContentLoaded.
 */
export function initSnapshots(): void {
  // Only initialize if the snapshots button exists
  if (document.getElementById('snapshotsButton')) {
    window.snapshotsManager = new SnapshotsManager();
  }
}

// Add a global function to create a snapshot (can be called from other parts of the app)
window.createSnapshot = function (title?: string): Promise<void> {
  if (window.snapshotsManager) {
    return window.snapshotsManager.createSnapshot(title);
  }
  console.warn('Snapshots manager not initialized');
  return Promise.resolve();
};
