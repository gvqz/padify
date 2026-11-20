/**
 * The offline indicator — the status bar's honest little chip.
 *
 * Network state used to be invisible: offline, the app just kept working
 * (it is offline-first by design), while the cloud panel kept offering a
 * sign-in that could not leave the device. The chip makes the state
 * visible where the user already looks — beside the save state — and it
 * is the one online/offline listener the app shell owns.
 *
 * Deliberately tiny: no retry logic, no messaging — the sync pipeline
 * has its own offline vocabulary (SyncPhase 'offline', cloud/ui.ts).
 * This only answers "is the network here" in the always-visible surface,
 * and the cloud panel borrows the same navigator.onLine question for its
 * own sign-in honesty.
 */

export function initOfflineIndicator(): void {
  const chip = document.getElementById('offlineChip');
  if (!chip) {
    return;
  }

  const apply = (): void => {
    chip.hidden = navigator.onLine;
  };

  apply();
  window.addEventListener('online', apply);
  window.addEventListener('offline', apply);
}
