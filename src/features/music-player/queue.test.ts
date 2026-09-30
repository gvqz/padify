import { describe, expect, it } from 'vitest';
import {
  endedAction,
  enqueueTrack,
  freeQueueRemaining,
  nextPlayIndex,
  normalizePlayIndex,
  prevPlayIndex,
  removeQueueAt,
} from './queue';

/** A rand() stub that replays a fixed sequence, repeating the last value. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const off = { shuffle: false, repeat: 'off' as const };
const all = { shuffle: false, repeat: 'all' as const };
const one = { shuffle: false, repeat: 'one' as const };
const shuffled = { shuffle: true, repeat: 'off' as const };

describe('normalizePlayIndex (the play step)', () => {
  it('returns null for an empty queue', () => {
    expect(normalizePlayIndex(0, 0, off)).toBeNull();
  });

  it('passes through in-range indices untouched', () => {
    expect(normalizePlayIndex(3, 1, off)).toBe(1);
  });

  it('wraps an overrun to 0 only under repeat-all, else refuses', () => {
    expect(normalizePlayIndex(3, 3, all)).toBe(0);
    expect(normalizePlayIndex(3, 99, all)).toBe(0);
    expect(normalizePlayIndex(3, 3, off)).toBeNull();
    expect(normalizePlayIndex(3, 3, one)).toBeNull();
  });

  it('wraps negatives to the last row under every mode', () => {
    expect(normalizePlayIndex(3, -1, off)).toBe(2);
    expect(normalizePlayIndex(1, -5, off)).toBe(0);
  });

  it('re-rolls a manual play under shuffle, never landing back on the same row', () => {
    // Sequence 0.0, 0.5, 0.9 over length 3 → rolls 0, 1, 2; starting at 1
    // the first roll (0) already differs, so index 0 wins.
    expect(normalizePlayIndex(3, 1, shuffled, false, seq(0, 0.5, 0.9))).toBe(0);
    // Starting at 0, the roll of 0 is rejected, 0.5 → 1 is taken.
    expect(normalizePlayIndex(3, 0, shuffled, false, seq(0, 0.5, 0.9))).toBe(1);
  });

  it('keeps the requested index when the play is auto, or the queue is a single row', () => {
    expect(normalizePlayIndex(3, 1, shuffled, true, seq(0.99))).toBe(1);
    expect(normalizePlayIndex(1, 0, shuffled, false, seq(0.99))).toBe(0);
  });
});

describe('nextPlayIndex (the next button / auto-advance)', () => {
  it('returns null for an empty queue or a single-row shuffle', () => {
    expect(nextPlayIndex(0, -1, off)).toBeNull();
    expect(nextPlayIndex(1, 0, shuffled)).toBeNull();
  });

  it('advances linearly and wraps to 0 at the end (manual press, repeat off)', () => {
    expect(nextPlayIndex(3, 0, off)).toBe(1);
    expect(nextPlayIndex(3, 2, off)).toBe(0);
    expect(nextPlayIndex(3, 2, all)).toBe(0);
  });

  it('stops instead of wrapping on auto-advance at the end with repeat off', () => {
    expect(nextPlayIndex(3, 2, off, true)).toBe('stop');
    expect(nextPlayIndex(3, 2, all, true)).toBe(0);
    expect(nextPlayIndex(3, 2, one, true)).toBe(0);
    // A manual next at the end wraps even with repeat off.
    expect(nextPlayIndex(3, 2, off, false)).toBe(0);
  });

  it('jumps anywhere-but-here under shuffle', () => {
    expect(nextPlayIndex(3, 1, shuffled, false, seq(1 / 3, 2 / 3))).toBe(2);
  });
});

describe('prevPlayIndex (the prev button)', () => {
  it('returns null for an empty queue', () => {
    expect(prevPlayIndex(0, -1)).toBeNull();
  });

  it('steps back and wraps from before-the-start to the last row', () => {
    expect(prevPlayIndex(3, 2)).toBe(1);
    expect(prevPlayIndex(3, 0)).toBe(2);
    expect(prevPlayIndex(3, -1)).toBe(2);
  });
});

describe('enqueueTrack (the + button)', () => {
  it('starts the player cold: the track becomes the queue and the current row', () => {
    expect(enqueueTrack(['a'], -1, 'x', false)).toEqual({
      kind: 'appended',
      queue: ['a', 'x'],
      index: -1,
    });
    // ^ non-empty queue appends even when nothing is playing.
    expect(enqueueTrack([], -1, 'x', false)).toEqual({ kind: 'started', queue: ['x'], index: 0 });
  });

  it('appends to a live queue and only ever clamps the index down', () => {
    expect(enqueueTrack(['a', 'b'], 1, 'c', true)).toEqual({
      kind: 'appended',
      queue: ['a', 'b', 'c'],
      index: 1,
    });
    // A restored-but-never-started queue keeps freeIndex at -1 on append.
    expect(enqueueTrack(['a'], -1, 'b', false)).toEqual({
      kind: 'appended',
      queue: ['a', 'b'],
      index: -1,
    });
  });
});

describe('removeQueueAt (queue rows)', () => {
  it('ignores out-of-range removals', () => {
    expect(removeQueueAt(['a'], 0, -1)).toBeNull();
    expect(removeQueueAt(['a'], 0, 1)).toBeNull();
  });

  it('shifts the index down when a row before the current one is removed', () => {
    expect(removeQueueAt(['a', 'b', 'c'], 2, 0)).toEqual({
      queue: ['b', 'c'],
      index: 1,
      wasCurrent: false,
      emptied: false,
    });
  });

  it('removing the current row clamps the index to what remains', () => {
    expect(removeQueueAt(['a', 'b', 'c'], 1, 1)).toEqual({
      queue: ['a', 'c'],
      index: 1,
      wasCurrent: true,
      emptied: false,
    });
    expect(removeQueueAt(['a', 'b'], 1, 1)).toEqual({
      queue: ['a'],
      index: 0,
      wasCurrent: true,
      emptied: false,
    });
  });

  it('removing the only row empties the queue and parks the index at -1', () => {
    expect(removeQueueAt(['a'], 0, 0)).toEqual({
      queue: [],
      index: -1,
      wasCurrent: true,
      emptied: true,
    });
  });
});

describe('endedAction (a finished track)', () => {
  it('replays the same row under repeat-one', () => {
    expect(endedAction(3, 1, 'one')).toEqual({ kind: 'replay' });
  });

  it('advances mid-queue', () => {
    expect(endedAction(3, 1, 'off')).toEqual({ kind: 'play', index: 2 });
  });

  it('plays one-past-the-end only under repeat-all (the play step wraps it to 0)', () => {
    expect(endedAction(3, 2, 'all')).toEqual({ kind: 'play', index: 3 });
    expect(endedAction(3, 2, 'off')).toEqual({ kind: 'stop' });
    expect(endedAction(3, 2, 'one')).toEqual({ kind: 'replay' });
  });
});

describe('freeQueueRemaining (the queue badge)', () => {
  it('counts the rows after the current one, never negative', () => {
    expect(freeQueueRemaining(4, 1)).toBe(2);
    expect(freeQueueRemaining(4, 3)).toBe(0);
    expect(freeQueueRemaining(4, -1)).toBe(3); // nothing current → all rows remain
    expect(freeQueueRemaining(0, -1)).toBe(0);
  });
});
