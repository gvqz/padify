/**
 * The word-count pill ("N characters • M words"). One function, three
 * callers: the app's input wiring, the snapshot restore flow
 * (snapshots.ts) and the editor-preferences reset path — every code
 * path that swaps the note's text refreshes the pill through here so
 * the count never goes stale.
 */

import { selector } from './selector';
import { calculateCharactersAndWords } from './lib/text-stats';

export function updateWordCountPill(note: string = ''): void {
  const { notepad } = selector();
  const characterAndWordCountText = calculateCharactersAndWords(note);
  notepad.wordCount.text(characterAndWordCountText);

  // While the editor floats (Document Picture-in-Picture), #wordCount
  // moved with the editor into the floating window — the main-document
  // query above no longer finds it. The API exposes the open window;
  // mirror the count there so the floating window's status bar stays
  // honest too (before this, typing in the floating window saved the
  // note but left the pill frozen at its pre-float value).
  const floatingCount = documentPictureInPicture?.window?.document.getElementById('wordCount');
  if (floatingCount) {
    floatingCount.textContent = characterAndWordCountText;
  }
}
