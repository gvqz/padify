/**
 * The free queue's index math — what plays next, what "previous" means,
 * how the indices move when rows are added or removed.
 *
 * Pure functions, no DOM, no audio, no storage: the controller feeds them
 * the queue shape and acts on the answer. The math was lifted verbatim
 * from the controller's branches (freeNext / freePrev / enqueueFree /
 * removeFromQueue / handleFreeEnded) and pinned by characterization tests
 * before anything else was allowed to change — including the quirks,
 * like a shuffle "next" being re-rolled by the play step that follows it.
 */

export interface QueueOptions {
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

/** Random source injectable so tests are deterministic. */
export type Rand = () => number;

/**
 * The play step's index normalization (the head of the old playFreeAt):
 * out-of-range indices wrap only under repeat-all, negatives wrap to the
 * end, and a manual (non-auto) play under shuffle re-rolls the index so
 * pressing a row still surprises. Returns null when nothing should play.
 */
export function normalizePlayIndex(
  queueLength: number,
  index: number,
  opts: QueueOptions,
  auto = false,
  rand: Rand = Math.random,
): number | null {
  if (queueLength === 0) return null;
  let idx = index;
  if (idx >= queueLength) {
    if (opts.repeat === 'all') idx = 0;
    else return null;
  }
  if (idx < 0) idx = queueLength - 1;

  if (opts.shuffle && queueLength > 1 && !auto) {
    let randomIdx = idx;
    while (randomIdx === idx) randomIdx = Math.floor(rand() * queueLength);
    idx = randomIdx;
  }
  return idx;
}

/**
 * What "next" means for the free queue (the old freeNext): shuffle jumps
 * anywhere-but-here; linear advances with a wrap — except an auto-advance
 * at the end with repeat off, which stops the player instead.
 */
export function nextPlayIndex(
  queueLength: number,
  currentIndex: number,
  opts: QueueOptions,
  auto = false,
  rand: Rand = Math.random,
): number | 'stop' | null {
  if (queueLength === 0) return null;
  if (opts.shuffle) {
    if (queueLength <= 1) return null;
    let randomIdx = currentIndex;
    while (randomIdx === currentIndex) randomIdx = Math.floor(rand() * queueLength);
    return randomIdx;
  }
  let nextIdx = currentIndex + 1;
  if (nextIdx >= queueLength) {
    if (auto && opts.repeat === 'off') return 'stop';
    nextIdx = 0;
  }
  return nextIdx;
}

/**
 * What "previous" means (the old freePrev's index half): always steps back,
 * wrapping from the top to the last row. The restart-if-3s-played check
 * reads live audio state, so it stays in the controller.
 */
export function prevPlayIndex(queueLength: number, currentIndex: number): number | null {
  if (queueLength === 0) return null;
  let prevIdx = currentIndex - 1;
  if (prevIdx < 0) prevIdx = queueLength - 1;
  return prevIdx;
}

export type EnqueueResult =
  | { kind: 'appended'; queue: unknown[]; index: number }
  | { kind: 'started'; queue: unknown[]; index: 0 };

/**
 * The "+" button's bookkeeping (the old enqueueFree): a live or non-empty
 * queue appends (the current index only ever clamps down); a cold player
 * makes the track both "up next" and "now".
 */
export function enqueueTrack<T>(
  queue: T[],
  currentIndex: number,
  track: T,
  engineActive: boolean,
): EnqueueResult {
  if (engineActive || queue.length > 0) {
    const next = [...queue, track];
    return { kind: 'appended', queue: next, index: Math.min(currentIndex, next.length - 1) };
  }
  return { kind: 'started', queue: [track], index: 0 };
}

export interface RemoveResult {
  queue: unknown[];
  index: number;
  wasCurrent: boolean;
  emptied: boolean;
}

/**
 * Queue-row removal bookkeeping (the old removeFromQueue): removing a row
 * before the current one shifts the index down; removing the current row
 * clamps the index to whatever remains (−1 when the queue empties). What
 * to *do* with a removed current row (replay the clamped index, or clear
 * the player) is the controller's call.
 */
export function removeQueueAt<T>(
  queue: T[],
  currentIndex: number,
  removeIndex: number,
): RemoveResult | null {
  if (removeIndex < 0 || removeIndex >= queue.length) return null;
  const wasCurrent = removeIndex === currentIndex;
  const next = queue.filter((_, i) => i !== removeIndex);
  let index = currentIndex;
  if (removeIndex < currentIndex) index -= 1;
  if (wasCurrent) index = Math.min(index, next.length - 1);
  return { queue: next, index, wasCurrent, emptied: next.length === 0 };
}

export type EndedAction = { kind: 'replay' } | { kind: 'play'; index: number } | { kind: 'stop' };

/**
 * What a finished track means (the old handleFreeEnded): repeat-one replays
 * the same row, otherwise advance — one past the end only plays under
 * repeat-all (the play step then wraps it to 0), else the player rests.
 */
export function endedAction(
  queueLength: number,
  currentIndex: number,
  repeat: 'off' | 'all' | 'one',
): EndedAction {
  if (repeat === 'one') return { kind: 'replay' };
  const nextIdx = currentIndex + 1;
  if (nextIdx < queueLength || repeat === 'all') return { kind: 'play', index: nextIdx };
  return { kind: 'stop' };
}

/**
 * The queue tab's badge count: rows after the current one (never negative).
 */
export function freeQueueRemaining(queueLength: number, currentIndex: number): number {
  return Math.max(0, queueLength - Math.max(0, currentIndex) - 1);
}
