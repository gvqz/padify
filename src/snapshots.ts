/**
 * History — the one sheet, answering the three questions a person
 * actually brings to it (src/snapshots.ts owns the versions; the trash
 * rides along from the tab model, TabManager.trashed).
 *
 * The structural contract:
 *
 *  • THREE VIEWS, one toolbar — “This note” (the default), “All notes”
 *    and “Trash”. The sheet is opened FROM a note, so its first answer
 *    is that note's chain: versions scoped by identity (noteId),
 *    newest first, the change badges reading like the note's own
 *    commit log. “All notes” is the deliberate browse — every note's
 *    VERSIONS on one chronology, and nothing else: a trashed note used
 *    to appear twice beside its own versions (a grave row and version
 *    rows, same titles, different affordances), which was the mess
 *    this rework removed. Trash is its own view because a deleted note
 *    is not a version of anything — it is a note waiting, on a clock.
 *  • THE DELETE'S PROMISE — the trash flash on the History button
 *    (trash-flash.ts) says “it went in HERE”, and the next open honors
 *    it: a delete within HISTORY_TRASH_REDIRECT_MS lands the sheet on
 *    the Trash view once, then the promise is consumed. After that,
 *    every open starts on the note being written — the honest default,
 *    because the sheet cannot know which note you will be in tomorrow.
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
 *    in the rows. The QUERY IS SCOPED to the view it filters — this
 *    note's words, all notes' words, the trash's words — and a miss
 *    offers the way OUT of the scope ("Search all notes" / "Search the
 *    trash"), because the words are usually somewhere. A capture that
 *    lands while ANY filter (text or view) would hide it clears that
 *    filter, so the flash the user is promised is a flash they can see.
 *  • DATES — formatted at render time from the timestamp; the stored
 *    formattedDate field is written for older builds only.
 *  • THE CURRENT CHIP is unique by fiat — several snapshots can hold
 *    the same bytes as the open note (a restore chain guarantees it),
 *    but only the NEWEST of them wears the chip; an older twin is just
 *    history. A trash row never wears it.
 *  • THE SHEET — right-side, docked, day-anchored rail (see
 *    11-snapshots.css for the frame). Entries expand in place into a
 *    detail card that owns the actions. The footer tells the VIEW's
 *    truth beside ONE destructive button whose scope is the view it
 *    stands in — this note's versions, all versions, or the trash —
 *    never two destructives from different scopes side by side.
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
import { closeCollapse } from './ui/behavior/collapse';
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
import { hydrateModifierKeyElements } from './ui/platform-hints';
import { updateWordCountPill } from './word-count-pill';
import { TRASH_RETENTION_MS } from '../shared/wire';
import type { TrashedNote } from './storage';
import {
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
 *  search string per row in memory, so the cap is a memory ceiling,
 *  not a philosophy: at 200 rows × 20KB the worst case is ~4MB of
 *  lowercase copies — cheap next to the alternative. 2000 proved too
 *  tight the day the WELCOME note itself outgrew it (2013 readable
 *  chars), and a note app whose pitch is "never lose your work"
 *  cannot ship an unsearchable tail: what you typed last is usually
 *  what you are looking for. Only pathological paste-bombs feel the
 *  cap, and those still match on their first 20,000 characters. */
const SNAPSHOT_SEARCH_CAP = 20_000;

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
 *  hard cut; the cap holds either way. The ellipsis is the SINGLE
 *  character — the same one CSS text-overflow paints — so a derive-capped
 *  line and a container-clipped line end the same way in one list. */
function capAtWordBoundary(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  const cut = text.slice(0, cap - 1);
  const boundary = cut.lastIndexOf(' ');
  const head = boundary > cap / 2 ? cut.slice(0, boundary) : cut;
  return `${head.trimEnd()}\u2026`;
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

/** Days a grave still waits — trashRetentionChip and the footer's
 *  “next leaves in” share this clock so they can never disagree. */
export function trashDaysLeft(deletedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / DAY_MS));
}

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
  const daysLeft = trashDaysLeft(deletedAt, now);
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
// Pure helpers — the sheet's three views (exported so tests pin the
// decision layer without the manager's DOM wiring)
// ---------------------------------------------------------------------------

/** The toolbar's views: which rows the sheet shows. 'note' is the
 *  default — the sheet is opened from a note and answers for it first. */
export type HistorySegment = 'note' | 'all' | 'trash';

/** How long a delete keeps its promise that History opens on the trash.
 *  The button's flash is 2.4s (trash-flash.ts); the door stays pointed
 *  at the trash a while longer — the eye needs time to decide to click —
 *  but not forever: an hour-old delete is no longer the open's context. */
export const HISTORY_TRASH_REDIRECT_MS = 30_000;

/**
 * The view a fresh open lands on. The default answers the question the
 * sheet is opened FROM — what does THIS note look like — but a recent
 * delete overrides it once: the flash on the button promised the trash,
 * and the first open inside the window keeps that promise. The promise
 * is consumed by the open itself (see openSheet).
 */
export function historyOpeningSegment(
  lastTrashedAt: number | null,
  now: number = Date.now(),
): HistorySegment {
  if (lastTrashedAt !== null && now - lastTrashedAt < HISTORY_TRASH_REDIRECT_MS) {
    return 'trash';
  }
  return 'note';
}

/** The header's one-line truth about the view it stands over. */
export function historySubtitle(segment: HistorySegment, noteName?: string): string {
  if (segment === 'trash') {
    return 'Deleted notes — kept for 30 days.';
  }
  if (segment === 'all') {
    return 'Every version of every note.';
  }
  const name = noteName?.trim();
  return name ? `Versions of \u201c${name}\u201d.` : 'Versions of this note.';
}

/** The facts the footer's count line speaks from. */
export interface HistoryFooterFacts {
  segment: HistorySegment;
  /** Versions of the ACTIVE note — the 'note' view's subject. */
  noteVersions: number;
  /** The whole store's version count — what the cap caps. */
  totalVersions: number;
  /** Restorable graves. */
  trashCount: number;
  /** Days until the soonest grave goes for good; null when none. */
  nextTrashDays: number | null;
  /** The version cap, for the “of N” truth. */
  cap: number;
}

/** The footer's count line, per view: the view's own truth first, the
 *  store's beside it. One number per question, never two numbers
 *  disagreeing about the same one. */
export function historyFooterText(f: HistoryFooterFacts): string {
  if (f.segment === 'trash') {
    const base = `${f.trashCount} in trash`;
    if (f.nextTrashDays === null) {
      return base;
    }
    if (f.nextTrashDays <= 0) {
      return `${base} \u00b7 one leaves today`;
    }
    if (f.nextTrashDays === 1) {
      return `${base} \u00b7 next leaves tomorrow`;
    }
    return `${base} \u00b7 next leaves in ${f.nextTrashDays} days`;
  }
  if (f.segment === 'note') {
    const own = `${f.noteVersions} ${f.noteVersions === 1 ? 'version' : 'versions'}`;
    return `${own} \u00b7 ${f.totalVersions} of ${f.cap} across all notes`;
  }
  return `${f.totalVersions} of ${f.cap}${f.trashCount > 0 ? ` \u00b7 ${f.trashCount} in trash` : ''}`;
}

/** The footer's ONE destructive, dressed for the view it stands in —
 *  the button's scope is always the view's scope, so its label and its
 *  armed question must follow the segment (and the note, for the note
 *  view: switching notes mid-arm is a different question). */
export function historyScopeDeleteLabels(
  segment: HistorySegment,
  noteVersions: number,
): { quiet: string; armed: string } {
  if (segment === 'trash') {
    return { quiet: 'Empty trash', armed: 'Really empty it?' };
  }
  if (segment === 'note') {
    return {
      quiet: "Delete this note's versions",
      armed: `Delete ${noteVersions} ${noteVersions === 1 ? 'version' : 'versions'}?`,
    };
  }
  return { quiet: 'Delete all versions', armed: 'Really delete all?' };
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

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

  /** The toolbar's view. Every open resets it (see openSheet) — a stale
   *  view is a stale answer to a question nobody asked again. */
  private segment: HistorySegment = 'note';

  /** When a note last moved to the trash — the delete's promise that the
   *  NEXT open lands on the Trash view. Consumed by that open; expires
   *  on HISTORY_TRASH_REDIRECT_MS. */
  private lastTrashedAt: number | null = null;

  /** The trash row's Delete forever — arm, then confirm, in place. */
  private purgeConfirm = new TwoStepConfirm();

  /** The footer's ONE destructive — same two-step contract, keyed by the
   *  scope it would sweep so switching views (or notes) disarms. */
  private scopeDeleteConfirm = new TwoStepConfirm();

  /** Whether the tab model's persist listener is wired — the timeline
   *  refreshes when the trash moves underneath an open sheet (a sync
   *  merge, the delete toast's Undo). */
  private wiredTabsListener = false;

  /** Fingerprint of the row data the LAST renderRows painted (see
   *  rowsFingerprint). A persist that moves nothing the sheet shows
   *  must not rebuild the list — see wireTabsListener. */
  private renderedFingerprint: string | null = null;

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
    const openSheet = (event?: Event): void => {
      this.wireTabsListener();
      // Every open answers the note on stage — the default view is THIS
      // note's chain — unless a delete just made a promise: the flash on
      // this very button said "it went in here", and the first open
      // inside its window lands on the Trash view. The promise is
      // consumed by the open; a later open starts on the note again.
      this.segment = historyOpeningSegment(this.lastTrashedAt);
      this.lastTrashedAt = null;
      // A leftover armed destructive from a previous visit must not
      // survive into a new one — the arm is a gesture, not a state.
      this.scopeDeleteConfirm.disarm();
      // On a phone the History button lives in the hamburger's collapse;
      // fold it — a menu still standing under a full-screen sheet reads
      // as a waypoint nobody dismissed.
      closeCollapse(document.getElementById('navbar'));
      // The opener rides along so the sheet's close returns focus to
      // the button that opened it (the keyboard's way in deserves the
      // keyboard's way back; the modal layer owns the restore).
      const opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
      openModal($('#snapshotsModal').get(0), opener);
      // Paint from the cache the moment the sheet asks for it — the
      // reader's first clicks land on a list that is already there,
      // not on one an async re-read is about to replace (a rebuild
      // under an in-flight click can eat it: the delegated accordion
      // then reads the replaced row as never opened). A fresh open
      // also RESETS expansion: a row left open by the previous visit
      // must not come back pre-expanded — the reader's first click on
      // it would read as a toggle-to-CLOSE (expandRow is a toggle).
      // The store read below still owns the truth — if it moved, it
      // re-renders, with any row opened THIS visit carried over.
      this.renderRows(this.currentSearchTerm(), { resetOpen: true });
      // Honor the search field's leftover text — reopening used to show the
      // unfiltered list under a stale query.
      void this.loadSnapshots(this.currentSearchTerm());
    };
    document.getElementById('snapshotsButton')?.addEventListener('click', openSheet);

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

    // The toolbar's views — one tap re-answers the sheet: this note's
    // chain, every note's versions, or the trash.
    document.querySelectorAll('#snapshotSegment .snap-seg-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const seg = (button as HTMLElement).dataset.seg as HistorySegment | undefined;
        if (seg && seg !== this.segment) {
          this.setSegment(seg);
        }
      });
    });

    // The footer's ONE destructive — its scope is whatever view it
    // stands in. Arm on the first press, commit on the second; the
    // button's own label carries the confirm, and the scope key keeps
    // an arm from leaking across a view (or note) switch. No dialog
    // ever stacks over the sheet.
    document.getElementById('historyScopeDeleteBtn')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLElement;
      const manager = getTabManager();
      if (!manager) {
        return;
      }
      const activeId = manager.getActive()?.id;
      const noteVersions = this.cache.filter(({ snapshot }) => snapshot.noteId === activeId).length;
      const labels = historyScopeDeleteLabels(this.segment, noteVersions);
      const scopeKey = this.segment === 'note' ? `note:${activeId ?? '-'}` : this.segment;
      if (!this.scopeDeleteConfirm.tap(scopeKey, button, labels.armed)) {
        return;
      }
      if (this.segment === 'note') {
        if (!activeId) {
          return;
        }
        void this.deleteSnapshotsForNotes([activeId]).then((deleted) => {
          showToast(
            deleted === 1
              ? 'Deleted 1 version of this note.'
              : `Deleted ${deleted} versions of this note.`,
          );
        });
      } else if (this.segment === 'all') {
        this.deleteAllSnapshots();
      } else {
        this.emptyTrashFromSheet();
      }
    });

    // Escape with a view beyond the default (and no text query — the
    // field owns that case) resets the view first, by the same muscle
    // memory the search field follows: the narrowest state gives way
    // before the sheet itself closes. Capture phase, so the modal
    // layer's own Escape never sees this press.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') {
          return;
        }
        const modal = document.getElementById('snapshotsModal');
        const search = document.getElementById('searchSnapshots') as HTMLInputElement | null;
        if (
          this.segment !== 'note' &&
          modal?.classList.contains('in') &&
          (search?.value.trim() ?? '') === ''
        ) {
          e.stopPropagation();
          e.preventDefault();
          this.setSegment('note');
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
    // box still applies. A text query goes first; an empty field on a
    // non-default view narrows THAT back to the note. stopPropagation keeps
    // the document-level Escape handler from closing the modal under the
    // same press (the capture listener above has already had its turn).
    document.getElementById('searchSnapshots')?.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (e.key === 'Escape' && input.value !== '') {
        e.stopPropagation();
        input.value = '';
        this.renderRows('');
      } else if (e.key === 'Escape' && this.segment !== 'note') {
        e.stopPropagation();
        this.setSegment('note');
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

    // The no-match state's two ways out. "Clear the filter" drops the
    // QUERY only — the view the user chose is theirs to keep (the old
    // behavior also reset the view, throwing a trash browser back to
    // versions for the crime of a bad query). "Search the trash" /
    // "Search all notes" carries the query INTO the other scope: the
    // words are usually somewhere, and a miss here is a strong hint the
    // somewhere is there.
    document.getElementById('clearSearchFromEmpty')?.addEventListener('click', () => {
      const input = document.getElementById('searchSnapshots') as HTMLInputElement | null;
      if (input) {
        input.value = '';
      }
      this.renderRows('');
    });
    document.getElementById('widenSearchFromEmpty')?.addEventListener('click', () => {
      this.setSegment(this.segment === 'all' ? 'trash' : 'all');
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
        // A persist that moved nothing the sheet shows must not rebuild
        // the list. The everyday case is typing's debounce landing under
        // an open sheet: the rows would come back byte-identical, and a
        // rebuild under an in-flight click replaces the very node the
        // click is landing on — the delegated accordion then reads the
        // replaced row as never opened (CI caught this as a Restore
        // click on a button that never became visible again). Graves
        // and versions are the only row inputs a persist can move; the
        // Current chip reads the note's LIVE content, which the open
        // already painted. Sync merges, the toast's Undo and purges all
        // move graves and DO re-render (with the open row carried over).
        if (this.rowsFingerprint() !== this.renderedFingerprint) {
          this.renderRows(this.currentSearchTerm());
        }
      }
    });
  }

  /** A compact fingerprint of everything the sheet's rows derive from:
   *  the ACTIVE NOTE (the note view's subject — the tab-cycle shortcuts
   *  can switch it under an open sheet without moving a single row of
   *  data, and a stale chain under "Versions of this note" is a lie),
   *  the graves (id + arrival time) and the version cache (id + capture
   *  time). Snapshots and graves are immutable once written, so presence
   *  and identity fully determine the rows; order is normalized away
   *  because renderRows sorts by its own rules anyway. */
  private rowsFingerprint(): string {
    const graves = getTabManager()?.getTrashed() ?? [];
    const gravePart = graves
      .map((grave) => `${grave.id}@${grave.deletedAt}`)
      .sort()
      .join(',');
    const cachePart = this.cache
      .map(({ snapshot }) => `${snapshot.id ?? '?'}@${snapshot.timestamp}`)
      .sort()
      .join(',');
    const activePart = getTabManager()?.getActive()?.id ?? '-';
    return `${activePart}#${gravePart}#${cachePart}`;
  }

  /** A note moved to the trash (app.ts wires the tab model's listener
   *  here — the manager constructs before the tab model exists). This is
   *  the flash's second half: the next open lands on the Trash view. */
  noteTrashed(): void {
    this.lastTrashedAt = Date.now();
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
      // move. The grave is read BEFORE the restore: restoreNote fires
      // the persist listeners synchronously, the re-render drops the
      // row, and a DOM title lookup after it finds nothing — the toast
      // used to mourn an anonymous "The note".
      const manager = getTabManager();
      const grave = manager?.getTrashed().find((entry) => entry.id === id);
      if (manager?.restoreNote(id)) {
        // The same title the row wore (the note's name, or its first
        // line) — the toast says who came back.
        const title = grave ? trashRowModel(grave).title : null;
        showToast(
          title
            ? `\u201c${title}\u201d is back in the notes list.`
            : 'The note is back in the notes list.',
          'success',
        );
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

  /** Applies a view choice and re-renders. */
  private setSegment(segment: HistorySegment): void {
    this.segment = segment;
    this.renderSegment();
    this.renderRows(this.currentSearchTerm());
  }

  /** The view buttons mirror the state they own, and the Trash tab
   *  carries the count of what waits there — the signal a browser in
   * another view should not have to switch tabs to see. */
  private renderSegment(trashCount?: number): void {
    const graves =
      trashCount ?? (getTabManager()?.getTrashed() ?? []).filter(isRestorableGrave).length;
    document.querySelectorAll('#snapshotSegment .snap-seg-btn').forEach((node) => {
      const button = node as HTMLElement;
      const active = button.dataset.seg === this.segment;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      if (button.dataset.seg === 'trash') {
        const count = button.querySelector<HTMLElement>('.snap-seg-count');
        if (count) {
          count.textContent = graves > 0 ? String(graves) : '';
          count.toggleAttribute('hidden', graves === 0);
        }
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
        // A capture is a version of the ACTIVE note — the note view is
        // exactly where it lands, and any other view that would hide it
        // (the trash) gives way: the new snapshot is the thing the user
        // asked for, the view was yesterday's context.
        if (this.segment === 'trash') {
          this.segment = 'note';
          this.renderSegment();
        }

        // A store that only ever grows is a slow leak: retire the oldest
        // snapshots beyond the cap so safety copies stay bounded.
        pruneSnapshots(database, this.storeName)
          .then((pruned) => {
            if (pruned > 0) {
              void this.loadSnapshots(this.currentSearchTerm());
            }
          })
          .catch((error) => {
            console.warn(
              '[snapshots] prune failed — the cap will retry on the next snapshot',
              error,
            );
          });

        void this.loadSnapshots(this.currentSearchTerm());
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
    // The read is async; the sheet may already paint exactly what it
    // answers (openSheet's synchronous render, a refresh landing after
    // its own flash). Rows the rebuild would paint byte-identical must
    // not be rebuilt: a rebuild under the reader's cursor replaces the
    // very node an in-flight click is landing on. Render on movement
    // only — the fingerprint (graves + versions) is what the rows are.
    if (this.rowsFingerprint() !== this.renderedFingerprint) {
      this.renderRows(searchTerm);
    }
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
   *  ONE Current ever is a decision about the whole view (the newest
   *  identical row wears it), which renderRows owns. The note chip is
   *  suppressed in the note view: every row on that rail is the same
   *  note, and a chip repeating it is noise, not information. */
  private versionRowModel(
    snapshot: Snapshot,
    change?: SnapshotChangeBadge,
    showNoteChip = true,
  ): SheetRowModel {
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
      noteChip: showNoteChip ? snapshot.noteName : undefined,
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

  /** Renders the current view through the sheet kit: the active note's
   *  chain (note), every note's versions (all), or the graves (trash).
   *  Day runs anchor the rail in every view; only the ROW SET changes.
   *
   *  `resetOpen` is the fresh-open contract: a new visit starts
   *  collapsed (the DOM keeps the last visit's expansion, and a
   *  carried-open row would make the reader's first click a
   *  toggle-to-CLOSE); every in-session re-render — a persist, a
   *  capture, the open's own async store read — carries the open row
   *  across instead, so a background refresh rebuilds the list around
   *  the reader. */
  private renderRows(searchTerm: string = '', opts: { resetOpen?: boolean } = {}): void {
    const list = document.getElementById('snapshotsList');
    const empty = document.getElementById('noSnapshots');
    if (!list || !empty) {
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const filtering = term !== '';
    const now = Date.now();
    const manager = getTabManager();
    const activeTab = manager?.getActive();
    const graves = (manager?.getTrashed() ?? []).filter(isRestorableGrave);

    // The 'Current' chip answers one question — is this row the note I
    // have open, byte for byte? Read once per render; typing can't race
    // it (the sheet covers the editor).
    const active = getActiveNoteContent();
    const badges = this.computeChangeBadges();

    // The version set is SCOPED by the view: the active note's chain by
    // identity (legacy rows without a noteId belong to no note and ride
    // only in All notes), or every note's. The query then filters inside
    // the scope — the field searches what the view shows, nothing else.
    const scoped = this.cache.filter(({ snapshot }) =>
      this.segment === 'note'
        ? snapshot.noteId !== undefined && snapshot.noteId === activeTab?.id
        : true,
    );
    const filtered = scoped.filter((row) => !filtering || row.searchText.includes(term));
    const showNoteChip = this.segment !== 'note';
    const versionModels = filtered.map(({ snapshot }) =>
      this.versionRowModel(snapshot, badges.get(snapshot.id ?? -1), showNoteChip),
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

    // The trash view's rows — searched within themselves, like any view.
    const trashModels = graves
      .filter((grave) => !filtering || trashRowSearchText(grave).includes(term))
      .map((grave) => trashRowModel(grave, now));

    const rows: SheetRowModel[] = this.segment === 'trash' ? trashModels : versionModels;

    // A re-render must not snap shut the row the user is reading: the
    // sheet re-renders when a save lands underneath it (wireTabsListener
    // — a sync merge, the delete toast's Undo, an in-flight debounce
    // from the typing that OPENED the sheet), and a rebuilt list used
    // to come back fully collapsed, mid-read. Carry the open row's key
    // across the rebuild; a key that no longer exists renders closed.
    const openRow = opts.resetOpen
      ? null
      : (list.querySelector<HTMLElement>('.snap-item.is-open') as HTMLElement | null);
    const openKey = openRow?.dataset.rowKey ?? null;

    renderSheetTimeline(list, rows, {
      term: filtering ? term : '',
      flashKey: this.pendingFlashKey,
      openKey,
    });
    this.pendingFlashKey = null;
    // What the rows now derive from — the persist listener compares
    // against this to skip rebuilds that would paint the same list.
    this.renderedFingerprint = this.rowsFingerprint();

    // The header's one line follows the view (and, in the note view, the
    // note itself — a restore that switches notes re-names the sheet).
    const subtitle = document.getElementById('snapshotsSubtitle');
    if (subtitle) {
      subtitle.textContent = historySubtitle(this.segment, activeTab?.name ?? undefined);
    }

    // The empty state has faces, per view: the view's own emptiness (the
    // copy explains what would land here), or a query that matched
    // nothing IN it (the miss carries two ways out — drop the query, or
    // carry it into the other scope). They share the icon; the copy
    // must not lie.
    const scopeHasContent =
      this.segment === 'trash'
        ? graves.length > 0
        : this.segment === 'note'
          ? scoped.length > 0
          : this.cache.length > 0;
    const hasRows = rows.length > 0;
    list.style.display = hasRows ? 'block' : 'none';
    empty.style.display = hasRows ? 'none' : 'flex';
    // The miss face belongs to a QUERY that hid rows the view holds. An
    // empty view with a query is that view's empty face — there is
    // nothing for the query to have hidden, and offering to "clear the
    // filter" would claim otherwise.
    const showMiss = filtering && scopeHasContent && !hasRows;
    const trashFace = this.segment === 'trash';
    const noteFace = this.segment === 'note';
    document.getElementById('noSnapshotsEmpty')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsHint')?.toggleAttribute('hidden', showMiss || trashFace);
    document.getElementById('noTrashHint')?.toggleAttribute('hidden', showMiss || !trashFace);
    document.getElementById('noSnapshotsMiss')?.toggleAttribute('hidden', !showMiss);
    document.getElementById('noSnapshotsEmptyActions')?.toggleAttribute('hidden', !showMiss);
    document.getElementById('clearSearchFromEmpty')?.toggleAttribute('hidden', !showMiss);
    // The miss's second way out: carry the query into the other scope.
    // From the note view the wider version scope is All notes; from All
    // notes the other dimension entirely — the trash.
    const widen = document.getElementById('widenSearchFromEmpty');
    if (widen) {
      widen.textContent = this.segment === 'all' ? 'Search the trash' : 'Search all notes';
      widen.toggleAttribute('hidden', !showMiss);
    }
    if (!showMiss) {
      const title = document.getElementById('noSnapshotsEmpty');
      if (title) {
        title.textContent = trashFace
          ? 'Nothing in the trash.'
          : noteFace
            ? 'No versions of this note yet.'
            : 'Nothing here yet.';
      }
      // The hint points at what would land here — the note view's CTA
      // is the note's own; All notes also names where the deleted
      // notes went (the wayfinding a first-time browser needs).
      const hint = document.getElementById('noSnapshotsHint');
      if (hint) {
        hint.innerHTML = noteFace
          ? 'Take one with the button above, or <span class="snap-kbd-inline"><kbd data-mod-key>Ctrl</kbd> + <kbd>U</kbd></span>.'
          : 'Take one with the button above, or <span class="snap-kbd-inline"><kbd data-mod-key>Ctrl</kbd> + <kbd>U</kbd></span>. Deleted notes wait in the trash.';
        hydrateModifierKeyElements(hint);
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

    // The footer's count line tells the VIEW's truth (its own number
    // first, the store's beside it); the filtered story lives in the
    // field's own hit counter — one truth per place, never two numbers
    // disagreeing.
    const countElement = document.getElementById('snapshotsCount');
    if (countElement) {
      const nextTrashDays = graves.length
        ? Math.min(...graves.map((grave) => trashDaysLeft(grave.deletedAt, now)))
        : null;
      countElement.textContent = historyFooterText({
        segment: this.segment,
        noteVersions: scoped.length,
        totalVersions: this.cache.length,
        trashCount: graves.length,
        nextTrashDays,
        cap: MAX_SNAPSHOTS,
      });
    }

    // The footer's ONE destructive: its label, armed question, and
    // availability follow the view it stands in. The label write is
    // skipped while an arm is live — the confirm owns the button's text
    // until it disarms (and disarm restores the label it captured).
    const scopeBtn = document.getElementById('historyScopeDeleteBtn') as HTMLButtonElement | null;
    if (scopeBtn) {
      const labels = historyScopeDeleteLabels(this.segment, scoped.length);
      if (!scopeBtn.classList.contains('is-armed')) {
        const label = scopeBtn.querySelector('.snap-delete-all-label');
        if (label) {
          label.textContent = labels.quiet;
        }
      }
      // The trash view HIDES its destructive when there is nothing to
      // empty (a disabled “Empty trash” over an empty view is noise);
      // the version views keep theirs visible but disabled — the
      // affordance's existence is information even when gray.
      scopeBtn.toggleAttribute('hidden', trashFace && graves.length === 0);
      scopeBtn.disabled =
        (noteFace && scoped.length === 0) || (this.segment === 'all' && this.cache.length === 0);
    }

    this.renderSegment(graves.length);
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

  // Copy a snapshot's content to the clipboard — the READABLE text, the
  // same projection the detail card above the button shows. The raw
  // content is a storage format (html markup for text notes, a JSON
  // envelope for drawings); pasting `<div>` tags or scene braces into
  // another app answers a question nobody asked.
  copySnapshot(snapshotId: number | undefined, buttonElement: Element): void {
    if (snapshotId === undefined || !this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.get(snapshotId);

    request.onsuccess = (event) => {
      const snapshot = (event.target as IDBRequest).result as Snapshot | undefined;
      if (snapshot) {
        const readable = snapshotReadableText(snapshot.content, snapshot.noteType);
        // Use the Clipboard API
        navigator.clipboard
          .writeText(readable)
          .then(() => {
            this.showCopySuccess(buttonElement);
          })
          .catch((err) => {
            console.error('Failed to copy text: ', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = readable;
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
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

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
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      showToast('Error deleting snapshots');
    };
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
