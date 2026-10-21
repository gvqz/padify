/**
 * Task list notes — the surface's page markup (pure HTML string).
 *
 * The page that paints inside the editor host when a task list note is
 * open: a header (list color + inline-editable title + count), the rows
 * scroll, and the composer bar riding the bottom — the retired modal's
 * content pane promoted to a page. No ids: the page is scoped markup
 * the controller queries from its own root.
 */

import { ICONS } from './icons';

export function taskListPageMarkup(): string {
  return `
  <div class="tk-scope tkp" data-tasks-page>
    <header class="tkp-head">
      <button type="button" class="tkp-color" data-action="list-color" title="List color" aria-label="List color" aria-haspopup="menu"><span class="tk-dot"></span></button>
      <input type="text" class="tkp-title" maxlength="80" placeholder="Untitled list" aria-label="List name" spellcheck="false">
      <span class="tkp-count" aria-live="polite"></span>
      <span class="tkp-actions">
        <button type="button" class="tk-chip-btn tk-chip-danger" data-action="clear-completed" hidden>Clear</button>
      </span>
    </header>
    <div class="tk-scroll tkp-scroll">
      <div class="tk-sections"></div>
      <div class="tk-empty" hidden></div>
    </div>
    <footer class="tk-composer">
      <div class="tk-composer-row">
        <button type="button" class="tk-composer-add" data-composer-add title="Add reminder" aria-label="Add reminder">${ICONS.addCircle}</button>
        <input type="text" data-composer-input class="tk-composer-input" placeholder="New Reminder" autocomplete="off" aria-label="New reminder title">
      </div>
      <div class="tk-composer-details" hidden>
        <button type="button" class="tk-chip-btn" data-composer-when="date">${ICONS.calendar}<span>Date</span></button>
        <button type="button" class="tk-chip-btn" data-composer-when="remind">${ICONS.bell}<span>Remind</span></button>
        <button type="button" class="tk-chip-btn" data-composer-flag aria-pressed="false">${ICONS.flag}<span>Flag</span></button>
      </div>
    </footer>
  </div>`;
}
