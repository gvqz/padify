/**
 * Reminders — the data model.
 *
 * Tasks is the second feature rebuilt from the retired standalone pages
 * (see legacyfeatures/tasks.md for the reference): a local-first todo
 * manager with due dates, timed reminders, flags, priorities and custom
 * lists, laid out like Apple Reminders and themed like the music player.
 *
 * Everything here is shape + vocabulary — no DOM, no storage. The store
 * (store.ts) owns persistence, dates.ts owns the calendar math, the
 * controller (index.ts) owns the views.
 */

/** A task's priority — Apple's !, !!, !!! minus the shouting. */
export type Priority = 'none' | 'low' | 'medium' | 'high';

export const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high'];

/** How many ! marks each priority renders as (0 for none). */
export const PRIORITY_MARKS: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const PRIORITY_NEXT: Record<Priority, Priority> = {
  none: 'low',
  low: 'medium',
  medium: 'high',
  high: 'none',
};

/** The fixed smart views, in sidebar order. */
export type SmartViewId = 'today' | 'scheduled' | 'all' | 'flagged' | 'completed';

export const SMART_VIEW_IDS: SmartViewId[] = ['today', 'scheduled', 'all', 'flagged', 'completed'];

/** Every view the content pane can render (smart views + custom lists). */
export type ViewId = SmartViewId | `list:${string}`;

/** One task. ISO strings ('' = unset) keep the legacy page's shape honest. */
export interface Task {
  id: string;
  title: string;
  /** Free-form detail line under the title. */
  notes: string;
  /** Owning custom list (a TaskList id). */
  listId: string;
  completed: boolean;
  /** ISO timestamp of completion ('' while active). */
  completedAt: string;
  /** ISO datetime or ''. Due dates without time are midnight-less dates. */
  dueDate: string;
  /** ISO datetime or '' — when the reminder sweep should speak up. */
  reminderAt: string;
  /**
   * The reminderAt value last notified (stamp-and-compare, the legacy
   * page's once-per-time guard: a reminder fires once per reminderAt, and
   * editing the time re-arms it — see reminders.ts).
   */
  reminderNotifiedAt: string;
  flagged: boolean;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
  /** Manual order within its list — smaller floats to the top. */
  sortOrder: number;
}

/** A custom list — Apple's colored circles, kept deliberately quiet. */
export interface TaskList {
  id: string;
  name: string;
  /** A palette key resolved to a color in tasks.css (see LIST_COLORS). */
  color: ListColor;
  createdAt: string;
  sortOrder: number;
}

export const LIST_COLORS = ['blue', 'red', 'orange', 'green', 'purple', 'teal'] as const;

export type ListColor = (typeof LIST_COLORS)[number];

/** The persisted shape under the `padify-tasks` key. */
export interface TasksData {
  lists: TaskList[];
  tasks: Task[];
  /** The last view the user had open, restored on the next launch. */
  view: ViewId;
}

/** What the user is looking at, computed for the content pane. */
export interface TaskSection {
  /** Section heading ('Overdue', 'Today', list names…). Empty = untitled. */
  title: string;
  /** Heading tone — 'danger' tints it red like Apple's overdue header. */
  tone: 'default' | 'danger';
  tasks: Task[];
}

/** The default list every task lands in until it is moved. */
export const INBOX_LIST_ID = 'inbox';

export const DEFAULT_LIST_NAME = 'Reminders';

/** Fresh list names cycle through the palette so new lists differ visibly. */
export function nextListColor(existing: TaskList[]): ListColor {
  const used = new Set(existing.map((list) => list.color));
  // Every color already used? Start the rotation over from blue.
  for (const color of LIST_COLORS) {
    if (!used.has(color)) return color;
  }
  return 'blue';
}

/** New ids — the legacy page's fallback ladder, crypto first. */
export function newTaskId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newListId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
