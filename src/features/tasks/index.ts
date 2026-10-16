/**
 * Reminders — the feature's composition.
 *
 * Once a modal (features/tasks/index.ts's controller, PRs #143/#144);
 * now the app's second pillar: task lists are NOTES (noteType 'tasks'),
 * the rail navigates, the hub views aggregate, the calendar lays every
 * dated task on one grid, and the sweep fires on time from wherever
 * its note lives.
 *
 * app.ts calls initTasks() once, after TabManager.init(): the legacy
 * modal-era data migrates into notes, the surface's cross-note
 * environment wires, the rail + hub bind, and every mutation path
 * converges on the aggregate so counts and views stay truthful.
 */

import { getTabManager } from '../../tabs';
import { showToast } from '../../ui/toast';
import { configureTasksEnvironment, onTasksPageMutated } from '../../editor/tasks/surface';
import { taskNotes } from './aggregate';
import { initTasksRail } from './rail';
import { initTasksHub } from './hub';
import { initTaskReminderSweep } from './reminders';
import { migrateLegacyTasksToNotes } from './migrate';
import { dismissReminderToasts } from './toasts';

let initialized = false;

/** Wires the whole tasks feature. Idempotent; called once from app.ts. */
export function initTasks(): void {
  if (initialized) return;
  initialized = true;

  // 1. The one-time hand-off: the modal-era store becomes notes. Runs
  //    first so the counts below already see the migrated lists.
  const migrated = migrateLegacyTasksToNotes();
  if (migrated > 0) {
    showToast(
      migrated === 1
        ? 'Your reminders became a note'
        : `Your ${migrated} reminder lists became notes`,
    );
  }

  // 2. The surface's cross-note world: the Move menus, the toast
  //    dismissal. Before this lands the page still works — it just has
  //    no other lists to move to.
  configureTasksEnvironment({
    listsProvider: () => taskNotes.lists(),
    moveTaskToNote: (task, targetNoteId) => {
      taskNotes.adoptTask(task, targetNoteId);
      showToast('Moved');
    },
    openNote: (noteId) => {
      getTabManager()?.switchTo(noteId);
    },
    dismissToasts: dismissReminderToasts,
  });

  // 3. The rail + hub bind against a fresh aggregate.
  taskNotes.refresh();
  initTasksHub();
  initTasksRail();

  // 4. Every mutation path converges: the surface's own announces (a
  //    live page edit) and the manager's persists (rename, new note,
  //    sync merges, the aggregate's own writes) both refresh the
  //    aggregate, whose notify re-renders the rail and the open view.
  onTasksPageMutated(() => taskNotes.refreshAndNotify());
  getTabManager()?.addPersistListener(() => taskNotes.refreshAndNotify());

  // 5. Timed reminders fire without opening anything.
  initTaskReminderSweep();
}
