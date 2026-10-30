/**
 * Task list notes — the list page controller.
 *
 * The behavior engine for the tasks surface: renders one note's list as
 * a page inside the editor host (header + rows + the composer bar riding
 * the bottom), and owns every interaction — completing, the inline
 * detail editor, the shared popovers (when-picker, priority, move, color),
 * drag-to-reorder, and the composer's quick-add draft.
 *
 * Ported from the retired modal's controller (features/tasks/index.ts,
 * PRs #143/#144): the in-place chip refreshes and the focus-sparing
 * re-renders that battle taught us survive here verbatim in spirit —
 * the modal's shown-time focus enforcement is gone with the modal, which
 * deletes an entire class of the bugs we pinned there.
 *
 * The controller never persists by itself: every model mutation calls
 * back `announce()` (the surface's input event on the host — the one
 * signal autosave follows) and the shell's save loop captures the model
 * through the surface. Renames ride `onRename` (the surface writes the
 * tab name). Moving a task to another note rides `onMoveTask`.
 */

import { ICONS } from './icons';
import {
  completedToggle,
  editor as editorMarkup,
  emptyStateFor,
  isoDayKey,
  moveMenu,
  colorMenu,
  monthGrid,
  rowChips,
  taskRow,
  whenPopover,
  type ListRef,
} from './rows';
import { parseQuickAdd } from './nl-dates';
import {
  dateAndTimeToIso,
  formatDueChip,
  formatReminderChip,
  isoToDateAndTime,
  quickPresetIso,
} from './dates';
import { buildTask, sanitizeTask, type Task, type TaskNoteContent } from './content';
import { confirmDialog } from '../../ui/dialog';
import { showToast } from '../../ui/toast';

/** What the page asks the world around it to do. */
export interface TaskPageHooks {
  /** Announce a model mutation (autosave listens; the surface wires it). */
  announce: () => void;
  /** Commit the list's new name (the surface renames the note). */
  onRename: (name: string) => void;
  /** The other task notes — Move menus list them; empty means no chip. */
  listsProvider: () => ListRef[];
  /** Move a task (already removed from this model) into another note. */
  onMoveTask: (task: Task, targetNoteId: string) => void;
  /** The note's CURRENT id, read at call time — the live page is reused
   *  across tasks-to-tasks switches, and a captured-first-mount id would
   *  rename the WRONG note (Move menus must exclude the RIGHT self too). */
  noteId: () => string | null;
  /** Removes a task's open reminder toasts (the sweep owns them). */
  dismissToasts?: (taskId?: string) => void;
}

/** What the quick-add's chips know before the task exists. */
interface ComposerDraft {
  dueDate: string;
  flagged: boolean;
}

const DEFAULT_DRAFT: ComposerDraft = {
  dueDate: '',
  flagged: false,
};

export class TaskListPageController {
  private readonly root: HTMLElement;
  private readonly hooks: TaskPageHooks;

  private model: TaskNoteContent;

  private readonly titleInput: HTMLInputElement;
  private readonly colorDot: HTMLElement;
  private readonly colorButton: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly clearDone: HTMLButtonElement;
  private readonly sectionsEl: HTMLElement;
  private readonly emptyEl: HTMLElement;

  private readonly quickAdd: HTMLElement;
  private readonly composerInput: HTMLInputElement;
  private readonly quickAddLive: HTMLElement;
  private readonly composerDate: HTMLButtonElement;
  private readonly composerFlag: HTMLButtonElement;

  private readonly whenPop = document.createElement('div');
  private readonly movePop = document.createElement('div');
  private readonly colorPop = document.createElement('div');

  private completedExpanded = false;
  private editingId: string | null = null;
  private draft: ComposerDraft = { ...DEFAULT_DRAFT };

  /** What the when-popover is currently editing (quick-add draft vs a task). */
  private whenTarget: { kind: 'draft' } | { kind: 'task'; id: string } | null = null;
  private whenMode: 'date' | 'remind' = 'date';
  /** The month the popover's grid shows (prev/next walks it). */
  private whenView: { year: number; month: number } = { year: 0, month: 0 };
  private moveTargetId: string | null = null;
  private dragId: string | null = null;

  constructor(root: HTMLElement, model: TaskNoteContent, name: string, hooks: TaskPageHooks) {
    this.root = root;
    this.model = model;
    this.hooks = hooks;

    this.titleInput = this.q<HTMLInputElement>('.tkp-title');
    this.colorDot = this.q('.tkp-color .tk-dot');
    this.colorButton = this.q<HTMLButtonElement>('.tkp-color');
    this.countEl = this.q('.tkp-count');
    this.clearDone = this.q<HTMLButtonElement>('[data-action="clear-completed"]');
    this.sectionsEl = this.q('.tk-sections');
    this.emptyEl = this.q('.tk-empty');
    this.quickAdd = this.q('.tk-quickadd');
    this.composerInput = this.q<HTMLInputElement>('[data-composer-input]');
    this.quickAddLive = this.q('[data-quickadd-live]');
    this.composerDate = this.q<HTMLButtonElement>('[data-composer-when="date"]');
    this.composerFlag = this.q<HTMLButtonElement>('[data-composer-flag]');

    this.titleInput.value = name;

    for (const pop of [this.whenPop, this.movePop, this.colorPop]) {
      pop.className = pop === this.whenPop ? 'tk-when' : 'tk-menu';
      pop.hidden = true;
    }

    this.bind();
    this.render();
  }

  // ========================================================================
  // Model access
  // ========================================================================

  getModel(): TaskNoteContent {
    return this.model;
  }

  /** True while this page's markup still lives in a document. */
  rootIsConnected(): boolean {
    return this.root.isConnected;
  }

  /**
   * A wholesale replacement (snapshot restore, external edit, hub write):
   * the open editor stands down, the fresh model paints.
   */
  setModel(model: TaskNoteContent, name?: string): void {
    this.editingId = null;
    this.closePopovers();
    this.model = model;
    if (name !== undefined && name !== this.titleInput.value) {
      this.titleInput.value = name;
    }
    this.render();
  }

  focusComposer(): void {
    this.composerInput.focus();
  }

  /** Focus for the surface: the page's typing home. */
  composerElement(): HTMLInputElement {
    return this.composerInput;
  }

  /** The list's title input (the rename field in the page header). */
  titleElement(): HTMLInputElement {
    return this.titleInput;
  }

  /**
   * Where a note switch lands the caret: a list that never got a name
   * opens on its TITLE (Apple's new-list flow — name it first); a
   * named list goes straight to the composer.
   */
  focusTarget(): HTMLInputElement {
    return this.titleInput.value.trim() === '' ? this.titleInput : this.composerInput;
  }

  /** Stands down: popovers out of the document, state parked. */
  standDown(): void {
    this.closePopovers();
  }

  // ========================================================================
  // Rendering
  // ========================================================================

  private q<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`Tasks page markup missing ${selector}`);
    return el;
  }

  private render(): void {
    const now = new Date();
    const color = this.model.color;
    this.root.classList.remove(
      'tk-c-blue',
      'tk-c-red',
      'tk-c-orange',
      'tk-c-green',
      'tk-c-purple',
      'tk-c-teal',
    );
    this.root.classList.add(`tk-c-${color}`);
    this.colorDot.className = `tk-dot`;

    const active = this.model.tasks.filter((task) => !task.completed);
    const completed = this.completedTasks();

    this.countEl.textContent = String(active.length);
    this.clearDone.hidden = completed.length === 0;

    this.sectionsEl.innerHTML = active.map((task) => taskRow(task, now, color, true)).join('');
    if (completed.length > 0) {
      const doneRows = completed.map((task) => taskRow(task, now, color, false)).join('');
      this.sectionsEl.insertAdjacentHTML(
        'beforeend',
        completedToggle(completed.length, this.completedExpanded, doneRows),
      );
    }

    const empty = active.length === 0 && completed.length === 0;
    this.emptyEl.hidden = !empty;
    if (empty) {
      this.emptyEl.innerHTML = emptyStateFor('list');
    }
  }

  private completedTasks(): Task[] {
    return this.model.tasks
      .filter((task) => task.completed)
      .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  }

  private taskById(id: string): Task | null {
    return this.model.tasks.find((task) => task.id === id) ?? null;
  }

  private wrapFor(id: string): HTMLElement | null {
    return this.sectionsEl.querySelector<HTMLElement>(`.tk-task-wrap[data-id="${CSS.escape(id)}"]`);
  }

  private mutate(fn: () => void): void {
    fn();
    this.hooks.announce();
  }

  // ========================================================================
  // Event wiring (delegated on the page root — dies with the markup)
  // ========================================================================

  private bind(): void {
    // ---- the header: rename, color, clear completed ----
    const commitRename = (): void => {
      const raw = this.titleInput.value.trim();
      if (raw && raw !== this.titleInput.dataset.committed) {
        this.titleInput.dataset.committed = raw;
        this.hooks.onRename(raw);
      }
    };
    this.titleInput.dataset.committed = this.titleInput.value;
    this.titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename();
        this.composerInput.focus();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        this.titleInput.value = this.titleInput.dataset.committed ?? '';
        this.composerInput.focus();
      }
    });
    this.titleInput.addEventListener('blur', commitRename);

    this.colorButton.addEventListener('click', () => this.openColorMenu());
    this.clearDone.addEventListener('click', () => void this.clearCompletedFlow());

    // ---- rows, editors, the completed toggle ----
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
        this.render();
        return;
      }
      if (wrap && target.closest('.tk-editor-chips')) {
        const when = target.closest<HTMLElement>('[data-editor-when]');
        if (when && id) {
          this.openWhen(
            { kind: 'task', id },
            when.dataset.editorWhen === 'remind' ? 'remind' : 'date',
            when.closest('.tk-editor-chips'),
          );
          return;
        }
        if (target.closest('[data-editor-flag]') && id) {
          this.toggleFlag(id);
          return;
        }
        if (target.closest('[data-editor-move]') && id) {
          this.openMoveMenu(id);
          return;
        }
        if (target.closest('[data-editor-delete]') && id) {
          this.deleteTask(id);
          return;
        }
        return; // clicks inside the editor elsewhere never open/close rows
      }
      // The row's hover tools: date + flag without opening the accordion.
      if (wrap && target.closest('[data-row-when]') && id) {
        this.openWhen({ kind: 'task', id }, 'date', target.closest('.tk-rowtools'));
        return;
      }
      if (wrap && target.closest('[data-row-flag]') && id) {
        this.toggleFlag(id);
        return;
      }
      if (wrap && target.closest('.tk-task-main')) {
        this.toggleEditor(id!);
      }
    });

    // Editor commit when focus leaves the form (popover interactions stay inside).
    this.sectionsEl.addEventListener('focusout', (event) => {
      const form = (event.target as Element).closest('.tk-editor');
      if (!form) return;
      const next = event.relatedTarget;
      if (next instanceof Node && form.contains(next)) return;
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

    // ---- drag-to-reorder ----
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
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'move';
      wrap.classList.add('is-drag-over');
    });
    this.sectionsEl.addEventListener('drop', (event) => {
      if (!this.dragId) return;
      const wrap = (event.target as Element).closest<HTMLElement>('.tk-task-wrap[draggable]');
      if (wrap && wrap.dataset.id && wrap.dataset.id !== this.dragId) {
        event.preventDefault();
        this.moveTaskBefore(this.dragId, wrap.dataset.id);
      }
      this.endDrag();
    });
    this.sectionsEl.addEventListener('dragend', () => this.endDrag());

    // ---- the quick-add ----
    this.composerInput.addEventListener('input', () => this.renderQuickAddLive());
    this.composerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitComposer();
      }
    });
    this.composerDate.addEventListener('click', () => this.openWhen({ kind: 'draft' }, 'date'));
    this.composerFlag.addEventListener('click', () => {
      this.draft.flagged = !this.draft.flagged;
      this.renderQuickAddChips();
    });

    // ---- popovers: shared wiring ----
    this.bindWhenPopover();
    this.bindMoveMenu();
    this.bindColorMenu();

    // Outside click closes whichever popover is open.
    this.outsideClick = (event: MouseEvent): void => {
      if (this.popoverClosed()) return;
      const target = event.target instanceof Element ? event.target : null;
      // A click whose target the click itself destroyed (the popover
      // re-rendered its grid mid-bubble) is not an outside click.
      if (target && !target.isConnected) return;
      if (
        target &&
        (this.whenPop.contains(target) ||
          this.movePop.contains(target) ||
          this.colorPop.contains(target) ||
          target.closest(
            '[data-editor-when],[data-editor-move],[data-row-when],[data-composer-when],.tkp-color,.tk-rowtools',
          ))
      ) {
        return;
      }
      this.closePopovers();
    };
    document.addEventListener('click', this.outsideClick);

    // Escape, consumed inside the page before the document's close-all:
    // popovers first, then the open editor (the music player's row menu
    // pattern — see CONTRIBUTING's layering rules).
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!this.popoverClosed()) {
        this.closePopovers();
        event.stopPropagation();
      } else if (this.editingId) {
        this.closeEditor(false);
        event.stopPropagation();
      }
    });
  }

  private outsideClick: (event: MouseEvent) => void = () => {};

  /** Detaches the document-level listener (dismiss calls this). */
  dispose(): void {
    document.removeEventListener('click', this.outsideClick);
    this.standDown();
  }

  // ========================================================================
  // Completing tasks
  // ========================================================================

  private toggleComplete(id: string): void {
    const task = this.taskById(id);
    if (!task) return;
    this.mutate(() => {
      task.completed = !task.completed;
      task.completedAt = task.completed ? new Date().toISOString() : '';
      task.updatedAt = new Date().toISOString();
    });
    if (!task.completed) {
      this.render();
      return;
    }
    // Paint the circle immediately; let the row sink after the animation.
    const taskEl = this.wrapFor(id)?.querySelector('.tk-task');
    if (taskEl) {
      taskEl.classList.add('is-done');
      taskEl.querySelector('.tk-check')?.setAttribute('aria-checked', 'true');
    }
    window.setTimeout(() => this.render(), 460);
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
    const task = this.taskById(id);
    if (!wrap || !task) return;

    this.editingId = id;
    wrap.classList.add('is-editing');
    const holder = wrap.querySelector<HTMLElement>('.tk-editor')!;
    holder.innerHTML = editorMarkup(task, new Date(), this.otherLists());
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
        const original = this.taskById(id!);
        if (original && (title || notes)) {
          const nextTitle = (title?.value ?? original.title).trim();
          const nextNotes = notes?.value ?? original.notes;
          if (nextTitle !== original.title || nextNotes !== original.notes) {
            // An emptied title falls back to the original (legacy rule).
            this.mutate(() => {
              original.title = nextTitle || original.title;
              original.notes = nextNotes;
              original.updatedAt = new Date().toISOString();
            });
          }
        }
      }
      if (holder) {
        holder.hidden = true;
        holder.innerHTML = '';
      }
    }
    this.render();
  }

  private toggleFlag(id: string): void {
    const task = this.taskById(id);
    if (!task) return;
    this.mutate(() => {
      task.flagged = !task.flagged;
      task.updatedAt = new Date().toISOString();
    });
    this.refreshEditorFlag(id);
    // No render here — it would rebuild the rows and destroy the open
    // editor the flag was toggled from. The chips update in place; the
    // view itself re-syncs on the editor's closing render.
    this.refreshRowChips(id);
  }

  /** Replaces a row's chips (date / reminder / flag) in place. */
  private refreshRowChips(id: string): void {
    const task = this.taskById(id);
    const main = this.wrapFor(id)?.querySelector<HTMLElement>('.tk-task-main');
    if (!task || !main) return;
    const title = main.querySelector('.tk-title');
    const notes = main.querySelector('.tk-notes');
    const origin = main.querySelector('.tk-origin');
    const current = main.querySelector('.tk-chips');
    const fresh = rowChips(task, new Date());
    const anchor = origin ?? notes ?? title;
    if (current && fresh) {
      current.outerHTML = fresh;
    } else if (current) {
      current.remove();
    } else if (fresh && anchor) {
      anchor.insertAdjacentHTML('afterend', fresh);
    }
    // The hover tools' flag icon rides the state too.
    const flagTool = this.wrapFor(id)?.querySelector<HTMLElement>('[data-row-flag]');
    if (flagTool) {
      flagTool.innerHTML = task.flagged ? ICONS.flagFilled : ICONS.flag;
    }
  }

  private refreshEditorFlag(id: string): void {
    const task = this.taskById(id);
    const button = this.wrapFor(id)?.querySelector<HTMLButtonElement>('[data-editor-flag]');
    if (!task || !button) return;
    button.classList.toggle('is-set', task.flagged);
    button.setAttribute('aria-pressed', String(task.flagged));
    button.innerHTML = `${task.flagged ? ICONS.flagFilled : ICONS.flag}<span>Flag</span>`;
  }

  private deleteTask(id: string): void {
    this.mutate(() => {
      this.model.tasks = this.model.tasks.filter((task) => task.id !== id);
    });
    this.hooks.dismissToasts?.(id);
    this.editingId = null;
    this.render();
    showToast('Reminder deleted');
  }

  // ========================================================================
  // The quick-add
  // ========================================================================

  private draftIsSet(): boolean {
    return this.draft.dueDate !== '' || this.draft.flagged;
  }

  private submitComposer(): void {
    const raw = this.composerInput.value.trim();
    if (!raw) {
      this.composerInput.focus();
      return;
    }
    // The natural language speaks first: when-words at the end of the
    // line become dates; the explicit draft chips override them.
    const parsed = parseQuickAdd(raw, new Date());
    const title = parsed.matched.length > 0 ? parsed.title : raw;
    const dueDate = this.draft.dueDate || parsed.dueDate;
    const reminderAt = parsed.reminderAt;
    const minOrder =
      this.model.tasks.length > 0 ? Math.min(...this.model.tasks.map((task) => task.sortOrder)) : 0;
    this.mutate(() => {
      this.model.tasks.unshift(
        buildTask({ title, dueDate, reminderAt, flagged: this.draft.flagged }, minOrder),
      );
    });
    this.composerInput.value = '';
    this.draft = { ...DEFAULT_DRAFT };
    this.renderQuickAddChips();
    this.quickAddLive.hidden = true;
    this.render();
    this.composerInput.focus();
  }

  /** The live NL chip: what the parse reads in the current input. */
  private renderQuickAddLive(): void {
    const raw = this.composerInput.value.trim();
    if (!raw) {
      this.quickAddLive.hidden = true;
      this.quickAddLive.textContent = '';
      return;
    }
    const parsed = parseQuickAdd(raw, new Date());
    const now = new Date();
    const label = parsed.dueDate
      ? formatDueChip(parsed.dueDate, now)
      : parsed.reminderAt
        ? `Reminds ${formatReminderChip(parsed.reminderAt, now)}`
        : '';
    if (!label || parsed.matched.length === 0) {
      this.quickAddLive.hidden = true;
      this.quickAddLive.textContent = '';
      return;
    }
    this.quickAddLive.textContent = label;
    this.quickAddLive.hidden = false;
  }

  private renderQuickAddChips(): void {
    const now = new Date();
    this.setChip(
      this.composerDate,
      this.draft.dueDate !== '',
      this.draft.dueDate ? formatDueChip(this.draft.dueDate, now) : 'Date',
    );
    this.composerFlag.classList.toggle('is-set', this.draft.flagged);
    this.composerFlag.setAttribute('aria-pressed', String(this.draft.flagged));
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
      // The grid's day buttons: pick the day and close — the decisive
      // flow (a time can follow through a reopen; the picked day stays
      // selected and the time field carries over).
      const day = target.closest<HTMLElement>('[data-when-day]')?.dataset.whenDay;
      if (day) {
        this.applyWhen(dateAndTimeToIso(day, this.currentWhenTime()));
        this.closePopovers();
        return;
      }
      // Prev/next walks the grid's month without touching the value.
      const nav = target.closest<HTMLElement>('[data-when-nav]')?.dataset.whenNav;
      if (nav) {
        const step = Number(nav);
        this.whenView = {
          year:
            this.whenView.year +
            (this.whenView.month + step < 0 ? -1 : this.whenView.month + step > 11 ? 1 : 0),
          month: (this.whenView.month + step + 12) % 12,
        };
        this.rerenderWhenPopover();
        return;
      }
      if (target.closest('[data-when-clear]')) {
        this.applyWhen('');
        this.closePopovers();
      }
    });
    this.whenPop.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches('[data-when-time]')) return;
      // The grid's selected day (or today) carries the typed time.
      const selected = this.whenPop.querySelector<HTMLElement>('.tk-wgrid-day.is-selected');
      const day = selected?.getAttribute('data-when-day') ?? isoDayKey(new Date().toISOString());
      const effectiveTime = this.whenMode === 'remind' && !input.value ? '09:00' : input.value;
      this.applyWhen(dateAndTimeToIso(day, effectiveTime));
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
      return this.whenMode === 'date' ? this.draft.dueDate : '';
    }
    const task = this.taskById(this.whenTarget.id);
    if (!task) return '';
    return this.whenMode === 'date' ? task.dueDate : task.reminderAt;
  }

  private openWhen(
    target: { kind: 'draft' } | { kind: 'task'; id: string },
    mode: 'date' | 'remind',
    anchor?: Element | null,
  ): void {
    this.closePopovers();
    this.whenTarget = target;
    this.whenMode = mode;
    const selected = this.currentWhenIso();
    const base = selected ? new Date(selected) : new Date();
    this.whenView = { year: base.getFullYear(), month: base.getMonth() };
    this.whenPop.innerHTML = whenPopover(mode, this.whenView, selected, new Date());

    if (!anchor) {
      anchor =
        target.kind === 'draft'
          ? this.quickAdd
          : this.wrapFor(target.id)?.querySelector('.tk-rowtools');
    }
    if (!anchor) return;
    anchor.appendChild(this.whenPop);
    this.whenPop.hidden = false;
    if (mode === 'remind') {
      this.whenPop.querySelector<HTMLInputElement>('[data-when-time]')?.focus();
    }
  }

  /** Repaints the popover's grid after a day pick (the selection moves). */
  private rerenderWhenGrid(selectedKey: string): void {
    const grid = this.whenPop.querySelector<HTMLElement>('[data-when-grid]');
    if (!grid) return;
    grid.outerHTML = monthGrid(this.whenView.year, this.whenView.month, selectedKey, new Date());
  }

  /** Repaints the whole popover body after a month walk (keeps the time). */
  private rerenderWhenPopover(): void {
    const timeInput = this.whenPop.querySelector<HTMLInputElement>('[data-when-time]');
    const time = timeInput?.value ?? '';
    const selected = this.whenPop.querySelector<HTMLElement>('.tk-wgrid-day.is-selected');
    const selectedKey = selected?.getAttribute('data-when-day') ?? this.currentWhenIso();
    this.whenPop.innerHTML = whenPopover(this.whenMode, this.whenView, selectedKey, new Date());
    const fresh = this.whenPop.querySelector<HTMLInputElement>('[data-when-time]');
    if (fresh && time) fresh.value = time;
  }

  private applyWhen(value: string): void {
    if (!this.whenTarget) return;
    if (this.whenTarget.kind === 'draft') {
      if (this.whenMode === 'date') this.draft.dueDate = value;
      this.renderQuickAddChips();
      return;
    }
    const id = this.whenTarget.id;
    const task = this.taskById(id);
    if (!task) return;
    this.mutate(() => {
      if (this.whenMode === 'date') {
        task.dueDate = value;
      } else {
        task.reminderAt = value;
        // A changed time re-arms the sweep.
        task.reminderNotifiedAt = '';
      }
      task.updatedAt = new Date().toISOString();
    });
    // Update the chips in place — re-rendering would close the editor.
    const button = this.wrapFor(id)?.querySelector<HTMLButtonElement>(
      `[data-editor-when="${this.whenMode}"]`,
    );
    const now = new Date();
    if (button) {
      if (this.whenMode === 'date') {
        this.setChip(button, value !== '', value ? formatDueChip(value, now) : 'Date');
      } else {
        this.setChip(button, value !== '', value ? formatReminderChip(value, now) : 'Remind');
      }
    }
    this.refreshRowChips(id);
  }

  // ========================================================================
  // The move menu (between notes) + the color menu
  // ========================================================================

  private otherLists(): ListRef[] {
    const lists = this.hooks.listsProvider();
    const ownId = this.hooks.noteId();
    return ownId ? lists.filter((list) => list.id !== ownId) : lists;
  }

  private bindMoveMenu(): void {
    this.movePop.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('[data-move-to]');
      const id = this.moveTargetId;
      if (!item || !id) return;
      const targetNoteId = item.dataset.moveTo ?? '';
      const wrap = this.wrapFor(id);
      const task = this.taskById(id);
      if (!task || !wrap) return;

      // The editor's live title/notes travel with the task.
      const titleEl = wrap.querySelector<HTMLInputElement>('.tk-editor-title');
      const notesEl = wrap.querySelector<HTMLTextAreaElement>('.tk-editor-notes');
      if (titleEl?.value.trim()) task.title = titleEl.value.trim();
      if (notesEl) task.notes = notesEl.value;

      const moving: Task = sanitizeTask(task) ?? task;
      this.mutate(() => {
        this.model.tasks = this.model.tasks.filter((entry) => entry.id !== id);
      });
      this.editingId = null;
      this.render();
      this.closePopovers();
      this.hooks.onMoveTask(moving, targetNoteId);
    });
  }

  private openMoveMenu(id: string): void {
    const lists = this.otherLists();
    if (lists.length === 0) return;
    this.closePopovers();
    this.moveTargetId = id;
    this.movePop.innerHTML = moveMenu(lists, this.hooks.noteId());
    const anchor = this.wrapFor(id)?.querySelector('.tk-editor-chips');
    if (!anchor) return;
    anchor.appendChild(this.movePop);
    this.movePop.hidden = false;
    this.movePop.querySelector<HTMLElement>('.tk-menu-item')?.focus();
  }

  private bindColorMenu(): void {
    this.colorPop.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('[data-list-color]');
      if (!item) return;
      const color = item.dataset.listColor as TaskNoteContent['color'];
      this.mutate(() => {
        this.model.color = color;
      });
      this.closePopovers();
      this.render();
    });
  }

  private openColorMenu(): void {
    this.closePopovers();
    this.colorPop.innerHTML = colorMenu(this.model.color);
    this.colorButton.appendChild(this.colorPop);
    this.colorPop.hidden = false;
    this.colorPop.querySelector<HTMLElement>('.tk-menu-item')?.focus();
  }

  // ========================================================================
  // Popover plumbing
  // ========================================================================

  protected closePopovers(): void {
    // Pull focus out of the doomed popovers FIRST: Chromium fires focusout
    // (relatedTarget null) when a focused node is removed, and the editor's
    // commit handler would read that as "the user left" — selecting a
    // date preset used to close the whole editor. Park focus
    // where the popover lived: the editor's title, or the composer input.
    const active = document.activeElement;
    if (
      active instanceof Node &&
      (this.whenPop.contains(active) ||
        this.movePop.contains(active) ||
        this.colorPop.contains(active))
    ) {
      const form = active instanceof Element ? active.closest<HTMLElement>('.tk-editor') : null;
      (form?.querySelector<HTMLElement>('.tk-editor-title') ?? this.composerInput).focus();
    }
    for (const pop of [this.whenPop, this.movePop, this.colorPop]) {
      pop.remove();
      pop.hidden = true;
    }
    this.whenTarget = null;
    this.moveTargetId = null;
  }

  private popoverClosed(): boolean {
    return this.whenPop.hidden && this.movePop.hidden && this.colorPop.hidden;
  }

  // ========================================================================
  // Clear completed
  // ========================================================================

  private async clearCompletedFlow(): Promise<void> {
    const count = this.completedTasks().length;
    if (count === 0) return;
    const confirmed = await confirmDialog({
      title: 'Clear completed reminders?',
      text: 'Every checked-off reminder will be removed from this list.',
      danger: true,
      confirm: 'Clear',
    });
    if (!confirmed) return;
    this.mutate(() => {
      this.model.tasks = this.model.tasks.filter((task) => !task.completed);
    });
    this.hooks.dismissToasts?.();
    this.completedExpanded = false;
    this.render();
    showToast('Completed reminders cleared');
  }

  // ========================================================================
  // Drag reorder helpers
  // ========================================================================

  private moveTaskBefore(id: string, targetId: string): void {
    const from = this.model.tasks.findIndex((task) => task.id === id);
    const to = this.model.tasks.findIndex((task) => task.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    this.mutate(() => {
      const [moved] = this.model.tasks.splice(from, 1);
      this.model.tasks.splice(to, 0, moved!);
      // Manual order is the array order now; re-stamp it.
      this.model.tasks.forEach((task, index) => {
        task.sortOrder = index;
      });
    });
    this.render();
  }

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
