/**
 * The Reminders rail — the tasks side of the app's navigation.
 *
 * The rail appears ONLY in task contexts: while a task list note is the
 * active note, or while a Reminders page (hub view) is open. Everywhere
 * else the editor takes its full width — notes never see a tasks
 * sidebar. A body class (`tasks-rail-on`) drives the CSS; every input
 * that can change the context (active tab, hub open/close, note
 * deletion) re-syncs it.
 *
 * At rest the rail is a 52px icon strip (destinations + count badges);
 * hovering it — or focusing into it, or pinning it — expands it to the
 * full navigation: the smart-view cards (Today / Scheduled / All /
 * Flagged / Completed / Calendar) and search. The lists themselves are
 * notes and live in the notes rail; this rail never repeats them.
 *
 * The calendar page is the exception: it already carries its own
 * sidebar (lists, the day inspector, the mini month), so the rail
 * stands down while that page is open — desktop shouldn't stack two
 * task sidebars on one screen. On phones (≤820px) the rail is a
 * drawer — opened from the hub's views button or the notes rail's
 * calendar icon — the same pattern as the notes rail's drawer, and it
 * stays available there (the calendar page starts with it closed).
 */

import { getTabManager } from '../../tabs';
import { closeTabRailDrawer } from '../../tab-rail-drawer';
import { taskNotes } from './aggregate';
import {
  closeTasksHub,
  currentTasksHubView,
  isTasksHubOpen,
  onTasksHubChanged,
  openTasksHub,
  setTasksHubSearch,
  type HubView,
} from './hub';

const MOBILE_MEDIA = '(max-width: 820px)';
const RAIL_BODY_CLASS = 'tasks-rail-on';

export function initTasksRail(): void {
  const rail = document.getElementById('taskRail');
  if (!rail) return;
  const backdrop = document.getElementById('taskRailBackdrop');
  const searchInput = document.getElementById('taskRailSearchInput') as HTMLInputElement | null;
  const searchClear = document.getElementById('taskRailSearchClear');
  const pinButton = document.getElementById('taskRailPin');
  const calendarButton = document.getElementById('tabRailCalendar');
  const viewsButton = document.getElementById('tkhViewsButton');

  const isMobile = (): boolean => window.matchMedia(MOBILE_MEDIA).matches;
  const setDrawerOpen = (open: boolean): void => {
    rail.classList.toggle('open', open);
    if (viewsButton) viewsButton.setAttribute('aria-expanded', String(open));
    if (backdrop) {
      backdrop.hidden = !open;
    }
  };

  // ---- contextual visibility: the rail only exists in task contexts ----
  // The calendar page is the one hub view that sends the rail home
  // (desktop): the page has its own sidebar, and a hover-expand rail on
  // the same edge is double duty. Phones keep the drawer — the views
  // button is their only nav — it just starts closed.
  const syncRailVisibility = (): void => {
    const active = getTabManager()?.getActive();
    const inTaskContext = (active?.noteType ?? '') === 'tasks' || isTasksHubOpen();
    const calendarPage = isTasksHubOpen() && currentTasksHubView() === 'calendar';
    const on = inTaskContext && !(calendarPage && !isMobile());
    document.body.classList.toggle(RAIL_BODY_CLASS, on);
    if (!on) setDrawerOpen(false);
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

  // ---- the calendar door in the notes rail's head ----
  calendarButton?.addEventListener('click', () => {
    if (isTasksHubOpen() && currentTasksHubView() === 'calendar') {
      closeTasksHub();
      return;
    }
    openTasksHub('calendar');
    if (isMobile()) {
      // The door can live inside the notes drawer — let the page show.
      closeTabRailDrawer();
      setDrawerOpen(false);
    }
  });

  // ---- the hub's views button (phones: the rail is a drawer) ----
  viewsButton?.addEventListener('click', () => {
    setDrawerOpen(!rail.classList.contains('open'));
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

  backdrop?.addEventListener('click', () => setDrawerOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && rail.classList.contains('open')) {
      setDrawerOpen(false);
    }
  });

  // Crossing the phone breakpoint flips the calendar-page rule (drawer
  // vs. no rail at all) — re-sync when the window changes size.
  window.matchMedia(MOBILE_MEDIA).addEventListener('change', () => {
    syncRailVisibility();
  });

  // Every context change re-syncs the rail's reason to exist.
  getTabManager()?.addActiveListener(() => {
    syncRailVisibility();
    refreshRail();
  });
  getTabManager()?.addPersistListener(() => {
    if (rail.classList.contains('open') && isMobile()) {
      setDrawerOpen(false);
    }
    syncRailVisibility();
    refreshRail();
  });
  onTasksHubChanged(() => {
    syncRailVisibility();
    refreshRail();
  });
  taskNotes.onChange(() => refreshRail());

  syncRailVisibility();
  refreshRail();
}

/** Re-renders counts from the aggregate. */
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

  // The calendar door's badge: how much needs attention today.
  const calendarDot = document.getElementById('tabRailCalendarDot');
  const calendarButton = document.getElementById('tabRailCalendar');
  if (calendarDot && calendarButton) {
    const todayCount = counts.today;
    calendarDot.textContent = todayCount > 0 ? String(todayCount) : '';
    calendarDot.hidden = todayCount === 0;
    calendarButton.classList.toggle('has-attention', todayCount > 0);
    calendarButton.setAttribute('aria-expanded', String(current === 'calendar'));
    calendarButton.setAttribute(
      'aria-label',
      todayCount > 0
        ? `Open the reminders calendar — ${todayCount} due today`
        : 'Open the reminders calendar',
    );
  }
}
