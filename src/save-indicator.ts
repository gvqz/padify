import { $ } from './lib/q';
import type { NotepadUI } from './selector';
import type { TabManager } from './tabs';

/**
 * Save-state indicator — "Saving…" appears while keystrokes are in
 * flight, "Saved" flips on when the debounced persist actually ran,
 * then quietly fades out.
 */
export function initSaveIndicator(notepad: NotepadUI, tabManager: TabManager): void {
  const $saveState = $('#saveState');
  let saveFadeTimer: ReturnType<typeof setTimeout> | null = null;

  notepad.note.on('input', function () {
    if (saveFadeTimer) {
      clearTimeout(saveFadeTimer);
      saveFadeTimer = null;
    }
    $saveState
      .removeClass('fade')
      .addClass('saving')
      .removeAttr('hidden')
      .find('.save-state-text')
      .text('Saving…');
  });

  tabManager.addPersistListener(function () {
    $saveState.removeClass('saving').find('.save-state-text').text('Saved');
    saveFadeTimer = setTimeout(function () {
      saveFadeTimer = null;
      $saveState.addClass('fade');
    }, 2000);
  });
}
