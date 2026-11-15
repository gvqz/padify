/**
 * Reminders — the app-level sweep.
 *
 * Timed reminders must fire whether or not any tasks page is open, so
 * this module is the feature's small always-on half riding the main
 * bundle. The engine is unchanged since the modal era, only the store
 * moved: the aggregate (aggregate.ts) reads every task note, so a
 * reminder set in any list fires from wherever its note lives.
 *
 *   • sweeps every 30 seconds, plus immediately on window focus and on
 *     visibilitychange back to visible;
 *   • a sweep is re-entrancy guarded;
 *   • a reminder fires when the task is active, reminderAt is a valid time
 *     in the past, and reminderNotifiedAt !== reminderAt — the
 *     stamp-and-compare guard that makes each time notify exactly once
 *     while editing the time re-arms it;
 *   • surfaces: an in-page toast (toasts.ts) plus a Web Notification
 *     when permission was already granted.
 */

import { taskNotes } from './aggregate';
import { showReminderToast, notifyOs } from './toasts';
import { openNoteFromTasks } from './hub';

const SWEEP_INTERVAL_MS = 30_000;

let sweepTimer: number | null = null;
let sweeping = false;

/** Starts the global sweep. Idempotent — called once from app.ts. */
export function initTaskReminderSweep(): void {
  if (sweepTimer !== null) return;

  sweepTimer = window.setInterval(() => {
    void sweep();
  }, SWEEP_INTERVAL_MS);
  window.addEventListener('focus', () => void sweep());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sweep();
  });
  void sweep();
}

/** One pass over the due reminders. Re-entrancy guarded (legacy parity). */
export async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // The aggregate's snapshot may be a beat old; re-read the notes.
    taskNotes.refresh();
    const due = taskNotes.pendingReminders(new Date());
    for (const row of due) {
      // Marks first so a throwing toast can never re-notify on the next pass.
      taskNotes.markReminderNotified(row.task.id);
      showReminderToast(row.task, () => openNoteFromTasks(row.note.id));
      notifyOs(row.task);
    }
  } finally {
    sweeping = false;
  }
}
