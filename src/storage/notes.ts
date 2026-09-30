/**
 * Padify storage — the notes repository.
 *
 * Notes used to live as ONE JSON blob in localStorage (`padifyTabs`), re-
 * serialised on every debounced keystroke. Now each note is a row in the
 * IndexedDB `notes` store and a save writes only what actually changed:
 *
 *  • loadNotes()  → { tabs, tombstones } (plus the active tab id via kv)
 *  • saveNotes()  → diff against the last-written index, then ONE
 *                   transaction with the changed rows
 *
 * The tab list's array order is persisted as a `position` field on every
 * record, and deletions are stored as `deleted: true` rows — both exactly
 * like the cloud schema (server/schema.sql), so the sync layer moves whole
 * records between local and remote without adapters.
 *
 * Durability notes:
 *  • The typing path is still debounced by TabManager (400ms) — a hard kill
 *    loses at most the same window it always did.
 *  • The legacy `padifyTabs`/`padifyTabTombstones` blobs are still written
 *    to localStorage as a compatibility mirror (see mirrorLegacyNotes), just
 *    throttled on the typing path so the main thread stops paying a
 *    whole-blob JSON.stringify per keystroke.
 *  • In fallback mode (no IndexedDB) saveNotes degrades to the old
 *    whole-blob writes, byte-for-byte the pre-migration behaviour.
 */

import { NOTES_STORE, storageBackend, writeAll } from './idb';
import { stateSet } from './kv';
import { normalizeNoteType, type NoteType } from '../editor/note-types';

/** A live note, structurally identical to NoteTab in tabs.ts. */
export interface StoredNoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  html: string;
  createdAt: number;
  updatedAt: number;
  /** The note kind — absent means the default (standard). */
  noteType?: NoteType;
  /** The theme the note's inline colors were last written under. */
  colorTheme?: 'light' | 'dark';
}

/** A deletion not yet confirmed by the cloud. */
export interface StoredTombstone {
  id: string;
  updatedAt: number;
}

export interface NotesSnapshot {
  tabs: StoredNoteTab[];
  tombstones: StoredTombstone[];
}

/** The stored record: a tab (or tombstone) plus its strip position. */
export interface NoteRecord extends StoredNoteTab {
  position: number;
  deleted: boolean;
}

/** The active tab id is a plain kv setting. */
export const ACTIVE_TAB_KEY = 'padifyActiveTab';

// Legacy localStorage blobs kept as the compatibility mirror.
const LEGACY_TABS_KEY = 'padifyTabs';
const LEGACY_TOMBSTONES_KEY = 'padifyTabTombstones';

/**
 * While the user is typing, the compatibility blob is rewritten at most this
 * often (structural changes — add/close/switch/rename/merge — always write
 * immediately).
 */
const MIRROR_MIN_INTERVAL_MS = 10_000;

/** Boot snapshot cache so loadNotes() can stay synchronous-shaped. */
let bootSnapshot: NotesSnapshot | null = null;

/**
 * The latest snapshot handed to saveNotes — the throttled trailing mirror
 * write needs the freshest model, which only TabManager knows.
 */
let currentSnapshotForMirror: NotesSnapshot | null = null;

/**
 * The last-written index powering the diff. Values are the fields that
 * matter for persistence — content changes always bump `updatedAt` in
 * TabManager, so html does not need to be compared (or copied) here.
 */
const lastWritten = new Map<
  string,
  {
    name: string | null;
    position: number;
    updatedAt: number;
    deleted: boolean;
    noteType: NoteType | undefined;
  }
>();

// ---- compatibility mirror state ---------------------------------------------

let lastMirrorWriteAt = 0;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorDirty = false;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Boot hook: caches the hydrated snapshot (live tabs in strip order, then
 * tombstones) and seeds the diff index. Called by index.ts after the
 * database (and any legacy import) is in place.
 */
export function hydrateNotes(records: NoteRecord[]): NotesSnapshot {
  const valid = records.filter(
    (record) => record && typeof record.id === 'string' && record.id !== '',
  );

  const live = valid
    .filter((record) => !record.deleted)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((record) => ({
      id: record.id,
      name: typeof record.name === 'string' ? record.name : null,
      html: typeof record.html === 'string' ? record.html : '',
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
      noteType: normalizeNoteType((record as { noteType?: unknown }).noteType),
      colorTheme:
        (record as { colorTheme?: unknown }).colorTheme === 'light' ||
        (record as { colorTheme?: unknown }).colorTheme === 'dark'
          ? (record as { colorTheme: 'light' | 'dark' }).colorTheme
          : undefined,
    }));

  const tombstones = valid
    .filter((record) => record.deleted)
    .map((record) => ({
      id: record.id,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    }));

  // Seed the diff index from the records as loaded: live tabs get their
  // position in the SORTED live list (that is the index saveNotes will use
  // when it diffs), tombstones get -1.
  live.forEach((tab, index) => {
    lastWritten.set(tab.id, {
      name: tab.name,
      position: index,
      updatedAt: tab.updatedAt,
      deleted: false,
      noteType: tab.noteType,
    });
  });
  tombstones.forEach((tombstone) => {
    lastWritten.set(tombstone.id, {
      name: null,
      position: -1,
      updatedAt: tombstone.updatedAt,
      deleted: true,
      noteType: undefined,
    });
  });

  bootSnapshot = { tabs: live, tombstones };
  return bootSnapshot;
}

/** The persisted model for TabManager.init(). */
export function loadNotes(): Promise<NotesSnapshot> {
  if (storageBackend() === 'local-storage') {
    return Promise.resolve(loadLegacySnapshot());
  }
  if (bootSnapshot) {
    return Promise.resolve(bootSnapshot);
  }
  // Not booted yet (or hydrated without records): treat as an empty store —
  // TabManager bootstraps the welcome note from there.
  return Promise.resolve({ tabs: [], tombstones: [] });
}

/**
 * Fallback-mode load: today's exact localStorage semantics, mapped into the
 * snapshot shape.
 */
function loadLegacySnapshot(): NotesSnapshot {
  const tabs: StoredNoteTab[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      parsed.forEach((entry: Record<string, unknown>) => {
        if (entry && typeof entry.id === 'string') {
          tabs.push({
            id: entry.id,
            name: typeof entry.name === 'string' ? entry.name : null,
            html: typeof entry.html === 'string' ? entry.html : '',
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
            noteType: normalizeNoteType(entry.noteType),
            colorTheme:
              entry.colorTheme === 'light' || entry.colorTheme === 'dark'
                ? entry.colorTheme
                : undefined,
          });
        }
      });
    }
  } catch {
    /* malformed blob — start from an empty tab list */
  }

  const tombstones: StoredTombstone[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_TOMBSTONES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      parsed.forEach((entry: Record<string, unknown>) => {
        if (entry && typeof entry.id === 'string' && typeof entry.updatedAt === 'number') {
          tombstones.push({ id: entry.id, updatedAt: entry.updatedAt });
        }
      });
    }
  } catch {
    /* malformed blob — no tombstones */
  }

  return { tabs, tombstones };
}

/**
 * Migration hook: reads the legacy localStorage blobs into note records
 * (tombstones included). Empty when nothing is there. index.ts decides
 * whether to import them.
 */
export function parseLegacyNoteRecords(): NoteRecord[] {
  const snapshot = loadLegacySnapshot();
  const records: NoteRecord[] = snapshot.tabs.map((tab, index) => ({
    ...tab,
    position: index,
    deleted: false,
  }));
  snapshot.tombstones.forEach((tombstone) => {
    records.push({
      id: tombstone.id,
      name: null,
      html: '',
      createdAt: tombstone.updatedAt,
      updatedAt: tombstone.updatedAt,
      position: -1,
      deleted: true,
    });
  });
  return records;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persists the model. Fire-and-forget on purpose: TabManager's persist path
 * stays synchronous (like the old localStorage writes) and the database
 * transaction lands right after; a failed batch is re-marked so the next
 * save retries it.
 *
 * `immediate=false` is the typing path: the IndexedDB diff still runs, but
 * the compatibility blob is throttled to MIRROR_MIN_INTERVAL_MS.
 */
export function saveNotes(
  snapshot: NotesSnapshot,
  activeId: string | null,
  options: { immediate?: boolean } = {},
): void {
  currentSnapshotForMirror = snapshot;

  if (activeId !== null) {
    stateSet(ACTIVE_TAB_KEY, activeId);
  }

  if (storageBackend() === 'local-storage') {
    persistLegacyBlobs(snapshot);
    return;
  }

  const { upserts, deletes } = diffAgainstLastWritten(snapshot);

  if (upserts.length > 0 || deletes.length > 0) {
    const write = writeAll(NOTES_STORE, upserts, deletes).catch((error) => {
      console.warn('[storage] notes save failed — retrying on the next change', error);
      // Drop the affected entries from the diff index so the next save
      // re-writes them.
      upserts.forEach((record) => lastWritten.delete(record.id));
      deletes.forEach((id) => lastWritten.delete(id));
    });
    trackWrite(write);
  }

  mirrorLegacyNotes(snapshot, options.immediate !== false);
}

/**
 * Computes the changed rows. `deleted` tombstone rows and repositioned tabs
 * are upserts; ids that vanished from the model entirely (cloud-confirmed
 * deletions, merges) are deletes.
 */
function diffAgainstLastWritten(snapshot: NotesSnapshot): {
  upserts: NoteRecord[];
  deletes: string[];
} {
  const upserts: NoteRecord[] = [];
  const seen = new Set<string>();

  snapshot.tabs.forEach((tab, index) => {
    seen.add(tab.id);
    const previous = lastWritten.get(tab.id);
    const signature = {
      name: tab.name,
      position: index,
      updatedAt: tab.updatedAt,
      deleted: false,
      noteType: tab.noteType,
    };
    if (
      !previous ||
      previous.name !== signature.name ||
      previous.position !== index ||
      previous.updatedAt !== tab.updatedAt ||
      previous.noteType !== signature.noteType ||
      previous.deleted
    ) {
      upserts.push({ ...tab, position: index, deleted: false });
      lastWritten.set(tab.id, signature);
    }
  });

  snapshot.tombstones.forEach((tombstone) => {
    seen.add(tombstone.id);
    const previous = lastWritten.get(tombstone.id);
    if (!previous || !previous.deleted || previous.updatedAt !== tombstone.updatedAt) {
      upserts.push({
        id: tombstone.id,
        name: null,
        html: '',
        createdAt: tombstone.updatedAt,
        updatedAt: tombstone.updatedAt,
        position: -1,
        deleted: true,
      });
      lastWritten.set(tombstone.id, {
        name: null,
        position: -1,
        updatedAt: tombstone.updatedAt,
        deleted: true,
        noteType: undefined,
      });
    }
  });

  const deletes: string[] = [];
  lastWritten.forEach((_signature, id) => {
    if (!seen.has(id)) {
      deletes.push(id);
    }
  });
  deletes.forEach((id) => lastWritten.delete(id));

  return { upserts, deletes };
}

/** Fallback-mode save: the exact pre-migration whole-blob writes. */
function persistLegacyBlobs(snapshot: NotesSnapshot): void {
  try {
    localStorage.setItem(LEGACY_TABS_KEY, JSON.stringify(snapshot.tabs));
  } catch {
    /* quota exceeded — nothing else to do in fallback mode */
  }
  try {
    localStorage.setItem(LEGACY_TOMBSTONES_KEY, JSON.stringify(snapshot.tombstones));
  } catch {
    /* quota exceeded */
  }
}

/**
 * Compatibility mirror: keeps `padifyTabs`/`padifyTabTombstones` in
 * localStorage so service-worker-cached versions of the app from before
 * this storage layer keep reading fresh data during the rollout window —
 * and as a durable backup if IndexedDB alone is ever wiped.
 */
function mirrorLegacyNotes(snapshot: NotesSnapshot, immediate: boolean): void {
  if (immediate) {
    if (mirrorTimer !== null) {
      clearTimeout(mirrorTimer);
      mirrorTimer = null;
    }
    writeLegacyNotesMirror(snapshot);
    return;
  }

  mirrorDirty = true;
  if (mirrorTimer !== null) {
    return;
  }

  const elapsed = Date.now() - lastMirrorWriteAt;
  if (elapsed >= MIRROR_MIN_INTERVAL_MS) {
    writeLegacyNotesMirror(snapshot);
    return;
  }

  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    if (mirrorDirty) {
      writeLegacyNotesMirror(currentSnapshotForMirror ?? { tabs: [], tombstones: [] });
    }
  }, MIRROR_MIN_INTERVAL_MS - elapsed);
}

function writeLegacyNotesMirror(snapshot: NotesSnapshot): void {
  try {
    localStorage.setItem(LEGACY_TABS_KEY, JSON.stringify(snapshot.tabs));
    localStorage.setItem(LEGACY_TOMBSTONES_KEY, JSON.stringify(snapshot.tombstones));
    lastMirrorWriteAt = Date.now();
    mirrorDirty = false;
  } catch {
    // Quota exceeded — the mirror is best-effort; IndexedDB stays
    // authoritative. Retry on the next immediate write.
    lastMirrorWriteAt = Date.now();
  }
}

/** Pagehide hook: writes a pending throttled mirror immediately. */
export function flushNotesMirror(): void {
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
  if (mirrorDirty && currentSnapshotForMirror) {
    writeLegacyNotesMirror(currentSnapshotForMirror);
  }
}

// ---------------------------------------------------------------------------
// Write tracking (tests + diagnostics)
// ---------------------------------------------------------------------------

const inFlightWrites: Promise<void>[] = [];

function trackWrite(write: Promise<void>): void {
  inFlightWrites.push(write);
}

/**
 * Resolves once every issued notes write has settled (committed or retried).
 * Mainly a test hook — production code treats saves as fire-and-forget.
 */
export function whenNotesIdle(): Promise<void> {
  return Promise.all(inFlightWrites.splice(0)).then(() => undefined);
}

/** Test hook: resets diff/mirror state. */
export function resetNotesForTests(): void {
  lastWritten.clear();
  bootSnapshot = null;
  inFlightWrites.splice(0);
  currentSnapshotForMirror = null;
  lastMirrorWriteAt = 0;
  mirrorDirty = false;
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
}
