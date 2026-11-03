import { beforeEach, describe, expect, it } from 'vitest';
import { recordTypingPulse, resetTypingPulses, typingWpm, TYPING_LIVE_MS } from './typing-speed';

/**
 * The typing-speed tracker's contract: a rolling 15-second window over
 * keystroke pulses, five keystrokes to the word, and a live deadline —
 * past it the read is null, because "current speed" that stopped
 * updating is a lie on a pill.
 */

// A fixed epoch so the math reads plainly.
const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetTypingPulses();
});

describe('typingWpm', () => {
  it('is null before anything was typed', () => {
    expect(typingWpm(T0)).toBeNull();
  });

  it('converts a steady pulse rate into words per minute', () => {
    // 60 wpm ≈ 5 keystrokes per second: 5 pulses per second for 15s = 75.
    for (let i = 0; i < 75; i++) {
      recordTypingPulse(T0 + i * 200);
    }
    expect(typingWpm(T0 + 14_000)).toBe(60);
  });

  it('counts the pulses in the window, not the typing history', () => {
    // A burst long ago ages out of the 15s window.
    for (let i = 0; i < 50; i++) {
      recordTypingPulse(T0 - 30_000 + i);
    }
    // One fresh pulse right now: 1/5 words over 0.25 min → rounds to 1.
    recordTypingPulse(T0);
    expect(typingWpm(T0)).toBe(1);
  });

  it('rounds small amounts honestly instead of zeroing them', () => {
    recordTypingPulse(T0 - 100);
    recordTypingPulse(T0);
    // 2 pulses / 5 words over 0.25 min = 1.6 → 2.
    expect(typingWpm(T0)).toBe(2);
  });

  it(`turns null ${TYPING_LIVE_MS}ms after the last pulse`, () => {
    // 40 ascending pulses ending exactly at L — the freshest pulse is
    // the deadline's anchor.
    const L = T0;
    for (let i = 0; i < 40; i++) {
      recordTypingPulse(L - (39 - i) * 10);
    }
    expect(typingWpm(L + TYPING_LIVE_MS)).toBeGreaterThan(0);
    expect(typingWpm(L + TYPING_LIVE_MS + 1)).toBeNull();
  });

  it('keeps reading while pulses keep arriving past the window edge', () => {
    // Typing steadily for a full minute: the window only ever holds the
    // freshest 15s — 50 gaps × 300ms spans both edges inclusive, so 51
    // pulses → 51/5 words over 0.25 min → 41 wpm — and the read stays
    // at that steady rate the whole minute.
    for (let i = 0; i < 200; i++) {
      const now = T0 + i * 300; // ~3.3 pulses/s
      recordTypingPulse(now);
      if (i > 60) {
        expect(typingWpm(now)).toBe(41);
      }
    }
  });
});
