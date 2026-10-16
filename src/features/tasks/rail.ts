/**
 * The Reminders rail — the tasks side of the app's navigation.
 *
 * Notes live left; Reminders live right. At rest the rail is a 52px icon
 * strip (destinations + count badges); hovering it — or focusing into
 * it, or pinning it — expands it to the full navigation: the smart-view
 * card grid (Apple's Reminders sidebar cards), the task notes as My
 * Lists, search, and New Task List. Clicking a destination opens the
 * tasks hub over the editor area; clicking a list opens that NOTE.
 *
 * On phones (≤820px) the rail is a drawer behind the topbar Reminders
 * button — the same pattern as the notes rail's drawer — with the hub
 * filling the screen once a destination is picked.
 */

import { getTabManager } from '../../tabs';
import { taskNotes } from './aggregate';
import {
  closeTasksHub,
  currentTasksHubView,
  isTasksHubOpen,
  onTasksHubChanged,
  openNoteFromTasks,
  openTasksHub,
  setTasksHubSearch,
  type HubView,
} from './hub';
import { escapeHtml } from '../../lib/escape';

const MOBILE_MEDIA = '(max-width: 820px)';

export function initTasksRail(): void {
  const rail = document.getElementById('taskRail');
  if (!rail) return;
  const backdrop = document.getElementById('taskRailBackdrop');
  const searchInput = document.getElementById('taskRailSearchInput') as HTMLInputElement | null;
  const searchClear = document.getElementById('taskRailSearchClear');
  const pinButton = document.getElementById('taskRailPin');
  const listsEl = document.getElementById('taskRailLists');
  const newListButton = document.getElementById('taskRailNewList');

  const isMobile = (): boolean => window.matchMedia(MOBILE_MEDIA).matches;
  const setDrawerOpen = (open: boolean): void => {
    rail.classList.toggle('open', open);
    if (backdrop) {
      backdrop.hidden = !open;
    }
  };

  // ---- the pin (keep the rail expanded) ----
  pinButton?.addEventListener('click', () => {
    const pinned = rail.classList.toggle('is-pinned');
    pinButton.setAttribute('aria-pressed', String(pinned));
  });

  // ---- destination cards ----
  rail.querySelectorAll<HTMLElement>('.tr-card[data-view]').forEach((card) => {
    card.addEventListener('click', () => {
      const next = card.dataset.view as HubView;
      if (isTasksHubOpen() && currentTasksHubView() === next) {
        closeTasksHub();
      } else {
        openTasksHub(next);
      }
      if (isMobile()) setDrawerOpen(false);
    });
  });

  // ---- search ----
  searchInput?.addEventListener('input', () => {
    if (searchClear) searchClear.hidden = searchInput.value === '';
    setTasksHubSearch(searchInput.value);
  });
  searchClear?.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    searchClear.hidden = true;
    setTasksHubSearch('');
  });
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.stopPropagation();
      searchInput.value = '';
      searchClear?.setAttribute('hidden', 'true');
      setTasksHubSearch('');
    }
  });

  // ---- My Lists: the notes ARE the lists ----
  listsEl?.addEventListener('click', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-note-id]');
    if (!row) return;
    openNoteFromTasks(row.dataset.noteId ?? '');
    if (isMobile()) setDrawerOpen(false);
  });

  newListButton?.addEventListener('click', () => {
    // The caret lands in the fresh list's title (focusTarget's rule for
    // unnamed lists); the hub steps aside for the new note.
    closeTasksHub();
    getTabManager()?.addTab(true, 'tasks');
    if (isMobile()) setDrawerOpen(false);
  });

  // The phone drawer: the topbar's Reminders button opens the rail
  // itself (the hub is one tap deeper, from a destination). Backdrop or
  // Escape closes it. On desktop the same button opens Today.
  const navButton = document.getElementById('tasksNavButton');
  navButton?.addEventListener('click', (event) => {
    event.preventDefault();
    if (isMobile()) {
      setDrawerOpen(!rail.classList.contains('open'));
      return;
    }
    if (isTasksHubOpen() && currentTasksHubView() === 'today') {
      closeTasksHub();
    } else {
      openTasksHub('today');
    }
  });

  backdrop?.addEventListener('click', () => setDrawerOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && rail.classList.contains('open')) {
      setDrawerOpen(false);
    }
  });

  // Picking a note closes the drawer on phones (the tab rail's parity).
  getTabManager()?.addPersistListener(() => {
    if (rail.classList.contains('open') && isMobile()) {
      setDrawerOpen(false);
    }
    refreshRail();
  });

  onTasksHubChanged(() => refreshRail());
  taskNotes.onChange(() => refreshRail());

  refreshRail();
}

/** Re-renders counts + the lists group from the aggregate. */
function refreshRail(): void {
  const rail = document.getElementById('taskRail');
  if (!rail) return;
  const now = new Date();
  const counts = taskNotes.smartCounts(now);

  rail.querySelectorAll<HTMLElement>('[data-count]').forEach((badge) => {
    const key = badge.dataset.count;
    if (key === 'calendar') {
      // Apple's calendar card badge: today's date number.
      badge.textContent = String(now.getDate());
      badge.classList.add('is-date');
      badge.hidden = false;
      return;
    }
    const value = counts[key as keyof typeof counts] ?? 0;
    badge.textContent = value > 0 ? String(value) : '';
    badge.hidden = value === 0;
  });

  // Active destination follows the open hub view.
  const current = currentTasksHubView();
  rail.querySelectorAll<HTMLElement>('.tr-card[data-view]').forEach((card) => {
    const active = card.dataset.view === current;
    card.classList.toggle('is-active', active);
    card.setAttribute('aria-selected', String(active));
  });

  // My Lists — the task notes, their dots, their counts.
  const listsEl = document.getElementById('taskRailLists');
  const groupEl = document.getElementById('taskRailListsGroup');
  if (!listsEl || !groupEl) return;
  const lists = taskNotes.lists();
  const perNote = taskNotes.listCounts();
  const activeNoteId = getTabManager()?.getActive()?.id;
  const currentView = currentTasksHubView();
  listsEl.innerHTML = lists
    .map((list) => {
      const count = perNote.get(list.id) ?? 0;
      const badge = count > 0 ? `<span class="tr-list-count">${count}</span>` : '';
      const active = !currentView && list.id === activeNoteId;
      return `
        <button type="button" class="tr-list${active ? ' is-active' : ''}" data-note-id="${escapeHtml(
          list.id,
        )}" title="Open ${escapeHtml(list.name)}">
            <span class="tk-scope tr-list-dot tk-c-${list.color}"><span class="tk-dot" aria-hidden="true"></span></span>
            <span class="tr-list-name">${escapeHtml(list.name)}</span>
            ${badge}
        </button>`;
    })
    .join('');
  groupEl.classList.toggle('is-empty', lists.length === 0);
}
