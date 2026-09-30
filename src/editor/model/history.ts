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

export class ModelHistory {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The state the model was last known to be in (after absorb/paint). */
  private known: string | null = null;

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
    if (this.undoStack.length > MAX_ENTRIES) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
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
    if (this.redoStack.length > MAX_ENTRIES) {
      this.redoStack.shift();
    }
    const restore = this.undoStack.pop()!;
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
    if (this.undoStack.length > MAX_ENTRIES) {
      this.undoStack.shift();
    }
    const restore = this.redoStack.pop()!;
    this.known = restore;
    return restore;
  }
}
