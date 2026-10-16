/**
 * aggregate.ts — every task note, indexed: pinned.
 *
 * The modal-era store tests (sanitize/CRUD/views/counts/search) carry
 * over in spirit — but the store is a set of NOTES now, so these tests
 * drive a stub TabManager's notes through the aggregate: the cross-note
 * views, the counts, the write-through (a hub edit lands in its note),
 * and the sweep's once-per-reminderAt stamp.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getTabManager, setTabManager, type NoteTab, type TabManager } from '../../tabs';
import {
  parseTaskNoteContent,
  serializeTaskNoteContent,
  type Task,
  type TaskNoteContent,
} from '../../editor/tasks/content';
import { taskNotes } from './aggregate';

const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

const NOW = new Date(2025, 2, 12, 14, 30);

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  notes: '',
  completed: false,
  completedAt: '',
  dueDate: '',
  reminderAt: '',
  reminderNotifiedAt: '',
  flagged: false,
  priority: 'none',
  createdAt: iso(2025, 3, 1),
  updatedAt: iso(2025, 3, 1),
  sortOrder: 0,
  ...overrides,
});

function noteTab(id: string, name: string, model: TaskNoteContent): NoteTab {
  return {
    id,
    name,
    content: serializeTaskNoteContent(model),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    noteType: 'tasks',
  };
}

/** A minimal TabManager stand-in: notes in, writeNoteContent writes back. */
function stubManager(tabs: NoteTab[]): TabManager {
  const notes = tabs;
  const stub = {
    allTabs: notes,
    writeNoteContent(tabId: string, content: string): void {
      const tab = notes.find((entry) => entry.id === tabId);
      if (tab) {
        tab.content = content;
        stub.persistCount = (stub.persistCount ?? 0) + 1;
      }
    },
    persistCount: 0,
  };
  return stub as unknown as TabManager;
}

let manager: TabManager;

beforeEach(() => {
  manager = stubManager([
    noteTab('n-travel', 'Travel', {
      version: 1,
      color: 'teal',
      tasks: [
        task('t-book', { title: 'Book ryokan', dueDate: iso(2025, 3, 11), sortOrder: 1 }),
        task('t-visa', { title: 'Visa paperwork', dueDate: iso(2025, 3, 12, 9, 0), sortOrder: 0 }),
        task('t-done', { title: 'Flights', completed: true, completedAt: iso(2025, 3, 12, 8, 0) }),
      ],
    }),
    noteTab('n-home', 'Home', {
      version: 1,
      color: 'orange',
      tasks: [task('t-milk', { title: 'Buy milk', reminderAt: iso(2025, 3, 12, 13, 0) })],
    }),
    // A plain note — not part of the tasks world.
    noteTab(
      'n-plain',
      'Groceries',
      parseTaskNoteContent('') && {
        ...{ version: 1 as const, color: 'blue' as const, tasks: [] as Task[] },
      },
    ),
  ]);
  (manager as unknown as { allTabs: NoteTab[] }).allTabs[2]!.noteType = 'standard';
  (manager as unknown as { allTabs: NoteTab[] }).allTabs[2]!.content = 'just text';
  setTabManager(manager);
  taskNotes.refresh();
});

describe('the aggregate reads', () => {
  it('lists only the task notes, with names and colors', () => {
    const lists = taskNotes.lists();
    expect(lists.map((list) => list.name)).toEqual(['Travel', 'Home']);
    expect(lists[0]).toMatchObject({ id: 'n-travel', color: 'teal' });
  });

  it('smart counts span every note', () => {
    expect(taskNotes.smartCounts(NOW)).toEqual({
      today: 3, // overdue ryokan + today visa + today-reminding milk
      scheduled: 3,
      all: 3,
      flagged: 0,
      completed: 1,
    });
  });

  it('per-note counts feed the rail', () => {
    expect(taskNotes.listCounts().get('n-travel')).toBe(2);
    expect(taskNotes.listCounts().get('n-home')).toBe(1);
  });

  it('Today splits Overdue from Today across notes', () => {
    const { sections, completed } = taskNotes.sectionsFor('today', NOW);
    expect(sections.map((section) => section.title)).toEqual(['Overdue', 'Today']);
    expect(sections[0]!.rows.map((row) => row.task.id)).toEqual(['t-book']);
    expect(sections[1]!.rows.map((row) => row.task.id).sort()).toEqual(['t-milk', 't-visa']);
    expect(completed.map((row) => row.task.id)).toEqual(['t-done']); // completed today
  });

  it('All groups by note with the note as heading', () => {
    const { sections } = taskNotes.sectionsFor('all', NOW);
    expect(sections.map((section) => section.title)).toEqual(['Travel', 'Home']);
    expect(sections[0]!.color).toBe('teal');
  });

  it('search spans titles and notes across notes', () => {
    const { sections } = taskNotes.search('milk');
    expect(sections.map((section) => section.title)).toEqual(['Home']);
    const nope = taskNotes.search('ryokan*missing');
    expect(nope.sections).toEqual([]);
  });
});

describe('the aggregate writes', () => {
  it('a hub toggle lands in the note and the counts follow', () => {
    expect(taskNotes.toggleComplete('t-visa')).toBe(true);
    const travel = parseTaskNoteContent(
      (manager as unknown as { allTabs: NoteTab[] }).allTabs[0]!.content,
    );
    expect(travel.tasks.find((entry) => entry.id === 't-visa')!.completed).toBe(true);
    expect(taskNotes.smartCounts(NOW).all).toBe(2);
    expect(taskNotes.smartCounts(NOW).completed).toBe(2);
  });

  it('updateTask re-arms a reminder when its time changes', () => {
    taskNotes.markReminderNotified('t-milk');
    expect(taskNotes.pendingReminders(NOW)).toEqual([]);
    taskNotes.updateTask('t-milk', { reminderAt: iso(2025, 3, 12, 14, 0) });
    expect(taskNotes.pendingReminders(NOW).map((row) => row.task.id)).toEqual(['t-milk']);
  });

  it('addTaskToNote lands at the top of the chosen note', () => {
    const added = taskNotes.addTaskToNote('n-home', { title: 'Water plants' });
    expect(added).not.toBeNull();
    const home = parseTaskNoteContent(
      (manager as unknown as { allTabs: NoteTab[] }).allTabs[1]!.content,
    );
    expect(home.tasks[0]!.id).toBe(added!.id);
  });

  it('moveTask carries a task between notes', () => {
    expect(taskNotes.moveTask('t-milk', 'n-travel')).toBe(true);
    const travel = parseTaskNoteContent(
      (manager as unknown as { allTabs: NoteTab[] }).allTabs[0]!.content,
    );
    const home = parseTaskNoteContent(
      (manager as unknown as { allTabs: NoteTab[] }).allTabs[1]!.content,
    );
    expect(travel.tasks.some((entry) => entry.id === 't-milk')).toBe(true);
    expect(home.tasks.some((entry) => entry.id === 't-milk')).toBe(false);
  });

  it('deleteTask removes it from its note only', () => {
    taskNotes.deleteTask('t-book');
    const travel = parseTaskNoteContent(
      (manager as unknown as { allTabs: NoteTab[] }).allTabs[0]!.content,
    );
    expect(travel.tasks.map((entry) => entry.id)).toEqual(['t-visa', 't-done']);
  });
});

describe('the sweep candidates (once-per-reminderAt, pinned)', () => {
  it('a due, unnotified, active task is a candidate exactly once', () => {
    const pending = taskNotes.pendingReminders(NOW);
    expect(pending.map((row) => row.task.id)).toEqual(['t-milk']);

    taskNotes.markReminderNotified('t-milk');
    expect(taskNotes.pendingReminders(NOW)).toEqual([]);
  });

  it('completed tasks never join the sweep', () => {
    taskNotes.toggleComplete('t-milk');
    expect(taskNotes.pendingReminders(NOW)).toEqual([]);
  });

  it('the stamp survives a re-read of the same notes (reload parity)', () => {
    taskNotes.markReminderNotified('t-milk');
    taskNotes.refresh(); // what the next sweep pass does
    expect(taskNotes.pendingReminders(NOW)).toEqual([]);
  });

  it('future reminders wait', () => {
    taskNotes.updateTask('t-milk', { reminderAt: iso(2025, 3, 12, 15, 0) });
    expect(taskNotes.pendingReminders(NOW)).toEqual([]);
    expect(
      taskNotes.pendingReminders(new Date(2025, 2, 12, 15, 1)).map((row) => row.task.id),
    ).toEqual(['t-milk']);
  });
});

describe('the target list', () => {
  it('falls back to the first note when the remembered one is gone', () => {
    expect(taskNotes.targetListId()).toBe('n-travel');
    localStorage.setItem('padify-tasks-last-list', 'n-home');
    expect(taskNotes.targetListId()).toBe('n-home');
    localStorage.setItem('padify-tasks-last-list', 'n-gone');
    expect(taskNotes.targetListId()).toBe('n-travel');
    localStorage.removeItem('padify-tasks-last-list');
  });
});

describe('the environment plumbing', () => {
  it('the manager is reachable through the same seam the app uses', () => {
    expect(getTabManager()).toBe(manager);
  });
});
