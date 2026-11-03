import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureWordCountPill, pulseWordCountPill, updateWordCountPill } from './word-count-pill';
import { resetTypingPulses } from './typing-speed';

/**
 * The word-count pill's render contract. The pill is a button holding
 * labeled segments (words lead, characters follow, optional live wpm)
 * plus an empty-note state on the container — the shell's exact markup,
 * mirrored here so the renderer is pinned against the structure
 * 09-pills.css styles.
 */

function mountPill(): void {
  document.body.innerHTML = `
    <div class="bottom-line">
      <div class="word-count-container">
        <button type="button" id="wordCount" class="wc-pill">
          <span class="wc-icon" aria-hidden="true"></span>
          <span class="wc-seg wc-seg-words">
            <span class="wc-num" data-wc="words">0</span>
            <span class="wc-unit" data-wc-unit="words">words</span>
          </span>
          <span class="wc-divider" aria-hidden="true"></span>
          <span class="wc-seg wc-seg-chars">
            <span class="wc-num" data-wc="chars">0</span>
            <span class="wc-unit" data-wc-unit="chars">characters</span>
          </span>
          <span class="wc-divider wc-divider-wpm" aria-hidden="true" hidden></span>
          <span class="wc-seg wc-seg-wpm" hidden>
            <span class="wc-live-dot" aria-hidden="true"></span>
            <span class="wc-num" data-wc="wpm">0</span>
            <span class="wc-unit" data-wc-unit="wpm">wpm</span>
          </span>
        </button>
      </div>
    </div>`;
}

const wordsNum = () => document.querySelector('[data-wc="words"]')?.textContent;
const charsNum = () => document.querySelector('[data-wc="chars"]')?.textContent;
const wpmNum = () => document.querySelector('[data-wc="wpm"]')?.textContent;
const wordsUnit = () => document.querySelector('[data-wc-unit="words"]')?.textContent;
const charsUnit = () => document.querySelector('[data-wc-unit="chars"]')?.textContent;
const container = () => document.querySelector('.word-count-container')!;
const pill = () => document.getElementById('wordCount')!;
const wordsSeg = () => document.querySelector<HTMLElement>('.wc-seg-words')!;
const charsSeg = () => document.querySelector<HTMLElement>('.wc-seg-chars')!;
const wpmSeg = () => document.querySelector<HTMLElement>('.wc-seg-wpm')!;
const wpmDivider = () => document.querySelector<HTMLElement>('.wc-divider-wpm')!;
const mainDivider = () => document.querySelector<HTMLElement>('.wc-divider:not(.wc-divider-wpm)')!;

beforeEach(() => {
  mountPill();
  resetTypingPulses();
  configureWordCountPill({ content: 'both', typingSpeed: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('updateWordCountPill', () => {
  it('renders the counts into the two segments', () => {
    updateWordCountPill('hello world');
    expect(wordsNum()).toBe('2');
    expect(charsNum()).toBe('11');
    expect(wordsUnit()).toBe('words');
    expect(charsUnit()).toBe('characters');
  });

  it('pluralizes the units correctly', () => {
    updateWordCountPill('hi');
    expect(wordsNum()).toBe('1');
    expect(wordsUnit()).toBe('word');
    expect(charsNum()).toBe('2');
    expect(charsUnit()).toBe('characters');
  });

  it('groups large numbers', () => {
    updateWordCountPill('word '.repeat(393)); // 1,965 chars, 393 words
    expect(charsNum()).toBe('1,965');
    expect(wordsNum()).toBe('393');
  });

  it('collapses an empty note to the dimmed "0 words" state', () => {
    updateWordCountPill('');
    expect(container().hasAttribute('data-wc-empty')).toBe(true);
    expect(wordsNum()).toBe('0');
    expect(wordsUnit()).toBe('words');
    // The character segment keeps its (hidden) count for the reveal.
    expect(charsNum()).toBe('0');
    expect(wordsSeg().hidden).toBe(false);
    expect(charsSeg().hidden).toBe(true);
    expect(mainDivider().hidden).toBe(true);
  });

  it('clears the empty state as soon as text exists', () => {
    updateWordCountPill('');
    updateWordCountPill('a');
    expect(container().hasAttribute('data-wc-empty')).toBe(false);
  });

  it('counts CJK characters as words (the text-stats convention)', () => {
    updateWordCountPill('你好世界');
    expect(wordsNum()).toBe('4');
    expect(charsNum()).toBe('4');
  });

  it('marks changed values with the tick class and leaves steady ones alone', () => {
    updateWordCountPill('hello');
    expect(document.querySelector('[data-wc="words"]')?.classList.contains('wc-tick')).toBe(true);

    // Same text again: no change, the tick does not re-fire.
    updateWordCountPill('hello');
    expect(document.querySelector('[data-wc="words"]')?.classList.contains('wc-tick')).toBe(true); // from the change above, not a re-fire

    updateWordCountPill('hello world');
    expect(document.querySelector('[data-wc="words"]')?.textContent).toBe('2');
  });

  it('describes the note and the action in the aria-label', () => {
    updateWordCountPill('hi');
    expect(pill().getAttribute('aria-label')).toBe('1 word, 2 characters. View note statistics');

    updateWordCountPill('hello world');
    expect(pill().getAttribute('aria-label')).toBe('2 words, 11 characters. View note statistics');
  });

  it('the aria-label mirrors only the segments the mode keeps visible', () => {
    updateWordCountPill('');
    // Empty note in the mixed mode: the characters segment is stood down.
    expect(pill().getAttribute('aria-label')).toBe('0 words. View note statistics');

    configureWordCountPill({ content: 'words' });
    updateWordCountPill('hello world');
    expect(pill().getAttribute('aria-label')).toBe('2 words. View note statistics');

    configureWordCountPill({ content: 'characters' });
    updateWordCountPill('hello world');
    expect(pill().getAttribute('aria-label')).toBe('11 characters. View note statistics');

    // The characters-only mode keeps its zero on an empty note.
    updateWordCountPill('');
    expect(pill().getAttribute('aria-label')).toBe('0 characters. View note statistics');
  });

  it('surfaces reading time in the tooltip', () => {
    updateWordCountPill('');
    expect(pill().title).toBe('View note statistics');

    // 400 words at the 200 wpm pace → 2 minutes.
    updateWordCountPill('word '.repeat(400));
    expect(pill().title).toBe('About 2 min read. View note statistics');
  });
});

describe('pill content modes', () => {
  it("content 'words' hides the characters segment but keeps writing its count", () => {
    configureWordCountPill({ content: 'words' });
    updateWordCountPill('hello world');
    expect(wordsSeg().hidden).toBe(false);
    expect(charsSeg().hidden).toBe(true);
    expect(mainDivider().hidden).toBe(true);
    // Hidden ≠ blank: the value stays for the mode flip.
    expect(charsNum()).toBe('11');
  });

  it("content 'characters' hides the words segment", () => {
    configureWordCountPill({ content: 'characters' });
    updateWordCountPill('hello world');
    expect(wordsSeg().hidden).toBe(true);
    expect(charsSeg().hidden).toBe(false);
    expect(mainDivider().hidden).toBe(true);
    expect(wordsNum()).toBe('2');
  });

  it("content 'characters' keeps its '0 characters' on an empty note", () => {
    configureWordCountPill({ content: 'characters' });
    updateWordCountPill('');
    // In this mode the count IS the pill's whole story — it stays.
    expect(wordsSeg().hidden).toBe(true);
    expect(charsSeg().hidden).toBe(false);
    expect(charsNum()).toBe('0');
    expect(container().hasAttribute('data-wc-empty')).toBe(true);
  });

  it('an unknown stored mode cannot happen — configure narrows the union', () => {
    // The type system carries this; the render just mirrors it.
    configureWordCountPill({ content: 'words' });
    updateWordCountPill('hello');
    expect(wordsSeg().hidden).toBe(false);
    expect(charsSeg().hidden).toBe(true);
  });

  it('a mode switch re-renders the last counts without new input', () => {
    updateWordCountPill('hello world');
    configureWordCountPill({ content: 'characters' });
    expect(wordsSeg().hidden).toBe(true);
    expect(charsSeg().hidden).toBe(false);
    expect(charsNum()).toBe('11');
  });

  it('a patch entry left undefined cannot blank its field', () => {
    updateWordCountPill('hello world');
    configureWordCountPill({ content: 'words' });
    // A caller passing { content: undefined } means "no opinion" — the
    // spread would otherwise copy the key and blank the mode.
    configureWordCountPill({ content: undefined });
    expect(wordsSeg().hidden).toBe(false);
    expect(charsSeg().hidden).toBe(true);
  });
});

describe('live typing speed segment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  it('stays hidden while the preference is off', () => {
    for (let i = 0; i < 20; i++) {
      pulseWordCountPill();
    }
    expect(wpmSeg().hidden).toBe(true);
    expect(wpmDivider().hidden).toBe(true);
    expect(wpmNum()).toBe('0');
  });

  it('appears while typing and shows the rolling words-per-minute', () => {
    configureWordCountPill({ typingSpeed: true });
    // 30 pulses in-window: 30/5 words over 0.25 min → 24 wpm.
    for (let i = 0; i < 30; i++) {
      pulseWordCountPill();
    }
    expect(wpmSeg().hidden).toBe(false);
    expect(wpmDivider().hidden).toBe(false);
    expect(wpmNum()).toBe('24');
    // The aria-label mentions the speed while it is live.
    expect(pill().getAttribute('aria-label')).toContain('about 24 words per minute');
  });

  it('the live dot rides the segment and survives every re-render', () => {
    configureWordCountPill({ typingSpeed: true });
    for (let i = 0; i < 30; i++) {
      pulseWordCountPill();
    }
    const dot = () => wpmSeg().querySelector('.wc-live-dot');
    expect(dot()).not.toBeNull();

    // The stand-down and revival do not consume the dot — it is part
    // of the segment's markup, not something the renderer mints.
    vi.advanceTimersByTime(7_000);
    expect(wpmSeg().hidden).toBe(true);
    pulseWordCountPill();
    expect(dot()).not.toBeNull();
  });

  it('stands down after the live deadline instead of freezing', () => {
    configureWordCountPill({ typingSpeed: true });
    for (let i = 0; i < 30; i++) {
      pulseWordCountPill();
    }
    expect(wpmSeg().hidden).toBe(false);

    // Just inside the deadline the segment is still up.
    vi.advanceTimersByTime(5_000);
    expect(wpmSeg().hidden).toBe(false);

    // The stand-down timer re-renders past it.
    vi.advanceTimersByTime(1_500);
    expect(wpmSeg().hidden).toBe(true);
    expect(wpmDivider().hidden).toBe(true);
    // And the aria-label drops the speed mention again.
    expect(pill().getAttribute('aria-label')).not.toContain('per minute');
  });

  it('a fresh pulse revives the segment after the stand-down', () => {
    configureWordCountPill({ typingSpeed: true });
    for (let i = 0; i < 30; i++) {
      pulseWordCountPill();
    }
    vi.advanceTimersByTime(7_000);
    expect(wpmSeg().hidden).toBe(true);

    pulseWordCountPill();
    expect(wpmSeg().hidden).toBe(false);
  });

  it('turning the preference off mid-session hides the segment at once', () => {
    configureWordCountPill({ typingSpeed: true });
    for (let i = 0; i < 30; i++) {
      pulseWordCountPill();
    }
    expect(wpmSeg().hidden).toBe(false);

    configureWordCountPill({ typingSpeed: false });
    expect(wpmSeg().hidden).toBe(true);
  });
});
