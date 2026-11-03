/**
 * Typing speed — the live WPM behind the word-count pill's optional
 * third segment.
 *
 * The model is a rolling window over keystroke pulses: every editor
 * `input` event records one pulse, and the read divides the pulses
 * held by the window by the window's span — five keystrokes to the
 * word, the gross-typing convention. No DOM, no storage: time comes
 * from the caller, so tests can drive the clock deterministically.
 *
 * "Current" has a deadline — LIVE_MS after the last pulse the read
 * turns null, which is the pill's cue to stand its speed segment down.
 * A frozen number on a quiet pill reads as broken, not as speed.
 */

const WINDOW_MS = 15_000;
const LIVE_MS = 6_000;
const KEYSTROKES_PER_WORD = 5;

/** The idle deadline the pill schedules its stand-down timer against. */
export const TYPING_LIVE_MS = LIVE_MS;

const pulses: number[] = [];

/** Records one typing pulse (one editor input event) at time `now`. */
export function recordTypingPulse(now: number): void {
  pulses.push(now);
  forget(now);
}

/** Drops pulses that aged out of the rolling window. */
function forget(now: number): void {
  while (pulses.length > 0 && now - pulses[0]! > WINDOW_MS) {
    pulses.shift();
  }
}

/**
 * The current typing speed in words per minute — null when no pulse
 * arrived within the live deadline (nothing is being typed right now).
 */
export function typingWpm(now: number): number | null {
  forget(now);
  if (pulses.length === 0) {
    return null;
  }
  const lastPulse = pulses[pulses.length - 1]!;
  if (now - lastPulse > LIVE_MS) {
    return null;
  }
  const windowMinutes = WINDOW_MS / 60_000;
  return Math.round(pulses.length / KEYSTROKES_PER_WORD / windowMinutes);
}

/** Clears every recorded pulse (test isolation). */
export function resetTypingPulses(): void {
  pulses.length = 0;
}
