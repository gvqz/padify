/**
 * The word-count pill — the note's vitals in one quiet capsule
 * ("339 words │ 1,963 characters"). One function, several callers: the
 * app's input wiring, the snapshot restore flow (snapshots.ts) and the
 * editor-preferences reset path — every code path that swaps the note's
 * text refreshes the pill through here so the count never goes stale.
 *
 * The pill is a real button (it opens the statistics modal) holding two
 * labeled segments, so the renderer writes values, pluralized units, the
 * empty-note state and a descriptive aria-label — not one text blob like
 * the old `<p>`. Numbers are grouped ("1,963") and tabular, and a changed
 * value gets the small rise-and-settle tick from wc-tick in 09-pills.css.
 */

import { countWords } from './lib/text-stats';

const numberFormat = new Intl.NumberFormat('en-US');

interface PillCounts {
  words: number;
  chars: number;
}

const plural = (count: number, singular: string, pluralForm: string): string =>
  count === 1 ? singular : pluralForm;

/** The tooltip companion: reading time at the 200 wpm pace text-stats uses. */
function readingTimeHint(words: number): string {
  if (words === 0) return '';
  const minutes = Math.ceil(words / 200);
  return minutes <= 1 ? 'About 1 min read. ' : `About ${minutes} min read. `;
}

/** Restarts the rise-and-settle animation; a no-op under reduced motion. */
function tick(el: HTMLElement): void {
  el.classList.remove('wc-tick');
  void el.offsetWidth; // reflow so re-adding the class replays it
  el.classList.add('wc-tick');
}

function setSegment(
  numEl: HTMLElement,
  unitEl: HTMLElement,
  value: number,
  singular: string,
  pluralForm: string,
): void {
  const text = numberFormat.format(value);
  if (numEl.textContent !== text) {
    numEl.textContent = text;
    tick(numEl);
  }
  unitEl.textContent = plural(value, singular, pluralForm);
}

/** Renders the pill inside one document; the main window and the
 * Picture-in-Picture window each carry their own #wordCount node. */
function renderPill(doc: Document, { words, chars }: PillCounts): void {
  const pill = doc.getElementById('wordCount');
  if (!pill) return;

  const wordsEl = pill.querySelector<HTMLElement>('[data-wc="words"]');
  const charsEl = pill.querySelector<HTMLElement>('[data-wc="chars"]');
  const wordsUnit = pill.querySelector<HTMLElement>('[data-wc-unit="words"]');
  const charsUnit = pill.querySelector<HTMLElement>('[data-wc-unit="chars"]');
  if (!wordsEl || !charsEl || !wordsUnit || !charsUnit) return;

  setSegment(wordsEl, wordsUnit, words, 'word', 'words');
  setSegment(charsEl, charsUnit, chars, 'character', 'characters');

  // An empty note collapses to "0 words" alone (both counts are zero,
  // a double zero is noise) and stands down visually via the CSS hook.
  const container = pill.closest('.word-count-container');
  if (container) {
    if (chars === 0) {
      container.setAttribute('data-wc-empty', '');
    } else {
      container.removeAttribute('data-wc-empty');
    }
  }

  pill.title = `${readingTimeHint(words)}View note statistics`;
  pill.setAttribute(
    'aria-label',
    `${words} ${plural(words, 'word', 'words')}, ${chars} ${plural(chars, 'character', 'characters')}. View note statistics`,
  );
}

export function updateWordCountPill(note: string = ''): void {
  const counts: PillCounts = {
    words: note !== '' ? countWords(note) : 0,
    chars: note.length,
  };

  renderPill(document, counts);

  // While the editor floats (Document Picture-in-Picture), #wordCount
  // moved with the editor into the floating window — the main-document
  // query above no longer finds it. The API exposes the open window;
  // mirror the render there so the floating window's status bar stays
  // honest too (before this, typing in the floating window saved the
  // note but left the pill frozen at its pre-float value).
  // Read off `window`, never the bare identifier: where the API is
  // missing (Firefox, tests) the bare name is an undeclared global and
  // optional-chaining does not save it — the ReferenceError used to kill
  // the update on every keystroke.
  const floatingWindow = window.documentPictureInPicture?.window;
  if (floatingWindow && floatingWindow.document !== document) {
    renderPill(floatingWindow.document, counts);
  }
}
