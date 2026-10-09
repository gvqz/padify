/**
 * Characterization suite for the writing-session timer (src/timer.ts) —
 * the modal, the bottom-right pill and the chime settings that survive a
 * reload.
 *
 * What this pins, and why it matters:
 *  - the countdown is DEADLINE-driven (endTime + Date.now()), not
 *    tick-counted, so a throttled background tab only delays the paint,
 *    never the expiry — the whole reason updateTimer() reads the clock
 *    instead of decrementing;
 *  - the end-of-session behavior: the chime fires only when the persisted
 *    `timerChime` setting is 'true', through the persisted
 *    `timerChimeSound` selection (defaulting to the first chime), and the
 *    timer fully resets afterwards (no zombie interval, no stale endTime);
 *  - every persisted write goes through the storage layer's stateSet on
 *    the three raw kv keys this feature owns (`timerChime`,
 *    `timerChimeSound`, `lastCustomTimerMinutes`) — they are legacy-listed
 *    keys, not enumerated settings, so they bypass the settings choke
 *    point by design (see storage/index.ts LEGACY_KV_KEYS);
 *  - the modal's select/running view flip and the custom-minutes clamp
 *    (1–240, NaN → 25).
 *
 * Everything here was written against the behaviour of the live app at the
 * commit this file landed. If a test fails after an intentional behavior
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { $ } from './lib/q';
import { initTimer, startTimer, stopTimer, timerConfig, updateTimer } from './timer';
import { stateGet, stateSet, resetStorageForTests, storageReady } from './storage';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// jsdom's HTMLMediaElement.play() is "not implemented" and returns undefined,
// so `alarmSound.play().catch(...)` would throw synchronously. The chime
// machinery only needs a thenable — a resolved promise is the autoplay-
// allowed case, and a rejected one is exercised explicitly below.
// Re-created per test because afterEach restores all mocks.
let playSpy: MockInstance<() => Promise<void>>;
let pauseSpy: MockInstance<() => void>;

// jsdom lacks scrollIntoView (rendering-dependent); nothing in the timer uses
// it, but the shared shell of these suites keeps the polyfill so a stray
// focus/scroll call cannot crash a test for the wrong reason.
beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {},
      configurable: true,
    });
  }
});

/**
 * The shell the timer needs outside its own modal: the bottom-right pill
 * (display + the #stopTimer link, mirroring editor-shell.html), the word
 * count container whose visibility moves the pill, and the toast.
 *
 * initTimer() appends #timerModal to <body> ONCE (first test); later mounts
 * keep it — its direct listeners (the chime checkbox change, the modal's
 * show.bs.modal) live on the modal element and would die with it, while the
 * delegated document listeners a re-init would pile up (document is never
 * replaced) would double-fire every click.
 */
function mountShell(): void {
  Array.from(document.body.children).forEach((child) => {
    if (child.id !== 'timerModal') child.remove();
  });
  document.body.insertAdjacentHTML(
    'afterbegin',
    `
    <div class="word-count-container" style="display: none"></div>
    <div class="timer-pill" style="display: none">
      <div class="timer-display">00:00</div>
      <a href="#" id="stopTimer" title="Stop the timer"></a>
    </div>
    <div id="toast"></div>
  `,
  );
}

/** Deletes the padify database so every test starts from an empty store. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** A storage boot from truly nothing — kv mirror AND localStorage wiped. */
async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

let timerInitialized = false;

/** Mounts the modal + wires the document-level handlers exactly once. */
function ensureTimerMounted(): void {
  if (!timerInitialized) {
    initTimer();
    timerInitialized = true;
  }
}

/** Resets the module state and modal chrome a previous session left behind. */
function resetTimerState(): void {
  stopTimer();
  timerConfig.endTime = null;
  timerConfig.alarmSound = null;
  // Restore the modal's resting state (a fresh boot leaves the chime off
  // and the custom minutes input at its markup default).
  $('#timerChime').prop('checked', false);
  $('#chimePicker').prop('hidden', true);
  $('#timerCustomMinutes').val('25');
  document.querySelectorAll('.chime-option').forEach((option) => {
    option.classList.remove('is-selected', 'is-playing');
    option.setAttribute('aria-checked', 'false');
  });
}

function toastText(): string {
  return document.getElementById('toast')!.textContent ?? '';
}

function pill(): HTMLElement {
  return document.querySelector('.timer-pill') as HTMLElement;
}

function click(selector: string): void {
  document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  mountShell();
  await freshBoot();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (timerInitialized) {
    resetTimerState();
  }
});

// ---------------------------------------------------------------------------
// Boot — what initTimer restores from persisted state
// ---------------------------------------------------------------------------

describe('boot (characterization)', () => {
  it('seeds the custom minutes input and the chime checkbox from storage', () => {
    stateSet('lastCustomTimerMinutes', '42');
    stateSet('timerChime', 'true');
    stateSet('timerChimeSound', 'reward');

    ensureTimerMounted();

    expect($('#timerCustomMinutes').val()).toBe('42');
    expect($('#timerChime').prop('checked')).toBe(true);
    // The chime picker follows the checkbox on boot, and the stored chime
    // is the selected radio.
    expect($('#chimePicker').prop('hidden')).toBe(false);
    expect(
      document
        .querySelector('.chime-option[data-chime="reward"]')!
        .classList.contains('is-selected'),
    ).toBe(true);
    expect(
      document.querySelector('.chime-option[data-chime="plink"]')!.getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('mounts the six presets and six chimes with stable ids', () => {
    ensureTimerMounted();

    const minutes = Array.from(document.querySelectorAll('.timer-preset')).map(
      (button) => (button as HTMLElement).dataset.minutes,
    );
    expect(minutes).toEqual(['10', '15', '25', '30', '45', '60']);

    const chimes = Array.from(document.querySelectorAll('.chime-option')).map(
      (option) => (option as HTMLElement).dataset.chime,
    );
    expect(chimes).toEqual(['bells', 'positive', 'correct', 'reward', 'subtle', 'plink']);
    // (The default-selection paint — first chime selected when nothing is
    // stored — is covered by the expiry test's default-chime pin; this test
    // runs after the modal has already been painted by the seeded-boot one.)
  });
});

// ---------------------------------------------------------------------------
// Chime settings — persistence through the storage layer
// ---------------------------------------------------------------------------

describe('chime settings (characterization)', () => {
  it('checking the chime box persists "true" and reveals the picker', () => {
    ensureTimerMounted();
    const checkbox = $('#timerChime');

    checkbox.prop('checked', true);
    checkbox.get(0)!.dispatchEvent(new Event('change'));

    expect(stateGet('timerChime')).toBe('true');
    expect($('#chimePicker').prop('hidden')).toBe(false);

    checkbox.prop('checked', false);
    checkbox.get(0)!.dispatchEvent(new Event('change'));

    expect(stateGet('timerChime')).toBe('false');
    expect($('#chimePicker').prop('hidden')).toBe(true);
  });

  it('picking a chime persists its id, moves the selection and previews it', () => {
    ensureTimerMounted();

    click('.chime-option[data-chime="correct"]');

    expect(stateGet('timerChimeSound')).toBe('correct');
    expect(
      document
        .querySelector('.chime-option[data-chime="correct"]')!
        .classList.contains('is-selected'),
    ).toBe(true);
    // The preview: an Audio element is created for that chime's file and
    // played, and the option paints its playing state.
    expect(timerConfig.alarmSound).not.toBeNull();
    expect(timerConfig.alarmSound!.src).toContain('sounds/chimes/correct.mp3');
    expect(timerConfig.alarmSound!.loop).toBe(false);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(
      document
        .querySelector('.chime-option[data-chime="correct"]')!
        .classList.contains('is-playing'),
    ).toBe(true);
  });

  it('a rejected preview (autoplay blocked) un-paints the playing state and moves on', () => {
    ensureTimerMounted();
    playSpy.mockRejectedValueOnce(new Error('autoplay blocked'));

    click('.chime-option[data-chime="plink"]');

    // The .catch handler runs on a microtask, after this synchronous return.
    return Promise.resolve().then(() => {
      expect(stateGet('timerChimeSound')).toBe('plink');
      expect(
        document
          .querySelector('.chime-option[data-chime="plink"]')!
          .classList.contains('is-playing'),
      ).toBe(false);
    });
  });

  it('switching chimes pauses the previous preview', () => {
    ensureTimerMounted();

    click('.chime-option[data-chime="correct"]');
    click('.chime-option[data-chime="positive"]');

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    // Only the newest option paints as playing.
    expect(
      document
        .querySelector('.chime-option[data-chime="correct"]')!
        .classList.contains('is-playing'),
    ).toBe(false);
    expect(
      document
        .querySelector('.chime-option[data-chime="positive"]')!
        .classList.contains('is-playing'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The session itself — countdown, views, expiry
// ---------------------------------------------------------------------------

describe('startTimer / updateTimer (characterization)', () => {
  it('a preset click starts the session, flips the modal views and announces it', () => {
    ensureTimerMounted();

    click('.timer-preset[data-minutes="10"]');

    expect(timerConfig.isRunning).toBe(true);
    expect(timerConfig.totalDurationSec).toBe(600);
    expect(timerConfig.timer).not.toBeNull();
    // The pill is shown, the display reads the full duration.
    expect(pill().style.display).not.toBe('none');
    expect($('.timer-display').text()).toBe('10:00');
    expect($('#timerRunningClock').text()).toBe('10:00');
    // Select view hidden, running view visible.
    expect($('#timerSelectView').prop('hidden')).toBe(true);
    expect($('#timerRunningView').prop('hidden')).toBe(false);
    expect(toastText()).toBe('Session started — 10 minutes. Keep writing!');
  });

  it('the countdown is deadline-driven — one tick paints one second gone', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(1);
    expect($('.timer-display').text()).toBe('01:00');

    vi.advanceTimersByTime(1000);
    expect($('.timer-display').text()).toBe('00:59');

    // The progress bar fills from elapsed-over-total (1/60 rounds to 2%).
    expect(document.getElementById('timerProgressBar')!.style.width).toBe('2%');
  });

  it('the last ten seconds paint the timer-ending state on the pill', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(1);
    vi.advanceTimersByTime(49_000); // 00:11 left — outside the window
    expect(pill().classList.contains('timer-ending')).toBe(false);

    vi.advanceTimersByTime(1000); // 00:10 left — the boundary is inclusive
    expect(pill().classList.contains('timer-ending')).toBe(true);
    vi.advanceTimersByTime(1000); // 00:09 left
    expect(pill().classList.contains('timer-ending')).toBe(true);
    expect($('.timer-display').text()).toBe('00:09');
  });

  it('expiry with the chime on: plays the persisted chime, resets, toasts', () => {
    vi.useFakeTimers();
    ensureTimerMounted();
    stateSet('timerChime', 'true');
    stateSet('timerChimeSound', 'reward');

    startTimer(1);
    vi.advanceTimersByTime(60_000);

    // The persisted chime — not always the first one — is what rings.
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(timerConfig.alarmSound!.src).toContain('sounds/chimes/reward.mp3');
    // Full reset: no interval, no deadline, zeros on the pill.
    expect(timerConfig.isRunning).toBe(false);
    expect(timerConfig.timer).toBeNull();
    expect(timerConfig.endTime).toBeNull();
    expect(timerConfig.remainingTime).toBe(0);
    expect($('.timer-display').text()).toBe('00:00');
    expect(pill().style.display).toBe('none');
    expect(toastText()).toBe('Writing session complete. Nice work!');
  });

  it('expiry with the chime off: silent — no Audio element is ever played', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(1);
    vi.advanceTimersByTime(60_000);

    expect(playSpy).not.toHaveBeenCalled();
    expect(toastText()).toBe('Writing session complete. Nice work!');
    expect(timerConfig.isRunning).toBe(false);
  });

  it('the expiry chime defaults to the first chime when none was ever picked', () => {
    vi.useFakeTimers();
    ensureTimerMounted();
    stateSet('timerChime', 'true');

    startTimer(1);
    vi.advanceTimersByTime(60_000);

    expect(timerConfig.alarmSound!.src).toContain('sounds/chimes/bells.mp3');
  });

  it('returning to the tab refreshes the display from the deadline, not the ticks', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(5);
    // Jump the clock WITHOUT running the interval callbacks — simulates a
    // background tab whose timers were frozen.
    vi.setSystemTime(Date.now() + 120_000);
    expect($('.timer-display').text()).toBe('05:00'); // paint is stale

    document.dispatchEvent(new Event('visibilitychange'));

    // The visibilitychange handler recomputed from endTime.
    expect($('.timer-display').text()).toBe('03:00');
  });

  it('+5 min extends the deadline and the total, and says so', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(5);
    vi.advanceTimersByTime(60_000); // 04:00 left
    click('#timerAddFiveBtn');

    expect(timerConfig.totalDurationSec).toBe(600);
    expect($('.timer-display').text()).toBe('09:00');
    expect(toastText()).toBe('Added 5 minutes to your session.');
    // Still one session: no second interval was stacked.
    expect(timerConfig.timer).not.toBeNull();
    expect(timerConfig.isRunning).toBe(true);
  });

  it('+5 min does nothing when no session is running', () => {
    ensureTimerMounted();

    click('#timerAddFiveBtn');

    expect(toastText()).toBe('');
    expect(timerConfig.isRunning).toBe(false);
    expect(timerConfig.totalDurationSec).toBe(0);
  });

  it('updateTimer with no session still walks the expiry path (guarded by its callers)', () => {
    ensureTimerMounted();
    // endTime null reads as an expired deadline: remaining clamps to 0 and
    // the completion branch runs. Latent quirk pinned as documentation —
    // only the interval (which requires a session) and the visibilitychange
    // seam (guarded by isRunning) call this today.
    updateTimer();

    expect(toastText()).toBe('Writing session complete. Nice work!');
    expect(timerConfig.isRunning).toBe(false);
    expect(playSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stopping — the two stop paths and their different side effects
// ---------------------------------------------------------------------------

describe('stopTimer (characterization)', () => {
  it("the running view's Stop button stops AND toasts", () => {
    ensureTimerMounted();
    startTimer(10);

    click('#timerStopBtn');

    expect(timerConfig.isRunning).toBe(false);
    expect($('.timer-display').text()).toBe('00:00');
    expect(pill().style.display).toBe('none');
    expect(toastText()).toBe('Session stopped.');
    // The modal returns to the duration picker.
    expect($('#timerSelectView').prop('hidden')).toBe(false);
    expect($('#timerRunningView').prop('hidden')).toBe(true);
  });

  it("the pill's × link stops silently — no toast", () => {
    ensureTimerMounted();
    startTimer(10);

    click('#stopTimer');

    expect(timerConfig.isRunning).toBe(false);
    expect(toastText()).toBe('');
  });

  it('starting a new session while one runs replaces it (no double interval)', () => {
    vi.useFakeTimers();
    ensureTimerMounted();

    startTimer(10);
    const firstInterval = timerConfig.timer;
    startTimer(25);

    expect(timerConfig.timer).not.toBe(firstInterval);
    expect($('.timer-display').text()).toBe('25:00');

    vi.advanceTimersByTime(60_000);
    expect($('.timer-display').text()).toBe('24:00');
  });
});

// ---------------------------------------------------------------------------
// Custom duration — clamp, steppers, persistence
// ---------------------------------------------------------------------------

describe('custom minutes (characterization)', () => {
  it('the stepper buttons step by five and clamp to 1..240 without persisting', () => {
    ensureTimerMounted();

    $('#timerCustomMinutes').val('25');
    click('#timerPlusBtn');
    expect($('#timerCustomMinutes').val()).toBe('30');

    $('#timerCustomMinutes').val('238');
    click('#timerPlusBtn');
    expect($('#timerCustomMinutes').val()).toBe('240'); // clamped high

    $('#timerCustomMinutes').val('3');
    click('#timerMinusBtn');
    expect($('#timerCustomMinutes').val()).toBe('1'); // clamped low

    // Steppers are transient UI: the last duration key is untouched.
    expect(stateGet('lastCustomTimerMinutes')).toBeNull();
  });

  it('Start session persists the duration and begins the countdown', () => {
    ensureTimerMounted();

    $('#timerCustomMinutes').val('42');
    click('#timerStartBtn');

    expect(stateGet('lastCustomTimerMinutes')).toBe('42');
    expect(timerConfig.isRunning).toBe(true);
    expect(timerConfig.totalDurationSec).toBe(42 * 60);
    expect($('.timer-display').text()).toBe('42:00');
    expect(toastText()).toBe('Session started — 42 minutes. Keep writing!');
  });

  it('junk text in the number input floors to 1 minute, not the NaN fallback', () => {
    ensureTimerMounted();

    $('#timerCustomMinutes').val('not a number');
    click('#timerStartBtn');

    // A type=number input reports invalid text as the empty string (spec
    // behavior), and Number('') is 0 — so junk rides the clamp to the
    // 1-minute floor, NOT the NaN→25 fallback. The 25 default only fires
    // when the input is missing entirely (val() null ?? 25).
    expect($('#timerCustomMinutes').val()).toBe('1');
    expect(stateGet('lastCustomTimerMinutes')).toBe('1');
    expect(timerConfig.totalDurationSec).toBe(60);
  });

  it('an out-of-range value is clamped to the 240-minute ceiling', () => {
    ensureTimerMounted();

    $('#timerCustomMinutes').val('9999');
    click('#timerStartBtn');

    expect(stateGet('lastCustomTimerMinutes')).toBe('240');
    expect(timerConfig.totalDurationSec).toBe(240 * 60);
  });
});

// ---------------------------------------------------------------------------
// The pill's docking quirk
// ---------------------------------------------------------------------------

describe('pill docking (characterization)', () => {
  it('docks at 1.4em when the word count container is hidden', () => {
    ensureTimerMounted();

    startTimer(10);

    // The shell mounts .word-count-container display:none (the pill-less
    // layout), so the timer moves to the 1.4em right offset. In jsdom every
    // element is zero-footprint, which reads as hidden to the q facade's
    // :hidden check — the same branch a real browser takes with the word
    // count pill disabled in preferences.
    expect(pill().style.right).toBe('1.4em');

    stopTimer();
    expect(pill().style.right).toBe('1.4em'); // stopping never un-docks it
  });
});

// ---------------------------------------------------------------------------
// Modal reopen — the running state is reflected every time it opens
// ---------------------------------------------------------------------------

describe('modal reopen (characterization)', () => {
  it('show.bs.modal re-syncs the views to the live session state', () => {
    ensureTimerMounted();

    startTimer(10);
    // A stale paint: force the select view visible as though the session
    // had ended while the modal was closed.
    $('#timerSelectView').prop('hidden', false);
    $('#timerRunningView').prop('hidden', true);

    $('#timerModal').get(0)!.dispatchEvent(new CustomEvent('show.bs.modal'));

    expect($('#timerSelectView').prop('hidden')).toBe(true);
    expect($('#timerRunningView').prop('hidden')).toBe(false);
    expect($('#timerRunningClock').text()).toBe('10:00');
  });
});
