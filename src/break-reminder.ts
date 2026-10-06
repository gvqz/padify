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

/** The popup's copy (one definition — the show, the close-reset and the
 *  modal markup must agree; the markup seeds the same strings). */
const BREAK_REMINDER_TITLE = 'Time for a quick break?';
const BREAK_REMINDER_TEXT =
  "You've been writing for a while. Stand up, stretch, or look away from the screen for a second.";

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
    $breakPopup.removeClass('show hide break-active ' + BREAK_FULLSCREEN_CLASS);
    $('#breakReminderActions').show();
    $('#takeBreakAction').text('Take break');
    $('#snoozeBreakAction').show();
    $('#breakReminderTitle').text(BREAK_REMINDER_TITLE);
    $('#breakReminderText').text(BREAK_REMINDER_TEXT);
    // Return the card to the rail so the next show starts docked.
    attachBreakPopupToRail();
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
 * The popup lives IN the notes rail — a rail section, not a floating
 * card. CSS positions it above the foot's New note control (absolute
 * within .tab-rail-foot), so it follows the mobile drawer's slide, hides
 * with the rail in the PIP host, and never needs JS re-anchoring on
 * resize. The user asked for it to feel — and be — part of that sidebar.
 * Runs from initBreakReminder, which boot.ts calls AFTER mountModals()
 * has mounted the modal partials the markup rides in on.
 */
function attachBreakPopupToRail(): void {
  const popup = document.getElementById('breakReminderPopup');
  const foot = document.querySelector('.tab-rail-foot');
  if (popup && foot && popup.parentElement !== foot) {
    foot.insertBefore(popup, foot.firstChild);
  }
}

/** The class that switches the card into its fullscreen presentation. */
const BREAK_FULLSCREEN_CLASS = 'break-reminder-fullscreen';

/**
 * Moves the popup between parents. Re-inserting an element resets its CSS
 * animations; the `quiet` variant suppresses that so a failed re-dock
 * attempt doesn't replay the entrance.
 */
function moveBreakPopup(popup: HTMLElement, foot: Element, quiet = false): void {
  if (quiet) {
    popup.style.animation = 'none';
    foot.insertBefore(popup, foot.firstChild);
    void popup.offsetWidth; // flush so the animation override takes
    popup.style.animation = '';
  } else {
    foot.insertBefore(popup, foot.firstChild);
  }
}

let lastKnownViewportHeight = window.innerHeight;

/**
 * Presentation sync — the popup prefers its docked rail spot, but some
 * hosts cannot show it there: a window too short clips the card against
 * the viewport, and the mobile drawer keeps the rail OFF-CANVAS when
 * closed (the popup would ride it out of sight). The user asked for the
 * reminder to always be findable: whenever the docked card is not fully
 * on screen, it is re-presented FULLSCREEN — re-parented to <body>,
 * fixed, centered, above the veil. When the context improves (window
 * grew, drawer slid open), the card returns to the rail.
 *
 * Runs at show time, when the entrance animation has settled, on window
 * resizes and on the rail's drawer transition. `retryDock` gates the
 * fullscreen→docked attempt so a resize drag doesn't replay the entrance
 * on every pixel (only growth can make the docked spot viable).
 */
function syncBreakPopupPresentation(retryDock = false): void {
  const popup = document.getElementById('breakReminderPopup');
  const foot = document.querySelector('.tab-rail-foot');

  if (!popup || !popup.classList.contains('show') || !foot) {
    return;
  }

  const isFullscreen = popup.classList.contains(BREAK_FULLSCREEN_CLASS);

  if (isFullscreen) {
    if (!retryDock) {
      return; // still no room — nothing to reconsider
    }
    // Try the docked spot again: move back into the rail and measure for
    // real. If it fits, the re-parent restarts the entrance as a docked
    // slide; if not, the fullscreen branch below re-parents us back.
    popup.classList.remove(BREAK_FULLSCREEN_CLASS);
    moveBreakPopup(popup, foot, true);
  }

  const rect = popup.getBoundingClientRect();
  const fitsViewport =
    rect.width > 0 &&
    rect.top >= -1 &&
    rect.left >= -1 &&
    rect.right <= window.innerWidth + 1 &&
    rect.bottom <= window.innerHeight + 1;

  if (fitsViewport) {
    if (!popup.classList.contains('break-active')) {
      $('#breakVeil').removeClass('active');
    }
    return;
  }

  // Not showable docked — go fullscreen over the veil.
  document.body.appendChild(popup);
  popup.classList.add(BREAK_FULLSCREEN_CLASS);
  $('#breakVeil').addClass('active');
}

function handleViewportResize(): void {
  const grew = window.innerHeight > lastKnownViewportHeight;
  lastKnownViewportHeight = window.innerHeight;

  if (!grew && $('#breakReminderPopup').hasClass(BREAK_FULLSCREEN_CLASS)) {
    return; // shrinking never revives the docked spot
  }

  syncBreakPopupPresentation(grew);
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
  $('#breakReminderTitle').text(BREAK_REMINDER_TITLE);
  $('#breakReminderText').text(BREAK_REMINDER_TEXT);

  // Pick the presentation before the first paint, then re-check once the
  // entrance animation has settled (the slide offsets the measured rect).
  syncBreakPopupPresentation();
  setTimeout(syncBreakPopupPresentation, 600);
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
  // The countdown title is larger — the card grows upward and a window
  // that comfortably fit the offer may now clip it.
  syncBreakPopupPresentation();

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

  // The popup is a rail section now — attach it once; CSS keeps it
  // docked above the foot's New note control through resizes and the
  // mobile drawer's slide (it is absolute INSIDE the rail).
  attachBreakPopupToRail();

  // Keep the presentation honest: a too-small host window or the closed
  // mobile drawer moves the card fullscreen; growth or an opened drawer
  // returns it to the rail. The rail's transform transition is the only
  // signal for the drawer slide (no resize fires), hence the listener.
  window.addEventListener('resize', handleViewportResize);
  document.getElementById('tabRail')?.addEventListener('transitionend', function () {
    syncBreakPopupPresentation(true);
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
