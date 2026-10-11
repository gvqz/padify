import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPendingWrites,
  resetStorageForTests,
  storageReady,
  stateGet,
  stateRemove,
  stateSet,
  loadNotes,
  saveNotes,
  whenNotesIdle,
  type StoredNoteTab,
} from './index';
import { flushKv } from './kv';
import { flushNotesMirror, type NoteRecord } from './notes';
import { DB_NAME, readAll, writeAll, NOTES_STORE } from './idb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const note = (id: string, content: string, updatedAt = 1): StoredNoteTab => ({
  id,
  name: null,
  content,
  createdAt: 0,
  updatedAt,
});

/** Deletes the padify database (close any connection first). */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Reset + fresh database + clean localStorage, then boot. */
async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

/** Reset module state but keep the database contents, then re-boot. */
async function reboot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await storageReady();
}

let originalWarn: typeof console.warn;

beforeEach(async () => {
  originalWarn = console.warn;
  console.warn = vi.fn();
});

afterEach(() => {
  console.warn = originalWarn;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// kv store
// ---------------------------------------------------------------------------

describe('kv store (settings)', () => {
  beforeEach(freshBoot);

  it('reads synchronously from the hydrated mirror', async () => {
    stateSet('mode', 'dark');
    expect(stateGet('mode')).toBe('dark');

    stateSet('mode', 'light');
    expect(stateGet('mode')).toBe('light');

    stateRemove('mode');
    expect(stateGet('mode')).toBeNull();
  });

  it('writes through to localStorage (compatibility mirror)', () => {
    stateSet('mode', 'dark');
    expect(localStorage.getItem('mode')).toBe('dark');

    stateRemove('mode');
    expect(localStorage.getItem('mode')).toBeNull();
  });

  it('persists to IndexedDB and survives a re-boot', async () => {
    stateSet('mode', 'dark');
    stateSet('selectedFont', 'serif');
    await flushKv();

    localStorage.clear(); // the IDB copy alone must be enough
    await reboot();

    expect(stateGet('mode')).toBe('dark');
    expect(stateGet('selectedFont')).toBe('serif');
  });

  it('returns null for unknown keys without touching anything', () => {
    expect(stateGet('never-set')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// notes repository
// ---------------------------------------------------------------------------

describe('notes repository', () => {
  beforeEach(freshBoot);

  it('round-trips a snapshot with positions, tombstones and active tab', async () => {
    saveNotes(
      {
        tabs: [note('a', '<b>one</b>'), note('b', 'two')],
        tombstones: [{ id: 'x', updatedAt: 5 }],
      },
      'b',
    );
    await whenNotesIdle();
    await flushKv();

    localStorage.clear(); // IDB alone must hold the model
    await reboot();

    const snapshot = await loadNotes();
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(snapshot.tabs[0].content).toBe('<b>one</b>');
    expect(snapshot.tombstones).toEqual([{ id: 'x', updatedAt: 5 }]);
    expect(stateGet('padifyActiveTab')).toBe('b');
  });

  it('round-trips syncSeq through a reload — the cloud merge anchor survives boot', async () => {
    // The save path stamps syncSeq on every row (the cloud layer sets it
    // when the server accepts a push); the boot hydration used to drop the
    // field, so every fresh session fell back to client-clock arbitration
    // until each note was re-adopted by a pull. Pin the round-trip.
    saveNotes(
      {
        tabs: [
          { ...note('a', 'body'), syncSeq: 42 },
          { ...note('b', 'body'), syncSeq: 0 },
        ],
        tombstones: [],
      },
      'a',
    );
    await whenNotesIdle();

    localStorage.clear();
    await reboot();

    const snapshot = await loadNotes();
    const a = snapshot.tabs.find((tab) => tab.id === 'a');
    const b = snapshot.tabs.find((tab) => tab.id === 'b');
    expect(a?.syncSeq).toBe(42); // the anchor survives the reload
    expect(b?.syncSeq).toBeUndefined(); // seq 0 and junk read as absent
  });

  it('stores tombstones as deleted rows and hard-deletes vanished ids', async () => {
    saveNotes({ tabs: [note('a', 'a'), note('b', 'b')], tombstones: [] }, 'a');
    await whenNotesIdle();

    // b is removed without a tombstone (cloud-confirmed deletion) → hard delete.
    // a is closed WITH a tombstone → deleted row.
    saveNotes({ tabs: [note('a', 'a')], tombstones: [{ id: 'a', updatedAt: 9 }] }, null);
    await whenNotesIdle();

    const records = await readAll<NoteRecord>(NOTES_STORE);
    const byId = new Map(records.map((record) => [record.id, record]));
    expect(byId.get('a')?.deleted).toBe(true);
    expect(byId.has('b')).toBe(false);
  });

  it('refuses to resurrect a note another tab deleted (mirror storage event)', async () => {
    // The cross-tab scenario: tab B deletes note a (its tombstone list
    // lands in the legacy mirror, which fires a `storage` event in tab A);
    // tab A still holds a live in its model and keeps typing. Without the
    // guard, A's next save upserts a live row back over B's tombstone —
    // locally AND via the next cloud push. With it, A's saves leave the
    // row alone until a re-hydrate catches up.
    saveNotes({ tabs: [note('a', 'original')], tombstones: [] }, 'a');
    await whenNotesIdle();

    // Simulate the other tab's mirror write.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'padifyTabTombstones',
        newValue: JSON.stringify([{ id: 'a', updatedAt: 99 }]),
      }),
    );

    saveNotes({ tabs: [note('a', 'typed after the delete', 50)], tombstones: [] }, 'a');
    await whenNotesIdle();

    const records = await readAll<NoteRecord>(NOTES_STORE);
    const byId = new Map(records.map((record) => [record.id, record]));
    // The live upsert was skipped: the row keeps its original body (and
    // whatever deletion state the other tab's write left behind).
    expect(byId.get('a')?.content).toBe('original');
  });

  it('persists strip order as position and honours it on load', async () => {
    saveNotes({ tabs: [note('a', 'a'), note('b', 'b'), note('c', 'c')], tombstones: [] }, 'a');
    await whenNotesIdle();

    // Reorder: b, c, a.
    saveNotes({ tabs: [note('b', 'b'), note('c', 'c'), note('a', 'a')], tombstones: [] }, 'b');
    await whenNotesIdle();

    await reboot();
    const snapshot = await loadNotes();
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['b', 'c', 'a']);
  });

  it('writes only the changed rows on a save', async () => {
    saveNotes({ tabs: [note('a', 'a'), note('b', 'b')], tombstones: [] }, 'a');
    await whenNotesIdle();

    // Unchanged model + no changes → the diff must be empty, i.e. a fresh
    // save issues no new write. Instrument by counting puts through the
    // database length: save the SAME model and expect no growth in flight.
    const before = (await readAll<NoteRecord>(NOTES_STORE)).length;
    saveNotes({ tabs: [note('a', 'a'), note('b', 'b')], tombstones: [] }, 'a');
    await whenNotesIdle();
    const after = (await readAll<NoteRecord>(NOTES_STORE)).length;

    expect(after).toBe(before);
  });

  it('loads rows persisted by a pre-rename build (html key) through the dual-read', async () => {
    // Hand-write rows exactly as an older build persisted them: the note
    // body under `html`, no `content` key anywhere. The rename transition
    // reads either key — an existing installation's notes must keep
    // loading after the upgrade, byte for byte.
    await writeAll(
      NOTES_STORE,
      [
        {
          id: 'old-a',
          name: null,
          html: '<p>legacy one</p>',
          createdAt: 1,
          updatedAt: 2,
          position: 0,
          deleted: false,
        },
        {
          id: 'old-b',
          name: null,
          html: '<i>legacy two</i>',
          createdAt: 1,
          updatedAt: 2,
          position: 1,
          deleted: false,
        },
      ],
      [],
    );

    await reboot();
    const snapshot = await loadNotes();
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['old-a', 'old-b']);
    expect(snapshot.tabs[0].content).toBe('<p>legacy one</p>');
    expect(snapshot.tabs[1].content).toBe('<i>legacy two</i>');
  });

  it('updates a changed note with the new content', async () => {
    saveNotes({ tabs: [note('a', 'v1', 10)], tombstones: [] }, 'a');
    await whenNotesIdle();

    saveNotes({ tabs: [note('a', 'v2', 20)], tombstones: [] }, 'a');
    await whenNotesIdle();

    const records = await readAll<NoteRecord>(NOTES_STORE);
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('v2');
    expect(records[0].updatedAt).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// compatibility mirror (legacy localStorage blobs)
// ---------------------------------------------------------------------------

describe('legacy blob mirror', () => {
  beforeEach(freshBoot);

  it('immediate saves write the legacy blobs to localStorage', () => {
    const tabs = [note('a', 'hello')];
    saveNotes({ tabs, tombstones: [{ id: 'z', updatedAt: 3 }] }, 'a');

    expect(JSON.parse(localStorage.getItem('padifyTabs') ?? '[]')).toEqual(tabs);
    expect(JSON.parse(localStorage.getItem('padifyTabTombstones') ?? '[]')).toEqual([
      { id: 'z', updatedAt: 3 },
    ]);
    expect(localStorage.getItem('padifyActiveTab')).toBe('a');
  });

  it('throttles the typing path and flushes on demand', () => {
    const first = [note('a', 'first', 1)];
    const second = [note('a', 'second', 2)];

    saveNotes({ tabs: first, tombstones: [] }, 'a');
    // Typing path: the blob keeps the last immediate state until the window
    // elapses (or a flush happens).
    saveNotes({ tabs: second, tombstones: [] }, 'a', { immediate: false });
    expect(localStorage.getItem('padifyTabs')).toBe(JSON.stringify(first));

    flushNotesMirror();
    expect(localStorage.getItem('padifyTabs')).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// legacy localStorage migration
// ---------------------------------------------------------------------------

describe('legacy migration', () => {
  beforeEach(freshBoot);

  it('imports tabs, tombstones and settings on first boot', async () => {
    localStorage.setItem(
      'padifyTabs',
      JSON.stringify([
        { id: 't1', name: 'First', content: '<i>hi</i>', createdAt: 1, updatedAt: 2 },
        { id: 't2', name: null, content: 'plain', createdAt: 3, updatedAt: 4 },
      ]),
    );
    localStorage.setItem('padifyTabTombstones', JSON.stringify([{ id: 'gone', updatedAt: 9 }]));
    localStorage.setItem('mode', 'dark');
    localStorage.setItem('selectedFont', 'serif');
    localStorage.setItem('note', 'legacy body');

    await reboot();

    const snapshot = await loadNotes();
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
    expect(snapshot.tabs[0].name).toBe('First');
    expect(snapshot.tombstones).toEqual([{ id: 'gone', updatedAt: 9 }]);
    expect(stateGet('mode')).toBe('dark');
    expect(stateGet('selectedFont')).toBe('serif');
    expect(stateGet('note')).toBe('legacy body');
    expect(stateGet('padifyStorageMigrated')).toBe('1');
  });

  it('keeps the legacy keys in place (frozen backup, not deleted)', async () => {
    localStorage.setItem('padifyTabs', JSON.stringify([note('t1', 'x')]));
    await reboot();
    expect(localStorage.getItem('padifyTabs')).not.toBeNull();
  });

  it('runs only once — later localStorage changes do not override IndexedDB', async () => {
    localStorage.setItem('mode', 'dark');
    localStorage.setItem('padifyTabs', JSON.stringify([note('t1', 'x')]));
    await reboot(); // migration runs here

    localStorage.setItem('mode', 'light'); // ignored: already migrated
    await reboot();

    expect(stateGet('mode')).toBe('dark');
  });

  it('leaves unknown keys alone (retired mini tools)', async () => {
    localStorage.setItem('someRetiredToolKey', 'junk');
    await reboot();
    expect(stateGet('someRetiredToolKey')).toBeNull();
    expect(localStorage.getItem('someRetiredToolKey')).toBe('junk');
  });
});

// ---------------------------------------------------------------------------
// fallback backend (no IndexedDB)
// ---------------------------------------------------------------------------

describe('fallback backend', () => {
  beforeEach(async () => {
    resetStorageForTests();
    vi.stubGlobal('indexedDB', undefined);
    localStorage.clear();
    await storageReady();
  });

  it('degrades kv to plain localStorage', () => {
    stateSet('mode', 'dark');
    expect(stateGet('mode')).toBe('dark');
    expect(localStorage.getItem('mode')).toBe('dark');
  });

  it('loads and saves notes as the legacy blobs', async () => {
    const tabs = [note('a', 'fallback body')];
    saveNotes({ tabs, tombstones: [] }, 'a');

    expect(JSON.parse(localStorage.getItem('padifyTabs') ?? '[]')).toEqual(tabs);
    expect(localStorage.getItem('padifyActiveTab')).toBe('a');

    resetStorageForTests();
    vi.stubGlobal('indexedDB', undefined);
    await storageReady();
    const snapshot = await loadNotes();
    expect(snapshot.tabs).toEqual(tabs);
  });
});

// ---------------------------------------------------------------------------
// boot semantics
// ---------------------------------------------------------------------------

describe('boot semantics', () => {
  beforeEach(freshBoot);

  it('storageReady is idempotent and resolves the same backend', async () => {
    const first = await storageReady();
    const second = await storageReady();
    expect(first).toBe('indexeddb');
    expect(second).toBe(first);
  });

  it('flushPendingWrites drains pending kv writes', async () => {
    stateSet('mode', 'dark');
    flushPendingWrites();
    // Give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reboot();
    expect(stateGet('mode')).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// dual-write reconciliation — the page-death race
// ---------------------------------------------------------------------------

describe('kv reconciliation (writes lost between the stores)', () => {
  beforeEach(freshBoot);

  /**
   * Simulates the page dying with a flush in flight: module state and the
   * pending batch vanish, localStorage and IndexedDB keep whatever they
   * had. This is exactly the 150ms window a fast tab close / reload hits.
   */
  async function dieWithFlushInFlight(): Promise<void> {
    resetStorageForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('a set whose flush died recovers from the localStorage mirror', async () => {
    stateSet('mode', 'dark');
    await flushKv(); // v1 committed
    stateSet('mode', 'light'); // v2 lives only in localStorage
    await dieWithFlushInFlight();

    await storageReady();
    expect(stateGet('mode')).toBe('light');
  });

  it('the recovered value is durable — it survives the next boot too', async () => {
    stateSet('mode', 'dark');
    await flushKv();
    stateSet('mode', 'light');
    await dieWithFlushInFlight();

    await storageReady();
    await reboot();
    expect(stateGet('mode')).toBe('light');
  });

  it('a delete whose flush died does not resurrect the row', async () => {
    stateSet('mode', 'dark');
    await flushKv();
    stateRemove('mode'); // the tombstone lives only in the vseq record
    await dieWithFlushInFlight();

    await storageReady();
    expect(stateGet('mode')).toBeNull();
  });

  it('committed writes reconcile to nothing — evidence prunes on flush', async () => {
    stateSet('mode', 'dark');
    stateSet('mode', 'light');
    await flushKv(); // only v2 committed; the v1 evidence is gone with it
    stateSet('selectedFont', 'serif');
    await flushKv();
    await dieWithFlushInFlight();

    await storageReady();
    expect(stateGet('mode')).toBe('light');
    expect(stateGet('selectedFont')).toBe('serif');
    // The vseq record should have pruned to empty — nothing pending.
    expect(localStorage.getItem('padify-kv-vseq')).toBe('{"n":3,"keys":{}}');
  });

  it('non-mirrored writes flush immediately — no coalescing window to lose', async () => {
    stateSet('padify-kv-nonmirrored-fixture', 'session-json', { localStorage: false });
    // The immediate flush is async but already drained the pending batch;
    // a few macrotask ticks let the transaction commit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dieWithFlushInFlight();

    await storageReady();
    expect(stateGet('padify-kv-nonmirrored-fixture')).toBe('session-json');
  });

  it('pre-versioning rows keep working: IndexedDB stays the incumbent', async () => {
    // A row written by a pre-fix build (no v) with a matching mirror —
    // no vseq evidence exists, so nothing reconciles and nothing breaks.
    await writeAll('kv', [{ key: 'mode', value: 'dark' }], []);
    localStorage.setItem('mode', 'dark');
    await dieWithFlushInFlight();

    await storageReady();
    expect(stateGet('mode')).toBe('dark');
  });

  it('a corrupted vseq record degrades to the pre-fix behaviour', async () => {
    stateSet('mode', 'dark');
    await flushKv();
    stateSet('mode', 'light');
    localStorage.setItem('padify-kv-vseq', '{not json');
    await dieWithFlushInFlight();

    await storageReady();
    // No readable evidence → IndexedDB (stale) wins — the documented
    // limitation, not a crash.
    expect(stateGet('mode')).toBe('dark');
  });
});
