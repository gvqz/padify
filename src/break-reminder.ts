import { $ } from './lib/q';
import { showToast } from './ui/toast';
import { debounce } from './lib/debounce';
import { stateGet, stateSet, stateRemove } from './storage';

/**
 * Break reminders — after 30 minutes of active writing, offer a
 * two-minute break with a countdown, snooze and dismiss. State
 * (accumulated writing time, snooze window) persists in the kv store.
 */

interface BreakReminderState {
  accumulatedMs: number;
  lastActivityAt: number;
  snoozedUntil: number;
  dismissedUntil: number;
}

const breakReminderConfig = {
  // Show the reminder after this much active writing time.
  // 3 SECONDS — a temporary testing value (the task list asks for it so
  // the flow can be exercised without a long session). Restore
  // 30 * 60 * 1000 before shipping.
  thresholdMs: 3 * 1000,

  // Ignore gaps longer than this so idle time does not count as writing.
  idleWindowMs: 2 * 60 * 1000,

  // Cap how much time a single input event can add to the session.
  activitySliceMs: 15000,

  // Hide the reminder for this long when the user snoozes it.
  snoozeMs: 10 * 60 * 1000,

  // Duration of the actual break countdown once started.
  breakDurationMs: 2 * 60 * 1000,

  // Keep the reminder suppressed for this long after dismissal.
  dismissCooldownMs: 30 * 60 * 1000,

  // Storage key (kv store) used to persist reminder state across reloads.
  storageKey: 'breakReminderState',
};

/** Gap between the popup's bottom edge and the New note button's top edge. */
const ANCHOR_GAP_PX = 8;

const breakReminderDefaults = {
  accumulatedMs: 0,
  lastActivityAt: 0,
  snoozedUntil: 0,
  dismissedUntil: 0,
};

/** The popup's copy (one definition — the show, the close-reset and the
 *  modal markup must agree; the markup seeds the same strings). */
const BREAK_REMINDER_TITLE = 'Time for a quick break?';
const BREAK_REMINDER_TEXT =
  "You've been working for a while. Stand up, stretch, or look away from the screen for a second.";

let breakReminderState = loadBreakReminderState();
let breakReminderCountdownTimer: ReturnType<typeof setInterval> | null = null;
let breakRemindersEnabled = false;

function loadBreakReminderState(): BreakReminderState {
  const rawState = stateGet(breakReminderConfig.storageKey);

  if (!rawState) {
    return { ...breakReminderDefaults };
  }

  try {
    return {
      ...breakReminderDefaults,
      ...JSON.parse(rawState),
    };
  } catch (error) {
    return { ...breakReminderDefaults };
  }
}

function persistBreakReminderState(): void {
  stateSet(breakReminderConfig.storageKey, JSON.stringify(breakReminderState));
}

// Debounced variant for the per-keystroke path. JSON.stringify + localStorage
// write on every input event is unnecessary work; the editor itself uses 400 ms
// for saveActiveFromEditor. The threshold check stays synchronous.
const persistBreakReminderStateDebounced = debounce(persistBreakReminderState, 1000);

function clearBreakReminderState(): void {
  breakReminderState = { ...breakReminderDefaults };
  stateRemove(breakReminderConfig.storageKey);
}

function closeBreakReminderPopup(): void {
  const $breakPopup = $('#breakReminderPopup');
  $breakPopup.addClass('hide');
  $('#breakVeil').removeClass('active');
  setTimeout(function () {
    $breakPopup.removeClass('show hide break-active');
    $('#breakReminderActions').show();
    $('#takeBreakAction').text('Take break');
    $('#snoozeBreakAction').show();
    $('#dismissBreakAction').show();
    $('#breakReminderTitle').text(BREAK_REMINDER_TITLE);
    $('#breakReminderText').text(BREAK_REMINDER_TEXT);
  }, 300);

  if (breakReminderCountdownTimer) {
    clearInterval(breakReminderCountdownTimer);
    breakReminderCountdownTimer = null;
  }
}

function resetBreakReminderSession(): void {
  breakReminderState.accumulatedMs = 0;
  breakReminderState.lastActivityAt = 0;
  persistBreakReminderState();
}

function shouldBlockBreakReminder(now: number): boolean {
  return now < breakReminderState.snoozedUntil || now < breakReminderState.dismissedUntil;
}

/**
 * Docks the popup above the "+ New note" split control in the notes rail —
 * its long-term home (the mini music player will share this anchor). The
 * popup stays body-level so it is never clipped by the rail, and keeps a
 * viewport-corner fallback for when the rail is hidden: the PIP host
 * removes it and the mobile drawer slides it off-screen.
 */
function anchorBreakPopup(): void {
  const popup = document.getElementById('breakReminderPopup');

  if (!popup) {
    return;
  }

  const anchor = document.querySelector('.tab-rail-add-group');
  const rect = anchor?.getBoundingClientRect();
  const railVisible =
    !!rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= 0 &&
    rect.top < window.innerHeight &&
    rect.bottom > 0;

  if (!railVisible) {
    popup.style.left = '20px';
    popup.style.bottom = '20px';
    popup.style.width = '';
    popup.style.maxWidth = '';
    return;
  }

  popup.style.left = `${Math.round(rect.left)}px`;
  popup.style.bottom = `${Math.round(window.innerHeight - rect.top + ANCHOR_GAP_PX)}px`;
  popup.style.width = `${Math.round(rect.width)}px`;
  popup.style.maxWidth = 'none';
}

/** The drawer's slide transition runs after the resize event — re-anchor
 *  once it settles, so the popup follows the rail in and out of view. */
const DRAWER_SLIDE_MS = 300;

function reAnchorWhileShown(): void {
  if (!$('#breakReminderPopup').hasClass('show')) {
    return;
  }

  anchorBreakPopup();
  window.setTimeout(anchorBreakPopup, DRAWER_SLIDE_MS);
}

function showBreakReminderPopup(): void {
  if (!breakRemindersEnabled) {
    return;
  }

  if ($('#breakReminderPopup').hasClass('show')) {
    return;
  }
  const $breakPopup = $('#breakReminderPopup');
  $breakPopup.removeClass('hide break-active').addClass('show');
  anchorBreakPopup();
  $('#breakReminderActions').show();
  $('#takeBreakAction').text('Take break');
  $('#snoozeBreakAction').show();
  $('#dismissBreakAction').show();
  $('#breakReminderTitle').text(BREAK_REMINDER_TITLE);
  $('#breakReminderText').text(BREAK_REMINDER_TEXT);
}

function maybeShowBreakReminder(now: number = Date.now()): void {
  if (!breakRemindersEnabled || document.hidden || shouldBlockBreakReminder(now)) {
    return;
  }

  if (breakReminderState.accumulatedMs >= breakReminderConfig.thresholdMs) {
    showBreakReminderPopup();
  }
}

function trackWritingActivity(): void {
  if (!breakRemindersEnabled || document.hidden) {
    return;
  }

  const now = Date.now();

  if (breakReminderState.lastActivityAt) {
    const delta = now - breakReminderState.lastActivityAt;

    if (delta <= breakReminderConfig.idleWindowMs) {
      breakReminderState.accumulatedMs += Math.min(delta, breakReminderConfig.activitySliceMs);
    }
  }

  breakReminderState.lastActivityAt = now;
  // Use the debounced variant — trackWritingActivity fires on every keystroke
  // (registered from app.ts on the editor's 'input' event). The threshold
  // check below stays synchronous; only the persistence is throttled.
  persistBreakReminderStateDebounced();
  maybeShowBreakReminder(now);
}

function formatBreakCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function startBreakCountdown(): void {
  const breakEndsAt = Date.now() + breakReminderConfig.breakDurationMs;

  breakReminderState.snoozedUntil = breakEndsAt;
  resetBreakReminderSession();
  persistBreakReminderState();

  $('#breakReminderPopup').addClass('break-active');
  $('#breakVeil').addClass('active');
  $('#breakReminderActions').show();
  $('#breakReminderTitle').text(formatBreakCountdown(breakReminderConfig.breakDurationMs));
  $('#breakReminderText').text('Relax your eyes. Unclench your jaw. Breathe.');
  $('#takeBreakAction').text('Back to writing');
  $('#snoozeBreakAction').hide();
  $('#dismissBreakAction').hide();

  if (breakReminderCountdownTimer) {
    clearInterval(breakReminderCountdownTimer);
  }

  breakReminderCountdownTimer = setInterval(() => {
    const msRemaining = breakEndsAt - Date.now();

    if (msRemaining <= 0) {
      clearInterval(breakReminderCountdownTimer!);
      breakReminderCountdownTimer = null;
      closeBreakReminderPopup();
      showToast('Break complete. Welcome back.');
      return;
    }

    $('#breakReminderTitle').text(formatBreakCountdown(msRemaining));
  }, 1000);
}

let breakReminderWired = false;

/**
 * Binds the popup's controls. Called from boot.ts AFTER mountModals() has
 * mounted the modal partials — the popup markup rides preferences-modal.html,
 * so binding at module-evaluation time (the old shape) attached every
 * handler to an EMPTY collection: Take break, Snooze, Dismiss and the close
 * button were all dead. Idempotent, like the other boot wiring steps.
 */
export function initBreakReminder(): void {
  if (breakReminderWired) {
    return;
  }
  breakReminderWired = true;

  $('#closeBreakReminderPopup').on('click', function () {
    breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
    resetBreakReminderSession();
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  $('#takeBreakAction').on('click', function () {
    if ($('#breakReminderPopup').hasClass('break-active')) {
      closeBreakReminderPopup();
      return;
    }

    startBreakCountdown();
  });

  $('#snoozeBreakAction').on('click', function () {
    breakReminderState.snoozedUntil = Date.now() + breakReminderConfig.snoozeMs;
    breakReminderState.lastActivityAt = 0;
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  $('#dismissBreakAction').on('click', function () {
    breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
    resetBreakReminderSession();
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  // Keep the dock above the New note button while the popup is visible —
  // the rail can change geometry under it (window resize, drawer slide).
  window.addEventListener('resize', reAnchorWhileShown);
  document.addEventListener('transitionend', (event) => {
    if ((event.target as Element | null)?.id === 'tabRail' && event.propertyName === 'transform') {
      reAnchorWhileShown();
    }
  });
}

// Idle time does not count as writing — reset the activity window when
// the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && breakRemindersEnabled) {
    breakReminderState.lastActivityAt = 0;
    persistBreakReminderState();
  }
});

/**
 * Turns break reminders on or off (the preferences checkbox).
 * Disabling also closes any open popup and clears the session state.
 */
export function setBreakRemindersEnabled(enabled: boolean): void {
  if (enabled) {
    breakRemindersEnabled = true;
    breakReminderState = loadBreakReminderState();
  } else {
    breakRemindersEnabled = false;
    closeBreakReminderPopup();
    clearBreakReminderState();
  }
}

/** Called from the editor's input handler to accumulate writing time. */
export { trackWritingActivity };
