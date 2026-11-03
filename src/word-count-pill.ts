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
 *
 * Two preferences shape the capsule (see editor-preferences.ts):
 *  - content — 'both' (words lead, characters follow), 'words' or
 *    'characters'. Hidden segments KEEP their counts written: the PiP
 *    mirror and the reveal-on-type flows depend on the values being
 *    present even when a mode stands them down.
 *  - typingSpeed — the live WPM segment: a third segment that appears
 *    while the user is actually typing (see typing-speed.ts) and stands
 *    down when the typing goes stale.
 */

import { countWords } from './lib/text-stats';
import { recordTypingPulse, TYPING_LIVE_MS, typingWpm } from './typing-speed';

const numberFormat = new Intl.NumberFormat('en-US');

export type PillContent = 'both' | 'words' | 'characters';

interface PillConfig {
  content: PillContent;
  typingSpeed: boolean;
}

let pillConfig: PillConfig = { content: 'both', typingSpeed: false };
let lastCounts: PillCounts = { words: 0, chars: 0 };
let idleHideTimer: ReturnType<typeof setTimeout> | null = null;

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

/** The live speed read for the segment: null when the feature is off or
 * the typing went stale — the segment's cue to stand down. */
function currentSpeed(): number | null {
  return pillConfig.typingSpeed ? typingWpm(Date.now()) : null;
}

/** Renders the speed segment (or its absence) inside one document. */
function renderSpeed(doc: Document, wpm: number | null): void {
  const pill = doc.getElementById('wordCount');
  if (!pill) return;

  const seg = pill.querySelector<HTMLElement>('.wc-seg-wpm');
  const divider = pill.querySelector<HTMLElement>('.wc-divider-wpm');
  const num = pill.querySelector<HTMLElement>('[data-wc="wpm"]');
  if (!seg || !divider || !num) return;

  if (wpm === null) {
    seg.hidden = true;
    divider.hidden = true;
    return;
  }

  const text = numberFormat.format(wpm);
  if (num.textContent !== text) {
    num.textContent = text;
    tick(num);
  }
  seg.hidden = false;
  divider.hidden = false;
}

function renderPill(doc: Document, { words, chars }: PillCounts): void {
  const pill = doc.getElementById('wordCount');
  if (!pill) return;

  const wordsEl = pill.querySelector<HTMLElement>('[data-wc="words"]');
  const charsEl = pill.querySelector<HTMLElement>('[data-wc="chars"]');
  const wordsUnit = pill.querySelector<HTMLElement>('[data-wc-unit="words"]');
  const charsUnit = pill.querySelector<HTMLElement>('[data-wc-unit="chars"]');
  if (!wordsEl || !charsEl || !wordsUnit || !charsUnit) return;

  // Counts are written even into segments a mode hides — the PiP mirror
  // and the reveal-on-type flows need the values in place.
  setSegment(wordsEl, wordsUnit, words, 'word', 'words');
  setSegment(charsEl, charsUnit, chars, 'character', 'characters');

  // Visibility — the content preference decides which counts carry the
  // capsule; an empty note still collapses (a double zero is noise).
  // In characters-only mode "0 characters" IS the pill's whole story,
  // so it stays visible where the mixed mode would hide it.
  const wordsSeg = pill.querySelector<HTMLElement>('.wc-seg-words');
  const charsSeg = pill.querySelector<HTMLElement>('.wc-seg-chars');
  const divider = pill.querySelector<HTMLElement>('.wc-divider');
  const wordsVisible = pillConfig.content !== 'characters';
  const charsVisible =
    pillConfig.content === 'characters' || (pillConfig.content === 'both' && chars !== 0);
  if (wordsSeg) wordsSeg.hidden = !wordsVisible;
  if (charsSeg) charsSeg.hidden = !charsVisible;
  // The hairline only separates two counts.
  if (divider) divider.hidden = !wordsVisible || !charsVisible;

  // The empty-note hook stands the capsule down visually (dimmed ink via
  // the CSS side; visibility itself is handled above).
  const container = pill.closest('.word-count-container');
  if (container) {
    if (chars === 0) {
      container.setAttribute('data-wc-empty', '');
    } else {
      container.removeAttribute('data-wc-empty');
    }
  }

  // The speed segment — only while the user is actually typing.
  const wpm = currentSpeed();
  renderSpeed(doc, wpm);

  // The accessible name mirrors what is on screen: a segment the
  // content mode stands down stays out of the label (its count is kept
  // written for the PiP mirror and the mode-flip reveal, but it is not
  // this capsule's story in the current mode). At least one segment is
  // always visible, so the label never comes out empty.
  const parts: string[] = [];
  if (wordsVisible) parts.push(`${words} ${plural(words, 'word', 'words')}`);
  if (charsVisible) parts.push(`${chars} ${plural(chars, 'character', 'characters')}`);
  if (wpm !== null) parts.push(`about ${wpm} ${plural(wpm, 'word', 'words')} per minute`);
  pill.setAttribute('aria-label', `${parts.join(', ')}. View note statistics`);
  pill.title = `${readingTimeHint(words)}View note statistics`;
}

/** Renders into every document that carries a pill — the main window and,
 * while the editor floats (Document Picture-in-Picture), the floating
 * window whose #wordCount the main-document query can't see. */
function renderEverywhere(): void {
  renderPill(document, lastCounts);

  // Read off `window`, never the bare identifier: where the API is
  // missing (Firefox, tests) the bare name is an undeclared global and
  // optional-chaining does not save it — the ReferenceError used to kill
  // the update on every keystroke.
  const floatingWindow = window.documentPictureInPicture?.window;
  if (floatingWindow && floatingWindow.document !== document) {
    renderPill(floatingWindow.document, lastCounts);
  }
}

export function updateWordCountPill(note: string = ''): void {
  lastCounts = {
    words: note !== '' ? countWords(note) : 0,
    chars: note.length,
  };
  renderEverywhere();
}

/**
 * Applies the pill preferences (content mode, typing speed) and re-renders.
 * Called on boot restore, preference changes and the reset-to-defaults flow.
 * Entries the caller leaves undefined are ignored rather than copied — a
 * spread would otherwise blank a field the caller merely failed to pass.
 */
export function configureWordCountPill(config: Partial<PillConfig>): void {
  const patch = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as Partial<PillConfig>;
  pillConfig = { ...pillConfig, ...patch };
  if (!pillConfig.typingSpeed) {
    cancelIdleHide();
  }
  renderEverywhere();
}

function cancelIdleHide(): void {
  if (idleHideTimer !== null) {
    clearTimeout(idleHideTimer);
    idleHideTimer = null;
  }
}

/**
 * One editor input event, on the pill's behalf: records the pulse and
 * re-renders the live segment. A stand-down timer re-renders after the
 * live deadline so the speed segment hides itself when the typing stops
 * instead of freezing at its last value.
 */
export function pulseWordCountPill(): void {
  if (!pillConfig.typingSpeed) {
    return;
  }
  recordTypingPulse(Date.now());
  cancelIdleHide();
  idleHideTimer = setTimeout(() => {
    idleHideTimer = null;
    renderEverywhere();
  }, TYPING_LIVE_MS + 250);
  renderEverywhere();
}
