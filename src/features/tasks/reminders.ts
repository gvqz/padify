/**
 * Reminders — the app-level sweep.
 *
 * Timed reminders must fire whether or not the Reminders modal was ever
 * opened, so this module is the feature's small always-on half: it rides
 * the main bundle next to the store (the modal's controller stays a lazy
 * chunk — see app.ts). The legacy page's engine, verbatim in spirit:
 *
 *   • sweeps every 30 seconds, plus immediately on window focus and on
 *     visibilitychange back to visible;
 *   • a sweep is re-entrancy guarded;
 *   • a reminder fires when the task is active, reminderAt is a valid time
 *     in the past, and reminderNotifiedAt !== reminderAt — the
 *     stamp-and-compare guard that makes each time notify exactly once
 *     while editing the time re-arms it;
 *   • surfaces: an in-page toast (10 s, dismissible, click opens the
 *     Reminders) plus a Web Notification when the browser granted
 *     permission (the app never asks — that prompt belongs to Settings).
 */

import { TaskStore } from './store';
import type { Task } from './types';
import { ICONS } from './markup';
import { openModal } from '../../ui/behavior/modal';
import { formatReminderChip } from './dates';

const SWEEP_INTERVAL_MS = 30_000;
const TOAST_LIFETIME_MS = 10_000;

let store: TaskStore | null = null;
let sweepTimer: number | null = null;
let sweeping = false;

/** Starts the global sweep. Idempotent — called once from app.ts. */
export function initTaskReminderSweep(): void {
  if (sweepTimer !== null) return;
  store = new TaskStore();

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
  if (sweeping || !store) return;
  sweeping = true;
  try {
    const due = store.pendingReminders(new Date());
    for (const task of due) {
      fireReminder(task, store);
    }
  } finally {
    sweeping = false;
  }
}

/** Marks first so a throwing toast can never re-notify on the next pass. */
function fireReminder(task: Task, from: TaskStore): void {
  from.markReminderNotified(task);
  showReminderToast(task);
  notifyOs(task);
}

// ---------------------------------------------------------------------------
// The in-page toast stack (page-level — the modal may be closed)
// ---------------------------------------------------------------------------

let toastStack: HTMLElement | null = null;

function stack(): HTMLElement {
  if (toastStack === null || !toastStack.isConnected) {
    toastStack = document.createElement('div');
    toastStack.className = 'tk-remind-stack';
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

function showReminderToast(task: Task): void {
  const now = new Date();
  const toast = document.createElement('div');
  toast.className = 'tk-remind-toast';
  toast.dataset.taskId = task.id;

  const dueLine = task.dueDate
    ? `is due ${formatReminderChip(task.dueDate, now)}.`
    : 'is ready for attention.';
  toast.innerHTML = `
    <span class="tk-remind-icon">${ICONS.bell}</span>
    <div class="tk-remind-copy" role="button" tabindex="0" title="Open Reminders">
      <span class="tk-remind-title"></span>
      <span class="tk-remind-sub"></span>
    </div>
    <button type="button" class="tk-remind-dismiss" aria-label="Dismiss reminder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`;
  // textContent after innerHTML — never build user words into markup.
  toast.querySelector<HTMLElement>('.tk-remind-title')!.textContent = task.title;
  toast.querySelector<HTMLElement>('.tk-remind-sub')!.textContent = dueLine;

  const dismiss = (): void => {
    toast.classList.add('tk-remind-out');
    window.setTimeout(() => toast.remove(), 200);
  };
  const timer = window.setTimeout(dismiss, TOAST_LIFETIME_MS);

  toast.querySelector<HTMLElement>('.tk-remind-dismiss')!.addEventListener('click', () => {
    window.clearTimeout(timer);
    dismiss();
  });
  const open = (): void => {
    window.clearTimeout(timer);
    const modal = document.getElementById('tasksModal');
    if (modal) openModal(modal);
  };
  toast.querySelector<HTMLElement>('.tk-remind-copy')!.addEventListener('click', open);
  toast.querySelector<HTMLElement>('.tk-remind-copy')!.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  stack().appendChild(toast);
}

/** Removes a task's open toasts (called by the controller on delete/clear). */
export function dismissReminderToasts(taskId?: string): void {
  if (!toastStack) return;
  const stale = taskId
    ? toastStack.querySelectorAll(`[data-task-id="${CSS.escape(taskId)}"]`)
    : toastStack.children;
  for (const node of [...stale]) node.remove();
}

/** Web Notification — only when permission was already granted. */
function notifyOs(task: Task): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification('Task reminder', {
      body: task.dueDate
        ? `${task.title} is due ${formatReminderChip(task.dueDate, new Date())}.`
        : `${task.title} is ready for attention.`,
      tag: `padify-task-${task.id}-${task.reminderAt}`,
    });
  } catch {
    /* some platforms throw on Notification construction — the toast already spoke */
  }
}
