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

/**
 * Tranche three — the seq/base adoption fields. The in-memory truth for
 * syncSeq/syncBase/conflict/unseenChange lives here, keyed by id; the
 * stored spelling is what project() stamps and adoptStoredRow reads.
 * These tests pin the two maps and the note-life rules (what dies with a
 * note's death, what survives for the restore).
 */
describe('SyncLedger — the seq/base adoption fields', () => {
  const conflict = {
    kind: 'edit' as const,
    detectedAt: 3,
    mine: { name: 'Mine', content: '<p>my words</p>' },
    theirs: { name: 'Theirs', content: '<p>their words</p>', updatedAt: 9 },
  };
  const baseline = { from: '<p>what this device had</p>', fromName: null };

  it('adoptStoredRow maps the stored spelling into the entry — unpushed seeds the dirty set', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({
      id: 'a',
      syncSeq: 7,
      syncBase: { content: '<p>cloud agreed</p>', name: 'Kept' },
      conflict,
      unseenChange: baseline,
      unpushed: true,
    });
    ledger.adoptStoredRow({ id: 'b' });

    expect(ledger.conflictOf('a')).toEqual(conflict);
    expect(ledger.unseenOf('a')).toEqual(baseline);
    // The reload-recovery seed: bytes that outlived their session are
    // strands and re-enter the queue.
    expect(ledger.dirtyIds()).toEqual(['a']);
    expect(ledger.isDirty('b')).toBe(false);
  });

  it('adoptMergedRow replaces the sync state — absent fields clear, dirty and echoes untouched', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({ id: 'a', syncSeq: 7, unseenChange: baseline, unpushed: true });
    ledger.setEcho('a', { content: '<p>in flight</p>', updatedAt: 1_000 });

    // The merge dropped the marker and moved the seq; the note stays
    // dirty (its words still need the push) and the echo stays (the pull
    // in flight may still deliver the old row).
    ledger.adoptMergedRow({ id: 'a', syncSeq: 9, syncBase: { content: '<p>new</p>', name: null } });
    expect(ledger.unseenOf('a')).toBeUndefined();
    expect(ledger.dirtyIds()).toEqual(['a']);
    expect(ledger.echoMap().get('a')).toEqual({ content: '<p>in flight</p>', updatedAt: 1_000 });

    // Absent conflict clears a parked one.
    ledger.adoptStoredRow({ id: 'b', conflict });
    ledger.adoptMergedRow({ id: 'b' });
    expect(ledger.conflictOf('b')).toBeUndefined();
  });

  it('adoptPushed advances seq and base, reporting whether anything moved', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({ id: 'a', syncSeq: 7, syncBase: { content: '<p>v1</p>', name: null } });

    expect(ledger.adoptPushed('a', 7, { content: '<p>v1</p>', name: null })).toBe(false);
    expect(ledger.adoptPushed('a', 8, { content: '<p>v1</p>', name: null })).toBe(true);
    // A pushed row for an id the ledger never heard of still adopts.
    expect(ledger.adoptPushed('fresh', 2, { content: '<p>new</p>', name: 'N' })).toBe(true);
  });

  it('consumeUnseen reads and clears in one step — the peek fires exactly once', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({ id: 'a', unseenChange: baseline });

    expect(ledger.consumeUnseen('a')).toEqual(baseline);
    expect(ledger.consumeUnseen('a')).toBeUndefined();
    expect(ledger.unseenOf('a')).toBeUndefined();
  });

  it('noteTrashed kills the note-life state, keeps the anchor and the queue', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({
      id: 'a',
      syncSeq: 7,
      syncBase: { content: '<p>cloud agreed</p>', name: null },
      conflict,
      unseenChange: baseline,
    });
    // The trash flow requeues the grave's row.
    ledger.requeue('a');

    ledger.noteTrashed('a');
    expect(ledger.conflictOf('a')).toBeUndefined();
    expect(ledger.unseenOf('a')).toBeUndefined();
    // The anchor survives for the restore (a restored note three-way
    // merges); the grave's push stays queued.
    expect(ledger.isDirty('a')).toBe(true);

    // The projection still stamps the anchor on the grave's row.
    const grave = ledger.project({ id: 'a', name: null, content: '', createdAt: 0, updatedAt: 0 });
    expect(grave.syncSeq).toBe(7);
    expect(grave.syncBase).toEqual({ content: '<p>cloud agreed</p>', name: null });
    expect(grave.unpushed).toBe(true);
    expect(grave.conflict).toBeUndefined();
  });

  it('drop and retainOnly treat note-life state as mortal and id-history as durable', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({ id: 'dropped', syncSeq: 3, conflict, unseenChange: baseline });
    ledger.adoptStoredRow({ id: 'pruned', syncSeq: 4, conflict });
    ledger.adoptStoredRow({ id: 'kept', unseenChange: baseline });

    ledger.drop(['dropped']);
    ledger.retainOnly(['kept']);
    // Life state died with the notes that left the model.
    expect(ledger.conflictOf('dropped')).toBeUndefined();
    expect(ledger.unseenOf('pruned')).toBeUndefined();
    expect(ledger.unseenOf('kept')).toEqual(baseline);
    // The id-history state survives (a pull in flight, a restore).
    expect(
      ledger.project({ id: 'dropped', name: null, content: '', createdAt: 0, updatedAt: 0 })
        .syncSeq,
    ).toBe(3);
  });

  it('project stamps the stored spelling from the ledger — the one map', () => {
    const ledger = new SyncLedger();
    ledger.adoptStoredRow({
      id: 'a',
      syncSeq: 7,
      syncBase: { content: '<p>base</p>', name: null },
      conflict,
      unseenChange: baseline,
      unpushed: true,
    });

    const projected = ledger.project({
      id: 'a',
      name: 'A',
      content: '<p>now</p>',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(projected).toEqual({
      id: 'a',
      name: 'A',
      content: '<p>now</p>',
      createdAt: 1,
      updatedAt: 2,
      syncSeq: 7,
      syncBase: { content: '<p>base</p>', name: null },
      conflict,
      unseenChange: baseline,
      unpushed: true,
    });

    // An id the ledger has never heard of projects to the plain row —
    // nothing stamped, nothing invented.
    expect(
      ledger.project({ id: 'stranger', name: null, content: '', createdAt: 0, updatedAt: 0 }),
    ).toEqual({
      id: 'stranger',
      name: null,
      content: '',
      createdAt: 0,
      updatedAt: 0,
    });

    // A clean entry stamps no unpushed flag — the records stay lean.
    ledger.confirmPushed(['a']);
    expect(
      ledger.project({ id: 'a', name: 'A', content: '<p>now</p>', createdAt: 1, updatedAt: 2 })
        .unpushed,
    ).toBeUndefined();
  });
});
