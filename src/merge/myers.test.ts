import { describe, expect, it } from 'vitest';
import { diffSequences } from './myers';

/** Rebuilds b by walking the ops — the diff's core invariant. */
function rebuild<T>(a: T[], ops: ReturnType<typeof diffSequences<T>>): T[] {
  if (ops === null) {
    return [];
  }
  const out: T[] = [];
  let cursor = 0;
  for (const op of ops) {
    if (op.op === 'equal') {
      out.push(...a.slice(cursor, cursor + op.items.length));
      cursor += op.items.length;
    } else if (op.op === 'delete') {
      cursor += op.items.length;
    } else {
      out.push(...op.items);
    }
  }
  return out;
}

describe('diffSequences', () => {
  it('empty inputs diff to nothing', () => {
    expect(diffSequences([], [])).toEqual([]);
    expect(diffSequences([1], [])).toEqual([{ op: 'delete', items: [1] }]);
    expect(diffSequences([], [1])).toEqual([{ op: 'insert', items: [1] }]);
  });

  it('identical sequences diff to one equal run', () => {
    const ops = diffSequences([1, 2, 3], [1, 2, 3]);
    expect(ops).toEqual([{ op: 'equal', items: [1, 2, 3] }]);
  });

  it('a pure insertion in the middle', () => {
    const ops = diffSequences([1, 3], [1, 2, 3]);
    expect(ops).toEqual([
      { op: 'equal', items: [1] },
      { op: 'insert', items: [2] },
      { op: 'equal', items: [3] },
    ]);
    expect(rebuild([1, 3], ops)).toEqual([1, 2, 3]);
  });

  it('a pure deletion in the middle', () => {
    const ops = diffSequences([1, 2, 3], [1, 3]);
    expect(rebuild([1, 2, 3], ops)).toEqual([1, 3]);
  });

  it('a replacement in the middle is delete+insert at one boundary', () => {
    const ops = diffSequences([1, 2, 3], [1, 9, 3]);
    expect(ops).toEqual([
      { op: 'equal', items: [1] },
      { op: 'delete', items: [2] },
      { op: 'insert', items: [9] },
      { op: 'equal', items: [3] },
    ]);
    expect(rebuild([1, 2, 3], ops)).toEqual([1, 9, 3]);
  });

  it('prefix and suffix changes with a shared middle', () => {
    const a = ['x', 'k', 'e', 'e', 'p', 'y'];
    const b = ['z', 'k', 'e', 'e', 'p', 'w'];
    const ops = diffSequences(a, b)!;
    expect(rebuild(a, ops)).toEqual(b);
    // The equal run is the shared middle, not a greedy prefix grab.
    expect(ops.some((op) => op.op === 'equal' && op.items.join('') === 'keep')).toBe(true);
  });

  it('the classic Myers example round-trips', () => {
    const a = 'ABCABBA'.split('');
    const b = 'CBABAC'.split('');
    const ops = diffSequences(a, b)!;
    expect(rebuild(a, ops)).toEqual(b);
  });

  it('a custom equality predicate is honored', () => {
    const ops = diffSequences(
      ['A', 'b'],
      ['a', 'B'],
      (x, y) => x.toLowerCase() === y.toLowerCase(),
    );
    expect(ops).toEqual([{ op: 'equal', items: ['A', 'b'] }]);
  });

  it('long reversed sequences answer null — too far apart, honestly', () => {
    const a = Array.from({ length: 3000 }, (_, i) => i);
    const b = Array.from({ length: 3000 }, (_, i) => 3000 - i);
    expect(diffSequences(a, b)).toBeNull();
  });

  it('large identical sequences with a small change stay fast and correct', () => {
    const a = Array.from({ length: 8000 }, (_, i) => `w${i}`);
    const b = [...a.slice(0, 4000), 'INSERTED', ...a.slice(4000)];
    const ops = diffSequences(a, b)!;
    expect(rebuild(a, ops)).toEqual(b);
  });

  it('adjacent delete+insert coalesce into single runs', () => {
    const ops = diffSequences([1, 2, 3, 4], [9, 8, 3, 4])!;
    expect(ops.filter((op) => op.op === 'delete')).toHaveLength(1);
    expect(ops.filter((op) => op.op === 'insert')).toHaveLength(1);
    expect(rebuild([1, 2, 3, 4], ops)).toEqual([9, 8, 3, 4]);
  });
});
