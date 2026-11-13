import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reload-recovery contract (see sync.ts — seedPendingFromModel):
//
//   pendingPush and TabManager's dirtyIds used to be memory-only while the
//   pull cursor (sessionStorage) survived a reload. An edit stranded by a
//   reload was then never re-pushed (step 3 only re-pushes undelivered rows
//   on position drift) and, when another device later edited the same note,
//   the merge saw a "clean" local losing to a higher seq and silently
//   overwrote the stranded words — no three-way merge, no conflict park, no
//   trash copy.
//
// These tests drive the REAL cycle (initCloudSync → syncCycle →
// runSyncOnce) against a fake TabManager whose dirty set is pre-seeded the
// way TabManager.init seeds it from the durable unpushed flags (pinned for
// real in sync-durability.test.ts), with the api seam mocked. What is
// pinned here:
//
//   1. a recovered strand is PULLED AND MERGED BEFORE it is pushed (the
//      server's live-vs-live upsert is unconditional — push-first would
//      clobber a newer remote edit with stale bytes),
//   2. a strand meeting a newer remote edit is three-way merged or parked,
//      never silently discarded,
//   3. a strand meeting an unchanged remote row simply ships,
//   4. a normal (non-recovery) cycle still pushes its queue first,
//   5. the session token never lands in world-readable localStorage.

vi.mock('./api', () => {
  class ApiErrorMock extends Error {
    constructor(
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError: ApiErrorMock,
    api: vi.fn(),
    apiRaw: vi.fn(async () => ({ ok: true, status: 201 })),
  };
});

vi.mock('../ui/toast', () => ({ showToast: vi.fn() }));

import type { TabManager, NoteTab, TabsSyncPayload } from '../tabs';
import type { TrashedNote } from '../storage';
import type { NoteRow } from './sync';

interface FakeState {
  tabs: NoteTab[];
  trashed: TrashedNote[];
  dirty: Set<string>;
  confirmed: string[];
  appliedMerge: NoteTab[] | null;
}

function fakeManager(tabs: NoteTab[], dirty: string[] = [], trashed: TrashedNote[] = []) {
  const state: FakeState = {
    tabs: tabs.map((tab) => ({ ...tab })),
    trashed: trashed.map((entry) => ({ ...entry })),
    dirty: new Set(dirty),
    confirmed: [],
    appliedMerge: null,
  };
  const manager = {
    onPersist: null as ((payload: TabsSyncPayload) => void) | null,
    exportForSync: () =>
      ({
        tabs: state.tabs.map((tab) => ({ ...tab })),
        dirty: [...state.dirty],
        trashed: state.trashed.map((entry) => ({ ...entry })),
      }) as TabsSyncPayload,
    saveActiveFromEditor: () => {},
    applyExternalMerge: (next: NoteTab[]) => {
      state.appliedMerge = next.map((tab) => ({ ...tab }));
      state.tabs = next.map((tab) => ({ ...tab }));
    },
    applyExternalTrash: (next: TrashedNote[]) => {
      state.trashed = next.map((entry) => ({ ...entry }));
    },
    confirmPushed: (ids: string[]) => {
      state.confirmed.push(...ids);
      ids.forEach((id) => state.dirty.delete(id));
    },
    adoptPushedRows: (
      rows: Array<{ id: string; seq: number; content: string; name: string | null }>,
    ) => {
      rows.forEach((row) => {
        const tab = state.tabs.find((entry) => entry.id === row.id);
        if (tab) {
          tab.syncSeq = row.seq;
          tab.syncBase = { content: row.content, name: row.name };
        }
      });
    },
  };
  return { manager: manager as unknown as TabManager, state };
}

const tab = (id: string, overrides: Partial<NoteTab> = {}): NoteTab => ({
  id,
  name: null,
  content: `<p>${id}</p>`,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const SESSION = { token: 'tok-1', userId: 'u1', email: 'a@b.test' };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

let calls: Call[];
let seqCounter: number;
let pullAnswer: () => Record<string, unknown>;

async function freshSync() {
  const sync = await import('./sync');
  const { api } = await import('./api');
  const apiMock = vi.mocked(api);
  apiMock.mockImplementation(
    async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ method, path, body: options.body });
      if (path === '/api/me') {
        return { user: { id: SESSION.userId, email: SESSION.email } };
      }
      if (path.startsWith('/api/auth/')) {
        return { token: SESSION.token, user: { id: SESSION.userId, email: SESSION.email } };
      }
      if (method === 'PUT' && path === '/api/notes') {
        const rows = (options.body as { rows: NoteRow[] }).rows ?? [];
        return { ok: true, rows: rows.map((row) => ({ id: row.id, seq: ++seqCounter })) };
      }
      if (path.startsWith('/api/notes')) {
        return pullAnswer();
      }
      return {};
    },
  );
  return { sync, apiMock };
}

async function settle(): Promise<void> {
  // Real-timer settle: the fire-and-forget syncCycle is microtask-driven
  // (the api mock resolves immediately), so a short macrotask hop is
  // enough for the whole cycle to land.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const putCalls = (): Call[] =>
  calls.filter((call) => call.method === 'PUT' && call.path === '/api/notes');
const getNotesIndex = (): number =>
  calls.findIndex((call) => call.method === 'GET' && call.path.startsWith('/api/notes'));

/** Deletes the padify database so IDB-backed tests start empty. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls = [];
  seqCounter = 10;
  pullAnswer = () => ({ v: 2, rows: [], order: [], cursor: 10 });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  // Stop the 30s sync interval a signed-in session arms.
  try {
    const { getCloudSync } = await import('./sync');
    getCloudSync().signOut();
  } catch {
    /* module state may already be torn down */
  }
  vi.useRealTimers();
});

describe('recovery cycle — a strand that outlived a reload', () => {
  /** The never-booted storage graph reads its session from localStorage. */
  const seedFallbackSession = (): void => {
    localStorage.setItem('padifySession', JSON.stringify(SESSION));
  };

  it('pulls and merges BEFORE pushing, then ships the strand (call order pinned)', async () => {
    seedFallbackSession();
    const { sync } = await freshSync();
    const { manager, state } = fakeManager(
      [
        tab('x', {
          content: '<p>stranded words</p>',
          updatedAt: 3_000,
          syncSeq: 5,
          syncBase: { content: '<p>base</p>', name: null },
          unpushed: true,
        }),
      ],
      ['x'],
    );
    // The remote truth is unchanged for x (only its place is reported).
    pullAnswer = () => ({ v: 2, rows: [], order: ['x'], cursor: 10 });

    await sync.initCloudSync(manager);
    await settle();

    // Pull BEFORE push: the server's upsert takes live rows
    // unconditionally, so a strand pushed first could clobber a newer
    // remote edit with stale bytes.
    expect(putCalls().length).toBeGreaterThan(0);
    expect(getNotesIndex()).toBeGreaterThan(-1);
    expect(getNotesIndex()).toBeLessThan(calls.findIndex((call) => call.method === 'PUT'));
    // The strand shipped verbatim…
    const shipped = (putCalls()[0].body as { rows: NoteRow[] }).rows;
    expect(shipped.map((row) => row.id)).toEqual(['x']);
    expect(shipped[0].content).toBe('<p>stranded words</p>');
    // …and the queue retired once the server took it.
    expect(state.confirmed).toEqual(['x']);
    expect(state.dirty.has('x')).toBe(false);
  });

  it('parks the stranded words when a NEWER remote edit won — never a silent overwrite', async () => {
    seedFallbackSession();
    const { sync } = await freshSync();
    // Same region edited on both sides: the three-way merge cannot be
    // clean, so the strand must park for review instead of vanishing.
    const { manager, state } = fakeManager(
      [
        tab('x', {
          content: '<p>LOCAL</p>',
          updatedAt: 3_000,
          syncSeq: 5,
          syncBase: { content: '<p>base</p>', name: null },
          unpushed: true,
        }),
      ],
      ['x'],
    );
    pullAnswer = () => ({
      v: 2,
      rows: [
        {
          id: 'x',
          user_id: 'u1',
          name: null,
          content: '<p>REMOTE</p>',
          position: 0,
          created_at: 1_000,
          updated_at: 4_000,
          deleted: false,
          note_type: null,
          seq: 6,
        },
      ],
      order: ['x'],
      cursor: 6,
    });

    await sync.initCloudSync(manager);
    await settle();

    // The merge ran (remote took the canonical row)…
    expect(state.appliedMerge).not.toBeNull();
    const merged = state.appliedMerge!.find((entry) => entry.id === 'x')!;
    expect(merged.content).toBe('<p>REMOTE</p>');
    // …and the stranded words survived in the parked conflict record —
    // the exact bytes the pre-fix code silently discarded.
    expect(merged.conflict?.mine.content).toBe('<p>LOCAL</p>');
    expect(merged.conflict?.theirs.content).toBe('<p>REMOTE</p>');
  });

  it('three-way merges a strand whose edits do not overlap the remote ones', async () => {
    seedFallbackSession();
    const { sync } = await freshSync();
    const { manager, state } = fakeManager(
      [
        tab('x', {
          content: '<p>ONE</p><p>two</p>',
          updatedAt: 3_000,
          syncSeq: 5,
          syncBase: { content: '<p>one</p><p>two</p>', name: null },
          unpushed: true,
        }),
      ],
      ['x'],
    );
    pullAnswer = () => ({
      v: 2,
      rows: [
        {
          id: 'x',
          user_id: 'u1',
          name: null,
          content: '<p>one</p><p>TWO</p>',
          position: 0,
          created_at: 1_000,
          updated_at: 4_000,
          deleted: false,
          note_type: null,
          seq: 6,
        },
      ],
      order: ['x'],
      cursor: 6,
    });

    await sync.initCloudSync(manager);
    await settle();

    const merged = state.appliedMerge!.find((entry) => entry.id === 'x')!;
    expect(merged.content).toBe('<p>ONE</p><p>TWO</p>');
    expect(merged.conflict).toBeUndefined();
    // The merged version ships with both sides' words.
    const shipped = (putCalls()[0].body as { rows: NoteRow[] }).rows;
    expect(shipped[0].content).toBe('<p>ONE</p><p>TWO</p>');
  });

  it('pushes its queue FIRST on a normal (non-recovery) cycle', async () => {
    seedFallbackSession();
    vi.useFakeTimers();
    const { sync } = await freshSync();
    const { manager } = fakeManager(
      [tab('y', { syncSeq: 5, syncBase: { content: '<p>y</p>', name: null } })],
      [],
    );
    pullAnswer = () => ({ v: 2, rows: [], order: ['y'], cursor: 10 });

    await sync.initCloudSync(manager);
    await vi.advanceTimersByTimeAsync(0);
    const afterBoot = calls.length;

    // A fresh local edit: the registered persist hook fires with a dirty
    // id, the 1.2s debounce elapses, the cycle runs — push, THEN pull.
    (manager as unknown as { onPersist: (payload: TabsSyncPayload) => void }).onPersist!({
      tabs: [],
      dirty: ['y'],
      trashed: [],
    });
    await vi.advanceTimersByTimeAsync(1_300);

    const newCalls = calls.slice(afterBoot);
    const putIndex = newCalls.findIndex((call) => call.method === 'PUT');
    const getIndex = newCalls.findIndex(
      (call) => call.method === 'GET' && call.path.startsWith('/api/notes'),
    );
    expect(putIndex).toBeGreaterThan(-1);
    expect(getIndex).toBeGreaterThan(-1);
    expect(putIndex).toBeLessThan(getIndex);
  });

  it('keeps recovery armed when the first cycle dies offline (retry reconciles in order)', async () => {
    seedFallbackSession();
    const { sync } = await freshSync();
    const { manager } = fakeManager(
      [
        tab('x', {
          content: '<p>stranded words</p>',
          updatedAt: 3_000,
          syncSeq: 5,
          syncBase: { content: '<p>base</p>', name: null },
          unpushed: true,
        }),
      ],
      ['x'],
    );
    // The pull fails — offline. Nothing may ship before the merge sees
    // the remote truth.
    pullAnswer = () => {
      throw new Error('offline');
    };

    await sync.initCloudSync(manager);
    await settle();
    expect(putCalls()).toEqual([]);

    // Back online: the retry still pulls first.
    pullAnswer = () => ({ v: 2, rows: [], order: ['x'], cursor: 10 });
    sync.getCloudSync().syncNow();
    await settle();

    expect(putCalls().length).toBeGreaterThan(0);
    expect(getNotesIndex()).toBeLessThan(calls.findIndex((call) => call.method === 'PUT'));
  });
});

describe('session token storage hardening', () => {
  it('never writes the bearer token to localStorage on sign-in (IndexedDB mode)', async () => {
    await deleteDatabase();
    const storage = await import('../storage');
    await storage.storageReady();
    expect(storage.storageBackend()).toBe('indexeddb');

    const { sync } = await freshSync();
    const { manager } = fakeManager([]);
    await sync.initCloudSync(manager);
    const result = await sync.getCloudSync().signIn('a@b.test', 'long enough');
    expect(result.ok).toBe(true);

    // The world-readable copy must not exist…
    expect(localStorage.getItem('padifySession')).toBeNull();
    // …while the durable kv copy does (read through the module's mirror).
    expect(storage.stateGet('padifySession')).toContain('tok-1');
  });

  it('scrubs the localStorage copy an older build left behind, keeping the session', async () => {
    await deleteDatabase();
    // An old build mirrored its session to localStorage; the boot
    // migration imports it into kv (gap-fill), and the fresh boot must
    // then scrub the world-readable copy while the session itself lives.
    localStorage.setItem(
      'padifySession',
      JSON.stringify({ token: 'legacy-tok', userId: 'u1', email: 'a@b.test' }),
    );
    const storage = await import('../storage');
    await storage.storageReady();
    expect(storage.stateGet('padifySession')).toContain('legacy-tok');

    const { sync } = await freshSync();
    const { manager } = fakeManager([]);
    await sync.initCloudSync(manager);

    expect(localStorage.getItem('padifySession')).toBeNull();
    // The session survived the scrub — /api/me validated it (signed-in
    // path ran a sync cycle).
    expect(calls.some((call) => call.path === '/api/me')).toBe(true);
    expect(sync.getCloudSync().getStatus().state).toBe('signed-in');
  });
});
