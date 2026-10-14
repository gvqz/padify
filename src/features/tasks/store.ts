/**
 * Reminders — the local task store.
 *
 * Owns persistence and every derived collection the content pane renders:
 * the smart views (Today / Scheduled / All / Flagged / Completed), the
 * per-list views, the sidebar counts and search. Deliberately the same
 * shape as the music player's LocalMusicLibrary: a plain class loaded
 * once, mutated through small methods, persisted through the storage
 * layer's stateGet/stateSet (IndexedDB with a localStorage mirror).
 *
 * Persistence (one key):
 *   padify-tasks  { lists, tasks, view } — sanitized on load so a
 *                corrupted or hostile payload can never brick the app.
 *
 * One-time courtesy: the retired standalone Tasks page (legacyfeatures/
 * tasks.md) kept its array under localStorage `tasks`; on the first load
 * with no padify-tasks, that array is imported (title mapping, default
 * list) and the flag `legacyImported` is stamped so it never runs twice.
 */

import { stateGet, stateSet } from '../../storage';
import {
  INBOX_LIST_ID,
  LIST_COLORS,
  PRIORITIES,
  SMART_VIEW_IDS,
  nextListColor,
  newListId,
  newTaskId,
  type ListColor,
  type Priority,
  type Task,
  type TaskList,
  type TaskSection,
  type TasksData,
  type ViewId,
} from './types';
import {
  daysAway,
  dueBucket,
  formatCompletedSection,
  isSameDay,
  isToday,
  parseWhen,
  startOfDay,
} from './dates';

export const STORAGE_KEY = 'padify-tasks';
/** The retired standalone page's key — imported once, never rewritten. */
const LEGACY_KEY = 'tasks';
/** Cap both collections so a runaway loop can never wedge storage. */
const MAX_TASKS = 2000;
const MAX_LISTS = 50;

// ---------------------------------------------------------------------------
// Sanitization — every field falls back when missing or wrong-typed
// ---------------------------------------------------------------------------

function sanitizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizeIso(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return parseWhen(value) === null ? '' : value;
}

function sanitizePriority(value: unknown): Priority {
  return PRIORITIES.includes(value as Priority) ? (value as Priority) : 'none';
}

function sanitizeColor(value: unknown): ListColor {
  return LIST_COLORS.includes(value as ListColor) ? (value as ListColor) : 'blue';
}

function isTaskShape(value: unknown): value is Partial<Task> & { id: string } {
  return Boolean(value) && typeof value === 'object' && typeof (value as Task).id === 'string';
}

function sanitizeTask(value: unknown): Task | null {
  if (!isTaskShape(value)) return null;
  const nowIso = new Date().toISOString();
  const completed = Boolean(value.completed);
  return {
    id: value.id,
    title: sanitizeText(value.title, 600),
    notes: sanitizeText(value.notes, 4000),
    listId: sanitizeText(value.listId, 100) || INBOX_LIST_ID,
    completed,
    completedAt: completed ? sanitizeIso(value.completedAt) || nowIso : '',
    dueDate: sanitizeIso(value.dueDate),
    reminderAt: sanitizeIso(value.reminderAt),
    reminderNotifiedAt: sanitizeIso(value.reminderNotifiedAt),
    flagged: Boolean(value.flagged),
    priority: sanitizePriority(value.priority),
    createdAt: sanitizeIso(value.createdAt) || nowIso,
    updatedAt: sanitizeIso(value.updatedAt) || nowIso,
    sortOrder: Number.isFinite(value.sortOrder) ? (value.sortOrder as number) : 0,
  };
}

function sanitizeList(value: unknown): TaskList | null {
  if (!value || typeof value !== 'object' || typeof (value as TaskList).id !== 'string') {
    return null;
  }
  const list = value as TaskList;
  return {
    id: list.id,
    name: sanitizeText(list.name, 80) || 'List',
    color: sanitizeColor(list.color),
    createdAt: sanitizeIso(list.createdAt) || new Date().toISOString(),
    sortOrder: Number.isFinite(list.sortOrder) ? list.sortOrder : 0,
  };
}

function sanitizeView(value: unknown): ViewId {
  if (typeof value === 'string' && (SMART_VIEW_IDS as string[]).includes(value)) {
    return value as ViewId;
  }
  if (typeof value === 'string' && value.startsWith('list:')) {
    return value as ViewId;
  }
  return 'today';
}

/** The retired page's task shape → ours (title becomes the title). */
function importLegacyTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object') return null;
  const legacy = value as Record<string, unknown>;
  if (typeof legacy.id !== 'string') return null;
  const nowIso = new Date().toISOString();
  const completed = Boolean(legacy.completed);
  return {
    id: legacy.id,
    title: sanitizeText(legacy.text, 600),
    notes: '',
    listId: INBOX_LIST_ID,
    completed,
    completedAt: completed ? sanitizeIso(legacy.completedAt) || nowIso : '',
    dueDate: sanitizeIso(legacy.dueDate),
    reminderAt: sanitizeIso(legacy.reminderAt),
    reminderNotifiedAt: sanitizeIso(legacy.reminderNotifiedAt),
    flagged: false,
    priority: 'none',
    createdAt: nowIso,
    updatedAt: nowIso,
    sortOrder: 0,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Storage accessors are injectable so unit tests run without IDB. */
export type StateReader = (key: string) => string | null;
export type StateWriter = (key: string, value: string) => void;

/** What a fresh task is made of — addTask fills the rest. */
export interface TaskDraft {
  title: string;
  notes?: string;
  listId?: string;
  dueDate?: string;
  reminderAt?: string;
  flagged?: boolean;
  priority?: Priority;
}

export class TaskStore {
  lists: TaskList[] = [];
  tasks: Task[] = [];
  view: ViewId = 'today';
  legacyImported = false;

  private readonly read: StateReader;
  private readonly write: StateWriter;
  private readonly readLegacy: StateReader;

  constructor(
    read: StateReader = stateGet,
    write: StateWriter = stateSet,
    readLegacy: StateReader = (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
  ) {
    this.read = read;
    this.write = write;
    this.readLegacy = readLegacy;
    this.load();
  }

  load(): void {
    try {
      const raw = this.read(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TasksData> & { legacyImported?: boolean };
        this.lists = (Array.isArray(parsed.lists) ? parsed.lists : [])
          .map(sanitizeList)
          .filter((list): list is TaskList => list !== null)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .slice(0, MAX_LISTS);
        this.tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
          .map(sanitizeTask)
          .filter((task): task is Task => task !== null && task.title.length > 0)
          .slice(0, MAX_TASKS);
        this.view = sanitizeView(parsed.view);
        this.legacyImported = Boolean(parsed.legacyImported);
        return;
      }
    } catch {
      /* corrupted JSON — fall through to a clean start */
    }
    this.lists = [];
    this.tasks = [];
    this.view = 'today';
    this.importLegacyOnce();
  }

  /** The retired standalone page's data, adopted on first sight only. */
  private importLegacyOnce(): void {
    if (this.legacyImported) return;
    this.legacyImported = true;
    try {
      const raw = this.readLegacy(LEGACY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const imported = parsed
        .map(importLegacyTask)
        .filter((task): task is Task => task !== null && task.title.length > 0)
        .slice(0, MAX_TASKS);
      if (imported.length === 0) return;
      // Newest-on-top, the old page's order.
      imported.forEach((task, index) => {
        task.sortOrder = -index;
      });
      this.tasks = imported;
      // Legacy reminders keep their fired stamps — do not re-notify history.
      this.persist();
    } catch {
      /* unreadable legacy payload — ignore it entirely */
    }
  }

  persist(): void {
    try {
      this.write(
        STORAGE_KEY,
        JSON.stringify({
          lists: this.lists,
          tasks: this.tasks,
          view: this.view,
          legacyImported: this.legacyImported,
        } satisfies TasksData & { legacyImported: boolean }),
      );
    } catch {
      /* storage unavailable — tasks live for this page only */
    }
  }

  // ---- lookups --------------------------------------------------------------

  listById(id: string): TaskList | null {
    return this.lists.find((list) => list.id === id) ?? null;
  }

  taskById(id: string): Task | null {
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  /** The list a view id refers to ('' for smart views). */
  listForView(view: ViewId): TaskList | null {
    return view.startsWith('list:') ? this.listById(view.slice(5)) : null;
  }

  activeTasks(): Task[] {
    return this.tasks.filter((task) => !task.completed);
  }

  // ---- task CRUD -------------------------------------------------------------

  /** Adds a task at the TOP of its list (Apple's newest-first) and returns it. */
  addTask(draft: TaskDraft): Task {
    const listId = draft.listId && this.listById(draft.listId) ? draft.listId : this.targetListId();
    const siblings = this.tasks.filter((task) => task.listId === listId);
    const minOrder = siblings.length > 0 ? Math.min(...siblings.map((t) => t.sortOrder)) : 0;
    const nowIso = new Date().toISOString();
    const task: Task = {
      id: newTaskId(),
      title: sanitizeText(draft.title, 600).trim(),
      notes: sanitizeText(draft.notes ?? '', 4000),
      listId,
      completed: false,
      completedAt: '',
      dueDate: sanitizeIso(draft.dueDate ?? ''),
      reminderAt: sanitizeIso(draft.reminderAt ?? ''),
      reminderNotifiedAt: '',
      flagged: Boolean(draft.flagged),
      priority: sanitizePriority(draft.priority ?? 'none'),
      createdAt: nowIso,
      updatedAt: nowIso,
      sortOrder: minOrder - 1,
    };
    this.tasks.unshift(task);
    if (this.tasks.length > MAX_TASKS) this.tasks.pop();
    this.persist();
    return task;
  }

  /** Patches a task (dates re-arm reminders when they change — controller passes through). */
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | null {
    const task = this.taskById(id);
    if (!task) return null;
    const reminderChanged = patch.reminderAt !== undefined && patch.reminderAt !== task.reminderAt;
    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();
    // Completing stamps (or honors an explicit completedAt — the legacy
    // import and tests need to backdate); uncompleting clears.
    if ('completed' in patch) {
      task.completedAt = patch.completedAt ?? (task.completed ? new Date().toISOString() : '');
    }
    if (reminderChanged) {
      task.reminderNotifiedAt = '';
    }
    this.persist();
    return task;
  }

  /** Flips completion; returns the new state (true = now done). */
  toggleComplete(id: string): boolean {
    const task = this.taskById(id);
    if (!task) return false;
    return this.updateTask(id, { completed: !task.completed })?.completed ?? false;
  }

  deleteTask(id: string): void {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index !== -1) {
      this.tasks.splice(index, 1);
      this.persist();
    }
  }

  /** Moves a task above another within the same list (drag reorder target). */
  moveTaskBefore(id: string, targetId: string): void {
    const task = this.taskById(id);
    const target = this.taskById(targetId);
    if (!task || !target || task.id === target.id || task.listId !== target.listId) return;
    const siblings = this.tasks
      .filter((t) => t.listId === task.listId && t.id !== task.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const insertAt = siblings.findIndex((t) => t.id === target.id);
    siblings.splice(insertAt === -1 ? siblings.length : insertAt, 0, task);
    siblings.forEach((t, index) => {
      t.sortOrder = index;
    });
    this.persist();
  }

  /** Moves a task to another list (or the default list for ''). */
  moveTaskToList(id: string, listId: string): void {
    const task = this.taskById(id);
    if (!task) return;
    const target = listId === INBOX_LIST_ID || this.listById(listId) ? listId : INBOX_LIST_ID;
    if (task.listId === target) return;
    task.listId = target;
    task.updatedAt = new Date().toISOString();
    this.persist();
  }

  // ---- list CRUD -------------------------------------------------------------

  /** Which list new tasks land in for the current view. */
  targetListId(): string {
    const list = this.listForView(this.view);
    return list ? list.id : INBOX_LIST_ID;
  }

  addList(name: string, color?: ListColor): TaskList {
    const trimmed = name.trim().slice(0, 80);
    const list: TaskList = {
      id: newListId(),
      name: trimmed || `List ${this.lists.length + 1}`,
      color: color ?? nextListColor(this.lists),
      createdAt: new Date().toISOString(),
      sortOrder: (this.lists.at(-1)?.sortOrder ?? 0) + 1,
    };
    this.lists.push(list);
    if (this.lists.length > MAX_LISTS) this.lists.shift();
    this.persist();
    return list;
  }

  renameList(id: string, name: string): void {
    const list = this.listById(id);
    if (!list) return;
    const trimmed = name.trim().slice(0, 80);
    if (trimmed) {
      list.name = trimmed;
      this.persist();
    }
  }

  deleteList(id: string): void {
    if (id === INBOX_LIST_ID) return;
    const index = this.lists.findIndex((list) => list.id === id);
    if (index === -1) return;
    this.lists.splice(index, 1);
    // Orphans fall home instead of vanishing.
    this.tasks.forEach((task) => {
      if (task.listId === id) task.listId = INBOX_LIST_ID;
    });
    if (this.view === (`list:${id}` as ViewId)) this.view = 'all';
    this.persist();
  }

  // ---- reminders engine support ----------------------------------------------

  /** Active tasks with a due reminder: candidates for the sweep. */
  pendingReminders(now: Date): Task[] {
    const nowMs = now.getTime();
    return this.tasks.filter(
      (task) =>
        !task.completed &&
        task.reminderAt !== '' &&
        task.reminderNotifiedAt !== task.reminderAt &&
        (parseWhen(task.reminderAt)?.getTime() ?? Infinity) <= nowMs,
    );
  }

  /** Stamps a reminder as notified without touching anything else. */
  markReminderNotified(task: Task): void {
    task.reminderNotifiedAt = task.reminderAt;
    this.persist();
  }

  // ---- view computation --------------------------------------------------------

  /** The sidebar badge counts (Today / Scheduled / All / Flagged / Completed). */
  smartCounts(now: Date): Record<'today' | 'scheduled' | 'all' | 'flagged' | 'completed', number> {
    let today = 0;
    let scheduled = 0;
    let flagged = 0;
    for (const task of this.tasks) {
      if (task.completed) continue;
      if (
        task.reminderAt !== '' &&
        (parseWhen(task.reminderAt)?.getTime() ?? Infinity) < endOfToday(now)
      ) {
        today += 1;
      } else if (task.dueDate !== '' && daysAway(task.dueDate, now) <= 0) {
        today += 1;
      }
      if (task.dueDate !== '' || task.reminderAt !== '') scheduled += 1;
      if (task.flagged) flagged += 1;
    }
    return {
      today,
      scheduled,
      all: this.activeTasks().length,
      flagged,
      completed: this.tasks.filter((task) => task.completed).length,
    };
  }

  /** Per-list badge counts. */
  listCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const task of this.tasks) {
      if (task.completed) continue;
      counts.set(task.listId, (counts.get(task.listId) ?? 0) + 1);
    }
    return counts;
  }

  /** A task belongs in the Today view when it is due today, overdue, or reminds today. */
  private isTodayTask(task: Task, now: Date): boolean {
    if (task.dueDate !== '' && daysAway(task.dueDate, now) <= 0) return true;
    if (task.reminderAt !== '') {
      const remind = parseWhen(task.reminderAt);
      if (remind !== null && remind.getTime() < endOfToday(now)) return true;
    }
    return false;
  }

  /**
   * The sections for the ACTIVE tasks of a view, in display order.
   * Completed tasks matching the view are returned separately so the
   * controller can render its collapsed "N Completed" row.
   */
  sectionsFor(view: ViewId, now: Date): { sections: TaskSection[]; completed: Task[] } {
    const active = this.activeTasks();
    switch (view) {
      case 'today': {
        const inView = active.filter((task) => this.isTodayTask(task, now));
        const overdue = inView.filter(
          (task) => task.dueDate !== '' && daysAway(task.dueDate, now) < 0,
        );
        const today = inView.filter((task) => !overdue.includes(task));
        const sections: TaskSection[] = [];
        if (overdue.length > 0) {
          sections.push({ title: 'Overdue', tone: 'danger', tasks: byDueDate(overdue) });
        }
        if (today.length > 0) {
          sections.push({ title: 'Today', tone: 'default', tasks: byListOrder(today) });
        }
        return { sections, completed: this.todayCompleted(now) };
      }
      case 'scheduled': {
        const dated = active.filter((task) => task.dueDate !== '' || task.reminderAt !== '');
        return { sections: scheduledSections(dated, now), completed: this.scheduledCompleted(now) };
      }
      case 'all': {
        const perList = this.lists
          .map((list) => ({
            list,
            tasks: byListOrder(active.filter((task) => task.listId === list.id)),
          }))
          .filter((section) => section.tasks.length > 0);
        const inbox = byListOrder(active.filter((task) => !this.listById(task.listId)));
        const out: TaskSection[] = perList.map((section) => ({
          title: section.list.name,
          tone: 'default',
          tasks: section.tasks,
        }));
        if (inbox.length > 0) {
          out.push({ title: 'Reminders', tone: 'default', tasks: inbox });
        }
        return { sections: out, completed: this.completedTasks() };
      }
      case 'flagged': {
        const flagged = byListOrder(active.filter((task) => task.flagged));
        return {
          sections:
            flagged.length > 0 ? [{ title: 'Flagged', tone: 'default', tasks: flagged }] : [],
          completed: this.tasks.filter((task) => task.completed && task.flagged),
        };
      }
      case 'completed': {
        const done = this.completedTasks();
        const sections: TaskSection[] = [];
        for (const task of done) {
          const title = formatCompletedSection(task.completedAt, now);
          const last = sections.at(-1);
          if (last && last.title === title) {
            last.tasks.push(task);
          } else {
            sections.push({ title, tone: 'default', tasks: [task] });
          }
        }
        return { sections, completed: [] };
      }
      default: {
        // list:<id>
        const listId = view.slice(5);
        const list = this.listById(listId);
        const tasks = byListOrder(active.filter((task) => task.listId === listId));
        const sections: TaskSection[] =
          tasks.length > 0 ? [{ title: list?.name ?? 'List', tone: 'default', tasks }] : [];
        const done = this.tasks
          .filter((task) => task.completed && task.listId === listId)
          .sort((a, b) => (b.completedAt < a.completedAt ? -1 : 1));
        return { sections, completed: done };
      }
    }
  }

  /**
   * Completed tasks that belong in the Today view — what Apple shows at its
   * bottom: everything checked off today (overdue or not). Yesterday's
   * completed leave with the day; the due date plays no part once the
   * circle is filled.
   */
  private todayCompleted(now: Date): Task[] {
    return this.completedTasks().filter(
      (task) => task.completedAt !== '' && isToday(task.completedAt, now),
    );
  }

  /** Completed tasks with any date/reminder — the Scheduled view's trailer. */
  private scheduledCompleted(now: Date): Task[] {
    return this.completedTasks().filter(
      (task) =>
        task.dueDate !== '' ||
        (task.reminderAt !== '' && !isSameDay(parseWhen(task.reminderAt) ?? now, now)) ||
        (task.completedAt !== '' && isToday(task.completedAt, now)),
    );
  }

  /** All completed, newest first — the Completed/All views' trailer. */
  private completedTasks(): Task[] {
    return this.tasks
      .filter((task) => task.completed)
      .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  }

  /**
   * True when checking off `taskId` emptied the visible view — the
   * confetti condition (the legacy page fired when the whole list was
   * done; here it is per-view, which is what the user actually sees).
   * The completed trailer does not count: history sitting below the last
   * active task should not mute the celebration.
   */
  viewClearedBy(taskId: string, now: Date): boolean {
    const task = this.taskById(taskId);
    if (!task || !task.completed) return false;
    if (this.view === 'completed') return false;
    const { sections } = this.sectionsFor(this.view, now);
    return sections.every((section) => section.tasks.length === 0);
  }

  /** Search: title + notes, case-insensitive; done tasks ride separately. */
  search(query: string): { sections: TaskSection[]; completed: Task[] } {
    const needle = query.trim().toLowerCase();
    if (!needle) return { sections: [], completed: [] };
    const match = (task: Task): boolean =>
      task.title.toLowerCase().includes(needle) || task.notes.toLowerCase().includes(needle);
    const sections: TaskSection[] = [];
    for (const list of this.lists) {
      const tasks = byListOrder(
        this.activeTasks().filter((task) => task.listId === list.id && match(task)),
      );
      if (tasks.length > 0) sections.push({ title: list.name, tone: 'default', tasks });
    }
    const inbox = byListOrder(
      this.activeTasks().filter((task) => !this.listById(task.listId) && match(task)),
    );
    if (inbox.length > 0) sections.push({ title: 'Reminders', tone: 'default', tasks: inbox });
    return { sections, completed: this.completedTasks().filter(match) };
  }
}

// ---------------------------------------------------------------------------
// Section-local sort helpers
// ---------------------------------------------------------------------------

function byListOrder(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);
}

function byDueDate(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const due = (task: Task): number => parseWhen(task.dueDate)?.getTime() ?? Infinity;
    return due(a) - due(b) || a.sortOrder - b.sortOrder;
  });
}

/** end of today, as a timestamp the Today filter can compare against. */
function endOfToday(now: Date): number {
  const day = startOfDay(now);
  day.setDate(day.getDate() + 1);
  return day.getTime();
}

/**
 * The Scheduled view's grouped sections: Overdue → Today → Tomorrow →
 * one section per coming weekday → Later. Groups by DUE date first
 * (reminder-only tasks fall back to their reminder time's day).
 */
function scheduledSections(tasks: Task[], now: Date): TaskSection[] {
  const groups = new Map<
    string,
    { sortKey: number; title: string; tone: 'default' | 'danger'; tasks: Task[] }
  >();
  for (const task of tasks) {
    const anchor = task.dueDate !== '' ? task.dueDate : task.reminderAt;
    if (anchor === '') continue;
    const bucket = dueBucket(anchor, now);
    const date = parseWhen(anchor)!;
    const day = startOfDay(date);
    let key: string;
    let title: string;
    let sortKey: number;
    switch (bucket) {
      case 'overdue':
        key = 'overdue';
        title = 'Overdue';
        sortKey = -1;
        break;
      case 'today':
        key = 'today';
        title = 'Today';
        sortKey = 0;
        break;
      case 'tomorrow':
        key = 'tomorrow';
        title = 'Tomorrow';
        sortKey = 1;
        break;
      case 'week': {
        key = `day:${day.getTime()}`;
        title = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
        sortKey = 2 + day.getTime() / 86_400_000;
        break;
      }
      case 'upcoming':
      default:
        key = 'later';
        title = 'Later';
        sortKey = 1e12;
        break;
    }
    let group = groups.get(key);
    if (!group) {
      group = { sortKey, title, tone: bucket === 'overdue' ? 'danger' : 'default', tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()]
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((group) => ({
      title: group.title,
      tone: group.tone,
      tasks: group.tasks.sort(
        (a, b) =>
          (parseWhen(a.dueDate || a.reminderAt)?.getTime() ?? 0) -
            (parseWhen(b.dueDate || b.reminderAt)?.getTime() ?? 0) || a.sortOrder - b.sortOrder,
      ),
    }));
}
