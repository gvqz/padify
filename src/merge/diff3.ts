/**
 * diff3 — the three-way merge over token sequences.
 *
 * The recipe git taught everyone, at note scale: diff base→mine and
 * base→theirs as replacement HUNKS over base's coordinates, then splice
 * both hunk lists back into one sequence. Hunks that touch different
 * parts of the base apply together (the auto-merge — the whole point);
 * identical hunks apply once; hunks that touch the SAME words differently
 * are a conflict, and the caller routes the note to review.
 */

import { diffSequences } from './myers';
import { tokenEquals, type Token } from './tokens';

/** base[start, end) was replaced by `replacement` on one side. */
interface Hunk {
  start: number;
  end: number;
  replacement: Token[];
}

/** Diff ops → hunks over base coordinates. */
function hunksOf(base: readonly Token[], other: readonly Token[]): Hunk[] | null {
  const ops = diffSequences(base, other, tokenEquals);
  if (ops === null) {
    return null;
  }
  const hunks: Hunk[] = [];
  let cursor = 0;
  for (const op of ops) {
    if (op.op === 'equal') {
      cursor += op.items.length;
      continue;
    }
    if (op.op === 'delete') {
      const last = hunks[hunks.length - 1];
      if (last && last.end === cursor) {
        // A delete immediately followed by an insert on the same boundary
        // (coalescing never mixes ops) — they are one replacement.
        // Handled below when the insert arrives; nothing to do here.
      }
      hunks.push({ start: cursor, end: cursor + op.items.length, replacement: [] });
      cursor += op.items.length;
      continue;
    }
    // insert: attaches to a hunk at this boundary, or stands alone.
    const last = hunks[hunks.length - 1];
    if (last && last.end === cursor && last.replacement.length === 0) {
      // A delete ending exactly here just preceded this insert — same
      // replacement site. (The coalescer emits delete before insert.)
      last.replacement = op.items;
    } else if (last && last.end === cursor) {
      last.replacement.push(...op.items);
    } else {
      hunks.push({ start: cursor, end: cursor, replacement: op.items });
    }
  }
  return hunks;
}

function sameTokens(a: readonly Token[], b: readonly Token[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((token, index) => tokenEquals(token, b[index]!));
}

export interface ThreeWayResult {
  /** The merged sequence — meaningful only when `conflict` is false. */
  merged: Token[];
  /** True when at least one hunk pair could not be reconciled. */
  conflict: boolean;
}

/**
 * Merges `theirs` and `mine` over their common ancestor `base`. Both sides
 * "win" wherever they are the only one that changed; both-changed-same
 * wins once; both-changed-differently flags a conflict (the merged output
 * then carries MINE's version of the conflicting region — callers park the
 * note for review rather than trust a half-merge).
 *
 * Returns conflict: true (not null) when the sides are too far apart to
 * diff — "cannot merge" and "merged with conflicts" both end at review.
 */
export function mergeThreeWay(
  base: readonly Token[],
  mine: readonly Token[],
  theirs: readonly Token[],
): ThreeWayResult {
  if (sameTokens(mine, theirs)) {
    return { merged: [...mine], conflict: false };
  }
  if (sameTokens(base, mine)) {
    return { merged: [...theirs], conflict: false };
  }
  if (sameTokens(base, theirs)) {
    return { merged: [...mine], conflict: false };
  }

  const mineHunks = hunksOf(base, mine);
  const theirHunks = hunksOf(base, theirs);
  if (mineHunks === null || theirHunks === null) {
    return { merged: [...mine], conflict: true };
  }

  const merged: Token[] = [];
  let conflict = false;
  let cursor = 0; // position in base, also the high-water mark of applied hunks
  let mi = 0;
  let ti = 0;

  const overlaps = (a: Hunk, b: Hunk): boolean =>
    // Intervals that share words…
    (a.start < b.end && b.start < a.end) ||
    // …or two insertions landing on the SAME anchor — zero-width spans
    // the interval test cannot see, but two different words inserted at
    // one spot is exactly the ambiguity review exists for.
    (a.start === b.start && a.end === b.end);
  const sameHunk = (a: Hunk, b: Hunk): boolean =>
    a.start === b.start && a.end === b.end && sameTokens(a.replacement, b.replacement);

  /** Applies a hunk, flagging a conflict when it reaches back into a
   *  region another hunk already claimed (hunk.start < cursor). */
  const apply = (hunk: Hunk): void => {
    if (hunk.start < cursor) {
      conflict = true;
    }
    merged.push(...base.slice(Math.min(cursor, hunk.start), hunk.start), ...hunk.replacement);
    cursor = Math.max(cursor, hunk.end);
  };

  while (mi < mineHunks.length || ti < theirHunks.length) {
    const mineHunk = mineHunks[mi];
    const theirHunk = theirHunks[ti];
    // Pick the hunk that starts first (mine wins ties — order between
    // non-overlapping hunks does not matter to the output).
    const useMine =
      theirHunk === undefined || (mineHunk !== undefined && mineHunk.start <= theirHunk.start);

    if (useMine) {
      if (theirHunk !== undefined && overlaps(mineHunk!, theirHunk)) {
        if (sameHunk(mineHunk!, theirHunk)) {
          // Both sides made the identical change — apply it once.
          apply(mineHunk!);
        } else {
          // The true collision: same words, different edits. The merged
          // output carries MINE here (the caller parks theirs for
          // review); the base words between the hunks are dropped with
          // the region — a review resolves the whole span at once.
          const regionEnd = Math.max(mineHunk!.end, theirHunk.end);
          merged.push(
            ...base.slice(Math.min(cursor, mineHunk!.start), mineHunk!.start),
            ...mineHunk!.replacement,
          );
          cursor = Math.max(cursor, regionEnd);
          conflict = true;
        }
        mi += 1;
        ti += 1;
      } else {
        apply(mineHunk!);
        mi += 1;
      }
      continue;
    }

    // Theirs starts strictly earlier — it cannot overlap any unapplied
    // mine hunk (that one starts later); the applied-region guard inside
    // apply() catches the consumed-overlap case.
    apply(theirHunk);
    ti += 1;
  }

  merged.push(...base.slice(cursor));
  return { merged, conflict };
}
