/**
 * store.ts — persistence hygiene, CRUD ordering, the smart views, counts,
 * search and the legacy adoption. Storage is injected (a pair of maps), so
 * no test ever touches IndexedDB or localStorage.
 */

import { describe, expect, it } from 'vitest';
import { STORAGE_KEY, TaskStore, type StateReader, type StateWriter } from './store';
import { INBOX_LIST_ID, type Task, type TaskList, type ViewId } from './types';

/** The fixed "now" every test passes explicitly. */
const NOW = new Date(2025, 2, 12, 14, 30);
const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

function harness(pre?: { padify?: string; legacy?: string }): {
  store: TaskStore;
  written: Map<string, string>;
  seed: (key: string, value: string) => void;
  seedLegacy: (value: string) => void;
} {
  const backing = new Map<string, string>();
  const legacy = new Map<string, string>();
  const written = new Map<string, string>();
  if (pre?.padify) backing.set(STORAGE_KEY, pre.padify);
  if (pre?.legacy) legacy.set('tasks', pre.legacy);
  const read: StateReader = (key) => backing.get(key) ?? null;
  const write: StateWriter = (key, value) => {
    backing.set(key, value);
    written.set(key, value);
  };
  return {
    store: new TaskStore(read, write, (key) => legacy.get(key) ?? null),
    written,
    seed: (key, value) => backing.set(key, value),
    seedLegacy: (value) => legacy.set('tasks', value),
  };
}

/** A task with the fields the view math cares about. */
function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    title: 'Write tests',
    notes: '',
    listId: INBOX_LIST_ID,
    completed: false,
    completedAt: '',
    dueDate: '',
    reminderAt: '',
    reminderNotifiedAt: '',
    flagged: false,
    priority: 'none',
    createdAt: iso(2025, 3, 10),
    updatedAt: iso(2025, 3, 10),
    sortOrder: 0,
    ...overrides,
  };
}

describe('load — sanitization', () => {
  it('starts clean with nothing stored', () => {
    const { store } = harness();
    expect(store.tasks).toEqual([]);
    expect(store.lists).toEqual([]);
    expect(store.view).toBe('today');
  });

  it('corrupted JSON falls back to a clean start', () => {
    const { store, seed } = harness();
    seed(STORAGE_KEY, '{oops not json');
    store.load();
    expect(store.tasks).toEqual([]);
  });

  it('wrong-typed fields fall back to defaults, junk rows are dropped', () => {
    const { store, seed } = harness();
    seed(
      STORAGE_KEY,
      JSON.stringify({
        lists: [{ id: 'l1', name: 'Shopping', color: 'nope', sortOrder: 'x' }],
        tasks: [
          { id: 'ok', title: 'Milk', priority: 'high', completed: 'yes' },
          { id: 'notitle' },
          'junk',
          { id: 'bad-due', title: 'X', dueDate: 'whenever' },
        ],
        view: 'nonsense',
      }),
    );
    store.load();
    expect(store.tasks).toHaveLength(2);
    expect(store.taskById('ok')?.priority).toBe('high');
    expect(store.taskById('ok')?.completed).toBe(true);
    expect(store.taskById('ok')?.completedAt).not.toBe('');
    expect(store.taskById('bad-due')?.dueDate).toBe('');
    expect(store.view).toBe('today');
    expect(store.lists[0]?.color).toBe('blue'); // unknown color → default
    expect(store.lists[0]?.name).toBe('Shopping');
  });

  it('tasks with empty titles are dropped (never render ghost rows)', () => {
    const { store, seed } = harness();
    seed(STORAGE_KEY, JSON.stringify({ tasks: [task({ id: 'ghost', title: '' })] }));
    store.load();
    expect(store.tasks).toEqual([]);
  });
});

describe('the legacy standalone page adoption', () => {
  it('imports the old `tasks` array once, newest on top', () => {
    const legacyPayload = JSON.stringify([
      { id: 'a', text: 'First ever', completed: false, dueDate: '', reminderAt: '' },
      {
        id: 'b',
        text: 'Second',
        completed: true,
        reminderAt: iso(2025, 3, 9, 9, 0),
        reminderNotifiedAt: iso(2025, 3, 9, 9, 0),
      },
    ]);
    const { store } = harness({ legacy: legacyPayload });
    expect(store.tasks.map((t) => t.title)).toEqual(['First ever', 'Second']);
    // The stamp carries: the old page already fired that reminder.
    expect(store.taskById('b')?.reminderNotifiedAt).toBe(iso(2025, 3, 9, 9, 0));
    // And the import is recorded so it never runs again.
    expect(store.legacyImported).toBe(true);
  });

  it('never runs when padify-tasks already exists', () => {
    const { store } = harness({
      legacy: JSON.stringify([{ id: 'a', text: 'Old' }]),
      padify: JSON.stringify({ tasks: [task({ id: 'new', title: 'Mine' })], legacyImported: true }),
    });
    expect(store.tasks.map((t) => t.id)).toEqual(['new']);
  });

  it('ignores unreadable legacy payloads entirely', () => {
    const { store } = harness({ legacy: '}{' });
    expect(store.tasks).toEqual([]);
    // The failed adoption still counts as done — no re-reads.
    expect(store.legacyImported).toBe(true);
  });
});

describe('task CRUD + ordering', () => {
  it('addTask prepends (newest on top) and defaults to the view list', () => {
    const { store } = harness();
    store.addTask({ title: 'one' });
    store.addTask({ title: 'two' });
    expect(store.tasks.map((t) => t.title)).toEqual(['two', 'one']);
    expect(store.tasks.every((t) => t.listId === INBOX_LIST_ID)).toBe(true);
  });

  it('addTask in a list view files into that list', () => {
    const { store } = harness();
    const list = store.addList('Shopping');
    store.view = `list:${list.id}`;
    store.addTask({ title: 'Milk' });
    expect(store.tasks[0]?.listId).toBe(list.id);
  });

  it("empty and whitespace titles are the caller's problem — store trims only", () => {
    const { store } = harness();
    store.addTask({ title: '  spaced  ' });
    expect(store.tasks[0]?.title).toBe('spaced');
  });

  it('toggleComplete stamps and clears completedAt', () => {
    const { store } = harness();
    const added = store.addTask({ title: 'x' });
    expect(store.toggleComplete(added.id)).toBe(true);
    expect(store.taskById(added.id)?.completedAt).not.toBe('');
    expect(store.toggleComplete(added.id)).toBe(false);
    expect(store.taskById(added.id)?.completedAt).toBe('');
  });

  it('editing the reminder re-arms it (notified stamp resets)', () => {
    const { store } = harness();
    const added = store.addTask({ title: 'x', reminderAt: iso(2025, 3, 12, 9, 0) });
    store.markReminderNotified(added);
    expect(store.taskById(added.id)?.reminderNotifiedAt).toBe(iso(2025, 3, 12, 9, 0));
    store.updateTask(added.id, { reminderAt: iso(2025, 3, 12, 15, 0) });
    expect(store.taskById(added.id)?.reminderNotifiedAt).toBe('');
  });

  it('moveTaskBefore reorders within a list and refuses cross-list jumps', () => {
    const { store } = harness();
    const list = store.addList('L');
    const a = store.addTask({ title: 'a', listId: list.id });
    const b = store.addTask({ title: 'b', listId: list.id });
    const c = store.addTask({ title: 'c', listId: list.id });
    store.moveTaskBefore(a.id, c.id); // a moves above c: c, b, a → a, c, b
    const order = store.tasks
      .filter((t) => t.listId === list.id)
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map((t) => t.title);
    expect(order).toEqual(['a', 'c', 'b']);
    // The other-list task stays put.
    const stray = store.addTask({ title: 'stray' });
    store.moveTaskBefore(stray.id, b.id);
    expect(store.taskById(stray.id)?.listId).toBe(INBOX_LIST_ID);
  });

  it('deleteList re-homes orphans and falls back to All', () => {
    const { store } = harness();
    const list = store.addList('Doomed');
    store.addTask({ title: 'kept', listId: list.id });
    store.view = `list:${list.id}`;
    store.deleteList(list.id);
    expect(store.view).toBe('all');
    expect(store.tasks[0]?.listId).toBe(INBOX_LIST_ID);
  });
});

describe('smart counts', () => {
  it('today = due today + overdue + reminders today; scheduled = anything dated', () => {
    const { store } = harness();
    store.addTask({ title: 'past due', dueDate: iso(2025, 3, 10) });
    store.addTask({ title: 'due today', dueDate: iso(2025, 3, 12, 17, 0) });
    store.addTask({ title: 'reminds today', reminderAt: iso(2025, 3, 12, 18, 0) });
    store.addTask({ title: 'tomorrow', dueDate: iso(2025, 3, 13) });
    store.addTask({ title: 'free-floating' });
    const doneToday = store.addTask({ title: 'done today', dueDate: iso(2025, 3, 12) });
    store.updateTask(doneToday.id, { completed: true, completedAt: iso(2025, 3, 12, 10, 0) });
    const counts = store.smartCounts(NOW);
    expect(counts.today).toBe(3);
    expect(counts.scheduled).toBe(4);
    expect(counts.all).toBe(5);
    expect(counts.completed).toBe(1);
  });
});

describe('the views', () => {
  it('today sections: overdue (danger) first, then today', () => {
    const { store } = harness();
    store.addTask({ title: 'overdue', dueDate: iso(2025, 3, 10) });
    store.addTask({ title: 'today', dueDate: iso(2025, 3, 12) });
    store.addTask({ title: 'later', dueDate: iso(2025, 3, 20) });
    const { sections } = store.sectionsFor('today', NOW);
    expect(sections.map((s) => s.title)).toEqual(['Overdue', 'Today']);
    expect(sections[0].tone).toBe('danger');
    expect(sections[0].tasks.map((t) => t.title)).toEqual(['overdue']);
  });

  it('scheduled buckets by day and keeps completed separate', () => {
    const { store } = harness();
    store.addTask({ title: 'old', dueDate: iso(2025, 3, 9) });
    store.addTask({ title: 'now', dueDate: iso(2025, 3, 12, 9, 0) });
    store.addTask({ title: 'next', dueDate: iso(2025, 3, 13) });
    store.addTask({ title: 'friday', dueDate: iso(2025, 3, 14) });
    store.addTask({ title: 'far', dueDate: iso(2025, 4, 2) });
    const { sections } = store.sectionsFor('scheduled', NOW);
    expect(sections.map((s) => s.title)).toEqual([
      'Overdue',
      'Today',
      'Tomorrow',
      'Friday',
      'Later',
    ]);
  });

  it('all groups by list, inbox last under its own heading', () => {
    const { store } = harness();
    const shopping = store.addList('Shopping');
    store.addTask({ title: 'milk', listId: shopping.id });
    store.addTask({ title: 'note to self' });
    const { sections } = store.sectionsFor('all', NOW);
    expect(sections.map((s) => s.title)).toEqual(['Shopping', 'Reminders']);
  });

  it('flagged shows flagged only; completed groups by day, newest first', () => {
    const { store } = harness();
    store.addTask({ title: 'flagged', flagged: true });
    store.addTask({ title: 'plain' });
    expect(store.sectionsFor('flagged', NOW).sections[0]?.tasks).toHaveLength(1);

    const yesterday = store.addTask({ title: 'yesterday' });
    store.updateTask(yesterday.id, { completed: true, completedAt: iso(2025, 3, 11, 9, 0) });
    const today = store.addTask({ title: 'today' });
    store.updateTask(today.id, { completed: true, completedAt: iso(2025, 3, 12, 9, 0) });
    const { sections, completed } = store.sectionsFor('completed', NOW);
    expect(completed).toEqual([]);
    expect(sections.map((s) => [s.title, ...s.tasks.map((t) => t.title)])).toEqual([
      ['Today', 'today'],
      ['Yesterday', 'yesterday'],
    ]);
  });

  it('list views scope to the list and keep their done for the trailer', () => {
    const { store } = harness();
    const work = store.addList('Work');
    store.addTask({ title: 'todo', listId: work.id });
    const done = store.addTask({ title: 'did', listId: work.id });
    store.toggleComplete(done.id);
    store.addTask({ title: 'other list' });
    const { sections, completed } = store.sectionsFor(`list:${work.id}`, NOW);
    expect(sections[0]?.tasks.map((t) => t.title)).toEqual(['todo']);
    expect(completed.map((t) => t.title)).toEqual(['did']);
  });

  it("today's completed trailer: checked off today, whatever the due date", () => {
    const { store } = harness();
    const dd = store.addTask({ title: 'dd', dueDate: iso(2025, 3, 12) });
    store.updateTask(dd.id, { completed: true, completedAt: iso(2025, 3, 12, 10, 0) });
    const overdueDoneYesterday = store.addTask({ title: 'old', dueDate: iso(2025, 3, 4) });
    store.updateTask(overdueDoneYesterday.id, {
      completed: true,
      completedAt: iso(2025, 3, 11, 9, 0),
    });
    const { completed } = store.sectionsFor('today', NOW);
    expect(completed.map((t) => t.title)).toEqual(['dd']);
  });
});

describe('viewClearedBy — the confetti condition', () => {
  it('fires when the check empties the view, trailer or not', () => {
    const { store } = harness();
    const first = store.addTask({ title: 'only', dueDate: iso(2025, 3, 12) });
    store.toggleComplete(first.id);
    expect(store.viewClearedBy(first.id, NOW)).toBe(true);

    const second = store.addTask({ title: 'another', dueDate: iso(2025, 3, 12) });
    const third = store.addTask({ title: 'and another', dueDate: iso(2025, 3, 12) });
    store.toggleComplete(second.id);
    expect(store.viewClearedBy(second.id, NOW)).toBe(false);
    store.toggleComplete(third.id);
    expect(store.viewClearedBy(third.id, NOW)).toBe(true); // history below, view still cleared
  });

  it('never fires for uncompleting or in the completed view', () => {
    const { store } = harness();
    const t = store.addTask({ title: 'x' });
    store.toggleComplete(t.id);
    store.view = 'completed';
    expect(store.viewClearedBy(t.id, NOW)).toBe(false);
    store.view = 'today';
    store.toggleComplete(t.id); // back to active
    expect(store.viewClearedBy(t.id, NOW)).toBe(false);
  });
});

describe('search', () => {
  it('matches title and notes, case-insensitive, grouped by list', () => {
    const { store } = harness();
    const list = store.addList('Projects');
    store.addTask({ title: 'Buy oat milk', listId: list.id });
    store.addTask({ title: 'Water plants', notes: 'the fern especially' });
    store.addTask({ title: 'Unrelated' });
    const hit = store.search('OAT');
    expect(hit.sections).toHaveLength(1);
    expect(hit.sections[0]?.title).toBe('Projects');
    const fern = store.search('fern');
    expect(fern.sections[0]?.tasks[0]?.title).toBe('Water plants');
    expect(store.search('zzz').sections).toEqual([]);
  });
});

describe('the reminder sweep candidates', () => {
  it('pendingReminders: active, due, unnotified — each exactly once', () => {
    const { store } = harness();
    const due = store.addTask({ title: 'due', reminderAt: iso(2025, 3, 12, 9, 0) });
    store.addTask({ title: 'future', reminderAt: iso(2025, 3, 13, 9, 0) });
    const done = store.addTask({ title: 'done', reminderAt: iso(2025, 3, 12, 8, 0) });
    store.toggleComplete(done.id);
    const notified = store.addTask({ title: 'already', reminderAt: iso(2025, 3, 12, 7, 0) });
    store.markReminderNotified(notified);

    let pending = store.pendingReminders(NOW);
    expect(pending.map((t) => t.id)).toEqual([due.id]);

    store.markReminderNotified(due);
    pending = store.pendingReminders(NOW);
    expect(pending).toEqual([]);
  });
});

describe('persistence shape', () => {
  it('writes lists, tasks, view and the legacy flag under one key', () => {
    const { store, written } = harness();
    const list = store.addList('Work');
    store.addTask({
      title: 'task',
      listId: list.id,
      dueDate: iso(2025, 3, 12, 17, 0),
      priority: 'medium',
    });
    store.view = `list:${list.id}` as ViewId;
    store.persist();
    const raw = written.get(STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as { lists: TaskList[]; tasks: Task[]; view: ViewId };
    expect(parsed.lists[0]?.name).toBe('Work');
    expect(parsed.tasks[0]?.priority).toBe('medium');
    expect(parsed.view).toBe(`list:${list.id}`);
  });
});
