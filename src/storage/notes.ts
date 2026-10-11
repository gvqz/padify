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
import { reportSaveFailure, reportSaveRecovered } from './persistence';
import { normalizeNoteType, type NoteType } from '../editor/note-types';

/** A live note, structurally identical to NoteTab in tabs.ts. */
export interface StoredNoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  /**
   * The note's content in its type's format. The persisted JSON has said
   * `content` since the typed content model renamed it; rows written by
   * every build before that say `html`, and the loaders read both —
   * `content ?? html` — so an existing installation's notes keep loading
   * after the upgrade. Writers only ever emit `content`.
   */
  content: string;
  createdAt: number;
  updatedAt: number;
  /** The note kind — absent means the default (standard). */
  noteType?: NoteType;
  /** The theme the note's inline colors were last written under. */
  colorTheme?: 'light' | 'dark';
  /** Sync v2: the server sequence of the last synced version (sync
   *  metadata; see tabs.ts NoteTab.syncSeq). */
  syncSeq?: number;
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

/**
 * The stored record: a tab (or tombstone) plus its strip position.
 *
 * `html` is the legacy spelling of StoredNoteTab.content: rows persisted
 * by every build before the rename carry their note under that key, and
 * the loaders dual-read `content ?? html`. It is typed optional here so
 * the dual-read can run against raw records; new writers never set it.
 *
 * `v` is the row's SCHEMA VERSION — the local twin of the server's
 * PRAGMA-guarded migrations (server/db.ts). v1 (and every unversioned
 * row) is the pre-rename shape above; writers today stamp
 * NOTE_RECORD_VERSION. The point is forward determinism: when a future
 * shape lands (an encoded body, a restructured field), its migration
 * dispatches on record.v instead of sniffing field shapes — and shapes
 * that happen to look alike can never be misread as each other. The
 * field is local-only: it never crosses the wire (the sync layer copies
 * NoteTab, which has no v) and the server's row parser ignores unknown
 * keys anyway.
 */
export interface NoteRecord extends StoredNoteTab {
  position: number;
  deleted: boolean;
  html?: string;
  /** Local schema version — absent means v1 (the legacy dual-read shape). */
  v?: number;
}

/**
 * The current local note-row schema. Version history:
 *  • 1 (implied, unversioned rows) — the pre-rename shape: body under
 *    `html`, dual-read by the loaders.
 *  • 2 — the typed-content-model shape: body under `content`, note type
 *    and color theme optional fields. Writers stamp v=2 since this
 *    constant landed.
 *
 * Bump it WITH a case in migrateNoteRecord — never one without the other.
 */
export const NOTE_RECORD_VERSION = 2;

/**
 * Reads a raw stored record into the current shape, running any needed
 * migration and stamping the result's version. Pure (no writes): callers
 * decide whether a migrated row is worth writing back — hydrateNotes
 * feeds it to the snapshot, saveNotes re-stamps on its next write anyway.
 */
export function migrateNoteRecord(record: NoteRecord): NoteRecord {
  // Only a positive INTEGER counts as a version stamp: junk (NaN,
  // negatives, 2.5, a string) reads as v1 — the conservative path that
  // only ever normalizes the body read, never skips it.
  const stamped = typeof record.v === 'number' && Number.isInteger(record.v) && record.v > 0;
  const version = stamped ? (record.v as number) : 1;

  // A row from a NEWER build passes through untouched. Restamping it
  // (the old unconditional `{ ...migrated, v: NOTE_RECORD_VERSION }`)
  // would rewrite a future shape as the current version — a downgrade
  // that makes the next upgrade misread the row forever. Unknown-shape
  // fields already ride along harmlessly (the loaders only read known
  // keys), so the honest move is to leave the stamp alone.
  if (version > NOTE_RECORD_VERSION) {
    return record;
  }

  let migrated = record;
  if (version < 2) {
    // v1 → v2: the rename transition. The body may sit under the legacy
    // `html` key (content wins when both appear — the dual-read order the
    // loaders have always used).
    const body =
      typeof record.content === 'string'
        ? record.content
        : typeof record.html === 'string'
          ? record.html
          : '';
    migrated = { ...record, content: body };
  }

  return { ...migrated, v: NOTE_RECORD_VERSION };
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
 * Note ids deleted by ANOTHER tab of this browser (learned from the
 * compatibility mirror's `storage` events — a tab's own writes never fire
 * them). Without this, a stale tab that still holds a deleted note live
 * would upsert the row back over the tombstone on its next save: the note
 * resurrects locally AND rides the next cloud push to every device. The
 * diff refuses to write live rows for these ids; the model catches up on
 * the next re-hydrate (reload) like every other cross-tab change.
 */
const externallyDeletedIds = new Set<string>();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LEGACY_TOMBSTONES_KEY || !event.newValue) {
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue);
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const entry of parsed) {
        if (entry && typeof entry.id === 'string') {
          externallyDeletedIds.add(entry.id);
        }
      }
    } catch {
      /* the other tab wrote a partial blob — ignore it */
    }
  });
}

/**
 * The latest snapshot handed to saveNotes — the throttled trailing mirror
 * write needs the freshest model, which only TabManager knows.
 */
let currentSnapshotForMirror: NotesSnapshot | null = null;

/**
 * The last-written index powering the diff. Values are the fields that
 * matter for persistence — content changes always bump `updatedAt` in
 * TabManager, so content does not need to be compared (or copied) here.
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
    .map((raw) => {
      // Route through the migration so unversioned (v1) rows read their
      // body the same way the hand-rolled dual-read always did.
      const record = migrateNoteRecord(raw);
      return {
        id: record.id,
        name: typeof record.name === 'string' ? record.name : null,
        content: typeof record.content === 'string' ? record.content : '',
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
        noteType: normalizeNoteType((record as { noteType?: unknown }).noteType),
        colorTheme:
          (record as { colorTheme?: unknown }).colorTheme === 'light' ||
          (record as { colorTheme?: unknown }).colorTheme === 'dark'
            ? (record as { colorTheme: 'light' | 'dark' }).colorTheme
            : undefined,
        // Round-trip the sync sequence so conflict arbitration keeps its
        // seq anchor across reloads instead of degrading to client clocks
        // for the whole session (see NoteTab.syncSeq).
        syncSeq:
          typeof (record as { syncSeq?: unknown }).syncSeq === 'number' &&
          (record as { syncSeq: number }).syncSeq > 0
            ? (record as { syncSeq: number }).syncSeq
            : undefined,
      };
    });

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
            // Dual-read the rename: rows persisted by older builds say `html`.
            content:
              typeof entry.content === 'string'
                ? entry.content
                : typeof entry.html === 'string'
                  ? entry.html
                  : '',
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
            noteType: normalizeNoteType(entry.noteType),
            colorTheme:
              entry.colorTheme === 'light' || entry.colorTheme === 'dark'
                ? entry.colorTheme
                : undefined,
            syncSeq:
              typeof entry.syncSeq === 'number' && entry.syncSeq > 0 ? entry.syncSeq : undefined,
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
      content: '',
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
    const write = writeAll(NOTES_STORE, upserts, deletes)
      .then(() => {
        // The write landed: any earlier failure is over. The save
        // indicator hears the transition and stops warning.
        reportSaveRecovered();
      })
      .catch((error) => {
        console.warn('[storage] notes save failed — retrying on the next change', error);
        // A failed save must not stay a console-only fact: the
        // persistence layer turns it into the persistent warning the
        // save indicator shows (quota causes get the storage-full
        // wording and a re-ask for navigator.storage.persist()).
        reportSaveFailure(error);
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
    // Another tab of this browser deleted this note after we hydrated:
    // never upsert a live row back over its tombstone (see
    // externallyDeletedIds). The id stays "seen" so the trailing
    // delete-sweep below doesn't drop the tombstone either.
    if (externallyDeletedIds.has(tab.id)) {
      return;
    }
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
      // Every writer stamps the current schema version (see
      // NOTE_RECORD_VERSION); v is local-only and never crosses the wire.
      upserts.push({ ...tab, position: index, deleted: false, v: NOTE_RECORD_VERSION });
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
        content: '',
        createdAt: tombstone.updatedAt,
        updatedAt: tombstone.updatedAt,
        position: -1,
        deleted: true,
        v: NOTE_RECORD_VERSION,
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
  // In fallback mode (Safari private windows, hardened browsers) these
  // writes ARE the save — a swallowed quota failure would leave the save
  // indicator saying "Saved" while every keystroke after the failure is
  // lost on reload. Route failures through the same health machinery the
  // IndexedDB path uses, so the indicator warns and the persist() re-ask
  // has a chance to run. Only a clean sweep of BOTH writes counts as
  // recovered — a successful tombstone write must not mask a failed tabs
  // write (reportSaveRecovered flips the indicator back to healthy).
  let failure: unknown = null;
  try {
    localStorage.setItem(LEGACY_TABS_KEY, JSON.stringify(snapshot.tabs));
  } catch (error) {
    failure = error;
  }
  try {
    localStorage.setItem(LEGACY_TOMBSTONES_KEY, JSON.stringify(snapshot.tombstones));
  } catch (error) {
    if (failure === null) {
      failure = error;
    }
  }
  if (failure !== null) {
    reportSaveFailure(failure);
  } else {
    reportSaveRecovered();
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
    // authoritative. Retry on the next immediate write. Say it once,
    // though: the mirror's documented job is the durable backup (and
    // fresh data for SW-cached old builds) — a set of notes bigger than
    // the localStorage quota means that backup silently stopped being
    // true, which deserves one console trace, not a keystroke-spam of
    // them.
    if (!warnedMirrorQuota) {
      warnedMirrorQuota = true;
      console.warn(
        '[storage] the localStorage compatibility mirror no longer fits the quota — ' +
          'IndexedDB remains authoritative, but the legacy backup is stale until notes shrink. ' +
          'Consider exporting or deleting old notes.',
      );
    }
    lastMirrorWriteAt = Date.now();
  }
}

/** One-shot guard for the mirror quota warning. */
let warnedMirrorQuota = false;

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
  externallyDeletedIds.clear();
  warnedMirrorQuota = false;
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
}
