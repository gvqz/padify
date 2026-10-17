/**
 * The tasks hub — the aggregated Reminders pages.
 *
 * The rail's destinations (Today / Scheduled / All / Flagged /
 * Completed / Search) open HERE: a page that takes over the editor
 * area while a note stays selected underneath. Every row belongs to a
 * task note, so the hub is a VIEWER with teeth — completing, the inline
 * editor, moving between lists and deleting all write through the
 * aggregate into their notes; clicking a row's origin (its list dot)
 * closes the hub and opens that note.
 *
 * The hub is singleton markup (markup.ts mounts it at boot); this
 * controller binds it once. Registered as a dismissable LAYER: Escape
 * and outside clicks close it — except while an inner consumer (the
 * inline editor, a popover) is open, which consume Escape themselves.
 */

import { registerLayer } from '../../ui/behavior/layers';
import { getTabManager } from '../../tabs';
import { showToast } from '../../ui/toast';
import { ICONS } from '../../editor/tasks/icons';
import {
  completedToggle,
  editor as editorMarkup,
  emptyStateFor,
  moveMenu,
  priorityMenu,
  priorityLabel,
  rowChips,
  section as sectionMarkup,
  taskRow,
  whenPopover,
  type ListRef,
} from '../../editor/tasks/rows';
import { fireTaskConfetti } from '../../editor/tasks/confetti';
import {
  dateAndTimeToIso,
  formatDueChip,
  formatReminderChip,
  isoToDateAndTime,
  quickPresetIso,
} from '../../editor/tasks/dates';
import type { Priority, Task } from '../../editor/tasks/content';
import { taskNotes, type AggSection, type AggTask, type HubViewId } from './aggregate';
import { dismissReminderToasts } from './toasts';
import { initTasksCalendar, renderTasksCalendar } from './calendar';

export type HubView = HubViewId | 'search' | 'calendar';

const HUB_BODY_CLASS = 'tasks-hub-open';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let view: HubView | null = null;
let searchQuery = '';
let editingId: string | null = null;
let completedExpanded = false;

/** The composer's chips before the task exists. */
interface ComposerDraft {
  dueDate: string;
  reminderAt: string;
  flagged: boolean;
  priority: Priority;
}

const DEFAULT_DRAFT: ComposerDraft = {
  dueDate: '',
  reminderAt: '',
  flagged: false,
  priority: 'none',
};
let draft: ComposerDraft = { ...DEFAULT_DRAFT };

let whenTarget: { kind: 'draft' } | { kind: 'task'; id: string } | null = null;
let whenMode: 'date' | 'remind' = 'date';
let prioTarget: { kind: 'draft' } | { kind: 'task'; id: string } | null = null;
let moveTargetId: string | null = null;

const whenPop = document.createElement('div');
const prioMenu = document.createElement('div');
const movePop = document.createElement('div');
const targetMenu = document.createElement('div');

type HubListener = (view: HubView | null) => void;
const listeners = new Set<HubListener>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function emit(): void {
  for (const listener of listeners) listener(view);
}

/** Opens the hub on a view (or switches views). */
export function openTasksHub(next: HubView): void {
  const hub = hubEl();
  // The hub rides the editor column (#textareaContainer) — while the
  // editor floats in a PiP window the markup is in the other document,
  // and this window has nothing to open. No-op beats a throw.
  if (!hub) return;
  view = next;
  if (next !== 'search') searchQuery = '';
  hub.hidden = false;
  document.body.classList.add(HUB_BODY_CLASS);
  completedExpanded = false;
  editingId = null;
  closePopovers();
  renderHub();
  // The composer is where the typing goes — desktop only, so phones
  // don't grow a keyboard uninvited.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    composerInput().focus();
  }
  emit();
}

/** Returns to the note underneath. */
export function closeTasksHub(): void {
  if (view === null) return;
  view = null;
  searchQuery = '';
  editingId = null;
  closePopovers();
  const hub = hubEl();
  if (hub) hub.hidden = true;
  document.body.classList.remove(HUB_BODY_CLASS);
  const manager = getTabManager();
  if (manager) {
    // The note the user left is still selected — put the caret back.
    manager.focusEditor();
  }
  emit();
}

/** Opens a note (origin chips, reminder toasts) — closing the hub first. */
export function openNoteFromTasks(noteId: string): void {
  closeTasksHub();
  getTabManager()?.switchTo(noteId);
}

export function isTasksHubOpen(): boolean {
  return view !== null;
}

export function currentTasksHubView(): HubView | null {
  return view;
}

export function onTasksHubChanged(listener: HubListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rail's search box drives this — typing lives in the search view. */
export function setTasksHubSearch(query: string): void {
  if (!hubEl()) return; // the editor floats — this window has no hub
  searchQuery = query;
  if (query.trim() === '') {
    if (view === 'search') closeTasksHub();
    return;
  }
  const wasOpen = view !== null;
  view = 'search';
  const hub = hubEl();
  if (!hub) return;
  hub.hidden = false;
  if (!wasOpen) {
    document.body.classList.add(HUB_BODY_CLASS);
    editingId = null;
    completedExpanded = false;
  }
  renderHub();
  emit();
}

/** Re-render the open view (the aggregate moved). */
export function refreshTasksHub(): void {
  if (view !== null) {
    renderHub();
  }
}

// ---------------------------------------------------------------------------
// Init + binding
// ---------------------------------------------------------------------------

export function initTasksHub(): void {
  if (initialized) return;
  initialized = true;

  for (const pop of [whenPop, prioMenu, movePop, targetMenu]) {
    pop.className = pop === whenPop ? 'tk-when' : 'tk-menu';
    pop.hidden = true;
  }

  // The hub is a dismissable layer: Escape/outside closes it — unless an
  // inner consumer (editor, popover) is open, which own their Escape.
  // The rail and the topbar button are the hub's TRIGGERS: they must
  // count as inside the region, because the registry's outside-click
  // sweep runs AFTER opener handlers — a trigger outside the region
  // would close the hub its own click had just opened (the sweep and
  // the open race on the same bubbling click).
  const triggerElements = [
    hubEl(),
    document.getElementById('taskRail'),
    document.getElementById('tabRailCalendar'),
  ].filter((el): el is HTMLElement => el !== null);
  registerLayer({
    elements: triggerElements,
    isOpen: () => {
      // Null while the editor floats in a PiP window — a hub that is
      // not in this document can never read as open (the sweep consults
      // this on every pointerdown).
      const hub = hubEl();
      return hub !== null && !hub.hidden && innerConsumersClosed();
    },
    setOpen: (open) => {
      if (!open) closeTasksHub();
    },
  });

  bindRows();
  bindComposer();
  bindPopovers();
  initTasksCalendar();

  document.getElementById('tkhComposerAdd')?.addEventListener('click', () => submitComposer());

  hubEl()
    ?.querySelectorAll<HTMLElement>('[data-hub-close]')
    .forEach((button) => {
      button.addEventListener('click', () => closeTasksHub());
    });

  // Escape while an inner consumer is open never reaches the layer
  // sweep (its isOpen is false): popovers first, then the editor.
  hubEl()?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!innerConsumersClosed()) {
      if (!popoverClosed()) {
        closePopovers();
      } else if (editingId) {
        closeEditor(false);
      }
      event.stopPropagation();
    }
  });

  // Outside clicks close open popovers (the layer sweep handles the hub).
  document.addEventListener('click', (event) => {
    if (popoverClosed()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target &&
      (whenPop.contains(target) ||
        prioMenu.contains(target) ||
        movePop.contains(target) ||
        targetMenu.contains(target) ||
        target.closest('#tkhComposerDetails,.tk-editor-chips,#tkhTarget'))
    ) {
      return;
    }
    closePopovers();
  });

  // The aggregate moves → the open view re-renders (unless the editor is
  // mid-edit; the editor's own close re-renders).
  taskNotes.onChange(() => {
    if (editingId === null) refreshTasksHub();
  });
}

function innerConsumersClosed(): boolean {
  return popoverClosed() && editingId === null;
}

function hubEl(): HTMLElement | null {
  // Nullable on purpose: the hub rides the editor column, and a PiP
  // float moves that column (hub inside) into another document — every
  // entry point must tolerate the markup being absent from THIS one.
  return document.getElementById('tasksHub');
}

function composerInput(): HTMLInputElement {
  const el = document.getElementById('tkhComposerInput') as HTMLInputElement | null;
  if (!el) throw new Error('Tasks hub markup missing #tkhComposerInput');
  return el;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHub(): void {
  const now = new Date();
  const hub = hubEl();
  if (!hub) return; // the editor floats — nothing to paint here
  const title = hub.querySelector<HTMLElement>('#tkhTitle')!;
  const count = hub.querySelector<HTMLElement>('#tkhCount')!;
  const actions = hub.querySelector<HTMLElement>('#tkhActions')!;
  const sectionsEl = hub.querySelector<HTMLElement>('#tkhSections')!;
  const emptyEl = hub.querySelector<HTMLElement>('#tkhEmpty')!;
  const targetChip = hub.querySelector<HTMLElement>('#tkhTarget')!;

  const searching = view === 'search';
  if (view === 'calendar') {
    // The calendar is a PAGE, not a subpage: the hub's own title/count
    // stand down (the month title is the page's), and .is-calendar lets
    // the CSS give the grid the full height instead of a scrolling doc.
    hub.classList.add('is-calendar');
    title.textContent = 'Calendar';
    count.textContent = String(taskNotes.smartCounts(now).today);
    actions.innerHTML = '';
    renderTasksCalendar((iso) => {
      draft.dueDate = iso;
      renderComposerChips();
      openComposerDetails();
      composerInput().focus();
    });
    renderTargetChip(targetChip);
    return;
  }
  hub.classList.remove('is-calendar');
  const result = searching
    ? taskNotes.search(searchQuery)
    : taskNotes.sectionsFor((view ?? 'today') as HubViewId, now);
  const sections: AggSection[] = result.sections;
  const completed = view === 'completed' ? [] : result.completed;
  const activeTotal = sections.reduce((sum, entry) => sum + entry.rows.length, 0);
  const listFor = (row: AggTask): ListRef => row.note;

  title.textContent = searching
    ? 'Search'
    : view === 'today'
      ? 'Today'
      : view === 'scheduled'
        ? 'Scheduled'
        : view === 'all'
          ? 'All'
          : view === 'flagged'
            ? 'Flagged'
            : 'Completed';
  count.textContent = activeTotal + completed.length > 0 ? `${activeTotal + completed.length}` : '';

  actions.innerHTML = '';
  if (view === 'completed') {
    const done = taskNotes.smartCounts(now).completed;
    if (done > 0) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'tk-chip-btn tk-chip-danger';
      clear.dataset.action = 'clear-completed';
      clear.textContent = `Clear ${done}`;
      actions.appendChild(clear);
    }
  }

  sectionsEl.innerHTML = sections
    .map((entry) =>
      sectionMarkup(
        {
          title: entry.title,
          tone: entry.tone,
          color: entry.color,
          tasks: entry.rows.map((row) => row.task),
        },
        now,
        (task) => colorOf(task),
        false,
        (task) => listFor({ task, note: noteOf(task) }),
      ),
    )
    .join('');

  if (completed.length > 0) {
    const doneRows = completed
      .map((row) => taskRow(row.task, now, row.note.color, false, row.note))
      .join('');
    sectionsEl.insertAdjacentHTML(
      'beforeend',
      completedToggle(completed.length, completedExpanded, doneRows),
    );
  }

  const noNotesAtAll = taskNotes.lists().length === 0;
  const empty = activeTotal === 0 && completed.length === 0;
  emptyEl.hidden = !empty;
  if (empty) {
    emptyEl.innerHTML = noNotesAtAll
      ? `${ICONS.done}<p class="tk-empty-title">No task lists yet</p><p class="tk-empty-sub">A task list is a note — checkboxes, dates, reminders and flags, living beside your other notes.</p><button type="button" class="tk-chip-btn" data-action="create-list">${ICONS.plus} New Task List</button>`
      : emptyStateFor(searching ? 'search' : (view ?? 'today'));
  }

  renderTargetChip(targetChip);
}

/** The composer's target list: the dot + name new reminders file into. */
function renderTargetChip(chip: HTMLElement): void {
  const lists = taskNotes.lists();
  if (lists.length === 0) {
    chip.hidden = true;
    return;
  }
  const targetId = taskNotes.targetListId() ?? lists[0]!.id;
  const target = lists.find((list) => list.id === targetId) ?? lists[0]!;
  chip.hidden = false;
  chip.classList.add(`tk-c-${target.color}`);
  chip.title = `New reminders land in ${target.name} — click to change`;
  chip.innerHTML = `<span class="tk-dot" aria-hidden="true"></span><span class="tkh-target-name">${escapeText(
    target.name,
  )}</span><svg class="tkh-target-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}

function escapeText(value: string): string {
  const holder = document.createElement('span');
  holder.textContent = value;
  return holder.innerHTML;
}

function colorOf(task: Task): string {
  return taskNotes.taskById(task.id)?.note.color ?? 'none';
}

function noteOf(task: Task): ListRef {
  return taskNotes.taskById(task.id)?.note ?? { id: '', name: '', color: 'none' };
}

function wrapFor(id: string): HTMLElement | null {
  return hubEl()?.querySelector<HTMLElement>(`.tk-task-wrap[data-id="${CSS.escape(id)}"]`) ?? null;
}

// ---------------------------------------------------------------------------
// Rows: complete, editor, origin, move
// ---------------------------------------------------------------------------

function bindRows(): void {
  const sectionsEl = hubEl()?.querySelector<HTMLElement>('#tkhSections');
  if (!sectionsEl) return;

  sectionsEl.addEventListener('click', (event) => {
    const target = event.target as Element;
    const wrap = target.closest<HTMLElement>('.tk-task-wrap');
    const id = wrap?.dataset.id ?? null;

    // The origin chip opens the task's note.
    const origin = target.closest<HTMLElement>('[data-list-open]');
    if (origin) {
      const noteId = origin.dataset.listOpen ?? '';
      if (noteId) openNoteFromTasks(noteId);
      return;
    }

    if (target.closest('.tk-check')) {
      if (id) toggleComplete(id);
      return;
    }
    if (target.closest('.tk-done-toggle')) {
      completedExpanded =
        (target.closest<HTMLElement>('.tk-done-toggle')?.getAttribute('aria-expanded') ??
          'false') !== 'true';
      renderHub();
      return;
    }
    if (target.closest('[data-action="clear-completed"]')) {
      void clearCompletedFlow();
      return;
    }
    if (target.closest('[data-action="create-list"]')) {
      void createFirstList();
      return;
    }
    if (wrap && target.closest('.tk-editor-chips')) {
      const when = target.closest<HTMLElement>('[data-editor-when]');
      if (when && id) {
        openWhen({ kind: 'task', id }, when.dataset.editorWhen === 'remind' ? 'remind' : 'date');
        return;
      }
      if (target.closest('[data-editor-flag]') && id) {
        toggleFlag(id);
        return;
      }
      if (target.closest('[data-editor-priority]') && id) {
        openPriorityMenu({ kind: 'task', id });
        return;
      }
      if (target.closest('[data-editor-move]') && id) {
        openMoveMenu(id);
        return;
      }
      if (target.closest('[data-editor-delete]') && id) {
        deleteTask(id);
        return;
      }
      return;
    }
    if (wrap && target.closest('.tk-task-main')) {
      toggleEditor(id!);
    }
  });

  // Editor commit when focus leaves the form.
  sectionsEl.addEventListener('focusout', (event) => {
    const form = (event.target as Element).closest('.tk-editor');
    if (!form) return;
    const next = event.relatedTarget;
    if (next instanceof Node && form.contains(next)) return;
    closeEditor(true);
  });

  sectionsEl.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const titleInput = event.target.closest<HTMLInputElement>('.tk-editor-title');
    const notesArea = event.target.closest<HTMLTextAreaElement>('.tk-editor-notes');
    if (!titleInput && !notesArea) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      closeEditor(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeEditor(false);
    }
  });
}

function toggleComplete(id: string): void {
  const now = new Date();
  const before = taskNotes.sectionsFor((view ?? 'today') as HubViewId, now);
  const hadActive = before.sections.some((section) => section.rows.length > 0);
  taskNotes.toggleComplete(id);
  const done = taskNotes.taskById(id)?.task.completed ?? false;
  if (!done) {
    renderHub();
    return;
  }
  const taskEl = wrapFor(id)?.querySelector('.tk-task');
  if (taskEl) {
    taskEl.classList.add('is-done');
    taskEl.querySelector('.tk-check')?.setAttribute('aria-checked', 'true');
  }
  const after = taskNotes.sectionsFor((view ?? 'today') as HubViewId, now);
  const cleared =
    (view === 'today' || view === 'scheduled' || view === 'flagged') &&
    hadActive &&
    !after.sections.some((section) => section.rows.length > 0);
  window.setTimeout(() => {
    if (cleared) fireTaskConfetti();
    renderHub();
  }, 460);
}

function toggleEditor(id: string): void {
  if (editingId === id) {
    closeEditor(true);
    return;
  }
  if (editingId) closeEditor(true);
  const found = taskNotes.taskById(id);
  const wrap = wrapFor(id);
  if (!found || !wrap) return;

  editingId = id;
  wrap.classList.add('is-editing');
  const holder = wrap.querySelector<HTMLElement>('.tk-editor')!;
  const lists = taskNotes.lists().filter((list) => list.id !== found.note.id);
  holder.innerHTML = editorMarkup(found.task, new Date(), lists);
  holder.hidden = false;
  const title = holder.querySelector<HTMLInputElement>('.tk-editor-title');
  title?.focus();
  title?.select();
}

function closeEditor(commit: boolean): void {
  const id = editingId;
  editingId = null;
  const wrap = id ? wrapFor(id) : null;
  if (wrap) {
    wrap.classList.remove('is-editing');
    const holder = wrap.querySelector<HTMLElement>('.tk-editor');
    if (commit && holder && id) {
      const title = holder.querySelector<HTMLInputElement>('.tk-editor-title');
      const notes = holder.querySelector<HTMLTextAreaElement>('.tk-editor-notes');
      const original = taskNotes.taskById(id);
      if (original && (title || notes)) {
        const nextTitle = (title?.value ?? original.task.title).trim();
        const nextNotes = notes?.value ?? original.task.notes;
        if (nextTitle !== original.task.title || nextNotes !== original.task.notes) {
          taskNotes.updateTask(id, {
            title: nextTitle || original.task.title,
            notes: nextNotes,
          });
        }
      }
    }
    if (holder) {
      holder.hidden = true;
      holder.innerHTML = '';
    }
  }
  renderHub();
}

function toggleFlag(id: string): void {
  const found = taskNotes.taskById(id);
  if (!found) return;
  taskNotes.updateTask(id, { flagged: !found.task.flagged });
  refreshEditorFlag(id);
  refreshRowChips(id);
}

/** Replaces a row's chips in place (an open editor must not die). */
function refreshRowChips(id: string): void {
  const found = taskNotes.taskById(id);
  const main = wrapFor(id)?.querySelector<HTMLElement>('.tk-task-main');
  if (!found || !main) return;
  const title = main.querySelector('.tk-title');
  const notes = main.querySelector('.tk-notes');
  const origin = main.querySelector('.tk-origin');
  const current = main.querySelector('.tk-chips');
  const fresh = rowChips(found.task, new Date());
  const anchor = origin ?? notes ?? title;
  if (current && fresh) {
    current.outerHTML = fresh;
  } else if (current) {
    current.remove();
  } else if (fresh && anchor) {
    anchor.insertAdjacentHTML('afterend', fresh);
  }
}

function refreshEditorFlag(id: string): void {
  const found = taskNotes.taskById(id);
  const button = wrapFor(id)?.querySelector<HTMLButtonElement>('[data-editor-flag]');
  if (!found || !button) return;
  button.classList.toggle('is-set', found.task.flagged);
  button.setAttribute('aria-pressed', String(found.task.flagged));
  button.innerHTML = `${found.task.flagged ? ICONS.flagFilled : ICONS.flag}<span>Flag</span>`;
}

function deleteTask(id: string): void {
  taskNotes.deleteTask(id);
  dismissReminderToasts(id);
  editingId = null;
  renderHub();
  showToast('Reminder deleted');
}

async function clearCompletedFlow(): Promise<void> {
  const { default: Swal } = await import('sweetalert2');
  const result = await Swal.fire({
    title: 'Clear completed reminders?',
    text: 'Every checked-off reminder, across every list, will be removed.',
    showCancelButton: true,
    confirmButtonText: 'Clear',
    confirmButtonColor: 'var(--vz-danger, #ee0000)',
  });
  if (!result.isConfirmed) return;
  const now = new Date();
  for (const row of taskNotes.sectionsFor('completed', now).sections) {
    for (const entry of row.rows) {
      taskNotes.deleteTask(entry.task.id);
    }
  }
  dismissReminderToasts();
  renderHub();
  showToast('Completed reminders cleared');
}

async function createFirstList(): Promise<void> {
  const manager = getTabManager();
  if (!manager) return;
  // focusEditor=true lands the caret in the fresh list's title (the
  // surface's focusTarget rule) — name it right away.
  manager.addTab(true, 'tasks');
  closeTasksHub();
  showToast('New task list created — name it in its title bar');
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

function bindComposer(): void {
  const input = composerInput();
  const hub = hubEl();
  if (!hub) return;

  input.addEventListener('focus', () => openComposerDetails());
  input.addEventListener('input', () => openComposerDetails());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitComposer();
    }
  });

  const composer = hub.querySelector<HTMLElement>('#tkhComposer')!;
  composer.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && composer.contains(next)) return;
    if (input.value === '' && !draftIsSet() && popoverClosed()) {
      (hub.querySelector('#tkhComposerDetails') as HTMLElement).hidden = true;
    }
  });

  hub.querySelector('#tkhComposerDate')?.addEventListener('click', () => {
    openWhen({ kind: 'draft' }, 'date');
  });
  hub.querySelector('#tkhComposerRemind')?.addEventListener('click', () => {
    openWhen({ kind: 'draft' }, 'remind');
  });
  const flag = hub.querySelector<HTMLButtonElement>('#tkhComposerFlag');
  flag?.addEventListener('click', () => {
    draft.flagged = !draft.flagged;
    renderComposerChips();
  });
  hub.querySelector('#tkhComposerPriority')?.addEventListener('click', () => {
    openPriorityMenu({ kind: 'draft' });
  });

  // The target-list chip menu.
  hub.querySelector('#tkhTarget')?.addEventListener('click', () => openTargetMenu());
}

function openComposerDetails(): void {
  const details = hubEl()?.querySelector<HTMLElement>('#tkhComposerDetails');
  if (details) details.hidden = false;
}

function draftIsSet(): boolean {
  return (
    draft.dueDate !== '' || draft.reminderAt !== '' || draft.flagged || draft.priority !== 'none'
  );
}

function submitComposer(): void {
  const input = composerInput();
  const title = input.value.trim();
  const lists = taskNotes.lists();
  if (!title) {
    input.focus();
    return;
  }
  if (lists.length === 0) {
    // No lists yet: the first one is created for the task to land in.
    const manager = getTabManager();
    if (!manager) return;
    manager.addTab(true, 'tasks');
    input.value = '';
    draft = { ...DEFAULT_DRAFT };
    renderComposerChips();
    void taskNotes.addTaskToNote(manager.getActive()!.id, { title, ...draft });
    closeTasksHub();
    showToast('Task list created with your first reminder');
    return;
  }
  const targetId = taskNotes.targetListId() ?? lists[0]!.id;
  const target = lists.find((list) => list.id === targetId) ?? lists[0]!;
  const added = taskNotes.addTaskToNote(target.id, { title, ...draft });
  taskNotes.rememberTargetList(target.id);
  input.value = '';
  draft = { ...DEFAULT_DRAFT };
  renderComposerChips();
  if (added) {
    showToast(`Added to ${target.name}`);
  }
  renderHub();
  input.focus();
}

function renderComposerChips(): void {
  const hub = hubEl();
  if (!hub) return;
  const now = new Date();
  const date = hub.querySelector<HTMLButtonElement>('#tkhComposerDate')!;
  const remind = hub.querySelector<HTMLButtonElement>('#tkhComposerRemind')!;
  const flag = hub.querySelector<HTMLButtonElement>('#tkhComposerFlag')!;
  const priority = hub.querySelector<HTMLButtonElement>('#tkhComposerPriority')!;
  setChip(date, draft.dueDate !== '', draft.dueDate ? formatDueChip(draft.dueDate, now) : 'Date');
  setChip(
    remind,
    draft.reminderAt !== '',
    draft.reminderAt ? formatReminderChip(draft.reminderAt, now) : 'Remind',
  );
  flag.classList.toggle('is-set', draft.flagged);
  flag.setAttribute('aria-pressed', String(draft.flagged));
  setChip(priority, draft.priority !== 'none', priorityLabel(draft.priority));
}

function setChip(button: HTMLButtonElement, isSet: boolean, label: string): void {
  button.classList.toggle('is-set', isSet);
  const span = button.querySelector('span');
  if (span) span.textContent = label;
}

// ---------------------------------------------------------------------------
// Popovers: when / priority / move / target
// ---------------------------------------------------------------------------

function bindPopovers(): void {
  whenPop.addEventListener('click', (event) => {
    const target = event.target as Element;
    const preset = target.closest<HTMLElement>('[data-when-preset]')?.dataset.whenPreset;
    if (preset) {
      const timeInput = whenPop.querySelector<HTMLInputElement>('[data-when-time]');
      const time = timeInput?.value || (whenMode === 'remind' ? '09:00' : currentWhenTime());
      applyWhen(
        quickPresetIso(preset as 'today' | 'tomorrow' | 'weekend' | 'nextWeek', new Date(), time),
      );
      closePopovers();
      return;
    }
    if (target.closest('[data-when-clear]')) {
      applyWhen('');
      closePopovers();
    }
  });
  whenPop.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches('[data-when-date],[data-when-time]')) return;
    const dateInput = whenPop.querySelector<HTMLInputElement>('[data-when-date]');
    const timeInput = whenPop.querySelector<HTMLInputElement>('[data-when-time]');
    let dateValue = dateInput?.value ?? '';
    const timeValue = timeInput?.value ?? '';
    if (!dateValue && input.matches('[data-when-time]') && timeValue) {
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      dateValue = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      if (dateInput) dateInput.value = dateValue;
    }
    if (!dateValue) return;
    const effectiveTime = whenMode === 'remind' && !timeValue ? '09:00' : timeValue;
    applyWhen(dateAndTimeToIso(dateValue, effectiveTime));
  });

  prioMenu.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('[data-priority]');
    if (!item) return;
    const priority = item.dataset.priority as Priority;
    if (prioTarget?.kind === 'draft') {
      draft.priority = priority;
      renderComposerChips();
    } else if (prioTarget?.kind === 'task') {
      taskNotes.updateTask(prioTarget.id, { priority });
      const button = wrapFor(prioTarget.id)?.querySelector<HTMLButtonElement>(
        '[data-editor-priority]',
      );
      if (button) setChip(button, priority !== 'none', priorityLabel(priority));
      refreshRowChips(prioTarget.id);
    }
    closePopovers();
  });

  movePop.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('[data-move-to]');
    const id = moveTargetId;
    if (!item || !id) return;
    // The editor's live title/notes travel with the task.
    const wrap = wrapFor(id);
    const titleEl = wrap?.querySelector<HTMLInputElement>('.tk-editor-title');
    const notesEl = wrap?.querySelector<HTMLTextAreaElement>('.tk-editor-notes');
    const found = taskNotes.taskById(id);
    if (found && titleEl?.value.trim()) {
      taskNotes.updateTask(id, {
        title: titleEl.value.trim(),
        notes: notesEl?.value ?? found.task.notes,
      });
    }
    taskNotes.moveTask(id, item.dataset.moveTo ?? '');
    editingId = null;
    closePopovers();
    renderHub();
    showToast('Moved');
  });

  targetMenu.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('[data-move-to]');
    if (!item) return;
    taskNotes.rememberTargetList(item.dataset.moveTo ?? '');
    closePopovers();
    renderHub();
  });
}

function currentWhenTime(): string {
  const iso = currentWhenIso();
  return iso ? isoToDateAndTime(iso).time : '';
}

function currentWhenIso(): string {
  if (!whenTarget) return '';
  if (whenTarget.kind === 'draft') {
    return whenMode === 'date' ? draft.dueDate : draft.reminderAt;
  }
  const found = taskNotes.taskById(whenTarget.id);
  if (!found) return '';
  return whenMode === 'date' ? found.task.dueDate : found.task.reminderAt;
}

function openWhen(
  target: { kind: 'draft' } | { kind: 'task'; id: string },
  mode: 'date' | 'remind',
): void {
  closePopovers();
  whenTarget = target;
  whenMode = mode;
  whenPop.innerHTML = whenPopover(mode);
  const { date, time } = isoToDateAndTime(currentWhenIso());
  whenPop.querySelector<HTMLInputElement>('[data-when-date]')!.value = date;
  whenPop.querySelector<HTMLInputElement>('[data-when-time]')!.value = time;
  const anchor =
    target.kind === 'draft'
      ? hubEl()?.querySelector('#tkhComposerDetails')
      : wrapFor(target.id)?.querySelector('.tk-editor-chips');
  if (!anchor) return;
  anchor.appendChild(whenPop);
  whenPop.hidden = false;
  if (mode === 'remind') {
    whenPop.querySelector<HTMLInputElement>('[data-when-time]')?.focus();
  }
}

function applyWhen(value: string): void {
  if (!whenTarget) return;
  if (whenTarget.kind === 'draft') {
    if (whenMode === 'date') draft.dueDate = value;
    else draft.reminderAt = value;
    renderComposerChips();
    return;
  }
  const id = whenTarget.id;
  taskNotes.updateTask(id, whenMode === 'date' ? { dueDate: value } : { reminderAt: value });
  const button = wrapFor(id)?.querySelector<HTMLButtonElement>(`[data-editor-when="${whenMode}"]`);
  const now = new Date();
  if (button) {
    if (whenMode === 'date') {
      setChip(button, value !== '', value ? formatDueChip(value, now) : 'Date');
    } else {
      setChip(button, value !== '', value ? formatReminderChip(value, now) : 'Remind');
    }
  }
  refreshRowChips(id);
}

function openPriorityMenu(target: { kind: 'draft' } | { kind: 'task'; id: string }): void {
  closePopovers();
  prioTarget = target;
  const current =
    target.kind === 'draft'
      ? draft.priority
      : (taskNotes.taskById(target.id)?.task.priority ?? 'none');
  prioMenu.innerHTML = priorityMenu(current);
  const anchor =
    target.kind === 'draft'
      ? hubEl()?.querySelector('#tkhComposerDetails')
      : wrapFor(target.id)?.querySelector('.tk-editor-chips');
  if (!anchor) return;
  anchor.appendChild(prioMenu);
  prioMenu.hidden = false;
  prioMenu.querySelector<HTMLElement>('.tk-menu-item')?.focus();
}

function openMoveMenu(id: string): void {
  const found = taskNotes.taskById(id);
  if (!found) return;
  const lists = taskNotes.lists().filter((list) => list.id !== found.note.id);
  if (lists.length === 0) return;
  closePopovers();
  moveTargetId = id;
  movePop.innerHTML = moveMenu(lists, found.note.id);
  const anchor = wrapFor(id)?.querySelector('.tk-editor-chips');
  if (!anchor) return;
  anchor.appendChild(movePop);
  movePop.hidden = false;
  movePop.querySelector<HTMLElement>('.tk-menu-item')?.focus();
}

function openTargetMenu(): void {
  const lists = taskNotes.lists();
  if (lists.length === 0) return;
  closePopovers();
  const current = taskNotes.targetListId();
  targetMenu.innerHTML =
    `<div class="tk-menu-label">Add to list</div>` +
    lists
      .map(
        (list) =>
          `<button type="button" class="tk-menu-item${list.id === current ? ' is-on' : ''}" data-move-to="${list.id}"><span class="tk-dot tk-c-${list.color}" aria-hidden="true"></span><span class="tk-menu-label">${escapeText(list.name)}</span></button>`,
      )
      .join('');
  const anchor = hubEl()?.querySelector('#tkhTarget');
  if (!anchor) return;
  anchor.appendChild(targetMenu);
  targetMenu.hidden = false;
  targetMenu.querySelector<HTMLElement>('.tk-menu-item')?.focus();
}

function closePopovers(): void {
  const active = document.activeElement;
  if (
    active instanceof Node &&
    (whenPop.contains(active) ||
      prioMenu.contains(active) ||
      movePop.contains(active) ||
      targetMenu.contains(active))
  ) {
    const form = active instanceof Element ? active.closest<HTMLElement>('.tk-editor') : null;
    (form?.querySelector<HTMLElement>('.tk-editor-title') ?? composerInput()).focus();
  }
  for (const pop of [whenPop, prioMenu, movePop, targetMenu]) {
    pop.remove();
    pop.hidden = true;
  }
  whenTarget = null;
  prioTarget = null;
  moveTargetId = null;
}

function popoverClosed(): boolean {
  return whenPop.hidden && prioMenu.hidden && movePop.hidden && targetMenu.hidden;
}
