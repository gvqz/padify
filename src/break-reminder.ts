import $ from 'jquery';
import { showToast } from './utils';
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
  thresholdMs: 30 * 60 * 1000,

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

const breakReminderDefaults = {
  accumulatedMs: 0,
  lastActivityAt: 0,
  snoozedUntil: 0,
  dismissedUntil: 0,
};

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
    $('#breakReminderTitle').text('Time for a 2-minute break?');
    $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
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

function showBreakReminderPopup(): void {
  if (!breakRemindersEnabled) {
    return;
  }

  if ($('#breakReminderPopup').hasClass('show')) {
    return;
  }
  const $breakPopup = $('#breakReminderPopup');
  $breakPopup.removeClass('hide break-active').addClass('show');
  $('#breakReminderActions').show();
  $('#takeBreakAction').text('Take break');
  $('#snoozeBreakAction').show();
  $('#dismissBreakAction').show();
  $('#breakReminderTitle').text('Time for a 2-minute break?');
  $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
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
  persistBreakReminderState();
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
