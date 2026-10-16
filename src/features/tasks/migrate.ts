/**
 * The one-time migration: the modal-era store becomes notes.
 *
 * The retired Reminders modal kept everything under one `padify-tasks`
 * key (which itself had adopted the retired standalone page's `tasks`
 * array). Notes are the store now, so on the first boot after the pivot:
 *
 *   • every old custom list becomes a task list note (name = list name,
 *     color = list color, tasks keep their dates/flags/priorities);
 *   • the old default ("Reminders") list's tasks become a note too;
 *   • a user who never touched the modal but still has the standalone
 *     page's `tasks` array in localStorage gets that adopted the same
 *     way (the old store's courtesy, carried forward);
 *   • `padify-tasks-notes-migrated` stamps the door — it never runs
 *     twice. The old keys stay untouched (a downgrade keeps working);
 *     new data only ever lives in notes.
 *
 * Runs after TabManager.init() (app.ts): notes append as background tabs
 * in list order — the strip the user already knows gains their lists.
 */

import { stateGet, stateSet } from '../../storage';
import { getTabManager } from '../../tabs';
import { serializeTaskNoteContent, type ListColor, type Task } from '../../editor/tasks/content';

const OLD_KEY = 'padify-tasks';
const OLD_LEGACY_KEY = 'tasks';
const MIGRATED_FLAG = 'padify-tasks-notes-migrated';

interface OldTaskList {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
}

interface OldTask {
  id: string;
  title?: string;
  text?: string;
  notes?: string;
  listId?: string;
  completed?: boolean;
  completedAt?: string;
  dueDate?: string;
  reminderAt?: string;
  reminderNotifiedAt?: string;
  flagged?: boolean;
  priority?: string;
  sortOrder?: number;
}

interface OldStore {
  lists?: OldTaskList[];
  tasks?: OldTask[];
}

/** True when there is anything at all worth migrating. */
export function hasLegacyTasksData(): boolean {
  if (stateGet(MIGRATED_FLAG) !== null) return false;
  const old = stateGet(OLD_KEY);
  if (old) {
    try {
      const parsed = JSON.parse(old) as OldStore;
      if ((parsed.lists?.length ?? 0) > 0 || (parsed.tasks?.length ?? 0) > 0) return true;
    } catch {
      /* unreadable — treat as absent */
    }
  }
  try {
    const legacy = localStorage.getItem(OLD_LEGACY_KEY);
    if (legacy && JSON.parse(legacy) instanceof Array) return true;
  } catch {
    /* no legacy page data */
  }
  return false;
}

/**
 * Runs the migration once. Returns how many notes were created (0 when
 * nothing to do). Idempotent by flag.
 */
export function migrateLegacyTasksToNotes(): number {
  if (stateGet(MIGRATED_FLAG) !== null) return 0;
  stateSet(MIGRATED_FLAG, JSON.stringify({ at: new Date().toISOString() }));

  const manager = getTabManager();
  if (!manager) return 0;

  // 1. The modal-era store, when it exists.
  let oldLists: OldTaskList[] = [];
  let oldTasks: OldTask[] = [];
  const raw = stateGet(OLD_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as OldStore;
      oldLists = Array.isArray(parsed.lists)
        ? parsed.lists.filter((list) => list && typeof list.id === 'string')
        : [];
      oldTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch {
      /* unreadable — fall through to the legacy page data */
    }
  }

  // 2. The retired standalone page's array (only when the modal store
  //    never existed — the modal had already adopted it otherwise).
  if (!raw) {
    try {
      const legacy = localStorage.getItem(OLD_LEGACY_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy) as unknown;
        if (Array.isArray(parsed)) oldTasks = parsed as OldTask[];
      }
    } catch {
      /* unreadable legacy payload — ignore it entirely */
    }
  }

  const usableTasks = oldTasks.filter(
    (task) => task && typeof task.id === 'string' && (task.title || task.text || '').trim() !== '',
  );
  if (oldLists.length === 0 && usableTasks.length === 0) {
    return 0;
  }

  const toTask = (old: OldTask): Task => ({
    id: old.id,
    title: (old.title ?? old.text ?? '').slice(0, 600),
    notes: (old.notes ?? '').slice(0, 4000),
    completed: Boolean(old.completed),
    completedAt: old.completed ? (old.completedAt ?? new Date().toISOString()) : '',
    dueDate: old.dueDate ?? '',
    reminderAt: old.reminderAt ?? '',
    reminderNotifiedAt: old.reminderNotifiedAt ?? '',
    flagged: Boolean(old.flagged),
    priority:
      old.priority === 'low' || old.priority === 'medium' || old.priority === 'high'
        ? old.priority
        : 'none',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: Number.isFinite(old.sortOrder) ? (old.sortOrder as number) : 0,
  });

  const lists = [...oldLists].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const colorFor = (value: string | undefined): ListColor =>
    (['blue', 'red', 'orange', 'green', 'purple', 'teal'] as const).includes(value as ListColor)
      ? (value as ListColor)
      : 'blue';

  let created = 0;

  // The default list's tasks ride first (a note named Reminders), then
  // each custom list in the user's order.
  const inboxTasks = usableTasks
    .filter(
      (task) =>
        !task.listId || task.listId === 'inbox' || !lists.some((list) => list.id === task.listId),
    )
    .map(toTask);
  if (inboxTasks.length > 0) {
    manager.addBackgroundNote(
      'Reminders',
      'tasks',
      serializeTaskNoteContent({ version: 1, color: 'blue', tasks: inboxTasks }),
    );
    created += 1;
  }

  for (const list of lists) {
    const tasks = usableTasks.filter((task) => task.listId === list.id).map(toTask);
    const name = (list.name ?? '').trim().slice(0, 80) || `List ${created + 1}`;
    manager.addBackgroundNote(
      name,
      'tasks',
      serializeTaskNoteContent({ version: 1, color: colorFor(list.color), tasks }),
    );
    created += 1;
  }

  return created;
}
