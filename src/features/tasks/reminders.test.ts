/**
 * reminders.ts — the sweep's once-per-time guarantee, pinned.
 *
 * The stamp-and-compare guard is the behavior the legacy page got right
 * and the rebuild must not lose: each reminderAt notifies exactly once,
 * survives reloads, and re-arms when the time is edited. These tests drive
 * the TaskStore + the sweep's candidate logic against injected storage —
 * the DOM toast half is e2e's job.
 */

import { describe, expect, it } from 'vitest';
import { TaskStore } from './store';
import type { Task } from './types';

const NOW = new Date(2025, 2, 12, 14, 30);
const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

function freshStore(): TaskStore {
  const backing = new Map<string, string>();
  return new TaskStore(
    (key) => backing.get(key) ?? null,
    (key, value) => backing.set(key, value),
    () => null,
  );
}

describe('the sweep, through the store it drives', () => {
  it('a due, unnotified, active task is a candidate exactly once', () => {
    const store = freshStore();
    const task = store.addTask({ title: 'Call the dentist', reminderAt: iso(2025, 3, 12, 9, 0) });

    let pending = store.pendingReminders(NOW);
    expect(pending.map((t: Task) => t.id)).toEqual([task.id]);

    // "fire" it — stamp, the way fireReminder does
    store.markReminderNotified(pending[0]);
    pending = store.pendingReminders(NOW);
    expect(pending).toEqual([]);
  });

  it('completing a task removes it from candidates', () => {
    const store = freshStore();
    const task = store.addTask({ title: 'done deal', reminderAt: iso(2025, 3, 12, 8, 0) });
    store.toggleComplete(task.id);
    expect(store.pendingReminders(NOW)).toEqual([]);
  });

  it('future reminders wait, past-due ones go immediately', () => {
    const store = freshStore();
    store.addTask({ title: 'future', reminderAt: iso(2025, 3, 12, 15, 0) });
    const early = NOW; // 14:30 — 15:00 not due yet
    expect(store.pendingReminders(early)).toEqual([]);

    const later = new Date(2025, 2, 12, 15, 1);
    expect(store.pendingReminders(later).map((t) => t.title)).toEqual(['future']);
  });

  it('editing the time re-arms a fired reminder', () => {
    const store = freshStore();
    const task = store.addTask({ title: 'reschedule me', reminderAt: iso(2025, 3, 12, 9, 0) });
    store.markReminderNotified(task);
    expect(store.pendingReminders(NOW)).toEqual([]);

    store.updateTask(task.id, { reminderAt: iso(2025, 3, 12, 14, 0) });
    expect(store.pendingReminders(NOW).map((t) => t.id)).toEqual([task.id]);
  });

  it('dateless tasks never join the sweep', () => {
    const store = freshStore();
    store.addTask({ title: 'plain', dueDate: iso(2025, 3, 10) });
    expect(store.pendingReminders(NOW)).toEqual([]);
  });

  it('the stamp survives a reload (once across page loads)', () => {
    const backing = new Map<string, string>();
    const persist = { get: (key: string) => backing.get(key) ?? null };
    const mk = (): TaskStore =>
      new TaskStore(
        persist.get,
        (key, value) => backing.set(key, value),
        () => null,
      );

    const first = mk();
    const task = first.addTask({ title: 'across loads', reminderAt: iso(2025, 3, 12, 9, 0) });
    first.markReminderNotified(task);

    const second = mk(); // reload
    expect(second.pendingReminders(NOW)).toEqual([]);
  });
});
