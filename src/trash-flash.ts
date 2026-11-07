import { $ } from './lib/q';
import type { TabManager } from './tabs';

/** How long the trash flash owns the History button before the clock returns. */
const TRASH_FLASH_MS = 2400;

/**
 * The trash flash — a note that just moved to the trash gets its
 * receipt on the History button in the top bar: the clock steps aside,
 * a paper sheet drops into the can (lid lifts and holds, the sheet
 * sinks, the can gulps, the lid claps shut — see 03-topbar.css), the
 * whole button wears delete-red — then the clock comes back.
 *
 * Why HERE and not the save chip: the flash answers "where did my
 * note go", and the answer is "behind this door". The button that
 * opens History is the spot the eye should learn to associate with
 * recovery; the delete toast below still carries the words and the
 * Undo, so the button only needs the gesture.
 *
 * The flash is pure gesture — it blocks nothing, so nothing cancels
 * it: typing on the fresh tab doesn't interrupt it, and it always
 * runs its full clock before handing the button back. Back-to-back
 * deletes restart the choreography from the top (the class toggle +
 * forced reflow resets the keyframes).
 */
export function initTrashFlash(tabManager: TabManager): void {
  const $button = $('#snapshotsButton');
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function flashTrashed(): void {
    if (flashTimer) {
      clearTimeout(flashTimer);
    }
    $button.removeClass('is-trashed');
    // Restart the keyframes cleanly when a second note follows the
    // first before its flash ended (a flash that never ended must
    // still play again from the top).
    void ($button.get(0) as HTMLElement | undefined)?.offsetWidth;
    $button.addClass('is-trashed');
    flashTimer = setTimeout(function () {
      flashTimer = null;
      $button.removeClass('is-trashed');
    }, TRASH_FLASH_MS);
  }

  tabManager.addTrashListener(flashTrashed);
}
