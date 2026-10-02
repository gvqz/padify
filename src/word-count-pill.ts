/**
 * The word-count pill in the navbar ("N characters • M words"). One
 * function, three callers: the app's input wiring, the snapshot restore
 * flow (snapshots.ts) and the editor-preferences reset path — every code
 * path that swaps the note's text refreshes the pill through here so the
 * count never goes stale.
 */

import { selector } from './selector';
import { calculateCharactersAndWords } from './lib/text-stats';

export function updateWordCountPill(note: string = ''): void {
  const { notepad } = selector();
  const characterAndWordCountText = calculateCharactersAndWords(note);
  notepad.wordCount.text(characterAndWordCountText);
}
