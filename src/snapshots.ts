/**
 * History — the one sheet: safety copies and deleted notes on a single
 * timeline (src/snapshots.ts owns the versions; the trash rides along
 * from the tab model, TabManager.trashed).
 *
 * The structural contract:
 *
 *  • ONE TIMELINE — versions and trash entries are the same shape (a
 *    timestamped copy of a note, carrying identity), so they share one
 *    chronology, one day-anchored rail, one search field and one row
 *    renderer (src/ui/sheet-kit.ts — the shared vocabulary, born when
 *    the hand-copied twin of this sheet drifted). A trash entry is a
 *    row KIND, not a sheet: the rail dot dresses danger, a chip counts
 *    the retention, and its detail card offers Restore / Delete forever.
 *    The toolbar's segmented filter (All · Versions · Trash) narrows
 *    the timeline without ever reordering it — time stays the only axis.
 *  • IDENTITY — a snapshot records the note it came from (noteId + the
 *    note's NAME). Restore uses that identity: it brings the SOURCE
 *    note on stage and restores THERE; when the note sits in the TRASH,
 *    restore un-deletes it first (same id — share links survive, no
 *    duplicate beside its own grave); when the note is gone entirely,
 *    it resurrects as its own note. A restore must never overwrite an
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
 *    type label) plus the readable projection capped at a few thousand
 *    characters — never raw markup or JSON braces. The field carries
 *    its own trailing chrome: a live result count, a clear button
 *    (Escape works too), a "/" focus shortcut, and highlighted matches
 *    in the rows. A capture that lands while ANY filter (text or
 *    segment) would hide it clears that filter, so the flash the user
 *    is promised is a flash they can see.
 *  • DATES — formatted at render time from the timestamp; the stored
 *    formattedDate field is written for older builds only.
 *  • THE CURRENT CHIP is unique by fiat — several snapshots can hold
 *    the same bytes as the open note (a restore chain guarantees it),
 *    but only the NEWEST of them wears the chip; an older twin is just
 *    history. A trash row never wears it.
 *  • THE SHEET — right-side, docked, ONE continuous timeline (see
 *    11-snapshots.css for the frame). Entries expand in place into a
 *    detail card that owns the actions. The footer reports the store's
 *    truth (versions against the cap, trash beside it) while a query
 *    runs in the field's own hit counter.
 *  • RESTORE — one click, no confirmation dialog: the pre-restore
 *    safety copy (saved automatically right before the apply) is the
 *    undo path, so the ask would be theater. The sheet STAYS OPEN
 *    afterwards: the list re-renders, the restored row picks up the
 *    Current chip, and the next version is right there. Closing is the
 *    user's move.
 *  • DELETES — every destructive button is a two-step INLINE confirm
 *    (arm, then confirm) on the button itself (sheet-kit's
 *    TwoStepConfirm); nothing stacks a dialog over the sheet. Delete
 *    forever means forever: purging a trashed note sweeps that note's
 *    snapshots from the store too (deleteSnapshotsForNotes).
 */
import { $ } from './lib/q';
import { openModal } from './ui/behavior/modal';
import { getActiveNoteContent, getEditorText, getTabManager, htmlToText } from './tabs';
import {
  DEFAULT_NOTE_TYPE,
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
import { TRASH_RETENTION_MS } from '../shared/wire';
import type { TrashedNote } from './storage';
import {
  escapeHtmlText,
  renderSheetTimeline,
  wireSheetTimeline,
  type SheetRowModel,
  TwoStepConfirm,
} from './ui/sheet-kit';

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
 * note's NAME, preview, type label — plus the readable projection of the
 * note capped at a few thousand characters (see snapshotReadableText).
 * Computed once per load and cached on the row, so each keystroke
 * filters strings.
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

/** Truncation that lands on a word boundary — a hard slice feeding a
 *  CSS ellipsis reads as a mid-word cut, and a title is a word thing.
 *  A boundary suspiciously early (a long single word) falls back to the
 *  hard cut; the cap holds either way. */
function capAtWordBoundary(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  const cut = text.slice(0, cap - 3);
  const boundary = cut.lastIndexOf(' ');
  const head = boundary > cap / 2 ? cut.slice(0, boundary) : cut;
  return `${head.trimEnd()}...`;
}

/**
 * The row's title: the first meaningful line of the note's READABLE
 * projection — every kind, not just html ones. A title that quotes the
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
  return capAtWordBoundary(title, 50);
}

/** 100 characters of what the row should show of the note. */
export function deriveSnapshotPreview(content: string, noteType?: string): string {
  const preview = snapshotReadableText(content, noteType).replace(/\s+\n/g, '\n').trim();
  return preview ? capAtWordBoundary(preview, 100) : 'No content';
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

// ---------------------------------------------------------------------------
// Pure helpers — the trash rows (exported so tests pin them without the
// manager's DOM wiring)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A trash row worth showing: words or a name. Tombstone-shaped entries
 * (migrated pre-trash deletes with no content) are invisible: they have
 * nothing to restore and nothing to show, and delete-forever chores for
 * them would be exactly the clutter the trash exists to remove.
 */
export function isRestorableGrave(grave: TrashedNote): boolean {
  return (
    !!(grave.name && grave.name.trim()) ||
    snapshotReadableText(grave.content, grave.noteType).trim() !== ''
  );
}

/** The trash row's retention countdown — how long the note still waits. */
export function trashRetentionChip(
  deletedAt: number,
  now: number = Date.now(),
): { text: string; danger: boolean; title: string } {
  const daysLeft = Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / DAY_MS));
  if (daysLeft <= 0) {
    return {
      text: 'last day',
      danger: true,
      title: 'In the trash — its last day before it goes for good',
    };
  }
  const unit = daysLeft === 1 ? 'day' : 'days';
  return {
    text: `${daysLeft} ${unit}`,
    danger: daysLeft <= 3,
    title: `In the trash — ${daysLeft} ${unit} before it goes for good`,
  };
}

/**
 * A trashed note mapped onto the shared row model. The title is the
 * note's NAME when it has one (the strip the note returns to speaks
 * name-first); the chip counts the retention; the detail card offers
 * Restore (same id, share links survive) and Delete forever (which
 * sweeps this note's snapshots too — forever means forever).
 */
export function trashRowModel(grave: TrashedNote, now: number = Date.now()): SheetRowModel {
  const derived = deriveSnapshotTitle(grave.content, grave.noteType);
  const title = grave.name?.trim() || derived;
  const retention = trashRetentionChip(grave.deletedAt, now);
  const typeLabel = snapshotTypeBadgeLabel(normalizeNoteType(grave.noteType) ?? 'standard');
  return {
    key: `t:${grave.id}`,
    timestamp: grave.deletedAt,
    title,
    noteChip: grave.name?.trim() && grave.name.trim() !== title ? grave.name.trim() : undefined,
    preview: deriveSnapshotPreview(grave.content, grave.noteType),
    chip: retention,
    trash: true,
    detailText: snapshotReadableText(grave.content, grave.noteType),
    detailMeta: [`Trashed ${formatSnapshotTimestamp(grave.deletedAt)}`, typeLabel],
    hint: `Restores \u201c${title}\u201d to the end of your notes — same note, share links keep working.`,
    actions: [
      { kind: 'restore', label: 'Restore' },
      { kind: 'delete', label: 'Delete forever', title: `Delete ${title} for good` },
    ],
  };
}

/** What a trash row is searched by — the same fields a version row is. */
export function trashRowSearchText(grave: TrashedNote): string {
  const model = trashRowModel(grave);
  const label = model.detailMeta?.[1] ?? '';
  const text = snapshotReadableText(grave.content, grave.noteType).slice(0, SNAPSHOT_SEARCH_CAP);
  return `${model.title}\n${grave.name ?? ''}\n${model.preview ?? ''}\n${label}\n${text}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

/** The toolbar's segmented filter — which rows the timeline shows. */
export type HistorySegment = 'all' | 'versions' | 'trash';

export class SnapshotsManager {
  dbName: string;
  storeName: string;
  db: IDBDatabase | null;

  /** The last read, with each row's search text precomputed — keystrokes
   *  filter this array instead of re-reading IndexedDB. */
  private cache: { snapshot: Snapshot; searchText: string }[] = [];

  /** The just-created snapshot's row key — the timeline flashes exactly
   *  this row (and scrolls it into view) once, then clears the flag. */
  private pendingFlashKey: string | null = null;

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

  /** The segmented filter — narrows the timeline, never reorders it;
   *  persists across close/open like the search query. */
  private segment: HistorySegment = 'all';

  /** The trash row's Delete forever — arm, then confirm, in place. */
  private purgeConfirm = new TwoStepConfirm();

  /** The footer's Delete all versions — same two-step contract. */
  private deleteAllConfirm = new TwoStepConfirm();

  /** The footer's Empty trash — same two-step contract. */
  private emptyTrashConfirm = new TwoStepConfirm();

  /** Whether the tab model's persist listener is wired — the timeline
   *  refreshes when the trash moves underneath an open sheet (a sync
   *  merge, the delete toast's Undo). */
  private wiredTabsListener = false;

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
      // Mark the rejection handled BEFORE issuing it: until some caller
      // attaches .ready(), a rejected promise with no handler surfaces as
      // an uncaught page error — noise in exactly the degraded environments
      // (private mode, hardened browsers) this path exists for. Later
      // .ready() callers still receive the rejection.
      this.readyPromise.catch(() => undefined);
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
        // Same unhandled-rejection guard as the unavailable path above.
        this.readyPromise.catch(() => undefined);
        this.rejectReady(error);
      },
    );
  }

  // Setup event listeners
  setupEventListeners(): void {
    // Open the History sheet — a fresh read every time, because the
    // store (and the trash) may have moved under a stale render.
    const openSheet = (): void => {
      this.wireTabsListener();
      openModal($('#snapshotsModal').get(0));
      // Honor the search field's leftover text — reopening used to show the
      // unfiltered list under a stale query.
      void this.loadSnapshots(this.currentSearchTerm());
      // The delete-all affordance re-reads the store on every open — its
      // enabled state was last written at boot (or at the last capture),
      // and a store that changed underneath must not show a stale gray.
      void this.updateSnapshotsCount();
    };
    document.getElementById('snapshotsButton')?.addEventListener('click', openSheet);

    // The rail's trash entry lands on the trash segment — its question,
    // answered directly. Same sheet, pre-filtered.
    document.getElementById('tabRailTrash')?.addEventListener('click', () => {
      this.setSegment('trash');
      openSheet();
    });

    // The timeline's one delegated pair — rows expand, actions dispatch
    // (see wireSheetTimeline). Renders come and go underneath it.
    const list = document.getElementById('snapshotsList');
    if (list) {
      wireSheetTimeline(list, {
        onAction: (key, kind, button) => this.handleSheetAction(key, kind, button),
      });
    }

    // Create snapshot button
    document.getElementById('createSnapshotBtn')?.addEventListener('click', () => {
      void this.createSnapshot();
    });

    // The segmented filter — one tap narrows the timeline, never
    // reorders it.
    document.querySelectorAll('#snapshotSegment .snap-seg-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const seg = (button as HTMLElement).dataset.seg as HistorySegment | undefined;
        if (seg && seg !== this.segment) {
          this.setSegment(seg);
        }
      });
    });

    // Delete all versions — arm on the first press, commit on the
    // second. The button's own label carries the confirm; no dialog
    // stacks over the sheet.
    document.getElementById('deleteAllSnapshotsBtn')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLElement;
      if (this.deleteAllConfirm.tap('versions', button, 'Really delete all?')) {
        this.deleteAllSnapshots();
      }
    });

    // Empty trash — the same two-step contract, scoped to the trash
    // rows (the notes' snapshots go with them: forever means forever).
    document.getElementById('emptyTrashBtn')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLElement;
      if (this.emptyTrashConfirm.tap('trash', button, 'Really empty it?')) {
        this.emptyTrashFromSheet();
      }
    });

    // Escape with a segment narrowed (and no text query — the field owns
    // that case) resets the segment first, by the same muscle memory the
    // search field follows: the narrowest state gives way before the
    // sheet itself closes. Capture phase, so the modal layer's own
    // Escape never sees this press.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') {
          return;
        }
        const modal = document.getElementById('snapshotsModal');
        const search = document.getElementById('searchSnapshots') as HTMLInputElement | null;
        if (
          this.segment !== 'all' &&
          modal?.classList.contains('in') &&
          (search?.value.trim() ?? '') === ''
        ) {
          e.stopPropagation();
          e.preventDefault();
          this.setSegment('all');
        }
      },
      true,
    );

    // Search history — filters the cached rows; no store read per keystroke.
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
    // segment active narrows THAT back to all. stopPropagation keeps the
    // document-level Escape handler from closing the modal under the same
    // press (the capture listener above has already had its turn).
    document.getElementById('searchSnapshots')?.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (e.key === 'Escape' && input.value !== '') {
        e.stopPropagation();
        input.value = '';
        this.renderRows('');
      } else if (e.key === 'Escape' && this.segment !== 'all') {
        e.stopPropagation();
        this.setSegment('all');
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
    // filtered the list into that dead end (the query, the segment, or
    // both) without making the user find the tiny ×.
    document.getElementById('clearSearchFromEmpty')?.addEventListener('click', () => {
      const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
      if (input) {
        input.value = '';
      }
      this.setSegment('all');
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

  /** Wires the tab model's persist listener once — the timeline follows
   *  a trash that moves under an open sheet (a sync merge landing new
   *  graves, the delete toast's Undo, a purge from elsewhere). */
  private wireTabsListener(): void {
    if (this.wiredTabsListener) {
      return;
    }
    const manager = getTabManager();
    if (!manager) {
      return;
    }
    this.wiredTabsListener = true;
    manager.addPersistListener(() => {
      if (document.getElementById('snapshotsModal')?.classList.contains('in')) {
        this.renderRows(this.currentSearchTerm());
      }
    });
  }

  /** The timeline's action dispatcher — one row, one gesture. */
  private handleSheetAction(key: string, kind: string, button: HTMLElement): void {
    const split = key.indexOf(':');
    if (split === -1) {
      return;
    }
    const rowKind = key.slice(0, split);
    const id = key.slice(split + 1);

    if (kind === 'restore' && rowKind === 't') {
      // A trash row's Restore: the note returns under its own id at the
      // end of the strip; the sheet stays open — closing is the user's
      // move.
      const manager = getTabManager();
      if (manager?.restoreNote(id)) {
        const title =
          document.querySelector(`.snap-item[data-row-key="${CSS.escape(key)}"] .snap-name`)
            ?.textContent ?? 'The note';
        showToast(`"${title}" is back in the notes list.`, 'success');
        this.renderRows(this.currentSearchTerm());
      }
      return;
    }

    if (kind === 'restore' && rowKind === 'v') {
      this.restoreSnapshot(Number(id));
      return;
    }

    if (kind === 'copy' && rowKind === 'v') {
      this.copySnapshot(Number(id), button);
      return;
    }

    if (kind === 'delete' && rowKind === 't') {
      // Delete forever — arm, then confirm, on the button itself. The
      // commit sweeps the note's snapshots too (purgeNote).
      if (this.purgeConfirm.tap(key, button, 'Delete forever?')) {
        const manager = getTabManager();
        if (manager?.purgeNote(id)) {
          showToast('Deleted for good.');
          this.renderRows(this.currentSearchTerm());
        }
      }
    }
  }

  /** Applies a segmented choice and re-renders. */
  private setSegment(segment: HistorySegment): void {
    this.segment = segment;
    this.renderSegment();
    this.renderRows(this.currentSearchTerm());
  }

  /** The segmented filter's buttons mirror the state they own. */
  private renderSegment(): void {
    document.querySelectorAll('#snapshotSegment .snap-seg-btn').forEach((node) => {
      const button = node as HTMLElement;
      const active = button.dataset.seg === this.segment;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
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
   * Safety snapshot of a note that is NOT (or no longer) the active one.
   * Content comes from the tab's model (the note is not mounted in the
   * editor), and declines stay silent: the caller promised "a snapshot
   * is saved first", which an identical existing snapshot already
   * satisfies.
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
        // toast ("Note type changed", "Snapshot restored!"), and a
        // background "Snapshot created!" landing after it would replace
        // the user-facing message.
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
        this.pendingFlashKey = `v:${request.result as number}`;
        if (showCreatedToast) {
          showToast('Snapshot created!', 'success');
        }

        // A filter that would hide the row the user JUST created is a
        // trap — the flash would land on a row the list refuses to show.
        // Clearing it is the least-surprise move: the new snapshot is the
        // thing the user asked for, the filter was yesterday's context.
        // (The text check reuses the row's own searchable text.)
        const term = this.currentSearchTerm().trim().toLowerCase();
        if (term !== '' && !snapshotSearchText(snapshot).includes(term)) {
          const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
          if (input) {
            input.value = '';
          }
        }
        if (this.segment === 'trash') {
          this.segment = 'all';
          this.renderSegment();
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

  // Load all snapshots into the cache, filtered by the search term. One
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
   *  inside a note) — cache order is already newest-first, so the first
   *  earlier row with the same noteId is the previous version. */
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

  /** Maps a snapshot onto the shared row model. Current is NOT set here —
   *  ONE Current ever is a decision about the whole timeline (the newest
   *  identical row wears it), which renderRows owns. */
  private versionRowModel(snapshot: Snapshot, change?: SnapshotChangeBadge): SheetRowModel {
    // Where restore sends this version — the card says the target's
    // name before the click, not a dialog's after it.
    const manager = getTabManager();
    const source = snapshot.noteId
      ? manager?.allTabs.find((tab) => tab.id === snapshot.noteId)
      : undefined;
    const grave = snapshot.noteId
      ? manager?.getTrashed().find((entry) => entry.id === snapshot.noteId)
      : undefined;
    const resurrect = !!snapshot.noteId && !source && !grave;
    const targetName =
      snapshot.noteName ||
      snapshot.title ||
      deriveSnapshotTitle(snapshot.content, snapshot.noteType);
    const hint = resurrect
      ? `Recreates \u201c${targetName}\u201d as its own note \u2014 your current text is saved first.`
      : grave
        ? `Brings \u201c${targetName}\u201d back from the trash and restores this version.`
        : `Restores into \u201c${targetName}\u201d \u2014 your current text is saved first.`;

    return {
      key: `v:${snapshot.id ?? 'x'}`,
      timestamp: snapshot.timestamp,
      title: snapshot.title,
      noteChip: snapshot.noteName,
      preview: snapshot.preview,
      detailText: snapshotReadableText(snapshot.content, snapshot.noteType),
      detailMeta: [
        formatSnapshotTimestamp(snapshot.timestamp),
        snapshotTypeBadgeLabel(snapshot.noteType ?? 'standard'),
      ],
      hint,
      delta: change ? { delta: change.delta, unit: change.unit } : undefined,
      actions: [
        { kind: 'restore', label: 'Restore' },
        { kind: 'copy', label: 'Copy content', title: 'Copy content' },
      ],
    };
  }

  // Render the cached versions plus the model's trash through the sheet
  // kit — ONE continuous timeline, day runs anchoring the rail, trash
  // entries a row kind among versions.
  private renderRows(searchTerm: string = ''): void {
    const list = document.getElementById('snapshotsList');
    const empty = document.getElementById('noSnapshots');
    if (!list || !empty) {
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const filtering = term !== '';
    const now = Date.now();
    const manager = getTabManager();
    const graves = (manager?.getTrashed() ?? []).filter(isRestorableGrave);

    // The 'Current' chip answers one question — is this row the note I
    // have open, byte for byte? Read once per render; typing can't race
    // it (the sheet covers the editor).
    const active = getActiveNoteContent();
    const badges = this.computeChangeBadges();

    const filtered = this.cache.filter((row) => !filtering || row.searchText.includes(term));
    const versionModels = filtered.map(({ snapshot }) =>
      this.versionRowModel(snapshot, badges.get(snapshot.id ?? -1)),
    );

    // ONE Current, ever. Several snapshots can hold the note's exact
    // bytes — a restore chain (restore → safety copy → capture) sees to
    // it — but a chip on each of them answers "which version am I in?"
    // twice, which is no answer. The newest identical row wears the
    // chip; its older twins stay plain history. Rows are newest-first,
    // so the first match IS the newest.
    const currentSnapshot = filtered.find(({ snapshot }) =>
      isCurrentSnapshotState(snapshot, active),
    )?.snapshot;
    if (currentSnapshot?.id !== undefined) {
      const winner = versionModels.find((model) => model.key === `v:${currentSnapshot.id}`);
      if (winner) {
        winner.current = true;
      }
    }

    const trashModels = graves
      .filter((grave) => !filtering || trashRowSearchText(grave).includes(term))
      .map((grave) => trashRowModel(grave, now));

    let rows: SheetRowModel[];
    switch (this.segment) {
      case 'versions':
        rows = versionModels;
        break;
      case 'trash':
        rows = trashModels;
        break;
      default:
        rows = [...versionModels, ...trashModels].sort((a, b) => b.timestamp - a.timestamp);
    }

    renderSheetTimeline(list, rows, {
      term: filtering ? term : '',
      flashKey: this.pendingFlashKey,
    });
    this.pendingFlashKey = null;

    // The empty state has faces: nothing stored yet (the copy explains
    // what lands here), or nothing that matched the search (the miss
    // carries a recovery action, a one-click way out of the dead end the
    // query built). They share the icon; the copy must not lie.
    const hasAnyVersions = this.cache.length > 0;
    const hasAnyTrash = graves.length > 0;
    const hasRows = rows.length > 0;
    list.style.display = hasRows ? 'block' : 'none';
    empty.style.display = hasRows ? 'none' : 'flex';
    // The miss face belongs to a QUERY that hid everything — a segment
    // showing its own (empty) kind is that segment's empty face, not a
    // dead end, and must not offer to "clear the filter".
    const showMiss = filtering && (hasAnyVersions || hasAnyTrash) && !hasRows;
    const trashFace = this.segment === 'trash';
    document.getElementById('noSnapshotsEmpty')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsHint')?.toggleAttribute('hidden', showMiss || trashFace);
    document.getElementById('noTrashHint')?.toggleAttribute('hidden', showMiss || !trashFace);
    document.getElementById('noSnapshotsMiss')?.toggleAttribute('hidden', !showMiss);
    document.getElementById('clearSearchFromEmpty')?.toggleAttribute('hidden', !showMiss);
    if (!showMiss) {
      const title = document.getElementById('noSnapshotsEmpty');
      if (title) {
        title.textContent = trashFace ? 'Nothing in the trash.' : 'Nothing here yet.';
      }
    }

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

    // The footer tells the store's truth: versions against the cap, the
    // trash beside it. The filtered story lives in the field's own hit
    // counter — one truth per place, never two numbers disagreeing.
    const countElement = document.getElementById('snapshotsCount');
    if (countElement) {
      countElement.textContent =
        `${this.cache.length} of ${MAX_SNAPSHOTS}` +
        (hasAnyTrash ? ` \u00b7 ${graves.length} in trash` : '');
    }

    // The footer's scoped destructives: versions always visible (disabled
    // against an empty store), trash only when it has something to empty.
    const emptyTrashBtn = document.getElementById('emptyTrashBtn') as HTMLButtonElement | null;
    emptyTrashBtn?.toggleAttribute('hidden', graves.length === 0);
    const deleteAllBtn = document.getElementById(
      'deleteAllSnapshotsBtn',
    ) as HTMLButtonElement | null;
    if (deleteAllBtn) {
      deleteAllBtn.disabled = this.cache.length === 0;
    }

    this.renderSegment();
  }

  // Restore a snapshot — into THE NOTE IT CAME FROM.
  //
  // A snapshot records its source note; restore honors that identity:
  //   • the note is open → bring it on stage and restore THERE;
  //   • the note is in the TRASH → un-delete it first (same id, end of
  //     the strip — share links survive) and restore THERE, never a
  //     duplicate beside its own grave;
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

      // 1. Resolve the target: the note it came from — live, trashed,
      //    or gone.
      const legacy = !snapshot.noteId;
      const source = snapshot.noteId
        ? manager.allTabs.find((tab) => tab.id === snapshot.noteId)
        : undefined;
      const grave = snapshot.noteId
        ? manager.getTrashed().find((entry) => entry.id === snapshot.noteId)
        : undefined;
      const resurrect = !legacy && !source && !grave;

      // A trashed source comes back FIRST, under its own id — the
      // restore then lands on it, so no duplicate is ever born beside
      // the grave it just emptied.
      let cameFromTrash = false;
      if (grave && !source) {
        if (!manager.restoreNote(grave.id)) {
          showToast('Cannot restore — the notes list is at its cap.');
          return;
        }
        cameFromTrash = true;
      }

      // 2. Bring the target on stage — both restore seams (the safety
      //    copy and applySnapshotToActive) speak "active note". A
      //    resurrected note is born empty: nothing to lose.
      if (!legacy) {
        const live = manager.allTabs.find((tab) => tab.id === snapshot.noteId);
        if (live && live.id !== manager.getActive()?.id) {
          manager.switchTo(live.id, false);
        }
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
            // Silent: the restore toast below is the user-facing
            // message for this action — the safety copy is a background
            // detail and must not replace it.
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

      showToast(
        cameFromTrash
          ? 'Snapshot restored — the note is back from the trash.'
          : resurrect
            ? 'Snapshot restored as a new note.'
            : 'Snapshot restored!',
        'success',
      );

      // The sheet STAYS OPEN — the restore is mid-conversation, not the
      // end of one: the next version to compare (or restore) is right
      // there, the row that now matches the note picks up the Current
      // chip as direct feedback, and the pre-restore copy lands on top
      // with its flash. Closing is the user's move.
      this.pendingFlashKey = null;
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

  /**
   * Sweeps every snapshot that belongs to the given notes — "delete
   * forever" means forever: a note purged from the trash must not keep
   * answering from the History sheet (restorable through the resurrect
   * path) after its toast said it was gone for good. Best-effort by
   * contract: a snapshots outage must not block the purge.
   */
  async deleteSnapshotsForNotes(noteIds: string[]): Promise<number> {
    if (noteIds.length === 0) {
      return 0;
    }
    await this.ready().catch(() => undefined);
    if (!this.db) {
      return 0;
    }
    return new Promise((resolve, reject) => {
      let deleted = 0;
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const index = transaction.objectStore(this.storeName).index('noteId');
      for (const noteId of noteIds) {
        const cursorRequest = index.openCursor(IDBKeyRange.only(noteId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            cursor.delete();
            deleted += 1;
            cursor.continue();
          }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      }
      transaction.oncomplete = () => {
        if (deleted > 0) {
          void this.loadSnapshots(this.currentSearchTerm());
          void this.updateSnapshotsCount();
        }
        resolve(deleted);
      };
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /** The footer's Empty trash — every visible grave purged by the same
   *  sweeper-row mechanism (see TabManager.emptyTrash), each note's
   *  snapshots swept with it. */
  private emptyTrashFromSheet(): void {
    const manager = getTabManager();
    if (!manager) {
      return;
    }
    const purged = manager.emptyTrash();
    showToast(purged === 1 ? 'Deleted 1 note for good.' : `Deleted ${purged} notes for good.`);
    this.renderRows(this.currentSearchTerm());
  }

  // Delete all snapshots (the versions — the trash is the trash's own)
  deleteAllSnapshots(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.clear();

    request.onsuccess = () => {
      void this.loadSnapshots(this.currentSearchTerm());
      void this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      showToast('Error deleting snapshots');
    };
  }

  /** The store's size, against the footer and the delete-all affordance.
   *  The count TEXT itself is renderRows' to write — it knows the whole
   *  story (versions against the cap, trash beside it) — so this owns
   *  only the button's enabled state. Waits for the database open like
   *  every read: a boot-moment call must not read a null database and
   *  leave the button stuck disabled. */
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
 * Wires the History feature: constructs the manager when the snapshots
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
