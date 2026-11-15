import { describe, expect, it } from 'vitest';
import { SyncLedger } from './ledger';

/**
 * The ledger's contract, pinned where it lives. The behaviors below are
 * not preferences — they are the exact semantics the four structures it
 * replaces had (dirtyIds, unpushed stamping, pendingPush, ownEchoes),
 * preserved so the unification changes WHO owns the state, not WHAT the
 * state does. The strand invariant (session-start dirt = recover-first)
 * is cloud/sync.ts's to exercise; these tests stay timing-agnostic.
 */
describe('SyncLedger — the one dirty set', () => {
  it('marks, reads and lists dirty ids', () => {
    const ledger = new SyncLedger();
    expect(ledger.hasDirty()).toBe(false);
    expect(ledger.dirtyIds()).toEqual([]);

    ledger.markDirty('a');
    ledger.markDirty('b');
    expect(ledger.isDirty('a')).toBe(true);
    expect(ledger.isDirty('b')).toBe(true);
    expect(ledger.isDirty('c')).toBe(false);
    expect(ledger.hasDirty()).toBe(true);
    expect(ledger.dirtyIds()).toEqual(['a', 'b']);
  });

  it('a confirmed push cleans exactly the acknowledged ids', () => {
    const ledger = new SyncLedger();
    ledger.markDirty('a');
    ledger.markDirty('b');
    ledger.markDirty('c');

    // Only what the server actually acknowledged; a re-dirty after the
    // push snapshot stays queued for the next cycle.
    expect(ledger.confirmPushed(['a', 'b'])).toBe(true);
    expect(ledger.dirtyIds()).toEqual(['c']);
    expect(ledger.confirmPushed(['a'])).toBe(false);
    expect(ledger.dirtyIds()).toEqual(['c']);
  });

  it('a clean-then-dirty-again id moves to the back — Set semantics', () => {
    // The queue's order decides batch composition on the wire; the old
    // Set moved a re-dirtied id behind the rows still waiting.
    const ledger = new SyncLedger();
    ledger.markDirty('a');
    ledger.markDirty('b');
    ledger.confirmPushed(['a']);
    ledger.markDirty('a');
    expect(ledger.dirtyIds()).toEqual(['b', 'a']);

    // Re-marking an ALREADY dirty id leaves its place alone.
    ledger.markDirty('b');
    expect(ledger.dirtyIds()).toEqual(['b', 'a']);
  });

  it('requeue moves an id to the back even while dirty — the trash flow', () => {
    // requestCloseTab deletes the live entry's mark and re-adds it with
    // the grave's identity: the trash row rides behind the live rows.
    const ledger = new SyncLedger();
    ledger.markDirty('a');
    ledger.markDirty('b');
    ledger.requeue('a');
    expect(ledger.dirtyIds()).toEqual(['b', 'a']);
  });

  it('ids that left the model stop queueing but keep their echo', () => {
    const ledger = new SyncLedger();
    ledger.markDirty('gone');
    ledger.setEcho('gone', { content: '<p>bytes</p>', updatedAt: 1_000 });

    // Merged away / dropped seed / swept grave: nothing can confirm it.
    ledger.drop(['gone']);
    expect(ledger.dirtyIds()).toEqual([]);
    // The echo survives — a pull already in flight may still deliver
    // the row, and the merge must recognize it as this device's own.
    expect(ledger.echoMap().get('gone')).toEqual({ content: '<p>bytes</p>', updatedAt: 1_000 });
  });

  it('post-merge pruning keeps only the ids the model still holds', () => {
    const ledger = new SyncLedger();
    ledger.markDirty('kept-tab');
    ledger.markDirty('kept-grave');
    ledger.markDirty('merged-away');
    ledger.retainOnly(['kept-tab', 'kept-grave']);
    expect(ledger.dirtyIds()).toEqual(['kept-tab', 'kept-grave']);
  });

  it('echo fingerprints are one-per-note, latest wins, dirty untouched', () => {
    const ledger = new SyncLedger();
    ledger.markDirty('a');
    ledger.setEcho('a', { content: 'first', updatedAt: 1_000 });
    ledger.setEcho('a', { content: 'second', updatedAt: 2_000 });
    // An echo recorded for an id this ledger has never heard of is fine.
    ledger.setEcho('b', { content: 'other', updatedAt: 3_000 });

    const echoes = ledger.echoMap();
    expect(echoes.get('a')).toEqual({ content: 'second', updatedAt: 2_000 });
    expect(echoes.get('b')).toEqual({ content: 'other', updatedAt: 3_000 });
    expect(echoes.size).toBe(2);

    // The projection is a snapshot, not a handle: mutating it cannot
    // reach the ledger's state.
    echoes.delete('a');
    expect(ledger.echoMap().size).toBe(2);

    // Echoes never answer the dirty question; dirt never leaks into the
    // echo projection.
    expect(ledger.isDirty('a')).toBe(true);
    expect(ledger.isDirty('b')).toBe(false);
  });

  it('confirmPushed keeps the echo for the pull that may still deliver it', () => {
    const ledger = new SyncLedger();
    ledger.markDirty('a');
    ledger.setEcho('a', { content: '<p>pushed</p>', updatedAt: 1_000 });
    ledger.confirmPushed(['a']);
    expect(ledger.dirtyIds()).toEqual([]);
    expect(ledger.echoMap().get('a')).toEqual({ content: '<p>pushed</p>', updatedAt: 1_000 });
  });
});
