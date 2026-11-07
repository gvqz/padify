import { $ } from './lib/q';
import type { NotepadUI } from './selector';
import type { TabManager } from './tabs';
import {
  onStorageSaveHealth,
  storageSaveHealth,
  type StorageSaveHealth,
} from './storage/persistence';

/** How long the trash flash owns the chip before the save icon returns. */
const TRASH_FLASH_MS = 2400;

/**
 * Save-state indicator — "Saving…" appears while keystrokes are in
 * flight, "Saved" flips on when the debounced persist actually ran,
 * then quietly fades out.
 *
 * A failing save is NOT a quiet fact: the storage layer's save-health
 * signal turns the indicator into a persistent warning (no fade) that
 * stays until a write lands again. A quota failure reads "storage is
 * full" — the user needs to know their note stopped persisting, not
 * that some write "will be retried".
 *
 * And a trashed note gets a receipt here too: the chip plays the trash
 * flash (a paper drops into the can — see the save-state CSS) for a
 * beat, then hands the icon back to its save job. The delete toast
 * carries the words and the Undo; this answers "where did it go" at
 * the spot the eye already rests.
 */
export function initSaveIndicator(notepad: NotepadUI, tabManager: TabManager): void {
  const $saveState = $('#saveState');
  let saveFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let trashFlashTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the trash flash owns the chip — the persist's "Saved"
   *  paint must not land on top of the animation it fires alongside. */
  let trashFlashing = false;

  function stopFade(): void {
    if (saveFadeTimer) {
      clearTimeout(saveFadeTimer);
      saveFadeTimer = null;
    }
    $saveState.removeClass('fade');
  }

  /** Ends the flash now (typing on the new note outranks the receipt). */
  function clearTrashFlash(): void {
    if (trashFlashTimer) {
      clearTimeout(trashFlashTimer);
      trashFlashTimer = null;
    }
    if (trashFlashing) {
      trashFlashing = false;
      $saveState.removeClass('trashed');
    }
  }

  notepad.note.on('input', function () {
    // While a save is failing, the warning outranks "Saving…": the
    // honest status of an unsaved note is the failure, not the flight.
    if (storageSaveHealth().state === 'failing') {
      return;
    }
    // The user moved on to the next words — the receipt steps aside.
    clearTrashFlash();
    stopFade();
    $saveState.addClass('saving').removeAttr('hidden').find('.save-state-text').text('Saving…');
  });

  tabManager.addPersistListener(function () {
    // The trash flash outranks the "Saved" that the trashing itself
    // persists — the delete's receipt wins the chip until it ends.
    if (trashFlashing) {
      return;
    }
    // This fires per persist cycle while the async write may still be
    // settling — only paint the success state when nothing is failing;
    // the write's own resolution drives the warning below.
    if (storageSaveHealth().state !== 'failing') {
      $saveState.removeClass('saving save-error').find('.save-state-text').text('Saved');
      // A still-pending fade belongs to the PREVIOUS "Saved" — back-to-back
      // persists must not fade the chip early relative to the newest one.
      if (saveFadeTimer) {
        clearTimeout(saveFadeTimer);
      }
      saveFadeTimer = setTimeout(function () {
        saveFadeTimer = null;
        $saveState.addClass('fade');
      }, 2000);
    }
  });

  // The trash flash — one per trashed note, restarting cleanly even when
  // two notes go back-to-back (the class toggle + forced reflow resets
  // the keyframes; a flash that never ended plays again from the top).
  function flashTrashed(): void {
    stopFade();
    if (trashFlashTimer) {
      clearTimeout(trashFlashTimer);
    }
    trashFlashing = true;
    $saveState.removeClass('trashed');
    void ($saveState.get(0) as HTMLElement | undefined)?.offsetWidth;
    $saveState
      .removeClass('saving save-error')
      .addClass('trashed')
      .removeAttr('hidden')
      .find('.save-state-text')
      .text('Moved to trash');
    trashFlashTimer = setTimeout(function () {
      trashFlashTimer = null;
      trashFlashing = false;
      $saveState.removeClass('trashed');
      // Back to the save icon — unless the model's health said otherwise
      // while the flash ran (a failure never hides behind a receipt).
      if (storageSaveHealth().state === 'failing') {
        return;
      }
      $saveState.find('.save-state-text').text('Saved');
      if (saveFadeTimer) {
        clearTimeout(saveFadeTimer);
      }
      saveFadeTimer = setTimeout(function () {
        saveFadeTimer = null;
        $saveState.addClass('fade');
      }, 2000);
    }, TRASH_FLASH_MS);
  }

  tabManager.addTrashListener(flashTrashed);

  const applyHealth = (health: StorageSaveHealth): void => {
    if (health.state !== 'failing') {
      // Recovery: "Saved" fades out through the persist listener on the
      // next persist cycle — nothing to hold up here.
      $saveState.removeClass('save-error');
      return;
    }
    // The warning does not fade and does not clear on typing — the note
    // is NOT being saved, and pretending otherwise is the bug this fixes.
    // It also outranks the trash flash: a receipt for a lost note is no
    // receipt at all.
    clearTrashFlash();
    stopFade();
    $saveState
      .removeClass('saving fade')
      .addClass('save-error')
      .removeAttr('hidden')
      .find('.save-state-text')
      .text(
        health.cause === 'quota'
          ? 'Save failed — storage is full'
          : 'Save failed — retrying on the next change',
      );
  };

  onStorageSaveHealth(applyHealth);
}
