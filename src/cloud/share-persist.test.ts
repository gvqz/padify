import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The share persist hook's network + session seams are both mocked: the
// hook itself is pure scheduling logic (what gets re-sent, what settles),
// and pinning THAT is this file's job. The api seam is also a dynamic
// import inside share.ts — vi.mock intercepts those too.
//
// The hook's pending/confirmed sets are MODULE state, so every test
// re-imports the whole module fresh (vi.resetModules) — a settled
// tombstone from one test must not silence the next.

vi.mock('./sync', () => ({ getCloudUserId: () => 'user-1' }));
vi.mock('./api', () => ({ api: vi.fn(async () => ({})) }));

import type { TabsSyncPayload } from '../tabs';

const payloadWith = (tombstoneIds: string[]): TabsSyncPayload => ({
  tabs: [],
  dirty: [],
  // The model's tombstone list is CUMULATIVE — a payload after ANY later
  // edit still carries every not-yet-confirmed deletion.
  tombstones: tombstoneIds.map((id) => ({ id, updatedAt: 1 })),
});

interface Hook {
  persist: (payload: TabsSyncPayload) => void;
  patches: () => Array<Record<string, unknown>>;
}

/** Fresh module state + the registered persist listener + patch log. */
async function freshHook(): Promise<Hook> {
  const share = await import('./share');
  const { api } = await import('./api');
  const apiMock = vi.mocked(api);
  let listener: ((payload: TabsSyncPayload) => void) | null = null;
  share.initCloudShare({
    addPersistListener: (registered: (payload: TabsSyncPayload) => void) => {
      listener = registered;
    },
  } as Parameters<typeof share.initCloudShare>[0]);
  return {
    persist: (payload: TabsSyncPayload) => {
      (listener as (payload: TabsSyncPayload) => void)(payload);
    },
    patches: () =>
      apiMock.mock.calls
        .filter((call) => call[1]?.method === 'PATCH')
        .map((call) => (call[1]?.body ?? {}) as Record<string, unknown>),
  };
}

describe('onModelPersisted — the share tombstone settle (issue #118)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('a tombstone revokes once, and cumulative re-sends are NOT re-sent', async () => {
    const { persist, patches } = await freshHook();

    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(patches().map((body) => body.note_ids)).toEqual([['dead-1']]);

    // The model still carries dead-1 (cumulative list; the sync layer
    // owns emptying it) — the hook must not re-queue it.
    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(patches()).toHaveLength(1);
  });

  it('a NEW tombstone still revokes alongside the settled one', async () => {
    const { persist, patches } = await freshHook();

    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);

    persist(payloadWith(['dead-1', 'dead-2']));
    await vi.advanceTimersByTimeAsync(2_100);

    const bodies = patches();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].note_ids).toEqual(['dead-2']);
  });

  it('a FAILED revoke stays re-queueable — the next persist retries it', async () => {
    const { api } = await import('./api');
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
    const { persist, patches } = await freshHook();

    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(patches()).toHaveLength(1);

    // Back online: the same cumulative payload must produce a retry.
    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(patches()).toHaveLength(2);
    expect(patches()[1].note_ids).toEqual(['dead-1']);
  });

  it('ids the sync layer confirmed away leave the settled set — no growth', async () => {
    const { persist, patches } = await freshHook();

    persist(payloadWith(['dead-1']));
    await vi.advanceTimersByTimeAsync(2_100);

    // The sync layer emptied the model's list: the tombstone is gone.
    persist(payloadWith([]));
    persist(payloadWith(['dead-3']));
    await vi.advanceTimersByTimeAsync(2_100);

    const bodies = patches();
    expect(bodies[bodies.length - 1].note_ids).toEqual(['dead-3']);
  });
});
