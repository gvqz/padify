/**
 * The task list note surface — the 'json' content kind's editing surface.
 *
 * WHAT THE USER SEES. A note of type 'tasks' opens as the list page:
 * header (list color + inline-editable title + count), the task rows,
 * and the composer bar riding the bottom of the editor area. The note's
 * NAME is the list's name (renaming the title renames the note); the
 * note's CONTENT is the JSON model (editor/tasks/content.ts) — mutated
 * through the page and captured back on save, exactly like the Markdown
 * surface rides its source.
 *
 * HOW IT OWNS THE HOST (the Markdown surface's discipline, verbatim):
 * the host is set contenteditable=false and a page wrapper is mounted
 * inside it; the page's inputs are the editables. The html engine is
 * parked for the duration (ModelPort.setInert — app.ts wires it from
 * isHtmlContent, which is false for 'json' notes) so its listeners never
 * see the page's events.
 *
 * THE ANNOUNCE CONTRACT: user edits must surface as one bubbling `input`
 * event on the host — autosave, the word-count pill and the save
 * indicator all follow it. Every model mutation calls announce(); the
 * surface's own paints (display/commit/clear) never announce, so opening
 * a note never writes on its own.
 *
 * SURFACES ARE STATELESS SINGLETONS, so this module carries the one live
 * page (the app has one editor host) — the markdown surface's `live`
 * pattern. Other 'json' note kinds this build hasn't met ride the opaque
 * fallback: this surface only claims notes it knows how to draw.
 *
 * The seam OUT to the tasks feature (rail + hub + sweep live in
 * features/tasks — the architecture's feature-import rule): the
 * environment below. features/tasks/configure (via app.ts bootstrapping)
 * supplies the list of other task notes, the move handler, and the toast
 * dismissal; before that wiring lands the page still works, just without
 * its cross-note affordances. Editor code never imports the feature —
 * the feature reaches in.
 */

import { registerNoteSurface, type NoteSurface, type SurfaceNote } from '../surface';
import { opaqueNoteSurface } from '../surface';
import { getTabManager } from '../../tabs';
import { taskListPageMarkup } from './markup';
import { TaskListPageController } from './controller';
import type { ListRef } from './rows';
import {
  emptyTaskNoteContent,
  parseTaskNoteContent,
  serializeTaskNoteContent,
  taskNotePlainText,
  type Task,
  type TaskNoteContent,
} from './content';

// ---------------------------------------------------------------------------
// The environment — what the feature layer supplies
// ---------------------------------------------------------------------------

export interface TasksEnvironment {
  /** The task notes that exist (the Move menus list them). */
  listsProvider: () => ListRef[];
  /** Move a task between notes (the aggregate owns the write). */
  moveTaskToNote: (task: Task, targetNoteId: string) => void;
  /** Opens a note (origin chips, reminder toasts). */
  openNote: (noteId: string) => void;
  /** Removes reminder toasts (the sweep owns them). */
  dismissToasts: (taskId?: string) => void;
}

const defaultEnvironment: TasksEnvironment = {
  listsProvider: () => [],
  moveTaskToNote: () => undefined,
  openNote: () => undefined,
  dismissToasts: () => undefined,
};

let environment: TasksEnvironment = defaultEnvironment;

/**
 * Replaces parts of the environment. Called by the tasks feature's init
 * (app.ts) before notes restore, so the first paint already knows the
 * cross-note world.
 */
export function configureTasksEnvironment(next: Partial<TasksEnvironment>): void {
  environment = { ...environment, ...next };
}

/** The current environment (the page reads it per interaction). */
export function tasksEnvironment(): TasksEnvironment {
  return environment;
}

// ---------------------------------------------------------------------------
// Change notifications — the feature layer subscribes
// ---------------------------------------------------------------------------

type MutatedListener = () => void;
const mutatedListeners = new Set<MutatedListener>();

/** Fires after every user mutation of the live page's model. */
export function onTasksPageMutated(listener: MutatedListener): () => void {
  mutatedListeners.add(listener);
  return () => mutatedListeners.delete(listener);
}

function emitMutated(): void {
  for (const listener of mutatedListeners) listener();
}

// ---------------------------------------------------------------------------
// The live page
// ---------------------------------------------------------------------------

interface LiveTasksPage {
  host: HTMLElement;
  noteId: string | null;
  controller: TaskListPageController;
}

let live: LiveTasksPage | null = null;

/** True when the live page is this host's current paint. */
function liveFor(host: HTMLElement | null): LiveTasksPage | null {
  if (!live || !host || live.host !== host) return null;
  return live.controller.rootIsConnected() ? live : null;
}

function standDownLive(): void {
  if (!live) return;
  live.controller.dispose();
  live = null;
}

/**
 * The live page's model for a note — ahead of tab.content between saves
 * (the aggregate's writes consult it so a hub edit never clobbers words
 * still sitting in the page's debounce window). Null when the note is
 * not the live page.
 */
export function liveTasksModelFor(noteId: string): TaskNoteContent | null {
  return live && live.noteId === noteId && live.controller.rootIsConnected()
    ? live.controller.getModel()
    : null;
}

/**
 * An external write (the hub, the sweep, a sync merge) lands on a task
 * note: the live page repaints from the fresh content when it is the
 * note it is showing — and only when the bytes actually changed, so a
 * sweep stamping reminderNotifiedAt never flickers the rows.
 */
export function refreshTasksPageForNote(noteId: string, content: string, name?: string): void {
  const current = live;
  if (!current || current.noteId !== noteId || !current.controller.rootIsConnected()) return;
  if (serializeTaskNoteContent(current.controller.getModel()) === content) return;
  current.controller.setModel(parseTaskNoteContent(content), name);
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export class TasksNoteSurface implements NoteSurface {
  readonly kind = 'json' as const;
  readonly editable = true;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    // The page wrapper's inputs are the editables; the host must not be
    // one (nested editables scramble the caret).
    host.setAttribute('contenteditable', 'false');

    // No note open → the empty paint (nothing to show; the app always has
    // an active tab, this is the bare/pre-boot path).
    if (!note) {
      standDownLive();
      host.replaceChildren();
      host.scrollTop = 0;
      return;
    }

    // Another 'json' kind this build doesn't know (a board, a newer
    // type): the read-only card, never our page — its bytes stay safe.
    if (note.noteType !== 'tasks') {
      standDownLive();
      opaqueNoteSurface.display(host, note);
      return;
    }

    const model = parseTaskNoteContent(note.content ?? '');
    const name = typeof note.name === 'string' ? note.name : '';
    const noteId = typeof note.id === 'string' ? note.id : null;

    const existing = liveFor(host);
    if (existing) {
      // tasks → tasks (the common switch): reuse the mounted page.
      existing.noteId = noteId;
      existing.controller.setModel(model, name);
    } else {
      standDownLive();
      host.replaceChildren();
      host.insertAdjacentHTML('beforeend', taskListPageMarkup());
      const root = host.querySelector<HTMLElement>('[data-tasks-page]');
      if (root) {
        // The hooks read the LIVE object's noteId at call time: this page
        // is REUSED across tasks-to-tasks switches (existing.noteId moves),
        // and a captured-first-mount id would rename the wrong note.
        live = {
          host,
          noteId,
          controller: new TaskListPageController(root, model, name, {
            announce: () => {
              host.dispatchEvent(new InputEvent('input', { bubbles: true }));
              emitMutated();
            },
            onRename: (nextName) => {
              const current = live;
              const manager = getTabManager();
              if (manager && current?.noteId) {
                manager.renameTab(current.noteId, nextName);
              }
            },
            listsProvider: () => environment.listsProvider(),
            onMoveTask: (task, targetNoteId) => environment.moveTaskToNote(task, targetNoteId),
            noteId: () => live?.noteId ?? null,
            dismissToasts: (taskId) => environment.dismissToasts(taskId),
          }),
        };
      }
    }
    host.scrollTop = 0;
  }

  capture(host: HTMLElement | null): string | null {
    const current = liveFor(host);
    if (!current) return null;
    return serializeTaskNoteContent(current.controller.getModel());
  }

  visibleText(host: HTMLElement | null, note: SurfaceNote): string {
    const current = liveFor(host);
    const model = current ? current.controller.getModel() : parseTaskNoteContent(note.content);
    return taskNotePlainText(model);
  }

  commit(host: HTMLElement | null, content: string): boolean {
    if (host) {
      // This surface serves 'tasks' notes only (a future json kind
      // registers its own surface over the key); the snapshot restore
      // repaints the page from the restored bytes.
      this.display(host, { content, noteType: 'tasks' });
    }
    // The caller owns the persist — no port channel exists for this kind.
    return false;
  }

  insertText(host: HTMLElement | null, text: string): boolean {
    const current = liveFor(host);
    if (!current || text === '') return false;
    // Voice typing and the unicode picker speak into the page's typing
    // home: the composer — or the title while a fresh list is being
    // named (focusTarget's rule).
    const target = current.controller.focusTarget();
    target.focus();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  focusTarget(host: HTMLElement): HTMLElement | null {
    const current = liveFor(host);
    return current ? current.controller.focusTarget() : null;
  }

  dismiss(_host: HTMLElement): void {
    // The stage changes hands: the page's popovers and document listener
    // go with it. The next surface's display owns the host's children.
    standDownLive();
  }

  clear(host: HTMLElement): void {
    const current = liveFor(host);
    if (current) {
      // Clearing a task list note empties its rows, keeping the note
      // (and its color + name) — an empty list page is the honest paint.
      const color = current.controller.getModel().color;
      current.controller.setModel(emptyTaskNoteContent(color));
      return;
    }
    this.display(host, { content: '', noteType: 'tasks' });
  }
}

registerNoteSurface('json', new TasksNoteSurface());
