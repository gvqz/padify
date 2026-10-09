/**
 * Settings navigation — the two-pane settings experience.
 *
 * The preferences modal used to be one long scroll: six stacked sections,
 * ~14 rows, and finding a setting meant scanning (or knowing where Padify
 * happened to put it). This module owns the rebuilt layout's behavior on
 * top of the same markup contract and the same persisted controls:
 *
 *   - a section nav (role=tablist) that shows ONE pane at a time; clicks
 *     and the arrow/Home/End keys move between sections with the WAI-ARIA
 *     tablist keyboard recipe (roving tabindex, aria-selected)
 *   - the remembered section survives modal close/reopen (in memory for
 *     the page's lifetime — deliberately NOT persisted: storage stays
 *     exactly the settings choke-point schema, no new keys)
 *   - a search box that flattens the panes while a query is live: every
 *     pane with a matching row (or a matching section name) is shown
 *     stacked with its section head, non-matching rows are hidden, the
 *     nav itself steps aside, and a no-results state covers the rest
 *   - Escape over a non-empty search clears the query INSTEAD of closing
 *     the modal (the keydown stops propagating before the modal
 *     controller's document-level listener sees it); over an empty one
 *     it bubbles and closes the modal as before
 *
 * The controls inside the panes are untouched: the same ids the wiring
 * modules bind (editor-preferences, theme-controller, typing-effects,
 * cloud/ui) and the same storage keys — this layer only decides which of
 * them is on screen.
 *
 * The cloud pane is the one section that can appear later: it (and its
 * nav button) carry the `hidden` attribute until cloud/ui.ts reveals them
 * on a configured backend. Activation and search both skip `hidden`
 * panes, and a CSS `[hidden]` guard with `!important` keeps an
 * author-stylesheet `display` from overriding the attribute (the same
 * author-vs-UA cascade trap the chime picker hit — see 12-timer.css).
 */

import { $ } from '../lib/q';

/** A nav button + the pane it controls. */
interface SettingsSection {
  button: HTMLButtonElement;
  pane: HTMLElement;
}

/** Guard so the wiring lands exactly once (boot calls this with the DOM-only features). */
let initialized = false;

/** True while a search query is live (drives the `.is-searching` mode). */
function isSearching(layout: HTMLElement): boolean {
  return layout.classList.contains('is-searching');
}

/**
 * Searchable text for a row: title + hint, with presentation-only chrome
 * (the NEW badge) stripped so "new" doesn't surface the break-reminder
 * row. Computed from a clone because textContent is read-only by nature.
 */
function rowSearchText(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement;
  for (const badge of Array.from(clone.querySelectorAll('.pref-new-badge'))) {
    badge.remove();
  }
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Searchable text for a pane: its section title + hint. */
function paneSearchText(pane: HTMLElement): string {
  const parts: string[] = [];
  for (const el of Array.from(pane.querySelectorAll('.pref-section-title, .pref-section-hint'))) {
    parts.push((el.textContent ?? '').replace(/\s+/g, ' ').trim());
  }
  return parts.join(' ').toLowerCase();
}

export function initSettingsNav(): void {
  if (initialized) {
    return;
  }

  const $layout = $('#prefLayout');
  const $nav = $('#prefNav');
  const $search = $('#prefSearch');
  if (!$layout.length || !$nav.length || !$search.length) {
    // The markup contract (assertMarkupContract) fails loudly at boot if
    // the preferences modal is missing entirely; landing here means the
    // partial lost its nav/search internals, which is a markup bug the
    // architecture suite also catches. Stay inert rather than half-wired.
    return;
  }
  initialized = true;

  const layout = $layout.get(0) as HTMLElement;
  const nav = $nav.get(0) as HTMLElement;
  const searchInput = $search.get(0) as HTMLInputElement;
  const panesHost = document.getElementById('prefPanes');
  const emptyState = document.getElementById('prefSearchEmpty');
  const emptyQuery = document.getElementById('prefSearchEmptyQuery');

  // The sections, in nav order. The cloud section rides along `hidden`
  // until the backend is configured — it enters navigation the moment its
  // attribute clears, no re-init needed (every read below is live).
  const sections: SettingsSection[] = [];
  for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>('.pref-nav-item'))) {
    const paneId = button.getAttribute('aria-controls');
    const pane = paneId ? document.getElementById(paneId) : null;
    if (pane) {
      sections.push({ button, pane });
    }
  }

  // Row/pane search text is stable for the page's lifetime — cache it so
  // typing over the search box never re-clones the DOM.
  const rowText = new WeakMap<HTMLElement, string>();
  const paneText = new WeakMap<HTMLElement, string>();
  for (const { pane } of sections) {
    paneText.set(pane, paneSearchText(pane));
    for (const row of Array.from(pane.querySelectorAll<HTMLElement>('.pref-row'))) {
      rowText.set(row, rowSearchText(row));
    }
  }

  const visibleSections = (): SettingsSection[] => sections.filter(({ pane }) => !pane.hidden);

  /** The section currently shown (the DOM keeps it across modal open/close). */
  let activeSection: SettingsSection | null = null;

  /** Shows one pane, marks its tab, remembers it as the active section. */
  function activate(section: SettingsSection, focusButton = false): void {
    for (const other of sections) {
      const selected = other === section;
      other.button.classList.toggle('is-active', selected);
      other.button.setAttribute('aria-selected', selected ? 'true' : 'false');
      other.button.tabIndex = selected ? 0 : -1;
      other.pane.classList.toggle('is-active', selected);
    }
    activeSection = section;
    if (panesHost) {
      panesHost.scrollTop = 0;
    }
    if (focusButton) {
      section.button.focus();
    }
  }

  function moveSelection(delta: number): void {
    const visible = visibleSections();
    if (visible.length === 0) {
      return;
    }
    const current = activeSection ? visible.indexOf(activeSection) : -1;
    const next = visible[(current + delta + visible.length * 2) % visible.length];
    activate(next, true);
  }

  /** Restores the normal one-pane view (no query, nav back, rows unfiltered). */
  function clearSearch(): void {
    layout.classList.remove('is-searching');
    nav.removeAttribute('hidden');
    for (const { pane } of sections) {
      pane.classList.remove('is-match');
      for (const row of Array.from(pane.querySelectorAll<HTMLElement>('.pref-row'))) {
        row.classList.remove('is-filtered');
      }
    }
    if (emptyState) {
      emptyState.hidden = true;
    }
  }

  /**
   * Applies the live query: every pane that matches (by row text or by
   * its own section name — "writing" shows the whole Writing pane)
   * stacks in results mode; rows that don't match are filtered out; the
   * nav steps aside; an all-miss search shows the empty state.
   */
  function applySearch(rawQuery: string): void {
    const query = rawQuery.trim().toLowerCase();
    if (query === '') {
      clearSearch();
      return;
    }

    layout.classList.add('is-searching');
    nav.setAttribute('hidden', '');

    let anyMatch = false;
    for (const { pane } of sections) {
      if (pane.hasAttribute('hidden')) {
        pane.classList.remove('is-match');
        continue;
      }

      // A section-name match shows every row in the pane.
      const sectionMatches = (paneText.get(pane) ?? '').includes(query);
      let paneMatches = sectionMatches;

      for (const row of Array.from(pane.querySelectorAll<HTMLElement>('.pref-row'))) {
        const matches = sectionMatches || (rowText.get(row) ?? '').includes(query);
        row.classList.toggle('is-filtered', !matches);
        if (matches) {
          paneMatches = true;
        }
      }

      pane.classList.toggle('is-match', paneMatches);
      if (paneMatches) {
        anyMatch = true;
      }
    }

    if (emptyState) {
      emptyState.hidden = anyMatch;
    }
    if (emptyQuery) {
      emptyQuery.textContent = rawQuery.trim();
    }
    if (panesHost) {
      panesHost.scrollTop = 0;
    }
  }

  // ---- wiring -------------------------------------------------------------

  nav.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('.pref-nav-item');
    if (!button) {
      return;
    }
    const section = sections.find(({ button: b }) => b === button);
    if (section) {
      activate(section);
    }
  });

  // Tablist keyboard recipe: arrows cycle, Home/End jump. Only while the
  // search is idle — during a query the nav is hidden and its buttons
  // are unfocusable, so the keys below would have nowhere to land anyway.
  nav.addEventListener('keydown', (event) => {
    if (isSearching(layout)) {
      return;
    }
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'Home':
        event.preventDefault();
        {
          const visible = visibleSections();
          if (visible.length > 0) {
            activate(visible[0], true);
          }
        }
        break;
      case 'End':
        event.preventDefault();
        {
          const visible = visibleSections();
          if (visible.length > 0) {
            activate(visible[visible.length - 1], true);
          }
        }
        break;
      default:
        break;
    }
  });

  searchInput.addEventListener('input', () => {
    applySearch(searchInput.value);
  });

  // Escape over a live query clears the search and STAYS in the modal:
  // stopPropagation keeps the keydown from the modal controller's
  // document-level Escape listener (closing on the first press while the
  // user is mid-search would eat the query they were trying to refine).
  // Over an empty search the event bubbles on — the modal closes, as
  // before.
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || searchInput.value === '') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    searchInput.value = '';
    clearSearch();
  });

  // The first section (Appearance) is the default landing pane. Reopening
  // the modal lands wherever the user last was — the classes persist on
  // the DOM for the page's lifetime, exactly like the persisted controls
  // inside the panes. Sections hidden at boot (cloud) can't be active
  // until revealed.
  if (activeSection === null && sections.length > 0) {
    activate(sections[0]);
  }
}

/** Test seam: clears the init guard so a fresh mount can be wired again. */
export function resetSettingsNavForTests(): void {
  initialized = false;
}
