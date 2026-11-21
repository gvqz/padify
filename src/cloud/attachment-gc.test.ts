/**
 * The local attachment GC, pinned. Every seam is injected (tenants,
 * metas, deletes, the clock, the degraded gate) so the tests run the
 * real verdict — the shared one in shared/att-refs.ts — against plain
 * arrays and the REAL kv store (the markers and the throttle are the
 * sweep's only persistent state; reset per test).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAttachmentGcForTests, sweepLocalAttachmentGarbage } from './attachment-gc';
import { stateGet } from '../storage/kv';
import type { AttachmentMeta } from '../storage/attachments';

const ORPHANS_KEY = 'att-gc-orphans';
const LAST_RUN_KEY = 'att-gc-last-run';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const GRACE = 7 * 24 * HOUR;

/** One markdown tenant referencing `ids`; scenes ride noteType below. */
function markdownTenant(...ids: string[]): { content: string } {
  return {
    content: ids.map((id) => `![img](padify-att:${id})`).join('\n\n'),
  };
}

interface Harness {
  tenants: Array<{ content: string; noteType?: string | null }>;
  metas: AttachmentMeta[];
  deleted: string[];
  now: number;
}

function harness(state: Harness) {
  return {
    listMetas: vi.fn(async () => state.metas),
    deleteOne: vi.fn(async (id: string) => {
      state.deleted.push(id);
    }),
    now: vi.fn(() => state.now),
    degraded: vi.fn(() => false),
  };
}

function meta(id: string): AttachmentMeta {
  return { id, name: `${id}.img`, mime: 'image/webp', size: 10, createdAt: NOW, uploaded: 1 };
}

beforeEach(() => {
  resetAttachmentGcForTests();
});

describe('the local attachment sweep', () => {
  it('stamps a newcomer on first sight and deletes nothing', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const deleted = await sweepLocalAttachmentGarbage(
      () => Promise.resolve(state.tenants),
      harness(state),
    );

    expect(deleted).toBe(0);
    expect(state.deleted).toEqual([]);
    const markers = JSON.parse(String(stateGet(ORPHANS_KEY))) as Record<string, number>;
    expect(markers['att-aaaaaaaaaaaaaaaa']).toBe(NOW);
  });

  it('deletes an attachment that stays unreferenced past the grace window', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const seams = harness(state);
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    // A week and a tick later, still unreferenced — garbage.
    state.now = NOW + GRACE + 1;
    const deleted = await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    expect(deleted).toBe(1);
    expect(state.deleted).toEqual(['att-aaaaaaaaaaaaaaaa']);
    // The stamp left with the record.
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({});
  });

  it('holds an unreferenced attachment inside the grace window', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const seams = harness(state);
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    state.now = NOW + GRACE - HOUR;
    const deleted = await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    expect(deleted).toBe(0);
    expect(state.deleted).toEqual([]);
  });

  it('clears the clock when a reference comes back (the revival case)', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const seams = harness(state);
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    // The undo (or the second device's stale push) brings the ref back
    // before the window closes — the bytes must survive.
    state.tenants = [markdownTenant('att-aaaaaaaaaaaaaaaa')];
    state.now = NOW + GRACE + 1;
    const deleted = await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), seams);

    expect(deleted).toBe(0);
    expect(state.deleted).toEqual([]);
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({});
  });

  it('counts trash graves as tenants (a restore must find its images)', async () => {
    const state: Harness = {
      tenants: [markdownTenant('att-aaaaaaaaaaaaaaaa')], // the caller includes graves
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const deleted = await sweepLocalAttachmentGarbage(
      () => Promise.resolve(state.tenants),
      harness(state),
    );

    expect(deleted).toBe(0);
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({});
  });

  it('reads drawing notes through the scene grammar', async () => {
    const state: Harness = {
      tenants: [
        {
          noteType: 'drawing',
          content: JSON.stringify({
            version: 1,
            elements: [{ type: 'image', fileId: 'att-aaaaaaaaaaaaaaaa' }],
          }),
        },
      ],
      metas: [meta('att-aaaaaaaaaaaaaaaa'), meta('att-bbbbbbbbbbbbbbbb')],
      deleted: [],
      now: NOW,
    };
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), harness(state));

    const markers = JSON.parse(String(stateGet(ORPHANS_KEY))) as Record<string, number>;
    expect(markers['att-aaaaaaaaaaaaaaaa']).toBeUndefined();
    expect(markers['att-bbbbbbbbbbbbbbbb']).toBe(NOW);
  });

  it('throttles: a second sweep inside the interval reads nothing', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    const readTenants = vi.fn(async () => state.tenants);
    const seams = harness(state);
    await sweepLocalAttachmentGarbage(readTenants, seams);

    state.now = NOW + HOUR;
    state.tenants = [markdownTenant('att-aaaaaaaaaaaaaaaa')];
    const deleted = await sweepLocalAttachmentGarbage(readTenants, seams);

    expect(deleted).toBe(0);
    expect(readTenants).toHaveBeenCalledTimes(1); // the throttled run never looked
    // The stamp from the first run stands — but the next sweep past the
    // throttle sees the reference and clears it.
    state.now = NOW + 7 * HOUR;
    await sweepLocalAttachmentGarbage(readTenants, seams);
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({});
  });

  it('runs nothing on a degraded store', async () => {
    const state: Harness = {
      tenants: [],
      metas: [],
      deleted: [],
      now: NOW,
    };
    const readTenants = vi.fn(async () => state.tenants);
    const seams = { ...harness(state), degraded: vi.fn(() => true) };
    const deleted = await sweepLocalAttachmentGarbage(readTenants, seams);

    expect(deleted).toBe(0);
    expect(readTenants).not.toHaveBeenCalled();
    expect(stateGet(LAST_RUN_KEY)).toBeNull();
  });

  it('prunes stamps of records the store no longer holds', async () => {
    const state: Harness = {
      tenants: [],
      metas: [meta('att-aaaaaaaaaaaaaaaa')],
      deleted: [],
      now: NOW,
    };
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), harness(state));
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({
      'att-aaaaaaaaaaaaaaaa': NOW,
    });

    // The record vanished (cleared elsewhere); past the throttle, the
    // stamp must not outlive the store.
    state.metas = [];
    state.now = NOW + 7 * HOUR;
    await sweepLocalAttachmentGarbage(() => Promise.resolve(state.tenants), harness(state));
    expect(JSON.parse(String(stateGet(ORPHANS_KEY)))).toEqual({});
  });
});
