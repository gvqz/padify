/**
 * Myers O(ND) diff over generic sequences — the engine under the note
 * merge. Tokens, characters, anything with an equality predicate.
 *
 * From scratch on purpose (the repo's own tradition — the retired Text
 * Diff page carried one too): no dependency, deterministic output, and the
 * guarantees the merge needs — minimal edit script, hunks aligned to the
 * classic greedy path. The forward pass keeps a V-array and a trace per
 * D-step; backtracking yields the ops.
 */

export interface DiffOp<T> {
  op: 'equal' | 'delete' | 'insert';
  items: T[];
}

/** Coalesces runs of the same op — backtracking yields one op per step. */
function coalesce<T>(ops: DiffOp<T>[]): DiffOp<T>[] {
  const out: DiffOp<T>[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.op === op.op) {
      last.items.push(...op.items);
    } else if (op.items.length > 0) {
      out.push({ op: op.op, items: [...op.items] });
    }
  }
  return out;
}

/**
 * The diff of `a` into `b`: walking the ops rebuilds b from a (delete
 * removes from a, insert adds b's items). Equality is structural by
 * default; token callers pass their own predicate.
 *
 * Returns null when the inputs are beyond MAX_DIFF_STEPS of edit distance
 * — the caller treats that as "too far apart to merge", which is the
 * honest answer a review sheet exists for.
 */
export const MAX_DIFF_STEPS = 5_000;

export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  equals: (x: T, y: T) => boolean = (x, y) => x === y,
): DiffOp<T>[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    return [{ op: 'insert', items: [...b] }];
  }
  if (m === 0) {
    return [{ op: 'delete', items: [...a] }];
  }

  const max = n + m;
  if (max > MAX_DIFF_STEPS * 4) {
    // Even the best case cannot finish under the step budget.
    return null;
  }

  // The trace: one V-array snapshot per D. v[k] holds the furthest x
  // reachable on diagonal k. Offsets are shifted by max so k can go
  // negative; v is reused between D rounds but snapshotted into the trace
  // BEFORE each round's extensions (Myers' classic trick).
  const offset = max;
  const width = 2 * max + 1;
  const v = new Int32Array(width).fill(-1);
  v[offset + 1] = 0; // the (0, -1) sentinel
  const trace: Int32Array[] = [];

  let dFinal = -1;
  for (let d = 0; d <= Math.min(max, MAX_DIFF_STEPS); d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      // Down (insert from b) or right (delete from a): pick the neighbor
      // with the further reach, preferring down on ties (k === -d) and
      // right on the other edge (k === d).
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      // Slide along the diagonal while the sequences agree.
      while (x < n && y < m && equals(a[x]!, b[y]!)) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        dFinal = d;
        break;
      }
    }
    if (dFinal >= 0) {
      break;
    }
  }

  if (dFinal < 0) {
    return null; // over the step budget — too far apart
  }

  // Backtrack: from (n, m) to (0, 0), reading each round's snapshot.
  const reversed: DiffOp<T>[] = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d > 0; d -= 1) {
    const snapshot = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = snapshot[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ op: 'equal', items: [a[x - 1]!] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      // Arrived by moving down: an insert of b's item.
      reversed.push({ op: 'insert', items: [b[prevY]!] });
      y -= 1;
    } else {
      // Arrived by moving right: a delete of a's item.
      reversed.push({ op: 'delete', items: [a[prevX]!] });
      x -= 1;
    }
  }
  // The d=0 round is pure diagonal.
  while (x > 0 && y > 0) {
    reversed.push({ op: 'equal', items: [a[x - 1]!] });
    x -= 1;
    y -= 1;
  }
  // A pathological backtrack can leave one axis behind on d=0 — it cannot
  // in Myers' construction, but a defensive flush keeps the invariant
  // (walking the ops rebuilds b) unconditionally true.
  while (y > 0) {
    reversed.push({ op: 'insert', items: [b[y - 1]!] });
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ op: 'delete', items: [a[x - 1]!] });
    x -= 1;
  }

  return coalesce(reversed.reverse());
}
