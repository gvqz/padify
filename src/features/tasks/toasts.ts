/**
 * The reminder toasts — the sweep's in-page voice.
 *
 * A fired reminder surfaces as a toast (10 s, dismissible, click opens
 * the task's note) plus a Web Notification when the browser already
 * granted permission (the app never asks — that prompt belongs to
 * Settings). Page-level on purpose: toasts show whether or not any
 * tasks page is open.
 *
 * Split from reminders.ts when the sweep stopped being the only
 * consumer: the hub deletes a task and must clear its toasts too, and
 * the hub/sweep import pair would otherwise cycle.
 */

import { formatReminderChip } from '../../editor/tasks/dates';
import { ICONS } from '../../editor/tasks/icons';
import type { Task } from '../../editor/tasks/content';

const TOAST_LIFETIME_MS = 10_000;

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

/** Shows one reminder toast; `open` runs when the copy is clicked. */
export function showReminderToast(task: Task, open: () => void): void {
  const now = new Date();
  const toast = document.createElement('div');
  toast.className = 'tk-remind-toast';
  toast.dataset.taskId = task.id;

  const dueLine = task.dueDate
    ? `is due ${formatReminderChip(task.dueDate, now)}.`
    : 'is ready for attention.';
  toast.innerHTML = `
    <span class="tk-remind-icon">${ICONS.bell}</span>
    <div class="tk-remind-copy" role="button" tabindex="0" title="Open the list">
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
  const openToast = (): void => {
    window.clearTimeout(timer);
    open();
  };
  toast.querySelector<HTMLElement>('.tk-remind-copy')!.addEventListener('click', openToast);
  toast.querySelector<HTMLElement>('.tk-remind-copy')!.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openToast();
    }
  });

  stack().appendChild(toast);
}

/** Removes a task's open toasts (all of them when no id). */
export function dismissReminderToasts(taskId?: string): void {
  if (!toastStack) return;
  const stale = taskId
    ? toastStack.querySelectorAll(`[data-task-id="${CSS.escape(taskId)}"]`)
    : toastStack.children;
  for (const node of [...stale]) node.remove();
}

/** Web Notification — only when permission was already granted. */
export function notifyOs(task: Task): void {
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
