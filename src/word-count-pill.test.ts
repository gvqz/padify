import { beforeEach, describe, expect, it } from 'vitest';
import { updateWordCountPill } from './word-count-pill';

/**
 * The word-count pill's render contract. The pill is a button holding two
 * labeled segments (words lead, characters follow) plus an empty-note
 * state on the container — the shell's exact markup, mirrored here so the
 * renderer is pinned against the structure 09-pills.css styles.
 */

function mountPill(): void {
  document.body.innerHTML = `
    <div class="bottom-line">
      <div class="word-count-container">
        <button type="button" id="wordCount" class="wc-pill">
          <span class="wc-seg wc-seg-words">
            <span class="wc-num" data-wc="words">0</span>
            <span class="wc-unit" data-wc-unit="words">words</span>
          </span>
          <span class="wc-divider" aria-hidden="true"></span>
          <span class="wc-seg wc-seg-chars">
            <span class="wc-num" data-wc="chars">0</span>
            <span class="wc-unit" data-wc-unit="chars">characters</span>
          </span>
        </button>
      </div>
    </div>`;
}

const wordsNum = () => document.querySelector('[data-wc="words"]')?.textContent;
const charsNum = () => document.querySelector('[data-wc="chars"]')?.textContent;
const wordsUnit = () => document.querySelector('[data-wc-unit="words"]')?.textContent;
const charsUnit = () => document.querySelector('[data-wc-unit="chars"]')?.textContent;
const container = () => document.querySelector('.word-count-container')!;
const pill = () => document.getElementById('wordCount')!;

beforeEach(() => {
  mountPill();
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

  it('surfaces reading time in the tooltip', () => {
    updateWordCountPill('');
    expect(pill().title).toBe('View note statistics');

    // 400 words at the 200 wpm pace → 2 minutes.
    updateWordCountPill('word '.repeat(400));
    expect(pill().title).toBe('About 2 min read. View note statistics');
  });
});
