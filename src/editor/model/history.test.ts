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
