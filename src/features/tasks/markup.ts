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
 * Pure markup: the controllers (rail.ts, hub.ts) own behavior.
 */

/**
 * The hub's static skeleton: header (title + count + the back-to-note
 * close), the scroll area (sections + empty state), and the composer
 * bar riding the bottom — the same shape the retired modal's content
 * pane had, promoted to a page.
 */
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

  <div class="tk-scroll tkh-scroll" id="tkhScroll">
    <div class="tk-sections" id="tkhSections"></div>
    <div class="tk-empty" id="tkhEmpty" hidden></div>
  </div>

  <footer class="tk-composer" id="tkhComposer">
    <div class="tk-composer-row">
      <span class="tkh-target" id="tkhTarget"></span>
      <button type="button" class="tk-composer-add" id="tkhComposerAdd" title="Add reminder" aria-label="Add reminder">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>
      </button>
      <input type="text" id="tkhComposerInput" class="tk-composer-input" placeholder="New Reminder" autocomplete="off" aria-label="New reminder title">
    </div>
    <div class="tk-composer-details" id="tkhComposerDetails" hidden>
      <button type="button" class="tk-chip-btn" id="tkhComposerDate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg><span>Date</span>
      </button>
      <button type="button" class="tk-chip-btn" id="tkhComposerRemind">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 1.8 6 1.8 6H4.2S6 14 6 9"/><path d="M10.3 19.5a2 2 0 0 0 3.4 0"/></svg><span>Remind</span>
      </button>
      <button type="button" class="tk-chip-btn" id="tkhComposerFlag" aria-pressed="false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4.5C7 3 9 3 11 4.5s4 1.5 6 0V14c-2 1.5-4 1.5-6 0s-4-1.5-6 0"/></svg><span>Flag</span>
      </button>
    </div>
  </footer>
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
