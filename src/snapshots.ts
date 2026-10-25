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
 *  • DUPLICATES — an identical (content + type, normalized) capture
 *    against ANY of that note's existing snapshots is declined, not
 *    just the latest: the restore loop (v1 → v2 → restore v1 → capture)
 *    used to file the same bytes twice. Captures serialize through a
 *    queue so two rapid Ctrl+U presses cannot both pass the check.
 *  • EMPTINESS — judged per content kind (see snapshotHasContent), so
 *    an image-bearing note is not "empty" because its text projection
 *    is blank.
 *  • SEARCH — matches what a row shows (title, note name, preview,
 *    type label) plus the readable projection capped at a few
 *    thousand characters — never raw markup or JSON braces.
 *  • DATES — formatted at render time from the timestamp; the stored
 *    formattedDate field is written for older builds only.
 *  • THE MENU — sections by note type (registry order), day groups
 *    inside, the source note's name on the row.
 */
import { $ } from './lib/q';
import { openModal, closeModal } from './ui/behavior/modal';
import Swal from 'sweetalert2';
import { getActiveNoteContent, getEditorText, getTabManager, htmlToText } from './tabs';
import {
  DEFAULT_NOTE_TYPE,
  NOTE_TYPES,
  isHtmlContent,
  normalizeNoteType,
  noteTypeLabel,
  type NoteType,
} from './editor/note-types';
import { drawingScenePlainText } from './editor/drawing/scene';
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
      // Index order is storage order; the callers want time order.
      rows.sort((a, b) => b.timestamp - a.timestamp);
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
 * words is empty, full stop. Text/json/opaque kinds are their raw bytes.
 */
export function snapshotHasContent(content: string, noteType?: string): boolean {
  if (isHtmlContent(noteType)) {
    return htmlToText(content).trim() !== '';
  }
  return content.trim() !== '';
}

/** Two captures are the same snapshot when bytes and note type match —
 *  with the type NORMALIZED: 'standard' and absent are the same note,
 *  the same rule isCurrentSnapshotState applies to the Current chip. */
export function isSameSnapshotState(a: SnapshotState, b: SnapshotState): boolean {
  return a.content === b.content && normalizeNoteType(a.noteType) === normalizeNoteType(b.noteType);
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
    snapshot.content === active.content &&
    normalize(snapshot.noteType) === normalize(active.noteType)
  );
}

/** First meaningful line (html) or the type's label, capped at 50 chars. */
export function deriveSnapshotTitle(content: string, noteType?: string): string {
  const firstLine = isHtmlContent(noteType)
    ? htmlToText(content)
        .split('\n')
        .find((line) => line.trim() !== '')
    : noteType
      ? noteTypeLabel(noteType as NoteType)
      : undefined;
  const title = firstLine || 'Untitled Snapshot';
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
      rows: (buckets.get(key) ?? []).sort((a, b) => b.timestamp - a.timestamp),
    }));
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
        this.updateSnapshotsCount();
        void this.loadSnapshots();
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
    });

    // Create snapshot button
    document.getElementById('createSnapshotBtn')?.addEventListener('click', () => {
      void this.createSnapshot();
    });

    // Delete all snapshots button
    document.getElementById('deleteAllSnapshotsBtn')?.addEventListener('click', () => {
      Swal.fire({
        title: 'Want to delete all snapshots?',
        text: "You won't be able to revert this!",
        icon: 'warning',
        showCancelButton: true,
        customClass: {
          confirmButton: 'swal-btn-danger',
        },
        confirmButtonText: 'Yes, Delete!',
        cancelButtonText: 'No, keep it.',
      }).then((result) => {
        if (result.value) {
          this.deleteAllSnapshots();
        }
      });
    });

    // Search snapshots — filters the cached rows; no store read per keystroke.
    document.getElementById('searchSnapshots')?.addEventListener('input', (e) => {
      this.renderRows((e.target as HTMLInputElement).value);
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

        // A store that only ever grows is a slow leak: retire the oldest
        // snapshots beyond the cap so safety copies stay bounded.
        pruneSnapshots(database, this.storeName)
          .then((pruned) => {
            if (pruned > 0) {
              void this.loadSnapshots();
              this.updateSnapshotsCount();
            }
          })
          .catch((error) => {
            console.warn(
              '[snapshots] prune failed — the cap will retry on the next snapshot',
              error,
            );
          });

        void this.loadSnapshots();
        this.updateSnapshotsCount();
        resolve();
      };

      request.onerror = (event) => {
        console.error('Error creating snapshot', event);
        showToast('Error creating snapshot');
        resolve();
      };
    });
  }

  /** Every snapshot, newest first (the read order the UI wants). */
  private readAllSnapshots(): Promise<Snapshot[]> {
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
        // getAll returns key order (insertion); the UI wants time order.
        rows.sort((a, b) => b.timestamp - a.timestamp);
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

  // Render the cached rows through the current search term.
  private renderRows(searchTerm: string = ''): void {
    const snapshotsList = document.getElementById('snapshotsList');
    const noSnapshots = document.getElementById('noSnapshots');
    if (!snapshotsList || !noSnapshots) {
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const rows: Snapshot[] = term
      ? this.cache.filter((row) => row.searchText.includes(term)).map((row) => row.snapshot)
      : this.cache.map((row) => row.snapshot);

    // The 'Current' chip answers one question — is this row the note I
    // have open, byte for byte? Read once per render; typing can't race
    // it (the modal covers the editor).
    const active = getActiveNoteContent();

    snapshotsList.innerHTML = '';
    // Type sections, registry order: each header carries the kind's icon,
    // label and row count; the day timeline lives INSIDE the section.
    // Recency never reorders sections — the menu's shape is stable —
    // while rows inside stay newest-first.
    let highlighted = false;
    for (const section of groupSnapshotsByType(rows)) {
      const sectionHeader = document.createElement('li');
      sectionHeader.className = 'snapshots-type';
      sectionHeader.innerHTML = `
        <span class="snapshots-type-icon" aria-hidden="true">${section.icon}</span>
        <span class="snapshots-type-label">${this.escapeHtml(section.label)}</span>
        <span class="snapshots-type-count">${section.rows.length}</span>`;
      snapshotsList.appendChild(sectionHeader);

      // Day grouping inside the section: rows arrive newest-first, so the
      // day only moves backwards — a header li rides in whenever the
      // calendar day changes (Today / Yesterday / …).
      let currentDay = '';
      for (const snapshot of section.rows) {
        const dayKey = snapshotDayKey(snapshot.timestamp);
        if (dayKey !== currentDay) {
          currentDay = dayKey;
          const header = document.createElement('li');
          header.className = 'snapshots-day';
          header.textContent = formatSnapshotDayLabel(snapshot.timestamp);
          snapshotsList.appendChild(header);
        }
        const li = this.createSnapshotElement(snapshot);
        li.classList.toggle('is-current', isCurrentSnapshotState(snapshot, active));
        if (snapshot.id !== undefined && snapshot.id === this.pendingHighlightId) {
          li.classList.add('is-new');
          this.pendingHighlightId = null;
          highlighted = true;
        }
        snapshotsList.appendChild(li);
      }
    }

    // A just-taken snapshot lands at the top of a long list — bring it
    // into view so the flash is not wasted off-screen.
    if (highlighted) {
      snapshotsList.querySelector('.snapshot-item.is-new')?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }

    // The empty state has two faces: nothing stored yet, or nothing that
    // matched the search. They share the icon; the copy must not lie.
    const hasAny = this.cache.length > 0;
    const hasRows = rows.length > 0;
    snapshotsList.style.display = hasRows ? 'block' : 'none';
    noSnapshots.style.display = hasRows ? 'none' : 'flex';
    const showMiss = hasAny && !hasRows;
    document.getElementById('noSnapshotsEmpty')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsHint')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsMiss')?.toggleAttribute('hidden', !showMiss);
  }

  // Create a snapshot element for the UI — the timeline row. The main
  // area is a real button (expand/collapse), the side column carries the
  // clock and the three actions; the expand panel spans below both.
  createSnapshotElement(snapshot: Snapshot): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'snapshot-item';
    li.dataset.snapshotId = String(snapshot.id ?? '');

    // The type badge — shown for non-default types only, matching the tab
    // rail's convention: a badge matters when restoring would SWITCH the
    // note's type, which plain notes never do.
    const badge =
      snapshot.noteType && snapshot.noteType !== 'standard'
        ? `<span class="snapshot-type-badge">${this.escapeHtml(snapshotTypeBadgeLabel(snapshot.noteType))}</span>`
        : '';

    // The source note's NAME — the identity a mixed timeline owes the
    // reader. Unnamed notes store nothing (their first line IS their
    // label, which the title already shows); a name that merely repeats
    // the title adds noise, not identity.
    const noteChip =
      snapshot.noteName && snapshot.noteName !== snapshot.title
        ? `<span class="snapshot-note" title="The note this snapshot belongs to">${this.escapeHtml(snapshot.noteName)}</span>`
        : '';

    // The expandable panel's text — the readable projection, capped so a
    // giant note cannot turn the row into a wall.
    const readable = snapshotReadableText(snapshot.content, snapshot.noteType).trim();
    const expandText =
      readable.length > SNAPSHOT_EXPAND_CAP
        ? `${readable.slice(0, SNAPSHOT_EXPAND_CAP)}\u2026`
        : readable;
    const expandId = `snapshot-expand-${snapshot.id ?? 'x'}`;

    li.innerHTML = `
            <button type="button" class="snapshot-main" aria-expanded="false" aria-controls="${expandId}" title="Show this snapshot's text">
                <span class="snapshot-rail" aria-hidden="true">${snapshotTypeIcon(snapshot.noteType)}</span>
                <span class="snapshot-body">
                    <span class="snapshot-headline">
                        <span class="snapshot-title" title="${this.escapeHtml(snapshot.title)}">${this.escapeHtml(snapshot.title)}</span>
                        ${badge}
                        ${noteChip}
                        <span class="snapshot-current" title="Identical to the note you have open"><span class="snapshot-current-dot" aria-hidden="true"></span>Current</span>
                    </span>
                    <span class="snapshot-preview" title="${this.escapeHtml(snapshot.preview)}">${this.escapeHtml(snapshot.preview)}</span>
                </span>
                <svg class="snapshot-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            </button>
            <div class="snapshot-side">
                <span class="snapshot-date" title="${this.escapeHtml(formatSnapshotTimestamp(snapshot.timestamp))}">${this.escapeHtml(formatSnapshotClock(snapshot.timestamp))}</span>
                <span class="snapshot-actions">
                    <button type="button" class="snapshot-btn restore" title="Restore this snapshot" aria-label="Restore this snapshot">Restore</button>
                    <button type="button" class="snapshot-btn copy" title="Copy snapshot content" aria-label="Copy snapshot content">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <span class="snapshot-actions-sep" aria-hidden="true"></span>
                    <button type="button" class="snapshot-btn delete" title="Delete this snapshot" aria-label="Delete this snapshot">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11V17"></path><path d="M14 11V17"></path><path d="M4 7H20"></path><path d="M6 7H12H18V18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18V7Z"></path><path d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V7H9V5Z"></path></svg>
                    </button>
                </span>
            </div>
            <div class="snapshot-expand" id="${expandId}" hidden>
                <div class="snapshot-expand-text">${this.escapeHtml(expandText) || 'No content'}</div>
            </div>
        `;

    // The row's main button expands the readable text.
    const mainBtn = li.querySelector<HTMLElement>('.snapshot-main')!;
    mainBtn.addEventListener('click', () => {
      const open = li.classList.toggle('is-open');
      mainBtn.setAttribute('aria-expanded', String(open));
      li.querySelector('.snapshot-expand')?.toggleAttribute('hidden', !open);
    });

    // Add event listeners
    const restoreBtn = li.querySelector('.restore')!;
    const copyBtn = li.querySelector('.copy')!;
    const deleteBtn = li.querySelector('.delete')!;

    restoreBtn.addEventListener('click', () => this.restoreSnapshot(snapshot.id));
    copyBtn.addEventListener('click', () => this.copySnapshot(snapshot.id, copyBtn));
    deleteBtn.addEventListener('click', () => this.deleteSnapshot(snapshot.id));

    return li;
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
      // What the target holds right now. A background tab's model is the
      // truth (edits flush to the model when a note leaves the stage);
      // the live note reads through its surface (keystrokes inside the
      // debounce window count). A resurrection targets a note that does
      // not exist yet — there is nothing to ask about.
      const active = manager.getActive();
      const targetContent = source
        ? source.id === active?.id
          ? getActiveNoteContent()
          : { content: source.content, noteType: source.noteType }
        : legacy
          ? getActiveNoteContent()
          : null;
      const replaces =
        targetContent !== null &&
        snapshotHasContent(targetContent.content, targetContent.noteType) &&
        !isSameSnapshotState(targetContent, snapshotState);

      // 2. Ask before overwriting a note that holds something else. A
      //    declined ask leaves everything exactly as it was — no tab
      //    switch, no write.
      if (replaces) {
        const targetName = source?.name || snapshot.noteName || active?.name || 'this note';
        const result = await Swal.fire({
          title: 'Restore this snapshot?',
          text: `This will replace the current contents of "${targetName}". A safety snapshot is taken first.`,
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: 'Yes, Restore!',
          cancelButtonText: 'No, leave it.',
        });
        if (!result.value) {
          return;
        }
      }

      // 3. Bring the target on stage — both restore seams (the safety
      //    copy and applySnapshotToActive) speak "active note". A
      //    resurrected note is born empty: nothing to lose, nothing to
      //    ask.
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

      // 4. Safety copy of what the target holds RIGHT NOW (post-switch
      //    truth), attributed to the target note: restoring is the one
      //    destructive path whose confirm dialog was the sole
      //    protection — undo history resets on the wholesale replace.
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
          /* the restore still proceeds — the confirm already happened */
        }
      }

      // 5. The one restore path: it moves the note's type with the
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

      // Close the modal after a short delay
      setTimeout(() => {
        closeModal($('#snapshotsModal').get(0));
      }, 150);
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

  // Delete a snapshot
  deleteSnapshot(snapshotId: number | undefined): void {
    if (snapshotId === undefined) {
      return;
    }
    Swal.fire({
      title: 'Want to delete this snapshot?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      customClass: {
        confirmButton: 'swal-btn-danger',
      },
      confirmButtonText: 'Yes, Delete!',
      cancelButtonText: 'No, keep it.',
    }).then((result) => {
      if (result.value) {
        if (!this.db) return;
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(snapshotId);

        request.onsuccess = () => {
          void this.loadSnapshots();
          this.updateSnapshotsCount();
        };

        request.onerror = (event) => {
          console.error('Error deleting snapshot', event);
          showToast('Error deleting snapshot');
        };
      }
    });
  }

  // Delete all snapshots
  deleteAllSnapshots(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.clear();

    request.onsuccess = () => {
      void this.loadSnapshots();
      this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      showToast('Error deleting snapshots');
    };
  }

  // Update the snapshots count in the UI
  updateSnapshotsCount(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const countElement = document.getElementById('snapshotsCount');
      const deleteAllBtn = document.getElementById(
        'deleteAllSnapshotsBtn',
      ) as HTMLButtonElement | null;

      if (countElement) {
        countElement.textContent = String(countRequest.result);
      }

      // The cap is part of the story the footer tells — render it from
      // the constant so the copy can never drift from the behavior.
      const capElement = document.querySelector('#snapshotsModal .snapshots-cap');
      if (capElement) {
        capElement.textContent = `of ${MAX_SNAPSHOTS}`;
      }

      if (deleteAllBtn) {
        deleteAllBtn.disabled = countRequest.result === 0;
      }
    };
  }

  // Helper to escape HTML
  escapeHtml(unsafe: string | null | undefined): string {
    if (!unsafe) return '';
    return unsafe
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
