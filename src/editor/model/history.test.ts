import { describe, expect, it } from 'vitest';
import { ModelHistory } from './history';

/**
 * The history budget: undo entries are full serialized documents. The
 * entry cap (400) alone let a long session on a big note retain hundreds
 * of MB of strings. The byte budget drops the OLDEST groups past
 * ~20 MB while always keeping a floor of recent steps.
 */

describe('ModelHistory budget', () => {
  it('trims the oldest groups past the byte budget but keeps a floor of steps', () => {
    const history = new ModelHistory();
    // Each entry ~1 MB (1_000_000 UTF-16 units).
    const chunk = 'x'.repeat(1_000_000);
    for (let i = 0; i < 30; i += 1) {
      history.openGroup(`${chunk}-${i}`);
    }

    // The stacks were trimmed: undoing walks back fewer than all 30
    // groups, but never fewer than the 8-step floor.
    let undos = 0;
    while (history.canUndo()) {
      history.undo('current');
      undos += 1;
    }
    expect(undos).toBeGreaterThan(0);
    expect(undos).toBeLessThan(30);
    expect(undos).toBeGreaterThanOrEqual(8);
  });

  it('small documents keep the full entry cap (no premature trim)', () => {
    const history = new ModelHistory();
    for (let i = 0; i < 50; i += 1) {
      history.openGroup(`state-${i}`);
    }
    let undos = 0;
    while (history.canUndo()) {
      history.undo('current');
      undos += 1;
    }
    expect(undos).toBe(50); // tiny entries — nothing trimmed
  });

  it('redo bytes return to the budget when an edit clears the redo branch', () => {
    const history = new ModelHistory();
    const chunk = 'y'.repeat(1_000_000);
    history.openGroup(`${chunk}-a`);
    history.openGroup(`${chunk}-b`);
    history.undo('current'); // one redoable state now
    history.openGroup(`${chunk}-c`); // clears the redo branch
    // The redo stack is empty: nothing redoable survived.
    expect(history.canRedo()).toBe(false);
    let undos = 0;
    while (history.canUndo()) {
      history.undo('current');
      undos += 1;
    }
    expect(undos).toBeGreaterThanOrEqual(2); // a + c both retained
  });
});

/**
 * The caret rides the stacks: undo/redo restore the state AND the caret
 * that state was left with. The live caret at walk time only feeds the
 * OPPOSITE stack's entry (the state being left) — reusing it for the
 * restored state drifted the caret into the restored text whenever the
 * walk crossed a length change before it (a tab taken back, a redone
 * paste). See model-port's undo/redo for the engine side.
 */
describe('ModelHistory carets', () => {
  it('entries carry the caret they were left with through undo and redo', () => {
    const history = new ModelHistory();
    history.openGroup('state-a', { anchor: 1, focus: 1 });
    history.openGroup('state-b', { anchor: 2, focus: 2 });

    // Undoing pops the most recent group: the entry keeps ITS OWN caret
    // (where state-b was left), while the state being left — with the
    // live caret — becomes the redo entry.
    expect(history.undo('state-b2', { anchor: 3, focus: 4 })).toEqual({
      state: 'state-b',
      caret: { anchor: 2, focus: 2 },
    });
    expect(history.undo('state-b3', { anchor: 6, focus: 6 })).toEqual({
      state: 'state-a',
      caret: { anchor: 1, focus: 1 },
    });

    // Redoing: the popped redo entry keeps the caret its state was left
    // with when the undo fired.
    expect(history.redo('state-a2', { anchor: 5, focus: 5 })).toEqual({
      state: 'state-b3',
      caret: { anchor: 6, focus: 6 },
    });
  });

  it('a caret-less group undoes to a caret-less entry (the fallback stays)', () => {
    const history = new ModelHistory();
    history.openGroup('state-a'); // no caret captured (a selectionless mutate)
    expect(history.undo('current')).toEqual({ state: 'state-a', caret: null });
  });

  it('carets do not disturb the byte accounting (states only)', () => {
    const history = new ModelHistory();
    const chunk = 'z'.repeat(1_000_000);
    for (let i = 0; i < 30; i += 1) {
      history.openGroup(`${chunk}-${i}`, { anchor: i, focus: i });
    }
    let undos = 0;
    while (history.canUndo()) {
      history.undo('current', { anchor: 0, focus: 0 });
      undos += 1;
    }
    // Same trim behavior as the caret-less budget test above.
    expect(undos).toBeGreaterThanOrEqual(8);
    expect(undos).toBeLessThan(30);
  });
});
