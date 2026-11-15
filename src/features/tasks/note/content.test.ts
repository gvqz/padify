/**
 * content.ts — the task note model, pinned.
 *
 * The note's JSON is the store now, so the parse/serialize round-trip
 * and every fallback carry the weight the modal-era store tests used to:
 * a corrupted or hostile payload parses to the biggest honest subset,
 * and the share gate reads "no tasks" as empty, not "has bytes".
 */

import { describe, expect, it } from 'vitest';
import {
  buildTask,
  emptyTaskNoteContent,
  nextListColor,
  parseTaskNoteContent,
  serializeTaskNoteContent,
  taskNoteContentIsEmpty,
  taskNotePlainText,
  type Task,
} from './content';

const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Buy milk',
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

describe('parseTaskNoteContent', () => {
  it('an empty note is a fresh empty list', () => {
    const model = parseTaskNoteContent('');
    expect(model.tasks).toEqual([]);
    expect(model.color).toBe('blue');
  });

  it('unparseable content degrades to an empty list, never throws', () => {
    expect(parseTaskNoteContent('{nope').tasks).toEqual([]);
    expect(parseTaskNoteContent('null').tasks).toEqual([]);
    expect(parseTaskNoteContent('42').tasks).toEqual([]);
  });

  it('round-trips through serialize with stable shape', () => {
    const model = {
      version: 1 as const,
      color: 'teal' as const,
      tasks: [
        task({ dueDate: iso(2025, 3, 12) }),
        task({ id: 't2', title: 'Second', sortOrder: 1 }),
      ],
    };
    const again = parseTaskNoteContent(serializeTaskNoteContent(model));
    expect(again.color).toBe('teal');
    expect(again.tasks.map((entry) => entry.id)).toEqual(['t1', 't2']);
    expect(again.tasks[0]!.dueDate).toBe(iso(2025, 3, 12));
  });

  it('drops junk fields and keeps honest ones (hostile payload)', () => {
    const model = parseTaskNoteContent(
      JSON.stringify({
        version: 1,
        color: 'not-a-color',
        tasks: [
          { id: 'ok', title: 'Real', bogus: '<script>' },
          { id: 'no-title' },
          'a string',
          null,
        ],
      }),
    );
    expect(model.color).toBe('blue');
    expect(model.tasks.map((entry) => entry.id)).toEqual(['ok']);
    expect((model.tasks[0] as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('manual order wins over array order', () => {
    const model = parseTaskNoteContent(
      JSON.stringify({
        version: 1,
        color: 'blue',
        tasks: [task({ id: 'late', sortOrder: 5 }), task({ id: 'early', sortOrder: -2 })],
      }),
    );
    expect(model.tasks.map((entry) => entry.id)).toEqual(['early', 'late']);
  });

  it('a bogus date field is emptied, not trusted', () => {
    const model = parseTaskNoteContent(
      JSON.stringify({
        version: 1,
        color: 'blue',
        tasks: [task({ dueDate: 'not-a-date', reminderAt: 'yesterday-ish' })],
      }),
    );
    expect(model.tasks[0]!.dueDate).toBe('');
    expect(model.tasks[0]!.reminderAt).toBe('');
  });
});

describe('the empty gate + projections', () => {
  it('an empty list is "empty" for sharing even though its bytes are JSON', () => {
    expect(taskNoteContentIsEmpty(serializeTaskNoteContent(emptyTaskNoteContent()))).toBe(true);
    expect(taskNoteContentIsEmpty('')).toBe(true);
    expect(taskNoteContentIsEmpty('{broken')).toBe(true);
  });

  it('a list with tasks is not empty', () => {
    const model = { version: 1 as const, color: 'blue' as const, tasks: [task()] };
    expect(taskNoteContentIsEmpty(serializeTaskNoteContent(model))).toBe(false);
  });

  it('the plain-text projection reads like a checklist', () => {
    const model = {
      version: 1 as const,
      color: 'blue' as const,
      tasks: [
        task({ title: 'Buy milk', dueDate: iso(2025, 3, 12, 17, 0) }),
        task({
          id: 't2',
          title: 'Call dentist',
          notes: 'first thing',
          completed: true,
          completedAt: iso(2025, 3, 11),
        }),
      ],
    };
    const text = taskNotePlainText(model, new Date(2025, 2, 12));
    expect(text).toContain('- [ ] Buy milk');
    expect(text).toContain('- [x] Call dentist');
    expect(text).toContain('  first thing');
    // The word count reads words, not braces.
    expect(text).not.toContain('{');
  });
});

describe('buildTask + colors', () => {
  it('lands at the top of its list (newest-first) with sane defaults', () => {
    const built = buildTask({ title: '  New  ', flagged: true, priority: 'high' }, 3);
    expect(built.title).toBe('New');
    expect(built.sortOrder).toBe(2);
    expect(built.flagged).toBe(true);
    expect(built.priority).toBe('high');
    expect(built.completed).toBe(false);
    expect(built.reminderNotifiedAt).toBe('');
  });

  it('an unknown priority falls back to none', () => {
    expect(buildTask({ title: 'x', priority: 'urgent' as never }, 0).priority).toBe('none');
  });

  it('new list colors cycle through the palette', () => {
    expect(nextListColor(['blue', 'red'])).toBe('orange');
    expect(nextListColor(['blue', 'red', 'orange', 'green', 'purple', 'teal'])).toBe('blue');
  });
});
