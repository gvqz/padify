/**
 * Model history — one undo discipline for every mutation.
 *
 * The legacy engine's history was Chrome's execCommand stack, which never
 * saw the eight-plus paths that rewrote the DOM by hand (table structure,
 * checklist toggles, math edits, font normalization), so undo worked for
 * some actions and silently skipped others. Here every mutation is a
 * history event group: each port command is one group, each native edit
 * burst (a typing run, a delete, an Enter) is one group, and undo/redo
 * pops groups on and off two stacks of serialized states.
 *
 * Groups are OPENED by the caller: the state string pushed is the state
 * BEFORE the group's first change (the beforeinput handler absorbs and
 * snapshots before the browser edits; a command absorbs and snapshots
 * before the operation runs). Nothing is pushed on a group's
 * continuation events, which is what makes a whole typed phrase one
 * undo step — Chrome's own granularity, without its stack.
 */

/** Bounded so a long session cannot grow the two stacks without limit. */
const MAX_ENTRIES = 400;

/**
 * Byte budget for the retained history. Entries are full serialized
 * documents — 400 entries on a 1 MB note used to retain ~400 MB of
 * strings for the life of the session. Past the budget the OLDEST groups
 * are dropped (undo depth shrinks for huge documents; the alternative —
 * unbounded retention — is a slow OOM on low-memory devices).
 */
const MAX_RETAINED_BYTES = 20 * 1024 * 1024;

export class ModelHistory {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The state the model was last known to be in (after absorb/paint). */
  private known: string | null = null;
  /** Sum of the two stacks' retained string lengths (UTF-16 units). */
  private retainedBytes = 0;

  /** Records the model's current canonical state (after absorb or paint). */
  know(state: string): void {
    this.known = state;
  }

  /**
   * Opens a new event group: the given state (the pre-group state, just
   * absorbed) becomes undoable, and everything redoable is dropped — a new
   * edit always clears the redo branch, like every history there is.
   */
  openGroup(preGroupState: string): void {
    this.undoStack.push(preGroupState);
    this.retainedBytes += preGroupState.length;
    if (this.undoStack.length > MAX_ENTRIES) {
      this.retainedBytes -= this.undoStack.shift()!.length;
    }
    // A new edit clears the redo branch — return its bytes to the budget
    // before trimming, or the accounting drifts upward forever.
    for (const state of this.redoStack) {
      this.retainedBytes -= state.length;
    }
    this.redoStack.length = 0;
    this.trimToBudget();
  }

  /** Drops the oldest undo groups until the two stacks fit the budget. */
  private trimToBudget(): void {
    while (
      this.retainedBytes > MAX_RETAINED_BYTES &&
      // Always keep a handful of steps: an undo that can't even take back
      // the last edit is worse than a deep one on a giant document.
      this.undoStack.length > 8
    ) {
      this.retainedBytes -= this.undoStack.shift()!.length;
    }
  }

  /**
   * Wipes both stacks — a document replacement (opening another note,
   * restoring a snapshot) starts a fresh history; undo must never walk
   * back across documents. The port contract says it outright: the undo
   * history of a freshly opened note starts empty.
   */
  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.retainedBytes = 0;
    this.known = null;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Pops one group: returns the state to restore, or null when there is
   * nothing to undo. `current` is the model's state now, which becomes
   * redoable the moment the undo lands.
   */
  undo(current: string): string | null {
    if (this.undoStack.length === 0) {
      return null;
    }
    this.redoStack.push(current);
    this.retainedBytes += current.length;
    if (this.redoStack.length > MAX_ENTRIES) {
      this.retainedBytes -= this.redoStack.shift()!.length;
    }
    const restore = this.undoStack.pop()!;
    this.retainedBytes -= restore.length;
    this.known = restore;
    return restore;
  }

  /**
   * Pushes one group back on: returns the state to restore, or null when
   * there is nothing to redo. `current` is the model's state now.
   */
  redo(current: string): string | null {
    if (this.redoStack.length === 0) {
      return null;
    }
    this.undoStack.push(current);
    this.retainedBytes += current.length;
    if (this.undoStack.length > MAX_ENTRIES) {
      this.retainedBytes -= this.undoStack.shift()!.length;
    }
    const restore = this.redoStack.pop()!;
    this.retainedBytes -= restore.length;
    this.known = restore;
    return restore;
  }
}
