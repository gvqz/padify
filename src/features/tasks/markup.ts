/**
 * The tasks feature's mounted markup — the hub container.
 *
 * The rail is app chrome (editor-shell.html); the HUB is the feature's
 * page host: a sibling of the note surface inside #textareaContainer
 * that takes over the editor area while a Reminders view (Today /
 * Scheduled / All / Flagged / Completed / search / the calendar) is
 * open. Mounted at boot (boot.ts calls mountTasksMarkup before app
 * init), hidden until the first destination opens it.
 *
 * The skeleton: header (title + count + actions), the quick-add row at
 * the top of the list, and the scroll area (sections + empty state).
 * Pure markup: the controllers (rail.ts, hub.ts) own behavior.
 */

import { quickAddRow } from '../../editor/tasks/rows';

const tasksHubHtml = `
<section id="tasksHub" class="tk-scope tkh" hidden aria-label="Reminders">
  <header class="tkh-head">
    <button type="button" class="tkh-back" data-hub-close title="Back to the note" aria-label="Back to the note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
    </button>
    <h4 class="tkh-title" id="tkhTitle">Today</h4>
    <span class="tkh-count" id="tkhCount"></span>
    <span class="tkh-actions" id="tkhActions"></span>
    <button type="button" class="tkh-views" id="tkhViewsButton" title="Reminders views" aria-label="Reminders views" aria-expanded="false">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>
    </button>
  </header>

  <div class="tk-quickadd-wrap tkh-quickadd">${quickAddRow({ withTarget: true })}</div>

  <div class="tk-scroll tkh-scroll" id="tkhScroll">
    <div class="tk-sections" id="tkhSections"></div>
    <div class="tk-empty" id="tkhEmpty" hidden></div>
  </div>
</section>`;

/**
 * Mounts the hub container inside the editor column, after the note
 * surface (before .bottom-line). Called by boot.ts before app init.
 */
export function mountTasksMarkup(): void {
  const container = document.getElementById('textareaContainer');
  if (!container || document.getElementById('tasksHub')) return;
  const anchor = container.querySelector('.starter-template');
  if (anchor && anchor.nextSibling) {
    container.insertBefore(createFragment(), anchor.nextSibling);
  } else {
    container.append(createFragment());
  }
}

function createFragment(): DocumentFragment {
  const holder = document.createElement('template');
  holder.innerHTML = tasksHubHtml;
  return holder.content;
}
