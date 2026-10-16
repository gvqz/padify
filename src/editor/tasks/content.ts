/**
 * Task list notes — the content model for noteType 'tasks'.
 *
 * A task list IS a note: the note's name is the list's name, and its
 * content is this module's JSON shape. The type rides the note-type
 * registry as contentKind 'json' (editor/note-types.ts), so storage,
 * sync, snapshots and share treat it as an opaque structured string —
 * and the tasks surface (editor/tasks/surface.ts) is the only thing
 * that interprets it.
 *
 * Everything here is shape + parse + serialize — no DOM, no storage,
 * no TabManager. The aggregation across notes lives in features/tasks
 * (aggregate.ts); this module is what both sides share.
 *
 * Robustness contract (same as the retired modal's store): every field
 * falls back when missing or wrong-typed, so a corrupted or hostile
 * payload can never wedge the note — it parses to the biggest honest
 * subset. A note whose content is empty ('') or unparseable reads as a
 * fresh empty list; the bytes stay untouched in the model until the
 * surface next writes.
 */

import { formatDueChip, parseWhen } from './dates';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

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

/** The note type id this model belongs to (editor/note-types registry). */
export const TASK_NOTE_TYPE = 'tasks';

/** The list palette — colored circles, deliberately quiet. */
export const LIST_COLORS = ['blue', 'red', 'orange', 'green', 'purple', 'teal'] as const;

export type ListColor = (typeof LIST_COLORS)[number];

/**
 * One task. ISO strings ('' = unset) — the same shape the modal-era store
 * used minus `listId`: the owning NOTE is the list now, so the field that
 * said which list a task belonged to is the tab it lives in.
 */
export interface Task {
  id: string;
  title: string;
  /** Free-form detail line under the title. */
  notes: string;
  completed: boolean;
  /** ISO timestamp of completion ('' while active). */
  completedAt: string;
  /** ISO datetime or ''. Due dates without time are midnight-less dates. */
  dueDate: string;
  /** ISO datetime or '' — when the reminder sweep should speak up. */
  reminderAt: string;
  /**
   * The reminderAt value last notified (stamp-and-compare: a reminder
   * fires once per reminderAt, and editing the time re-arms it — see
   * features/tasks/reminders.ts).
   */
  reminderNotifiedAt: string;
  flagged: boolean;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
  /** Manual order within the list — smaller floats to the top. */
  sortOrder: number;
}

/** The persisted shape inside the note's content string. */
export interface TaskNoteContent {
  version: 1;
  /** The list's circle color (rail dots, checkboxes, row accents). */
  color: ListColor;
  tasks: Task[];
}

export const TASK_NOTE_CONTENT_VERSION = 1;

/** What a fresh task is made of — addTask fills the rest. */
export interface TaskDraft {
  title: string;
  notes?: string;
  dueDate?: string;
  reminderAt?: string;
  flagged?: boolean;
  priority?: Priority;
}

// ---------------------------------------------------------------------------
// Sanitization — every field falls back when missing or wrong-typed
// ---------------------------------------------------------------------------

const MAX_TITLE = 600;
const MAX_NOTES = 4000;
/** Cap the collection so a runaway loop can never wedge the note. */
export const MAX_TASKS = 2000;

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

export function sanitizeColor(value: unknown): ListColor {
  return LIST_COLORS.includes(value as ListColor) ? (value as ListColor) : 'blue';
}

/** A stored task becomes an honest task, or nothing. */
export function sanitizeTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object' || typeof (value as Task).id !== 'string') {
    return null;
  }
  const raw = value as Partial<Task> & { id: string };
  const nowIso = new Date().toISOString();
  const completed = Boolean(raw.completed);
  return {
    id: raw.id,
    title: sanitizeText(raw.title, MAX_TITLE),
    notes: sanitizeText(raw.notes, MAX_NOTES),
    completed,
    completedAt: completed ? sanitizeIso(raw.completedAt) || nowIso : '',
    dueDate: sanitizeIso(raw.dueDate),
    reminderAt: sanitizeIso(raw.reminderAt),
    reminderNotifiedAt: sanitizeIso(raw.reminderNotifiedAt),
    flagged: Boolean(raw.flagged),
    priority: sanitizePriority(raw.priority),
    createdAt: sanitizeIso(raw.createdAt) || nowIso,
    updatedAt: sanitizeIso(raw.updatedAt) || nowIso,
    sortOrder: Number.isFinite(raw.sortOrder) ? (raw.sortOrder as number) : 0,
  };
}

/** New ids — crypto first, the clock-and-random ladder second. */
export function newTaskId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Parse + serialize
// ---------------------------------------------------------------------------

/** A fresh list's content (the color the caller chose, tasks empty). */
export function emptyTaskNoteContent(color: ListColor = 'blue'): TaskNoteContent {
  return { version: TASK_NOTE_CONTENT_VERSION, color, tasks: [] };
}

/**
 * Reads a note's content string into the model. Empty, unparseable or
 * hostile content parses as a fresh empty list — never throws, so a
 * damaged note still opens (and still syncs its bytes untouched until
 * the surface writes over them).
 */
export function parseTaskNoteContent(content: string): TaskNoteContent {
  if (!content.trim()) {
    return emptyTaskNoteContent();
  }
  try {
    const parsed = JSON.parse(content) as Partial<TaskNoteContent> | null;
    if (!parsed || typeof parsed !== 'object') {
      return emptyTaskNoteContent();
    }
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map(sanitizeTask)
      .filter((task): task is Task => task !== null && task.title.length > 0)
      .slice(0, MAX_TASKS)
      // Manual order is authoritative: a sync that shuffled the array
      // still renders in the order the user chose.
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      version: TASK_NOTE_CONTENT_VERSION,
      color: sanitizeColor(parsed.color),
      tasks,
    };
  } catch {
    return emptyTaskNoteContent();
  }
}

/** The model back to the note's content string (stable key order). */
export function serializeTaskNoteContent(data: TaskNoteContent): string {
  return JSON.stringify({
    version: TASK_NOTE_CONTENT_VERSION,
    color: data.color,
    tasks: data.tasks,
  });
}

/**
 * True when the note carries nothing worth sharing or counting: no
 * tasks at all. The share-empty gate consults this so a bare list shell
 * (JSON bytes, zero reminders) is not a "share of nothing" wearing
 * braces.
 */
export function taskNoteContentIsEmpty(content: string): boolean {
  return parseTaskNoteContent(content).tasks.length === 0;
}

// ---------------------------------------------------------------------------
// Projections + builders
// ---------------------------------------------------------------------------

/**
 * The plain-text projection — what the word pill, statistics, the close
 * prompt and every text export read. A GitHub-style checklist with the
 * date chips in prose: words the reader can count, not JSON braces.
 */
export function taskNotePlainText(data: TaskNoteContent, now: Date = new Date()): string {
  const lines: string[] = [];
  for (const task of data.tasks) {
    const mark = task.completed ? 'x' : ' ';
    let line = `- [${mark}] ${task.title}`;
    if (task.dueDate) {
      line += ` — due ${formatDueChip(task.dueDate, now)}`;
    }
    lines.push(line);
    if (task.notes) {
      for (const note of task.notes.split('\n')) {
        lines.push(`  ${note}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Builds a Task in place — the CRUD half every caller (the surface's
 * composer, the hub's composer, the sweep) shares. The caller owns
 * persistence. Lands at the TOP of its list (Apple's newest-first):
 * pass the current minimum sortOrder.
 */
export function buildTask(draft: TaskDraft, minSortOrder: number): Task {
  const nowIso = new Date().toISOString();
  return {
    id: newTaskId(),
    title: sanitizeText(draft.title, MAX_TITLE).trim(),
    notes: sanitizeText(draft.notes ?? '', MAX_NOTES),
    completed: false,
    completedAt: '',
    dueDate: sanitizeIso(draft.dueDate ?? ''),
    reminderAt: sanitizeIso(draft.reminderAt ?? ''),
    reminderNotifiedAt: '',
    flagged: Boolean(draft.flagged),
    priority: sanitizePriority(draft.priority ?? 'none'),
    createdAt: nowIso,
    updatedAt: nowIso,
    sortOrder: minSortOrder - 1,
  };
}

/** Fresh list colors cycle through the palette so new lists differ visibly. */
export function nextListColor(existing: ListColor[]): ListColor {
  const used = new Set(existing);
  for (const color of LIST_COLORS) {
    if (!used.has(color)) return color;
  }
  return 'blue';
}
