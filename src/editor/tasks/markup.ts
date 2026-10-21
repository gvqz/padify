/**
 * Task list notes — the surface's page markup (pure HTML string).
 *
 * The page that paints inside the editor host when a task list note is
 * open: a header (list color + inline-editable title + count), the
 * quick-add row at the top of the list (desktop's add affordance), the
 * rows scroll, and the completed tail. No ids: the page is scoped markup
 * the controller queries from its own root.
 */

import { quickAddRow } from './rows';

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
    <div class="tk-quickadd-wrap tkp-quickadd">${quickAddRow()}</div>
    <div class="tk-scroll tkp-scroll">
      <div class="tk-sections"></div>
      <div class="tk-empty" hidden></div>
    </div>
  </div>`;
}
