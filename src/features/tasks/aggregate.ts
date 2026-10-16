/**
 * The tasks aggregate — every task note, indexed.
 *
 * The modal-era TaskStore kept ONE global payload; notes are the store
 * now, so this module reads every open 'tasks' note from the TabManager,
 * computes the cross-note views (Today / Scheduled / All / Flagged /
 * Completed / search — the right rail's destinations), and writes
 * through TabManager.writeNoteContent so a task edited in the hub lands
 * in its note (and a note open behind the hub repaints truthfully).
 *
 * Writes consult the surface's LIVE model first (editor/tasks/surface.ts
 * keeps the active note's model ahead of tab.content between saves), so
 * a hub edit never clobbers words still sitting in the page's debounce
 * window. Reads refresh on every persist, on the surface's mutation
 * signal, and on demand.
 */

import { getTabManager, type NoteTab } from '../../tabs';
import {
  buildTask,
  parseTaskNoteContent,
  serializeTaskNoteContent,
  type Task,
  type TaskDraft,
  type TaskNoteContent,
} from '../../editor/tasks/content';
import { liveTasksModelFor, refreshTasksPageForNote } from '../../editor/tasks/surface';
import type { ListRef } from '../../editor/tasks/rows';
import {
  daysAway,
  dueBucket,
  formatCompletedSection,
  isToday,
  parseWhen,
  startOfDay,
} from '../../editor/tasks/dates';

/** One task with its owning note's facts attached. */
export interface AggTask {
  task: Task;
  note: ListRef;
}

export type HubViewId = 'today' | 'scheduled' | 'all' | 'flagged' | 'completed';

export interface AggSection {
  title: string;
  tone: 'default' | 'danger';
  /** The heading's list color (the All view's per-note sections). */
  color?: string;
  rows: AggTask[];
}

interface TaskNoteEntry {
  tab: NoteTab;
  model: TaskNoteContent;
}

type ChangeListener = () => void;

const LAST_LIST_KEY = 'padify-tasks-last-list';

class TaskNotesAggregate {
  private entries: TaskNoteEntry[] = [];
  private readonly listeners = new Set<ChangeListener>();

  // ------------------------------------------------------------------
  // Refresh + notify
  // ------------------------------------------------------------------

  /** Re-reads every task note from the manager. Cheap (small notes). */
  refresh(): void {
    const manager = getTabManager();
    this.entries = manager
      ? manager.allTabs
          .filter((tab) => tab.noteType === 'tasks')
          .map((tab) => ({ tab, model: this.modelFor(tab) }))
      : [];
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refresh + tell the rail/hub the world moved. */
  refreshAndNotify(): void {
    this.refresh();
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** The task notes as rail/menu facts (order = the note strip's order). */
  lists(): ListRef[] {
    return this.entries.map((entry) => this.listRef(entry));
  }

  private listRef(entry: TaskNoteEntry): ListRef {
    return {
      id: entry.tab.id,
      name: entry.tab.name || 'Untitled list',
      color: entry.model.color,
    };
  }

  private modelFor(tab: NoteTab): TaskNoteContent {
    // The live page's model is ahead of tab.content between saves.
    return liveTasksModelFor(tab.id) ?? parseTaskNoteContent(tab.content);
  }

  taskById(taskId: string): AggTask | null {
    for (const entry of this.entries) {
      const task = entry.model.tasks.find((candidate) => candidate.id === taskId);
      if (task) return { task, note: this.listRef(entry) };
    }
    return null;
  }

  noteById(noteId: string): TaskNoteEntry | null {
    return this.entries.find((entry) => entry.tab.id === noteId) ?? null;
  }

  /** The note new hub tasks land in: the last-used list, or the first. */
  targetListId(): string | null {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_LIST_KEY);
    } catch {
      /* storage unavailable — the first list wins */
    }
    if (last && this.noteById(last)) return last;
    return this.entries[0]?.tab.id ?? null;
  }

  rememberTargetList(noteId: string): void {
    try {
      localStorage.setItem(LAST_LIST_KEY, noteId);
    } catch {
      /* preference only */
    }
  }

  /** The sidebar badge counts (Today / Scheduled / All / Flagged / Completed). */
  smartCounts(now: Date): Record<HubViewId, number> {
    let today = 0;
    let scheduled = 0;
    let flagged = 0;
    let all = 0;
    let completed = 0;
    for (const entry of this.entries) {
      for (const task of entry.model.tasks) {
        if (task.completed) {
          completed += 1;
          continue;
        }
        all += 1;
        if (
          (task.reminderAt !== '' &&
            (parseWhen(task.reminderAt)?.getTime() ?? Infinity) < endOfToday(now)) ||
          (task.dueDate !== '' && daysAway(task.dueDate, now) <= 0)
        ) {
          today += 1;
        }
        if (task.dueDate !== '' || task.reminderAt !== '') scheduled += 1;
        if (task.flagged) flagged += 1;
      }
    }
    return { today, scheduled, all, flagged, completed };
  }

  /** Per-note badge counts (the rail's My Lists group). */
  listCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      const active = entry.model.tasks.filter((task) => !task.completed).length;
      counts.set(entry.tab.id, active);
    }
    return counts;
  }

  /**
   * The sections for the ACTIVE tasks of a hub view, in display order.
   * Completed tasks matching the view come back separately for the
   * collapsed trailer.
   */
  sectionsFor(view: HubViewId, now: Date): { sections: AggSection[]; completed: AggTask[] } {
    const active: AggTask[] = [];
    const completed: AggTask[] = [];
    for (const entry of this.entries) {
      for (const task of entry.model.tasks) {
        const row: AggTask = { task, note: this.listRef(entry) };
        (task.completed ? completed : active).push(row);
      }
    }
    completed.sort((a, b) => (a.task.completedAt < b.task.completedAt ? 1 : -1));

    switch (view) {
      case 'today': {
        const inView = active.filter((row) => isTodayRow(row.task, now));
        const overdue = inView.filter(
          (row) => row.task.dueDate !== '' && daysAway(row.task.dueDate, now) < 0,
        );
        const todays = inView.filter((row) => !overdue.includes(row));
        const sections: AggSection[] = [];
        if (overdue.length > 0) {
          sections.push({ title: 'Overdue', tone: 'danger', rows: byDueDate(overdue) });
        }
        if (todays.length > 0) {
          sections.push({ title: 'Today', tone: 'default', rows: byListOrder(todays) });
        }
        return {
          sections,
          completed: completed.filter((row) => isToday(row.task.completedAt, now)),
        };
      }
      case 'scheduled': {
        const dated = active.filter((row) => row.task.dueDate !== '' || row.task.reminderAt !== '');
        return {
          sections: scheduledSections(dated, now),
          completed: completed.filter(
            (row) => row.task.dueDate !== '' || row.task.reminderAt !== '',
          ),
        };
      }
      case 'all': {
        // One section per note, in strip order — Apple's All view groups
        // by list with the list's name as the heading.
        const sections: AggSection[] = [];
        for (const entry of this.entries) {
          const rows = byListOrder(active.filter((row) => row.note.id === entry.tab.id));
          if (rows.length > 0) {
            const ref = this.listRef(entry);
            sections.push({ title: ref.name, tone: 'default', color: ref.color, rows });
          }
        }
        return { sections, completed };
      }
      case 'flagged': {
        const flagged = byListOrder(active.filter((row) => row.task.flagged));
        return {
          sections:
            flagged.length > 0 ? [{ title: 'Flagged', tone: 'default', rows: flagged }] : [],
          completed: completed.filter((row) => row.task.flagged),
        };
      }
      case 'completed': {
        const sections: AggSection[] = [];
        for (const row of completed) {
          const title = formatCompletedSection(row.task.completedAt, now);
          const last = sections.at(-1);
          if (last && last.title === title) {
            last.rows.push(row);
          } else {
            sections.push({ title, tone: 'default', rows: [row] });
          }
        }
        return { sections, completed: [] };
      }
    }
  }

  /** Search: title + notes, case-insensitive; matches grouped per note. */
  search(query: string): { sections: AggSection[]; completed: AggTask[] } {
    const needle = query.trim().toLowerCase();
    if (!needle) return { sections: [], completed: [] };
    const match = (task: Task): boolean =>
      task.title.toLowerCase().includes(needle) || task.notes.toLowerCase().includes(needle);
    const sections: AggSection[] = [];
    let completed: AggTask[] = [];
    for (const entry of this.entries) {
      const ref = this.listRef(entry);
      const rows = byListOrder(
        entry.model.tasks
          .filter((task) => !task.completed && match(task))
          .map((task) => ({ task, note: ref })),
      );
      if (rows.length > 0) {
        sections.push({ title: ref.name, tone: 'default', color: ref.color, rows });
      }
      completed = completed.concat(
        entry.model.tasks
          .filter((task) => task.completed && match(task))
          .map((task) => ({ task, note: ref })),
      );
    }
    completed.sort((a, b) => (a.task.completedAt < b.task.completedAt ? 1 : -1));
    return { sections, completed };
  }

  // ------------------------------------------------------------------
  // The sweep's reads
  // ------------------------------------------------------------------

  /** Active tasks with a due reminder, tagged with their notes. */
  pendingReminders(now: Date): AggTask[] {
    const nowMs = now.getTime();
    const out: AggTask[] = [];
    for (const entry of this.entries) {
      for (const task of entry.model.tasks) {
        if (
          !task.completed &&
          task.reminderAt !== '' &&
          task.reminderNotifiedAt !== task.reminderAt &&
          (parseWhen(task.reminderAt)?.getTime() ?? Infinity) <= nowMs
        ) {
          out.push({ task, note: this.listRef(entry) });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Writes — every one lands in the note via writeNoteContent
  // ------------------------------------------------------------------

  /**
   * The write primitive: mutate a note's (live-aware) model, serialize,
   * write. The active note's page repaints through the surface; a
   * background note takes the bytes.
   */
  private withNote(noteId: string, fn: (model: TaskNoteContent) => boolean): boolean {
    const manager = getTabManager();
    if (!manager) return false;
    const tab = manager.allTabs.find((entry) => entry.id === noteId && entry.noteType === 'tasks');
    if (!tab) return false;
    const model = this.modelFor(tab);
    if (!fn(model)) return false;
    manager.writeNoteContent(noteId, serializeTaskNoteContent(model));
    this.refreshAndNotify();
    return true;
  }

  /** Adds a task to a note (the hub composer's quick-add). */
  addTaskToNote(noteId: string, draft: TaskDraft): Task | null {
    let added: Task | null = null;
    const ok = this.withNote(noteId, (model) => {
      const minOrder =
        model.tasks.length > 0 ? Math.min(...model.tasks.map((task) => task.sortOrder)) : 0;
      added = buildTask(draft, minOrder);
      model.tasks.unshift(added);
      return true;
    });
    return ok ? added : null;
  }

  /** Patches a task wherever it lives. */
  updateTask(taskId: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): boolean {
    return this.withNoteForTask(taskId, (model, task) => {
      const reminderChanged =
        patch.reminderAt !== undefined && patch.reminderAt !== task.reminderAt;
      Object.assign(task, patch);
      task.updatedAt = new Date().toISOString();
      if ('completed' in patch) {
        task.completedAt = patch.completedAt ? new Date().toISOString() : '';
      }
      if (reminderChanged) {
        task.reminderNotifiedAt = '';
      }
      return true;
    });
  }

  /** Flips completion. */
  toggleComplete(taskId: string): boolean {
    const found = this.taskById(taskId);
    if (!found) return false;
    return this.updateTask(taskId, { completed: !found.task.completed });
  }

  deleteTask(taskId: string): boolean {
    return this.withNoteForTask(taskId, (model, task) => {
      model.tasks = model.tasks.filter((entry) => entry.id !== task.id);
      return true;
    });
  }

  /** Moves a task between notes (removes from the source, adds to the target). */
  moveTask(taskId: string, targetNoteId: string): boolean {
    const found = this.taskById(taskId);
    if (!found || found.note.id === targetNoteId) return false;
    const task: Task = found.task;
    const removed = this.withNote(found.note.id, (model) => {
      model.tasks = model.tasks.filter((entry) => entry.id !== taskId);
      return true;
    });
    if (!removed) return false;
    return this.adoptTask(task, targetNoteId);
  }

  /** Drops a task object into a note (the surface's move chip — the page
   * already removed it from its own live model). */
  adoptTask(task: Task, targetNoteId: string): boolean {
    return this.withNote(targetNoteId, (model) => {
      const minOrder =
        model.tasks.length > 0 ? Math.min(...model.tasks.map((entry) => entry.sortOrder)) : 0;
      const moving = { ...task, sortOrder: minOrder - 1, updatedAt: new Date().toISOString() };
      model.tasks.unshift(moving);
      return true;
    });
  }

  /** Stamps a reminder as notified without touching anything else. */
  markReminderNotified(taskId: string): boolean {
    return this.withNoteForTask(taskId, (model, task) => {
      task.reminderNotifiedAt = task.reminderAt;
      return true;
    });
  }

  /** withNote, resolved through a task id first. */
  private withNoteForTask(
    taskId: string,
    fn: (model: TaskNoteContent, task: Task) => boolean,
  ): boolean {
    const found = this.taskById(taskId);
    if (!found) return false;
    const noteId = found.note.id;
    return this.withNote(noteId, (model) => {
      const task = model.tasks.find((entry) => entry.id === taskId);
      if (!task) return false;
      return fn(model, task);
    });
  }

  /** The repaint seam the surface exposes for external writers. */
  repaintNote(noteId: string, name?: string): void {
    const entry = this.noteById(noteId);
    if (entry) {
      refreshTasksPageForNote(noteId, serializeTaskNoteContent(entry.model), name);
    }
  }
}

// ---------------------------------------------------------------------------
// Section-local helpers (the modal-era store's, lifted)
// ---------------------------------------------------------------------------

function byListOrder(rows: AggTask[]): AggTask[] {
  return [...rows].sort((a, b) => a.task.sortOrder - b.task.sortOrder);
}

function byDueDate(rows: AggTask[]): AggTask[] {
  return [...rows].sort((a, b) => {
    const due = (row: AggTask): number => parseWhen(row.task.dueDate)?.getTime() ?? Infinity;
    return due(a) - due(b) || a.task.sortOrder - b.task.sortOrder;
  });
}

/** end of today, as a timestamp the Today filter can compare against. */
function endOfToday(now: Date): number {
  const day = startOfDay(now);
  day.setDate(day.getDate() + 1);
  return day.getTime();
}

/** A task belongs in Today when due today, overdue, or reminding today. */
function isTodayRow(task: Task, now: Date): boolean {
  if (task.dueDate !== '' && daysAway(task.dueDate, now) <= 0) return true;
  if (task.reminderAt !== '') {
    const remind = parseWhen(task.reminderAt);
    if (remind !== null && remind.getTime() < endOfToday(now)) return true;
  }
  return false;
}

/**
 * The Scheduled view's grouped sections: Overdue → Today → Tomorrow →
 * one section per coming weekday → Later. Groups by DUE date first
 * (reminder-only tasks fall back to their reminder time's day).
 */
function scheduledSections(rows: AggTask[], now: Date): AggSection[] {
  const groups = new Map<
    string,
    { sortKey: number; title: string; tone: 'default' | 'danger'; rows: AggTask[] }
  >();
  for (const row of rows) {
    const anchor = row.task.dueDate !== '' ? row.task.dueDate : row.task.reminderAt;
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
      group = { sortKey, title, tone: bucket === 'overdue' ? 'danger' : 'default', rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()]
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((group) => ({
      title: group.title,
      tone: group.tone,
      rows: group.rows.sort(
        (a, b) =>
          (parseWhen(a.task.dueDate || a.task.reminderAt)?.getTime() ?? 0) -
            (parseWhen(b.task.dueDate || b.task.reminderAt)?.getTime() ?? 0) ||
          a.task.sortOrder - b.task.sortOrder,
      ),
    }));
}

/** The app's one aggregate instance. */
export const taskNotes = new TaskNotesAggregate();
