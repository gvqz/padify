import { $ } from './lib/q';
import type { NotepadUI } from './selector';
import type { TabManager } from './tabs';
import {
  onStorageSaveHealth,
  storageSaveHealth,
  type StorageSaveHealth,
} from './storage/persistence';

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
 */
export function initSaveIndicator(notepad: NotepadUI, tabManager: TabManager): void {
  const $saveState = $('#saveState');
  let saveFadeTimer: ReturnType<typeof setTimeout> | null = null;

  function stopFade(): void {
    if (saveFadeTimer) {
      clearTimeout(saveFadeTimer);
      saveFadeTimer = null;
    }
    $saveState.removeClass('fade');
  }

  notepad.note.on('input', function () {
    // While a save is failing, the warning outranks "Saving…": the
    // honest status of an unsaved note is the failure, not the flight.
    if (storageSaveHealth().state === 'failing') {
      return;
    }
    stopFade();
    $saveState.addClass('saving').removeAttr('hidden').find('.save-state-text').text('Saving…');
  });

  tabManager.addPersistListener(function () {
    // This fires per persist cycle while the async write may still be
    // settling — only paint the success state when nothing is failing;
    // the write's own resolution drives the warning below.
    if (storageSaveHealth().state !== 'failing') {
      $saveState.removeClass('saving save-error').find('.save-state-text').text('Saved');
      saveFadeTimer = setTimeout(function () {
        saveFadeTimer = null;
        $saveState.addClass('fade');
      }, 2000);
    }
  });

  const applyHealth = (health: StorageSaveHealth): void => {
    if (health.state !== 'failing') {
      // Recovery: "Saved" fades out through the persist listener on the
      // next persist cycle — nothing to hold up here.
      $saveState.removeClass('save-error');
      return;
    }
    // The warning does not fade and does not clear on typing — the note
    // is NOT being saved, and pretending otherwise is the bug this fixes.
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
