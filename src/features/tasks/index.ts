/**
 * Padify Reminders — the controller.
 *
 * The Reminders modal's engine: owns the TaskStore, renders the sidebar
 * and the content pane, the inline detail editor, the composer's
 * quick-add draft, the shared popovers (date/reminder picker, priority
 * menu) and drag-to-reorder inside a list. Loads on the first attempt to
 * open the modal (app.ts's lazy seam); markup mounts at boot (markup.ts).
 *
 * Event wiring follows the house rules (CONTRIBUTING.md): listeners bind
 * once here on singleton-surfaces (the modal, the scroll container, the
 * composer), and everything re-rendered through innerHTML — rows, editors,
 * popovers — talks through delegated handlers on those surfaces.
 */

import Swal from 'sweetalert2';
import type { SweetAlertResult } from 'sweetalert2';

import { TaskStore } from './store';
import { ICONS } from './markup';
import {
  completedToggle,
  editor as editorMarkup,
  emptyStateFor,
  listNavItem,
  priorityLabel,
  priorityMenu,
  rowChips,
  section,
  taskRow,
  whenPopover,
} from './rows';
import { fireTaskConfetti } from './confetti';
import { dismissReminderToasts } from './reminders';
import {
  dateAndTimeToIso,
  formatDueChip,
  formatReminderChip,
  isoToDateAndTime,
  quickPresetIso,
} from './dates';
import type { Priority, Task, ViewId } from './types';
import { showToast } from '../../ui/toast';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Reminders markup missing #${id}`);
  return el as T;
}

let initialized = false;

/** Wires the Reminders modal. Called once, on the first open (app.ts). */
export function initTasks(): void {
  if (initialized) return;
  initialized = true;
  new RemindersController();
}

/** What the composer's chips know before the task exists. */
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

class RemindersController {
  private readonly store = new TaskStore();
  private readonly modal: HTMLElement;

  private readonly searchInput: HTMLInputElement;
  private readonly searchClear: HTMLButtonElement;
  private readonly listNav: HTMLElement;
  private readonly listsGroup: HTMLElement;
  private readonly addListButton: HTMLButtonElement;
  private readonly viewTitle: HTMLElement;
  private readonly viewCount: HTMLElement;
  private readonly viewActions: HTMLElement;
  private readonly sectionsEl: HTMLElement;
  private readonly emptyEl: HTMLElement;

  private readonly composer: HTMLElement;
  private readonly composerInput: HTMLInputElement;
  private readonly composerDetails: HTMLElement;
  private readonly composerDate: HTMLButtonElement;
  private readonly composerRemind: HTMLButtonElement;
  private readonly composerFlag: HTMLButtonElement;
  private readonly composerPriority: HTMLButtonElement;

  private readonly whenPop = document.createElement('div');
  private readonly prioMenu = document.createElement('div');

  private searchQuery = '';
  private completedExpanded = false;
  private editingId: string | null = null;
  private draft: ComposerDraft = { ...DEFAULT_DRAFT };

  /** What the when-popover is currently editing (composer draft vs a task). */
  private whenTarget: { kind: 'draft' } | { kind: 'task'; id: string } | null = null;
  private whenMode: 'date' | 'remind' = 'date';
  private prioTarget: { kind: 'draft' } | { kind: 'task'; id: string } | null = null;
  private dragId: string | null = null;

  constructor() {
    this.modal = byId('tasksModal');
    this.searchInput = byId('tkSearchInput');
    this.searchClear = byId('tkSearchClear');
    this.listNav = byId('tkListNav');
    this.listsGroup = byId('tkListsGroup');
    this.addListButton = byId('tkAddList');
    this.viewTitle = byId('tkViewTitle');
    this.viewCount = byId('tkViewCount');
    this.viewActions = byId('tkViewActions');
    this.sectionsEl = byId('tkSections');
    this.emptyEl = byId('tkEmpty');
    this.composer = byId('tkComposer');
    this.composerInput = byId('tkComposerInput');
    this.composerDetails = byId('tkComposerDetails');
    this.composerDate = byId('tkComposerDate');
    this.composerRemind = byId('tkComposerRemind');
    this.composerFlag = byId('tkComposerFlag');
    this.composerPriority = byId('tkComposerPriority');

    // A restored view pointing at a deleted list lands on All.
    if (this.store.view.startsWith('list:') && !this.store.listForView(this.store.view)) {
      this.store.view = 'all';
    }

    this.whenPop.className = 'tk-when';
    this.whenPop.hidden = true;
    this.prioMenu.className = 'tk-menu';
    this.prioMenu.hidden = true;

    this.bind();
    this.renderAll();
  }

  // ========================================================================
  // Rendering
  // ========================================================================

  private renderAll(): void {
    this.renderNav();
    this.renderView();
  }

  private renderNav(): void {
    const now = new Date();
    const counts = this.store.smartCounts(now);
    const smart: [string, number][] = [
      ['tkCountToday', counts.today],
      ['tkCountScheduled', counts.scheduled],
      ['tkCountAll', counts.all],
      ['tkCountFlagged', counts.flagged],
      ['tkCountCompleted', counts.completed],
    ];
    for (const [id, count] of smart) {
      const badge = byId<HTMLElement>(id);
      badge.textContent = count > 0 ? String(count) : '';
      badge.hidden = count === 0;
    }

    const listCounts = this.store.listCounts();
    const activeView = this.searchQuery ? null : this.store.view;
    this.listNav.innerHTML = this.store.lists
      .map((list) =>
        listNavItem(list, listCounts.get(list.id) ?? 0, activeView === `list:${list.id}`),
      )
      .join('');
    this.listsGroup.hidden = this.store.lists.length === 0;

    // Smart destinations' active state.
    document
      .querySelectorAll<HTMLElement>('#tasksModal .tk-nav-item[data-view]')
      .forEach((item) => {
        const view = item.dataset.view ?? '';
        const isSmart = !view.startsWith('list:');
        item.classList.toggle('is-active', isSmart && activeView === view);
        item.setAttribute('aria-selected', String(isSmart && activeView === view));
      });
  }

  private renderView(): void {
    const now = new Date();
    const searching = this.searchQuery.trim().length > 0;

    let sectionsHtml: string;
    let completed: Task[];
    let activeTotal: number;
    let emptyKey: string = this.store.view;

    if (searching) {
      const found = this.store.search(this.searchQuery);
      const result = [...found.sections];
      completed = found.completed;
      activeTotal = result.reduce((sum, s) => sum + s.tasks.length, 0);
      sectionsHtml = result.map((s) => section(s, now, this.resolveColor, false)).join('');
      emptyKey = 'search';
      this.viewTitle.textContent = 'Search';
      this.viewCount.textContent =
        activeTotal + completed.length > 0 ? `${activeTotal + completed.length} matches` : '';
      this.viewActions.innerHTML = '';
    } else {
      const view = this.store.view;
      const found = this.store.sectionsFor(view, now);
      const result = [...found.sections];
      completed = view === 'completed' ? [] : found.completed;
      activeTotal = result.reduce((sum, s) => sum + s.tasks.length, 0);
      // Drag-to-reorder only where order is manual and unambiguous.
      const draggable = view.startsWith('list:') || view === 'all';
      sectionsHtml = result.map((s) => section(s, now, this.resolveColor, draggable)).join('');

      this.renderViewHead(view, activeTotal, completed.length);
    }

    this.sectionsEl.innerHTML = sectionsHtml;

    // The collapsed completed trailer (not in the Completed view itself).
    if (completed.length > 0 && (searching || this.store.view !== 'completed')) {
      const doneRows = completed
        .map((task) => taskRow(task, now, this.resolveColor(task), false))
        .join('');
      this.sectionsEl.insertAdjacentHTML(
        'beforeend',
        completedToggle(completed.length, this.completedExpanded, doneRows),
      );
    }

    const empty = activeTotal === 0 && completed.length === 0;
    this.emptyEl.hidden = !empty;
    if (empty) {
      this.emptyEl.innerHTML = emptyStateFor(emptyKey);
    }
  }

  private renderViewHead(view: ViewId, activeTotal: number, doneTotal: number): void {
    const list = this.store.listForView(view);
    // Apple colors a list's title with the list color.
    this.viewTitle.className = list ? `tk-list-title tk-c-${list.color}` : 'tk-list-title';
    this.viewTitle.textContent = this.titleFor(view);
    this.viewCount.textContent =
      view === 'completed' ? `${doneTotal} done` : this.countText(activeTotal);

    const actions: string[] = [];
    if (list) {
      actions.push(
        `<button type="button" class="tk-chip-btn" data-action="rename-list">Rename</button>`,
      );
      actions.push(
        `<button type="button" class="tk-chip-btn tk-chip-danger" data-action="delete-list">Delete</button>`,
      );
    } else if (view === 'completed' && doneTotal > 0) {
      actions.push(
        `<button type="button" class="tk-chip-btn tk-chip-danger" data-action="clear-completed">Clear</button>`,
      );
    }
    this.viewActions.innerHTML = actions.join('');
  }

  private titleFor(view: ViewId): string {
    switch (view) {
      case 'today':
        return 'Today';
      case 'scheduled':
        return 'Scheduled';
      case 'all':
        return 'All';
      case 'flagged':
        return 'Flagged';
      case 'completed':
        return 'Completed';
      default:
        return this.store.listForView(view)?.name ?? 'List';
    }
  }

  private countText(count: number): string {
    if (count === 0) return '';
    return `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
  }

  /** The list color class a task's checkbox + dot should wear. */
  private resolveColor = (task: Task): string => this.store.listById(task.listId)?.color ?? 'none';

  private wrapFor(id: string): HTMLElement | null {
    return this.sectionsEl.querySelector<HTMLElement>(`.tk-task-wrap[data-id="${CSS.escape(id)}"]`);
  }

  // ========================================================================
  // Event wiring (bind once — delegated for everything dynamic)
  // ========================================================================

  private bind(): void {
    // ---- sidebar ----
    document.querySelector('#tasksModal .tk-nav')!.addEventListener('click', (event) => {
      const target = event.target as Element;
      const nav = target.closest<HTMLElement>('.tk-nav-item[data-view]');
      if (nav) {
        this.switchView(nav.dataset.view as ViewId);
        return;
      }
      if (target.closest('#tkAddList')) {
        this.openAddListForm();
      }
    });

    // ---- search ----
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.searchClear.hidden = this.searchQuery === '';
      this.completedExpanded = false;
      this.renderView();
      this.renderNav();
    });
    this.searchClear.addEventListener('click', () => {
      this.clearSearch();
      this.searchInput.focus();
    });
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.searchQuery) {
        event.stopPropagation();
        this.clearSearch();
      }
    });

    // ---- the content pane: rows, editors, the completed toggle ----
    this.sectionsEl.addEventListener('click', (event) => {
      const target = event.target as Element;
      const wrap = target.closest<HTMLElement>('.tk-task-wrap');
      const id = wrap?.dataset.id ?? null;

      if (target.closest('.tk-check')) {
        if (id) this.toggleComplete(id);
        return;
      }
      if (target.closest('.tk-done-toggle')) {
        this.completedExpanded =
          (target.closest<HTMLElement>('.tk-done-toggle')?.getAttribute('aria-expanded') ??
            'false') !== 'true';
        this.renderView();
        return;
      }
      if (wrap && target.closest('.tk-editor-chips')) {
        const when = target.closest<HTMLElement>('[data-editor-when]');
        if (when && id) {
          this.openWhen(
            { kind: 'task', id },
            when.dataset.editorWhen === 'remind' ? 'remind' : 'date',
          );
          return;
        }
        if (target.closest('[data-editor-flag]') && id) {
          this.toggleFlag(id);
          return;
        }
        if (target.closest('[data-editor-priority]') && id) {
          this.openPriorityMenu({ kind: 'task', id });
          return;
        }
        if (target.closest('[data-editor-delete]') && id) {
          this.deleteTask(id);
          return;
        }
        return; // clicks inside the editor elsewhere never open/close rows
      }
      if (wrap && (target.closest('.tk-task-main') || target.closest('.tk-info'))) {
        this.toggleEditor(id!);
      }
    });

    // Editor commit when focus leaves the form (popover interactions stay inside).
    this.sectionsEl.addEventListener('focusout', (event) => {
      const form = (event.target as Element).closest('.tk-editor');
      if (!form) return;
      const next = event.relatedTarget;
      if (next instanceof Node && form.contains(next)) return;
      // The modal's shown/focus enforcement (bootstrap parity — modal.ts
      // focuses the dialog right before shown.bs.modal) lands focus on the
      // modal root mid-edit when the user outpaces the open transition;
      // that is not the user leaving the editor, and it must not commit.
      if (next === this.modal) return;
      this.closeEditor(true);
    });

    // Editor keys: Enter commits, Escape discards.
    this.sectionsEl.addEventListener('keydown', (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const titleInput = event.target.closest<HTMLInputElement>('.tk-editor-title');
      const notesArea = event.target.closest<HTMLTextAreaElement>('.tk-editor-notes');
      if (!titleInput && !notesArea) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.closeEditor(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeEditor(false);
      }
    });

    // Moving a task between lists (native select, compact + accessible).
    this.sectionsEl.addEventListener('change', (event) => {
      const select = event.target as HTMLSelectElement;
      if (!select.classList.contains('tk-editor-list')) return;
      const id = select.closest<HTMLElement>('.tk-task-wrap')?.dataset.id;
      if (!id) return;
      this.store.moveTaskToList(id, select.value);
      this.renderAll();
    });

    // ---- view actions (rename/delete list, clear completed) ----
    this.viewActions.addEventListener('click', (event) => {
      const action = (event.target as Element).closest<HTMLElement>('[data-action]')?.dataset
        .action;
      if (!action) return;
      if (action === 'rename-list') void this.renameListFlow();
      if (action === 'delete-list') void this.deleteListFlow();
      if (action === 'clear-completed') void this.clearCompletedFlow();
    });

    // ---- drag-to-reorder (manual-order views only) ----
    this.sectionsEl.addEventListener('dragstart', (event) => {
      const wrap = (event.target as Element).closest<HTMLElement>('.tk-task-wrap[draggable]');
      if (!wrap || !(event instanceof DragEvent)) return;
      this.dragId = wrap.dataset.id ?? null;
      wrap.classList.add('is-dragging');
      event.dataTransfer!.effectAllowed = 'move';
      event.dataTransfer!.setData('text/plain', this.dragId ?? '');
    });
    this.sectionsEl.addEventListener('dragover', (event) => {
      if (!this.dragId) return;
      const wrap = (event.target as Element).closest<HTMLElement>('.tk-task-wrap[draggable]');
      this.sectionsEl
        .querySelectorAll('.tk-task-wrap.is-drag-over')
        .forEach((el) => el.classList.remove('is-drag-over'));
      if (!wrap || wrap.dataset.id === this.dragId) return;
      const dragged = this.store.taskById(this.dragId);
      const over = this.store.taskById(wrap.dataset.id ?? '');
      if (!dragged || !over || dragged.listId !== over.listId) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'move';
      wrap.classList.add('is-drag-over');
    });
    this.sectionsEl.addEventListener('drop', (event) => {
      if (!this.dragId) return;
      const wrap = (event.target as Element).closest<HTMLElement>('.tk-task-wrap[draggable]');
      if (wrap && wrap.dataset.id && wrap.dataset.id !== this.dragId) {
        event.preventDefault();
        this.store.moveTaskBefore(this.dragId, wrap.dataset.id);
        this.renderView();
      }
      this.endDrag();
    });
    this.sectionsEl.addEventListener('dragend', () => this.endDrag());

    // ---- the composer ----
    this.composerInput.addEventListener('focus', () => this.openComposerDetails());
    this.composerInput.addEventListener('input', () => this.openComposerDetails());
    this.composerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitComposer();
      }
    });
    byId('tkComposerAdd').addEventListener('click', () => this.submitComposer());
    this.composer.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.composer.contains(next)) return;
      // Leaving the composer entirely: collapse the chips only when the
      // draft is untouched (typed text and set chips stay open on purpose).
      if (this.composerInput.value === '' && !this.draftIsSet() && this.popoverClosed()) {
        this.composerDetails.hidden = true;
      }
    });
    this.composerDate.addEventListener('click', () => {
      this.openWhen({ kind: 'draft' }, 'date');
    });
    this.composerRemind.addEventListener('click', () => {
      this.openWhen({ kind: 'draft' }, 'remind');
    });
    this.composerFlag.addEventListener('click', () => {
      this.draft.flagged = !this.draft.flagged;
      this.renderComposerChips();
    });
    this.composerPriority.addEventListener('click', () => {
      this.openPriorityMenu({ kind: 'draft' });
    });

    // ---- popovers: apply/close ----
    this.bindWhenPopover();
    this.bindPriorityMenu();
    document.addEventListener('click', (event) => {
      if (this.whenPop.hidden && this.prioMenu.hidden) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target &&
        (this.whenPop.contains(target) ||
          this.prioMenu.contains(target) ||
          target.closest(
            '[data-editor-when],[data-editor-priority],#tkComposerDate,#tkComposerRemind,#tkComposerPriority',
          ))
      ) {
        return;
      }
      this.closePopovers();
    });

    // Escape, consumed inside the modal before the document's close-all:
    // popovers first, then the open editor (see the music player's row menu).
    this.modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!this.whenPop.hidden || !this.prioMenu.hidden) {
        this.closePopovers();
        event.stopPropagation();
      } else if (this.editingId) {
        this.closeEditor(false);
        event.stopPropagation();
      }
    });

    // Opening the modal puts the cursor where the typing goes — desktop
    // only, so phones don't grow a keyboard uninvited. Never steal focus
    // from something meaningful already focused INSIDE the modal (a fast
    // open → edit flow can beat the 300ms shown transition); the modal
    // root itself does not count — modal.ts just put focus there as its
    // own shown-time enforcement.
    this.modal.addEventListener('shown.bs.modal', () => {
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== this.modal && this.modal.contains(active)) {
        return;
      }
      this.composerInput.focus();
    });
    this.modal.addEventListener('hidden.bs.modal', () => {
      this.closePopovers();
      this.closeEditor(true);
    });
  }

  // ========================================================================
  // Views + search
  // ========================================================================

  private switchView(view: ViewId): void {
    this.store.view = view;
    this.store.persist();
    this.completedExpanded = false;
    this.editingId = null;
    this.closePopovers();
    this.clearSearch(true);
    this.renderAll();
  }

  private clearSearch(silent = false): void {
    if (!silent) this.searchInput.focus();
    this.searchQuery = '';
    this.searchInput.value = '';
    this.searchClear.hidden = true;
    this.renderView();
    this.renderNav();
  }

  // ========================================================================
  // Completing tasks
  // ========================================================================

  private toggleComplete(id: string): void {
    const now = new Date();
    const done = this.store.toggleComplete(id);
    if (!done) {
      this.renderAll();
      return;
    }
    // Paint the circle immediately; let the row sink after the animation.
    const taskEl = this.wrapFor(id)?.querySelector('.tk-task');
    if (taskEl) {
      taskEl.classList.add('is-done');
      taskEl.querySelector('.tk-check')?.setAttribute('aria-checked', 'true');
    }
    const cleared = !this.searchQuery && this.store.viewClearedBy(id, now);
    window.setTimeout(() => {
      if (cleared) fireTaskConfetti();
      this.renderAll();
    }, 460);
  }

  // ========================================================================
  // The inline editor
  // ========================================================================

  private toggleEditor(id: string): void {
    if (this.editingId === id) {
      this.closeEditor(true);
      return;
    }
    if (this.editingId) this.closeEditor(true);
    const wrap = this.wrapFor(id);
    const task = this.store.taskById(id);
    if (!wrap || !task) return;

    this.editingId = id;
    wrap.classList.add('is-editing');
    const holder = wrap.querySelector<HTMLElement>('.tk-editor')!;
    holder.innerHTML = editorMarkup(task, this.store.lists, new Date());
    holder.hidden = false;
    const title = holder.querySelector<HTMLInputElement>('.tk-editor-title');
    title?.focus();
    title?.select();
  }

  private closeEditor(commit: boolean): void {
    const id = this.editingId;
    this.editingId = null;
    const wrap = id ? this.wrapFor(id) : null;
    if (wrap) {
      wrap.classList.remove('is-editing');
      const holder = wrap.querySelector<HTMLElement>('.tk-editor');
      if (commit && holder) {
        const title = holder.querySelector<HTMLInputElement>('.tk-editor-title');
        const notes = holder.querySelector<HTMLTextAreaElement>('.tk-editor-notes');
        const original = this.store.taskById(id!);
        if (original && (title || notes)) {
          const nextTitle = (title?.value ?? original.title).trim();
          const nextNotes = notes?.value ?? original.notes;
          if (nextTitle !== original.title || nextNotes !== original.notes) {
            // An emptied title falls back to the original (legacy rule).
            this.store.updateTask(id!, {
              title: nextTitle || original.title,
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
    this.renderAll();
  }

  private toggleFlag(id: string): void {
    const task = this.store.taskById(id);
    if (!task) return;
    this.store.updateTask(id, { flagged: !task.flagged });
    this.refreshEditorFlag(id);
    // No renderView here — it would rebuild the rows and destroy the open
    // editor the flag was toggled from. The chips update in place; the
    // view itself re-syncs on the editor's closing renderAll (so unflagging
    // in the Flagged view moves the row out when the editor closes).
    this.refreshRowChips(id);
    this.renderNav();
  }

  /** Replaces a row's chips (date / reminder / priority / flag) in place. */
  private refreshRowChips(id: string): void {
    const task = this.store.taskById(id);
    const main = this.wrapFor(id)?.querySelector<HTMLElement>('.tk-task-main');
    if (!task || !main) return;
    const title = main.querySelector('.tk-title');
    const notes = main.querySelector('.tk-notes');
    const current = main.querySelector('.tk-chips');
    const fresh = rowChips(task, new Date());
    if (current && fresh) {
      current.outerHTML = fresh;
    } else if (current) {
      current.remove();
    } else if (fresh) {
      (notes ?? title)?.insertAdjacentHTML('afterend', fresh);
    }
  }

  private refreshEditorFlag(id: string): void {
    const task = this.store.taskById(id);
    const button = this.wrapFor(id)?.querySelector<HTMLButtonElement>('[data-editor-flag]');
    if (!task || !button) return;
    button.classList.toggle('is-set', task.flagged);
    button.setAttribute('aria-pressed', String(task.flagged));
    button.innerHTML = `${task.flagged ? ICONS.flagFilled : ICONS.flag}<span>Flag</span>`;
  }

  private deleteTask(id: string): void {
    this.store.deleteTask(id);
    dismissReminderToasts(id);
    this.editingId = null;
    this.renderAll();
    showToast('Reminder deleted');
  }

  // ========================================================================
  // The composer
  // ========================================================================

  private openComposerDetails(): void {
    this.composerDetails.hidden = false;
  }

  private draftIsSet(): boolean {
    return (
      this.draft.dueDate !== '' ||
      this.draft.reminderAt !== '' ||
      this.draft.flagged ||
      this.draft.priority !== 'none'
    );
  }

  private submitComposer(): void {
    const title = this.composerInput.value.trim();
    if (!title) {
      this.composerInput.focus();
      return;
    }
    // Quick-add in a smart view files to the default list; in a list
    // view it files to that list (store.targetListId decides).
    const task = this.store.addTask({
      title,
      listId: this.store.targetListId(),
      dueDate: this.draft.dueDate,
      reminderAt: this.draft.reminderAt,
      flagged: this.draft.flagged,
      priority: this.draft.priority,
    });
    this.composerInput.value = '';
    this.draft = { ...DEFAULT_DRAFT };
    this.renderComposerChips();
    this.renderAll();
    this.composerInput.focus();

    // If the fresh task is invisible here (e.g. a dateless task added in
    // Today), follow it to where it landed — Apple's "added to Shopping".
    if (!this.sectionsEl.querySelector(`[data-id="${CSS.escape(task.id)}"]`)) {
      const list = this.store.listById(task.listId);
      this.switchView(list ? `list:${list.id}` : 'all');
      showToast(`Added to ${list ? list.name : 'Reminders'}`);
    }
  }

  private renderComposerChips(): void {
    const now = new Date();
    this.setChip(
      this.composerDate,
      this.draft.dueDate !== '',
      this.draft.dueDate ? formatDueChip(this.draft.dueDate, now) : 'Date',
    );
    this.setChip(
      this.composerRemind,
      this.draft.reminderAt !== '',
      this.draft.reminderAt ? formatReminderChip(this.draft.reminderAt, now) : 'Remind',
    );
    this.composerFlag.classList.toggle('is-set', this.draft.flagged);
    this.composerFlag.setAttribute('aria-pressed', String(this.draft.flagged));
    this.setChip(
      this.composerPriority,
      this.draft.priority !== 'none',
      priorityLabel(this.draft.priority),
    );
  }

  private setChip(button: HTMLButtonElement, isSet: boolean, label: string): void {
    button.classList.toggle('is-set', isSet);
    const span = button.querySelector('span');
    if (span) span.textContent = label;
  }

  // ========================================================================
  // The when-popover (date + reminder)
  // ========================================================================

  private bindWhenPopover(): void {
    this.whenPop.addEventListener('click', (event) => {
      const target = event.target as Element;
      const preset = target.closest<HTMLElement>('[data-when-preset]')?.dataset.whenPreset;
      if (preset) {
        const timeInput = this.whenPop.querySelector<HTMLInputElement>('[data-when-time]');
        const time =
          timeInput?.value || (this.whenMode === 'remind' ? '09:00' : this.currentWhenTime());
        const value = quickPresetIso(
          preset as 'today' | 'tomorrow' | 'weekend' | 'nextWeek',
          new Date(),
          time,
        );
        this.applyWhen(value);
        this.closePopovers();
        return;
      }
      if (target.closest('[data-when-clear]')) {
        this.applyWhen('');
        this.closePopovers();
      }
    });
    this.whenPop.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches('[data-when-date],[data-when-time]')) return;
      const dateInput = this.whenPop.querySelector<HTMLInputElement>('[data-when-date]');
      const timeInput = this.whenPop.querySelector<HTMLInputElement>('[data-when-time]');
      let dateValue = dateInput?.value ?? '';
      const timeValue = timeInput?.value ?? '';
      // Typing a time first pins the date to today (a reminder needs a day).
      if (!dateValue && input.matches('[data-when-time]') && timeValue) {
        const now = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        dateValue = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        if (dateInput) dateInput.value = dateValue;
      }
      if (!dateValue) return; // nothing to build yet
      const effectiveTime = this.whenMode === 'remind' && !timeValue ? '09:00' : timeValue;
      this.applyWhen(dateAndTimeToIso(dateValue, effectiveTime));
    });
  }

  /** The time half of the value being edited, for preset carries. */
  private currentWhenTime(): string {
    const iso = this.currentWhenIso();
    return iso ? isoToDateAndTime(iso).time : '';
  }

  private currentWhenIso(): string {
    if (!this.whenTarget) return '';
    if (this.whenTarget.kind === 'draft') {
      return this.whenMode === 'date' ? this.draft.dueDate : this.draft.reminderAt;
    }
    const task = this.store.taskById(this.whenTarget.id);
    if (!task) return '';
    return this.whenMode === 'date' ? task.dueDate : task.reminderAt;
  }

  private openWhen(
    target: { kind: 'draft' } | { kind: 'task'; id: string },
    mode: 'date' | 'remind',
  ): void {
    this.closePopovers();
    this.whenTarget = target;
    this.whenMode = mode;
    this.whenPop.innerHTML = whenPopover(mode);
    const { date, time } = isoToDateAndTime(this.currentWhenIso());
    this.whenPop.querySelector<HTMLInputElement>('[data-when-date]')!.value = date;
    this.whenPop.querySelector<HTMLInputElement>('[data-when-time]')!.value = time;

    const anchor =
      target.kind === 'draft'
        ? this.composerDetails
        : this.wrapFor(target.id)?.querySelector('.tk-editor-chips');
    if (!anchor) return;
    anchor.appendChild(this.whenPop);
    this.whenPop.hidden = false;
    if (mode === 'remind') {
      this.whenPop.querySelector<HTMLInputElement>('[data-when-time]')?.focus();
    }
  }

  private applyWhen(value: string): void {
    if (!this.whenTarget) return;
    if (this.whenTarget.kind === 'draft') {
      if (this.whenMode === 'date') this.draft.dueDate = value;
      else this.draft.reminderAt = value;
      this.renderComposerChips();
      return;
    }
    const id = this.whenTarget.id;
    const patch = this.whenMode === 'date' ? { dueDate: value } : { reminderAt: value };
    this.store.updateTask(id, patch);
    // Update the chips in place — re-rendering would close the editor.
    const button = this.wrapFor(id)?.querySelector<HTMLButtonElement>(
      `[data-editor-when="${this.whenMode}"]`,
    );
    const now = new Date();
    if (this.whenMode === 'date') {
      this.setChip(button!, value !== '', value ? formatDueChip(value, now) : 'Date');
    } else {
      this.setChip(button!, value !== '', value ? formatReminderChip(value, now) : 'Remind');
    }
    this.refreshRowChips(id);
    this.renderNav();
  }

  // ========================================================================
  // The priority menu
  // ========================================================================

  private bindPriorityMenu(): void {
    this.prioMenu.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('[data-priority]');
      if (!item) return;
      const priority = item.dataset.priority as Priority;
      if (this.prioTarget?.kind === 'draft') {
        this.draft.priority = priority;
        this.renderComposerChips();
      } else if (this.prioTarget?.kind === 'task') {
        const id = this.prioTarget.id;
        this.store.updateTask(id, { priority });
        const button = this.wrapFor(id)?.querySelector<HTMLButtonElement>('[data-editor-priority]');
        if (button) this.setChip(button, priority !== 'none', priorityLabel(priority));
        this.refreshRowChips(id);
      }
      this.closePopovers();
    });
  }

  private openPriorityMenu(target: { kind: 'draft' } | { kind: 'task'; id: string }): void {
    this.closePopovers();
    this.prioTarget = target;
    const current =
      target.kind === 'draft'
        ? this.draft.priority
        : (this.store.taskById(target.id)?.priority ?? 'none');
    this.prioMenu.innerHTML = priorityMenu(current);
    const anchor =
      target.kind === 'draft'
        ? this.composerDetails
        : this.wrapFor(target.id)?.querySelector('.tk-editor-chips');
    if (!anchor) return;
    anchor.appendChild(this.prioMenu);
    this.prioMenu.hidden = false;
    this.prioMenu.querySelector<HTMLElement>('.tk-menu-item')?.focus();
  }

  private closePopovers(): void {
    // Pull focus out of the doomed popovers FIRST: Chromium fires focusout
    // (relatedTarget null) when a focused node is removed, and the editor's
    // commit handler would read that as "the user left" — selecting a
    // priority or a date preset used to close the whole editor. Park focus
    // where the popover lived: the editor's title, or the composer input.
    const active = document.activeElement;
    if (
      active instanceof Node &&
      (this.whenPop.contains(active) || this.prioMenu.contains(active))
    ) {
      const form = active instanceof Element ? active.closest<HTMLElement>('.tk-editor') : null;
      (form?.querySelector<HTMLElement>('.tk-editor-title') ?? this.composerInput).focus();
    }
    this.whenPop.remove();
    this.whenPop.hidden = true;
    this.prioMenu.remove();
    this.prioMenu.hidden = true;
    this.whenTarget = null;
    this.prioTarget = null;
  }

  private popoverClosed(): boolean {
    return this.whenPop.hidden && this.prioMenu.hidden;
  }

  // ========================================================================
  // Lists: add (inline), rename / delete / clear (Swal flows)
  // ========================================================================

  private openAddListForm(): void {
    if (this.listsGroup.querySelector('.tk-list-add-form')) return;
    const form = document.createElement('div');
    form.className = 'tk-list-add-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'List name';
    input.maxLength = 80;
    input.setAttribute('aria-label', 'New list name');
    form.appendChild(input);
    this.addListButton.hidden = true;
    this.addListButton.insertAdjacentElement('beforebegin', form);
    input.focus();

    // Enter and blur can both land in one interaction (and Chromium can
    // fire the blur DURING the removal — the tab-rename race, again); the
    // settle-once flag plus the tolerant remove() is the same cure.
    let settled = false;
    const finish = (name: string): void => {
      if (settled) return;
      settled = true;
      try {
        form.remove();
      } catch {
        /* already torn down mid-blur */
      }
      this.addListButton.hidden = false;
      if (name.trim()) {
        const list = this.store.addList(name);
        this.switchView(`list:${list.id}`);
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        finish('');
      }
    });
    input.addEventListener('blur', (event) => {
      // The modal's shown-time focus enforcement can land here mid-typing
      // when the user outpaces the open transition — that blur is not the
      // user leaving (same guard the row editor uses).
      if (event.relatedTarget === this.modal) return;
      finish(input.value);
    });
  }

  private async renameListFlow(): Promise<void> {
    const list = this.store.listForView(this.store.view);
    if (!list) return;
    const result = (await Swal.fire({
      title: 'Rename list',
      input: 'text',
      inputValue: list.name,
      showCancelButton: true,
      confirmButtonText: 'Rename',
      confirmButtonColor: 'var(--vz-primary, #0070f3)',
      inputValidator: (value: string) => (value.trim() ? null : 'Enter a name.'),
    })) as SweetAlertResult<string>;
    if (result.isConfirmed && typeof result.value === 'string') {
      this.store.renameList(list.id, result.value);
      this.renderAll();
    }
  }

  private async deleteListFlow(): Promise<void> {
    const list = this.store.listForView(this.store.view);
    if (!list) return;
    const result = await Swal.fire({
      title: `Delete “${list.name}”?`,
      text: 'Its reminders move to your default list.',
      showCancelButton: true,
      confirmButtonText: 'Delete',
      confirmButtonColor: 'var(--vz-danger, #ee0000)',
    });
    if (result.isConfirmed) {
      this.store.deleteList(list.id);
      this.switchView('all');
      showToast('List deleted');
    }
  }

  private async clearCompletedFlow(): Promise<void> {
    const result = await Swal.fire({
      title: 'Clear completed reminders?',
      text: 'Every checked-off reminder will be removed.',
      showCancelButton: true,
      confirmButtonText: 'Clear',
      confirmButtonColor: 'var(--vz-danger, #ee0000)',
    });
    if (!result.isConfirmed) return;
    for (const task of this.store.tasks.filter((t) => t.completed)) {
      this.store.deleteTask(task.id);
    }
    dismissReminderToasts();
    this.renderAll();
    showToast('Completed reminders cleared');
  }

  // ========================================================================
  // Drag reorder helpers
  // ========================================================================

  private endDrag(): void {
    if (this.dragId) {
      this.wrapFor(this.dragId)?.classList.remove('is-dragging');
    }
    this.dragId = null;
    this.sectionsEl
      .querySelectorAll('.tk-task-wrap.is-drag-over')
      .forEach((el) => el.classList.remove('is-drag-over'));
  }
}
