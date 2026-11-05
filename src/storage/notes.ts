/**
 * Padify storage — the notes repository.
 *
 * Notes used to live as ONE JSON blob in localStorage (`padifyTabs`), re-
 * serialised on every debounced keystroke. Now each note is a row in the
 * IndexedDB `notes` store and a save writes only what actually changed:
 *
 *  • loadNotes()  → { tabs, trashed } (plus the active tab id via kv)
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
import { TRASH_RETENTION_MS } from '../../shared/wire';

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
  /**
   * The last version the CLOUD agreed to (content + name at the last
   * confirmed push or adoption) — the common ancestor a three-way merge
   * diffs against (see src/merge/). Set only while cloud sync is active;
   * absent on signed-out installs, so it costs nothing there.
   */
  syncBase?: { content: string; name: string | null };
  /** Conflicted-copy lineage (local-only sync metadata; see
   *  tabs.ts NoteTab.copyOf). */
  copyOf?: string;
}

/**
 * A note in the trash — the full record plus the moment it landed there.
 * Content is KEPT (that is what makes restore one click), and the id never
 * changes, so a restored note keeps every share link keyed to it.
 *
 * `purged` marks a delete-forever placeholder: content emptied, trash stamp
 * backdated past retention, invisible everywhere — it exists only until its
 * sweeper row is confirmed pushed (see TabManager.purgeNote). Local-only.
 */
export interface TrashedNote extends StoredNoteTab {
  deletedAt: number;
  purged?: boolean;
}

export interface NotesSnapshot {
  tabs: StoredNoteTab[];
  trashed: TrashedNote[];
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
  /** When the row was trashed (epoch ms) — present on every deleted row
   *  written by trash-aware builds; the v3 migration stamps it onto legacy
   *  tombstones from their updatedAt. */
  deletedAt?: number;
  html?: string;
  /** Local schema version — absent means v1 (the legacy dual-read shape). */
  v?: number;
}

/**
 * The current local note-row schema. Version history:
 *  • 1 (implied, unversioned rows) — the pre-rename shape: body under
 *    `html`, dual-read by the loaders.
 *  • 2 — the typed-content-model shape: body under `content`, note type
 *    and color theme optional fields.
 *  • 3 — the trash shape: deleted rows carry `deletedAt` (epoch ms) and
 *    KEEP their content — a delete is a trash entry now, restorable for
 *    TRASH_RETENTION_MS, not a content-less tombstone.
 *
 * Bump it WITH a case in migrateNoteRecord — never one without the other.
 */
export const NOTE_RECORD_VERSION = 3;

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

  if (version < 3 && migrated.deleted) {
    // v2 → v3: the trash transition. A deleted row without a trash stamp
    // is a legacy tombstone — its delete clock is the best stamp there is.
    // Content-less by construction (the old writers emptied it), so the
    // entry is invisible in the trash UI and the retention sweep retires
    // it on its own age.
    const stamp =
      typeof (migrated as { deletedAt?: unknown }).deletedAt === 'number' &&
      (migrated as { deletedAt: number }).deletedAt > 0
        ? (migrated as { deletedAt: number }).deletedAt
        : typeof migrated.updatedAt === 'number' && migrated.updatedAt > 0
          ? migrated.updatedAt
          : Date.now();
    migrated = { ...migrated, deletedAt: stamp };
  }

  return { ...migrated, v: NOTE_RECORD_VERSION };
}

/** Reads a stored syncBase back — junk reads as absent, never as a lie. */
function readSyncBase(value: unknown): { content: string; name: string | null } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const base = value as { content?: unknown; name?: unknown };
  if (typeof base.content !== 'string') {
    return undefined;
  }
  return {
    content: base.content,
    name: typeof base.name === 'string' ? base.name : null,
  };
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
 * `deletedAt` keys the trash-diff; `swept` marks retention-retired rows
 * seeded only so the next save deletes them.
 */
const lastWritten = new Map<
  string,
  {
    name: string | null;
    position: number;
    updatedAt: number;
    deleted: boolean;
    deletedAt: number;
    noteType: NoteType | undefined;
    swept: boolean;
    syncBase: { content: string; name: string | null } | undefined;
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
 * the trash) and seeds the diff index. Called by index.ts after the
 * database (and any legacy import) is in place.
 *
 * The retention sweep runs HERE: trashed rows whose window closed never
 * join the snapshot (the trash UI never sees them) — but they DO seed the
 * diff index, so the next saveNotes deletes them from the database, and
 * sweptTrashIds() names them for index.ts's immediate cleanup write.
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
        syncBase: readSyncBase((record as { syncBase?: unknown }).syncBase),
        // Round-trip the conflicted-copy lineage so the multiplication
        // guard survives reloads (see NoteTab.copyOf).
        copyOf:
          typeof (record as { copyOf?: unknown }).copyOf === 'string' &&
          (record as { copyOf: string }).copyOf
            ? (record as { copyOf: string }).copyOf
            : undefined,
      };
    });

  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const trashed = valid
    .filter((record) => record.deleted)
    .map((raw) => {
      const record = migrateNoteRecord(raw);
      const stamp =
        typeof record.deletedAt === 'number' && record.deletedAt > 0
          ? record.deletedAt
          : typeof record.updatedAt === 'number' && record.updatedAt > 0
            ? record.updatedAt
            : 0;
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
        syncSeq:
          typeof (record as { syncSeq?: unknown }).syncSeq === 'number' &&
          (record as { syncSeq: number }).syncSeq > 0
            ? (record as { syncSeq: number }).syncSeq
            : undefined,
        copyOf:
          typeof (record as { copyOf?: unknown }).copyOf === 'string' &&
          (record as { copyOf: string }).copyOf
            ? (record as { copyOf: string }).copyOf
            : undefined,
        deletedAt: stamp,
        purged: (record as { purged?: unknown }).purged === true ? true : undefined,
      } satisfies TrashedNote;
    })
    .filter((entry) => entry.deletedAt > cutoff);

  // Seed the diff index from the records as loaded: live tabs get their
  // position in the SORTED live list (that is the index saveNotes will use
  // when it diffs), the surviving trash gets -1 — and swept rows seed too,
  // so the next saveNotes deletes them from the database.
  live.forEach((tab, index) => {
    lastWritten.set(tab.id, {
      name: tab.name,
      position: index,
      updatedAt: tab.updatedAt,
      deleted: false,
      deletedAt: 0,
      noteType: tab.noteType,
      swept: false,
      syncBase: tab.syncBase,
    });
  });
  valid
    .filter((record) => record.deleted)
    .forEach((record) => {
      const swept = !trashed.some((entry) => entry.id === record.id);
      lastWritten.set(record.id, {
        name: null,
        position: -1,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
        deleted: true,
        noteType: undefined,
        // A swept row must LOOK unchanged to the diff (nothing about it
        // re-writes) while sitting in the index's delete path — the purge
        // write removes it by id.
        deletedAt: 0,
        swept,
        syncBase: undefined,
      });
    });

  bootSnapshot = { tabs: live, trashed };
  return bootSnapshot;
}

/**
 * The trashed rows the hydrate sweep retired — index.ts purges these from
 * the database right after boot so they don't linger until the first save.
 */
export function sweptTrashIds(): string[] {
  const ids: string[] = [];
  lastWritten.forEach((signature, id) => {
    if (signature.deleted && signature.swept) {
      ids.push(id);
    }
  });
  return ids;
}

/**
 * Hard-deletes note records by id — the write path behind "Delete
 * forever", "Empty trash" and the boot-time retention cleanup. Issues the
 * IndexedDB delete directly (the rows are already gone from the model)
 * and drops them from the diff index so no later save resurrects them.
 */
export function purgeNoteRecords(ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  ids.forEach((id) => lastWritten.delete(id));
  if (storageBackend() === 'local-storage') {
    // Fallback mode: rewrite the legacy blobs without the purged ids. The
    // tombstones mirror drops them; a live row with a purged id (a torn
    // state that should not exist) goes too.
    const snapshot = currentSnapshotForMirror ?? bootSnapshot ?? { tabs: [], trashed: [] };
    persistLegacyBlobs(snapshot);
    return;
  }
  trackWrite(
    writeAll(NOTES_STORE, [], ids).catch((error) => {
      console.warn('[storage] trash purge failed — retrying on the next boot sweep', error);
    }),
  );
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
  return Promise.resolve({ tabs: [], trashed: [] });
}

/**
 * Fallback-mode load: today's exact localStorage semantics, mapped into the
 * snapshot shape. The tombstones blob reads as the trash's id+clock pairs —
 * in fallback mode the blob IS the store, so a trashed entry there keeps
 * whatever the blob carries (the fallback writes content-less deletes,
 * same as it always did).
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
            syncBase: readSyncBase(entry.syncBase),
            copyOf: typeof entry.copyOf === 'string' && entry.copyOf ? entry.copyOf : undefined,
          });
        }
      });
    }
  } catch {
    /* malformed blob — start from an empty tab list */
  }

  const trashed: TrashedNote[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_TOMBSTONES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      parsed.forEach((entry: Record<string, unknown>) => {
        if (entry && typeof entry.id === 'string' && typeof entry.updatedAt === 'number') {
          const live = tabs.find((tab) => tab.id === entry.id);
          trashed.push({
            id: entry.id,
            name: null,
            content: '',
            createdAt: live?.createdAt ?? entry.updatedAt,
            updatedAt: entry.updatedAt,
            noteType: undefined,
            deletedAt:
              typeof entry.deletedAt === 'number' && entry.deletedAt > 0
                ? entry.deletedAt
                : entry.updatedAt,
          });
        }
      });
    }
  } catch {
    /* malformed blob — no trash */
  }

  return { tabs, trashed };
}

/**
 * Migration hook: reads the legacy localStorage blobs into note records
 * (trash included). Empty when nothing is there. index.ts decides
 * whether to import them.
 */
export function parseLegacyNoteRecords(): NoteRecord[] {
  const snapshot = loadLegacySnapshot();
  const records: NoteRecord[] = snapshot.tabs.map((tab, index) => ({
    ...tab,
    position: index,
    deleted: false,
  }));
  snapshot.trashed.forEach((entry) => {
    records.push({
      id: entry.id,
      name: entry.name,
      content: entry.content,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      noteType: entry.noteType,
      position: -1,
      deleted: true,
      deletedAt: entry.deletedAt,
    });
  });
  return records;
}

// ---------------------------------------------------------------------------
// Mirror reconciliation (the notes sibling of kv's reconcile)
// ---------------------------------------------------------------------------

/**
 * Boot hook (IndexedDB mode): the durability sweep. The legacy mirror is
 * written SYNCHRONOUSLY at pagehide, while the IndexedDB write issued in
 * the same breath can die with the page — so the newest state of a note
 * can exist only in localStorage. For every mirror row strictly newer
 * than its committed IndexedDB row, the mirror copy is the truth: a
 * lost edit recovers, a lost trash re-applies so the note cannot
 * resurrect.
 *
 * A recovered trash entry KEEPS the committed row's content when the mirror
 * blob has none (it never does — the mirror writes id+clock pairs): the
 * words on screen at the moment of the delete are exactly what the trash
 * exists to keep.
 *
 * Rescued rows deliberately keep their STALE diff-index seeds (and new
 * ids get none), so the next saveNotes diffs them as changed and
 * re-upserts them into the database — index.ts triggers that heal
 * immediately. Returns true when anything was rescued.
 */
export function reconcileNotesFromMirror(): boolean {
  if (storageBackend() === 'local-storage' || !bootSnapshot) {
    return false;
  }
  const mirror = loadLegacySnapshot();
  if (mirror.tabs.length === 0 && mirror.trashed.length === 0) {
    return false;
  }

  const liveById = new Map(bootSnapshot.tabs.map((tab) => [tab.id, tab]));
  const trashById = new Map(bootSnapshot.trashed.map((grave) => [grave.id, grave]));
  let changed = false;

  // Lost trashes re-apply — unless the committed row is at least as new
  // (a delete followed by edits that DID commit wins over the trash), or
  // the retention window already closed on them (a swept row must not
  // come back from a stale mirror: the hydrate sweep just retired it, and
  // re-adding it would make every ancient tombstone immortal).
  const retentionCutoff = Date.now() - TRASH_RETENTION_MS;
  for (const grave of mirror.trashed) {
    if (grave.deletedAt <= retentionCutoff) {
      continue;
    }
    const live = liveById.get(grave.id);
    const existing = trashById.get(grave.id);
    if (
      (live !== undefined && live.updatedAt >= grave.deletedAt) ||
      (existing !== undefined && existing.deletedAt >= grave.deletedAt)
    ) {
      continue;
    }
    // The trash keeps the committed row's words — that is the rescue.
    const words = live ?? existing;
    trashById.set(grave.id, {
      id: grave.id,
      name: words?.name ?? null,
      content: words?.content ?? '',
      createdAt: words?.createdAt ?? grave.deletedAt,
      updatedAt: grave.deletedAt,
      noteType: words?.noteType,
      colorTheme: words?.colorTheme,
      syncSeq: words?.syncSeq,
      copyOf: words?.copyOf,
      deletedAt: grave.deletedAt,
    });
    liveById.delete(grave.id);
    changed = true;
  }

  // Lost edits recover: a strictly newer mirror row replaces the
  // committed one's fields, keeping its strip position; a row the dying
  // page created at the last moment joins the end of the strip.
  const order = new Map(bootSnapshot.tabs.map((tab, index) => [tab.id, index]));
  for (const row of mirror.tabs) {
    const committed = liveById.get(row.id);
    if (committed) {
      if (committed.updatedAt >= row.updatedAt) continue; // IndexedDB is fresh enough
      committed.name = row.name;
      committed.content = row.content;
      committed.updatedAt = row.updatedAt;
      committed.noteType = row.noteType;
      committed.colorTheme = row.colorTheme;
      committed.syncSeq = row.syncSeq;
      committed.syncBase = row.syncBase;
      committed.copyOf = row.copyOf;
      trashById.delete(row.id);
    } else {
      // A mirror-live row the store holds as TRASHED is a delete the
      // mirror never saw — the committed trash (newer or equal) stands.
      if (trashById.has(row.id)) {
        continue;
      }
      liveById.set(row.id, row);
    }
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const end = order.size;
  const tabs = [...liveById.values()].sort(
    (a, b) => (order.get(a.id) ?? end) - (order.get(b.id) ?? end),
  );
  bootSnapshot = { tabs, trashed: [...trashById.values()] };
  return true;
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
 * Computes the changed rows. Trash rows (deleted, deletedAt stamped,
 * content kept) are upserts; ids that vanished from the model entirely
 * (purged trash, merges) are deletes.
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
    // never upsert a live row back over its trash row (see
    // externallyDeletedIds). The id stays "seen" so the trailing
    // delete-sweep below doesn't drop the trash row either.
    if (externallyDeletedIds.has(tab.id)) {
      return;
    }
    const previous = lastWritten.get(tab.id);
    const signature = {
      name: tab.name,
      position: index,
      updatedAt: tab.updatedAt,
      deleted: false,
      deletedAt: 0,
      noteType: tab.noteType,
      swept: false,
      syncBase: tab.syncBase,
    };
    const sameSyncBase =
      previous?.syncBase?.content === tab.syncBase?.content &&
      previous?.syncBase?.name === tab.syncBase?.name;
    if (
      !previous ||
      previous.name !== signature.name ||
      previous.position !== index ||
      previous.updatedAt !== tab.updatedAt ||
      previous.noteType !== signature.noteType ||
      previous.deleted ||
      !sameSyncBase
    ) {
      // Every writer stamps the current schema version (see
      // NOTE_RECORD_VERSION); v is local-only and never crosses the wire.
      upserts.push({ ...tab, position: index, deleted: false, v: NOTE_RECORD_VERSION });
      lastWritten.set(tab.id, signature);
    }
  });

  snapshot.trashed.forEach((grave) => {
    seen.add(grave.id);
    const previous = lastWritten.get(grave.id);
    if (
      !previous ||
      !previous.deleted ||
      previous.deletedAt !== grave.deletedAt ||
      previous.updatedAt !== grave.updatedAt
    ) {
      upserts.push({
        id: grave.id,
        name: grave.name,
        content: grave.content,
        createdAt: grave.createdAt,
        updatedAt: grave.updatedAt,
        noteType: grave.noteType,
        colorTheme: grave.colorTheme,
        syncSeq: grave.syncSeq,
        copyOf: grave.copyOf,
        position: -1,
        deleted: true,
        deletedAt: grave.deletedAt,
        ...(grave.purged ? { purged: true } : {}),
        v: NOTE_RECORD_VERSION,
      });
      lastWritten.set(grave.id, {
        name: grave.name,
        position: -1,
        updatedAt: grave.updatedAt,
        deleted: true,
        deletedAt: grave.deletedAt,
        noteType: grave.noteType,
        swept: false,
        syncBase: undefined,
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
  // recovered — a successful trash write must not mask a failed tabs
  // write (reportSaveRecovered flips the indicator back to healthy).
  let failure: unknown = null;
  try {
    localStorage.setItem(LEGACY_TABS_KEY, JSON.stringify(snapshot.tabs));
  } catch (error) {
    failure = error;
  }
  try {
    localStorage.setItem(
      LEGACY_TOMBSTONES_KEY,
      JSON.stringify(
        snapshot.trashed.map((grave) => ({ id: grave.id, updatedAt: grave.deletedAt })),
      ),
    );
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
      writeLegacyNotesMirror(currentSnapshotForMirror ?? { tabs: [], trashed: [] });
    }
  }, MIRROR_MIN_INTERVAL_MS - elapsed);
}

function writeLegacyNotesMirror(snapshot: NotesSnapshot): void {
  try {
    localStorage.setItem(LEGACY_TABS_KEY, JSON.stringify(snapshot.tabs));
    // The tombstones mirror carries the trash as id+clock pairs — the shape
    // every pre-storage build reads, so a trashed note reads as deleted
    // there and the cross-tab storage-event guard keeps working.
    localStorage.setItem(
      LEGACY_TOMBSTONES_KEY,
      JSON.stringify(
        snapshot.trashed.map((grave) => ({ id: grave.id, updatedAt: grave.deletedAt })),
      ),
    );
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
