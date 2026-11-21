import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The account-switch guard and the pending-queue hygiene (see sync.ts —
// accountSwitchDeclined, markAccountOwner, and the orphan eviction in
// runSyncOnce). These drive the REAL cycle against a fake TabManager with
// the api and dialog seams mocked, in the shape of sync-recovery.test.ts.
//
//   1. the notes database is per-browser, not per-account: signing into a
//      SECOND account here used to upload the first account's notes to it
//      in the very first cycle (the pull delivers none of them, so step 3
//      of runSyncOnce ships every "local-only" row). The owner marker
//      makes the switch an explicit choice;
//   2. a queued id with neither a tab nor a grave behind it can never
//      produce a row — left in the queue it pegged the status at
//      "pending" forever.

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
vi.mock('../ui/dialog', () => ({ confirmDialog: vi.fn() }));

import type { TabManager, TabsSyncPayload } from '../tabs';
import type { StoredNoteTab, TrashedNote } from '../storage';
import type { NoteRow } from './sync';
import { SyncLedger } from '../sync/ledger';
import { confirmDialog } from '../ui/dialog';

function fakeManager(tabs: StoredNoteTab[], dirty: string[] = [], trashed: TrashedNote[] = []) {
  const state = {
    tabs: tabs.map((tab) => ({ ...tab })),
    trashed: trashed.map((entry) => ({ ...entry })),
    ledger: new SyncLedger(),
    confirmed: [] as string[],
  };
  for (const id of dirty) {
    state.ledger.markDirty(id);
  }
  const manager = {
    syncLedger: state.ledger,
    onPersist: null as ((payload: TabsSyncPayload) => void) | null,
    exportForSync: () =>
      ({
        tabs: state.tabs.map((tab) => ({ ...tab })),
        dirty: state.ledger.dirtyIds(),
        trashed: state.trashed.map((entry) => ({ ...entry })),
      }) as TabsSyncPayload,
    saveActiveFromEditor: () => {},
    applyExternalMerge: (next: StoredNoteTab[]) => {
      state.tabs = next.map((tab) => ({ ...tab }));
    },
    applyExternalTrash: (next: TrashedNote[]) => {
      state.trashed = next.map((entry) => ({ ...entry }));
    },
    confirmPushed: (ids: string[]) => {
      state.confirmed.push(...ids);
      state.ledger.confirmPushed(ids);
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

const tab = (id: string, overrides: Partial<StoredNoteTab> = {}): StoredNoteTab => ({
  id,
  name: null,
  content: `<p>${id}</p>`,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const FIRST = { token: 'tok-1', userId: 'u1', email: 'first@example.test' };
const SECOND = { token: 'tok-2', userId: 'u2', email: 'second@example.test' };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

let calls: Call[];
let seqCounter: number;
let pullAnswer: () => Record<string, unknown>;
let meAnswer: { user: { id: string; email: string } };

async function freshSync() {
  const sync = await import('./sync');
  const { api } = await import('./api');
  const apiMock = vi.mocked(api);
  apiMock.mockImplementation(
    async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ method, path, body: options.body });
      if (path === '/api/me') {
        return meAnswer;
      }
      if (path === '/api/auth/signin') {
        return { token: SECOND.token, user: { id: SECOND.userId, email: SECOND.email } };
      }
      if (method === 'PUT' && path === '/api/notes') {
        const rows = (options.body as { rows: NoteRow[] }).rows ?? [];
        // The stamped answer a trash-aware server gives (shared/wire.ts
        // NotesPutV2): the row's own stamps back — the write LANDED —
        // plus the fresh seq.
        return {
          ok: true,
          rows: rows.map((row) => ({
            id: row.id,
            seq: ++seqCounter,
            updated_at: row.updated_at,
            deleted: !!row.deleted,
            deleted_at: row.deleted_at ?? null,
          })),
        };
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

const shippedRowIds = (): string[] =>
  putCalls().flatMap((call) =>
    ((call.body as { rows: NoteRow[] } | undefined)?.rows ?? []).map((row) => row.id),
  );

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls = [];
  seqCounter = 10;
  pullAnswer = () => ({ v: 2, rows: [], order: [], cursor: 10 });
  meAnswer = { user: { id: FIRST.userId, email: FIRST.email } };
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
});

describe('the account-switch guard', () => {
  it('declined: the first account’s notes never upload to the second account', async () => {
    // The device belongs to u1 (a completed cycle stamped the owner
    // marker) and still holds one of its notes.
    localStorage.setItem('padifySyncOwner', 'u1');
    const { sync } = await freshSync();
    const { manager } = fakeManager([tab('mine', { content: '<p>account one words</p>' })]);
    await sync.initCloudSync(manager); // no session yet: nothing runs
    vi.mocked(confirmDialog).mockResolvedValue(false);

    const result = await sync
      .getCloudSync()
      .signIn('second@example.test', 'a long enough password');

    expect(result.ok).toBe(false);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    // Nothing was uploaded and no session was stored.
    expect(putCalls()).toHaveLength(0);
    expect(sync.getCloudSync().getStatus().state).toBe('signed-out');
  });

  it('accepted: the switch proceeds and the notes upload to the new account', async () => {
    localStorage.setItem('padifySyncOwner', 'u1');
    const { sync } = await freshSync();
    const { manager } = fakeManager([tab('mine', { content: '<p>account one words</p>' })]);
    await sync.initCloudSync(manager);
    vi.mocked(confirmDialog).mockResolvedValue(true);

    const result = await sync
      .getCloudSync()
      .signIn('second@example.test', 'a long enough password');

    expect(result.ok).toBe(true);
    await settle();
    expect(shippedRowIds()).toContain('mine');
  });

  it('the same account asks nothing — the marker matches the session', async () => {
    localStorage.setItem('padifySyncOwner', 'u1');
    const { sync } = await freshSync();
    const { manager } = fakeManager([tab('mine', { content: '<p>my words</p>' })]);
    await sync.initCloudSync(manager);
    vi.mocked(confirmDialog).mockResolvedValue(false);

    // /api/auth/signin answers the SAME user the device already owns.
    const { api } = await import('./api');
    vi.mocked(api).mockImplementation(
      async (path: string, options: { method?: string; body?: unknown } = {}) => {
        const method = options.method ?? 'GET';
        calls.push({ method, path, body: options.body });
        if (path === '/api/me') {
          return meAnswer;
        }
        if (path === '/api/auth/signin') {
          return { token: FIRST.token, user: { id: FIRST.userId, email: FIRST.email } };
        }
        if (method === 'PUT' && path === '/api/notes') {
          const rows = (options.body as { rows: NoteRow[] }).rows ?? [];
          return {
            ok: true,
            rows: rows.map((row) => ({
              id: row.id,
              seq: ++seqCounter,
              updated_at: row.updated_at,
              deleted: !!row.deleted,
              deleted_at: row.deleted_at ?? null,
            })),
          };
        }
        if (path.startsWith('/api/notes')) {
          return pullAnswer();
        }
        return {};
      },
    );

    const result = await sync.getCloudSync().signIn('first@example.test', 'a long enough password');

    expect(result.ok).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('a restored session for another owner asks too — declined keeps everything local', async () => {
    // The boot path: a session for u2 stored while the device belongs to
    // u1 (a second window's sign-in, a pre-guard mess). The guard must
    // fire there as well, or the first cycle would upload u1's notes.
    localStorage.setItem('padifySyncOwner', 'u1');
    localStorage.setItem(
      'padifySession',
      JSON.stringify({ token: SECOND.token, userId: SECOND.userId, email: SECOND.email }),
    );
    meAnswer = { user: { id: SECOND.userId, email: SECOND.email } };
    const { sync } = await freshSync();
    const { manager } = fakeManager([tab('mine', { content: '<p>account one words</p>' })]);
    vi.mocked(confirmDialog).mockResolvedValue(false);

    await sync.initCloudSync(manager);
    await settle();

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(putCalls()).toHaveLength(0);
    expect(sync.getCloudSync().getStatus().state).toBe('signed-out');
  });

  it('an untouched welcome seed alone asks nothing — switching on an empty device is free', async () => {
    localStorage.setItem('padifySyncOwner', 'u1');
    const { sync } = await freshSync();
    // A pristine seed (byte-exact welcome content, no name, default
    // type) is boilerplate, not user data — the switch guard must not
    // ask about it, and the seed-twin drop in the merge keeps it from
    // ever uploading.
    const { WELCOME_HTML } = await import('../tabs');
    const { manager } = fakeManager([tab('seed', { content: WELCOME_HTML })]);
    await sync.initCloudSync(manager);
    vi.mocked(confirmDialog).mockResolvedValue(false);

    const result = await sync
      .getCloudSync()
      .signIn('second@example.test', 'a long enough password');

    expect(result.ok).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe('pending-queue hygiene', () => {
  it('an orphaned queued id is evicted after the merge — the status rests at idle', async () => {
    localStorage.setItem(
      'padifySession',
      JSON.stringify({ token: FIRST.token, userId: FIRST.userId, email: FIRST.email }),
    );
    const { sync } = await freshSync();
    // 'ghost' is dirty (a persist queued it) but exists as neither a tab
    // nor a grave — a local that lost its merge to a retention-expired
    // sweeper row. Nothing can ever build or confirm its row; without the
    // eviction it sat in pendingPush forever and every future cycle ended
    // in the "pending" state — a cloud icon claiming unsynced changes
    // that do not exist.
    const { manager } = fakeManager([tab('alive')], ['ghost']);

    await sync.initCloudSync(manager);
    await settle();

    expect(shippedRowIds()).not.toContain('ghost');
    const status = sync.getCloudSync().getStatus();
    expect(status.state).toBe('signed-in');
    if (status.state === 'signed-in') {
      expect(status.sync).toBe('idle');
    }
  });
});

describe("the push answer's refusal tell", () => {
  it('a row the server refused is not confirmed, not adopted, and stays dirty for the merge', async () => {
    localStorage.setItem(
      'padifySession',
      JSON.stringify({ token: FIRST.token, userId: FIRST.userId, email: FIRST.email }),
    );
    const { sync } = await freshSync();
    const { api } = await import('./api');
    // The server's recency guard refused the stale window's write: the
    // stamped answer carries the row that STAYED — the newer device's
    // confirmed bytes, the row's own seq — not the stamps that were
    // sent. Confirming that push would have pinned a false merge base
    // (our stale bytes, "what the server holds") and silenced the note
    // right before a pull could hand it to the three-way merge — the
    // exact way the two-tab race used to lose a confirmed version.
    vi.mocked(api).mockImplementation(
      async (path: string, options: { method?: string; body?: unknown } = {}) => {
        const method = options.method ?? 'GET';
        calls.push({ method, path, body: options.body });
        if (path === '/api/me') {
          return meAnswer;
        }
        if (method === 'PUT' && path === '/api/notes') {
          return {
            ok: true,
            rows: [{ id: 'contested', seq: 4, updated_at: 3000, deleted: false, deleted_at: null }],
          };
        }
        if (path.startsWith('/api/notes')) {
          return pullAnswer();
        }
        return {};
      },
    );
    const { manager, state } = fakeManager(
      [
        tab('contested', {
          content: '<p>my stale window words</p>',
          updatedAt: 2000,
          syncSeq: 3,
          syncBase: { content: '<p>the shared base</p>', name: null },
        }),
      ],
      ['contested'],
    );

    await sync.initCloudSync(manager);
    await settle();

    // The push itself shipped (the server heard the stale bytes and
    // refused them — that is the server's half of the fix)…
    expect(shippedRowIds()).toContain('contested');
    // …but the refusal tell means: no confirmation — the id stays dirty,
    // so the pull's three-way merge (base vs. my stale words vs. their
    // confirmed words) is its way out, not a silent echo believed.
    expect(state.confirmed).not.toContain('contested');
    expect(state.ledger.dirtyIds()).toContain('contested');
    // And no adoption: the tab's seq and merge base stay exactly where
    // the last honest sync left them.
    const contested = state.tabs.find((entry) => entry.id === 'contested');
    expect(contested?.syncSeq).toBe(3);
    expect(contested?.syncBase).toEqual({ content: '<p>the shared base</p>', name: null });
  });

  it('a row whose stamps the answer echoes back IS confirmed and adopted', async () => {
    localStorage.setItem(
      'padifySession',
      JSON.stringify({ token: FIRST.token, userId: FIRST.userId, email: FIRST.email }),
    );
    const { sync } = await freshSync();
    const { manager, state } = fakeManager(
      [tab('healthy', { content: '<p>words that landed</p>', updatedAt: 2000 })],
      ['healthy'],
    );

    await sync.initCloudSync(manager);
    await settle();

    // The default mock answers the contract shape — the sent stamps back
    // with a fresh seq — so the healthy push confirms and adopts.
    expect(state.confirmed).toContain('healthy');
    const healthy = state.tabs.find((entry) => entry.id === 'healthy');
    expect(healthy?.syncSeq).toBe(11); // seqCounter starts at 10
    expect(healthy?.syncBase).toEqual({ content: '<p>words that landed</p>', name: null });
  });
});
