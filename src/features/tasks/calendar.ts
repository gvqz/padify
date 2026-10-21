/**
 * The ONE calendar — every dated task, one grid.
 *
 * The calendar door in the notes rail's head (and the rail's Calendar
 * destination) opens this page: an iCloud-style calendar. The page IS
 * the view — a big title up top, the Day/Week/Month/Year modes (all
 * four live), prev/Today/next beside them, and the body: Day is the
 * one wide page for the picked day, hour-ruled — a time gutter down
 * the left, the day's reminders as real rows anchored under their
 * hour (date-only ones in an All-Day band up top), completing and the
 * inline editor working right on the sheet, and the sidebar's day
 * inspector stood down so the day isn't listed twice; Week lines up
 * seven day headers over the same ruled hours, every reminder on the
 * glass as a chip at its hour (a busy hour stretches its row for the
 * whole week at once); both timed pages carry Apple's red now-line in
 * the current hour and open scrolled to the working hours, and both
 * retime by drag: a chip or row picked off the ruling drops into
 * another hour (the drop line previews the exact minute), across the
 * columns to another day, or into the All-Day band to take the time
 * back off — and double-clicking a bare hour files a reminder right
 * there; Month is
 * the ruled grid whose days carry the day's reminders as colored
 * chips (one per task, tinted with its list's color, three then a
 * count); Year is the twelve-little-months spread, numbers only, days
 * with reminders reading darker, the month name zooming into Month.
 *
 * The RIGHT sidebar is the iCloud sidebar mirrored: the lists as colored
 * checkboxes (unchecking one sweeps its reminders off the grid), the
 * selected day's rows — due or reminding — using the same rows as every
 * tasks page, so completing, the inline editor and moving work here
 * too, an Up Next act so the panel is never a dead end, and the mini
 * month at the bottom (Month mode only — Year already shows twelve of
 * them). The day pane's Add button opens an inline
 * quick-add row right there — the hub's bottom composer stays off this
 * page — and Enter files the reminder onto the selected day (9:00),
 * keeping the row open for rapid entry.
 *
 * State is module-local (the cursor month + the selected day + the
 * hidden lists + which mode the page is in) and survives view switches;
 * the aggregate is re-read on every render, so edits elsewhere reflect
 * immediately. Rendered INTO the hub's sections container, which means
 * the hub's delegated row handlers serve these rows for free.
 */

import { taskNotes, type AggTask } from './aggregate';
import { taskRow } from '../../editor/tasks/rows';
import { hasTime, parseWhen, startOfDay } from '../../editor/tasks/dates';
import { escapeHtml } from '../../lib/escape';
import type { Task } from '../../editor/tasks/content';

/** The calendar sidebar's destination cluster — the page's way out,
 * desktop-style. `data-cal-dest` rides the hub's delegated handler,
 * which opens the matching view. */
function destinationsHtml(): string {
  const now = new Date();
  const counts = taskNotes.smartCounts(now);
  const views: Array<{ id: string; label: string; icon: string; count?: number }> = [
    {
      id: 'today',
      label: 'Today',
      icon: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="14.6" r="1.3" fill="currentColor" stroke="none"/>',
      count: counts.today,
    },
    {
      id: 'scheduled',
      label: 'Scheduled',
      icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    },
    {
      id: 'all',
      label: 'All',
      icon: '<path d="M3.5 13h4l2 4.5h5l2-4.5h4"/><path d="M5.3 7.5 3.5 13v4.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V13l-1.8-5.5a2 2 0 0 0-1.9-1.4H7.2a2 2 0 0 0-1.9 1.4z"/>',
      count: counts.all + counts.today + counts.scheduled,
    },
    {
      id: 'flagged',
      label: 'Flagged',
      icon: '<path d="M5 21V4.5C7 3 9 3 11 4.5s4 1.5 6 0V14c-2 1.5-4 1.5-6 0s-4-1.5-6 0"/>',
      count: counts.flagged,
    },
    {
      id: 'completed',
      label: 'Completed',
      icon: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.4 2.5 2.5 5-5.4"/>',
      count: counts.completed,
    },
  ];
  return views
    .map(
      (view) =>
        `<button type="button" class="tkcal-dest" data-cal-dest="${view.id}" title="${view.label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${view.icon}</svg><span>${escapeHtml(view.label)}</span>${
          view.count && view.count > 0 ? `<span class="tkcal-dest-count">${view.count}</span>` : ''
        }</button>`,
    )
    .join('');
}

/** The page's modes — Day the wide sheet, Week the seven columns,
 * Month the ruled grid, Year the twelve spreads. */
type CalMode = 'day' | 'week' | 'month' | 'year';

/** The cursor month (a date on its first day) + the selected day + the
 * day anchoring the shown week (any day inside it). */
let cursorMonth = firstOfMonth(new Date());
let selectedDay = startOfDay(new Date());
let cursorWeek = startOfDay(new Date());
/** Which page is on the glass right now. */
let mode: CalMode = 'month';
/** Task notes the user unchecked in the sidebar — their reminders hide. */
const hiddenLists = new Set<string>();

/** The bare hour slot clicked last (the double-click detector — a
 * re-render sits between the two clicks, so the browser's own dblclick
 * never sees the same node twice). */
let lastSlotClick: { key: string; at: number } | null = null;
/** The hour a slot double-click aimed the quick-add at, while it's open. */
let quickAddSlot: { day: Date; hour: number } | null = null;

/** The chip or row currently picked up: which task it is, the day it
 * was picked from (the stamp that gets retimed) and its element (for
 * the lifted look). */
interface DragRetime {
  taskId: string;
  fromKey: string;
  el: Element;
}
let dragRetime: DragRetime | null = null;
/** The one drop marker (accent line + minute bubble) shared by every
 * slot, and the slot currently painted as the target. */
let dropMarker: HTMLElement | null = null;
let dropOver: Element | null = null;
/** A drop the next render should celebrate: the chip pulses where it
 * landed, so a retime reads as something that happened. */
let landedTaskId: string | null = null;
let landedAt = 0;

let wired = false;

/** Binds the calendar's own interactions (delegated, once). */
export function initTasksCalendar(): void {
  if (wired) return;
  wired = true;
  const hub = document.getElementById('tasksHub');
  if (!hub) return;
  const sections = hub.querySelector<HTMLElement>('#tkhSections');
  if (!sections) return;

  sections.addEventListener('click', (event) => {
    const target = event.target as Element;

    // The arrows step by the page's own grain: a day in Day view, a
    // week in Week view, a month in Month view, a whole year in Year
    // view. Day steps move the picked day itself — and keep the other
    // pages' cursors on it, so a later flip lands where the user is.
    if (target.closest('[data-cal-prev]')) {
      if (mode === 'year') cursorMonth = shiftYear(cursorMonth, -1);
      else if (mode === 'week') cursorWeek = shiftWeek(cursorWeek, -1);
      else if (mode === 'day') stepSelectedDay(-1);
      else cursorMonth = shiftMonth(cursorMonth, -1);
      renderTasksCalendar();
      return;
    }
    if (target.closest('[data-cal-next]')) {
      if (mode === 'year') cursorMonth = shiftYear(cursorMonth, 1);
      else if (mode === 'week') cursorWeek = shiftWeek(cursorWeek, 1);
      else if (mode === 'day') stepSelectedDay(1);
      else cursorMonth = shiftMonth(cursorMonth, 1);
      renderTasksCalendar();
      return;
    }
    // The segmented control — switching modes re-renders the same state
    // into the other page. Week opens on the picked day's week; the
    // other pages open on the month the week sat in, so the flip never
    // jumps the glass to somewhere the user wasn't looking. Day needs
    // no hand-off: the picked day IS its page.
    const modeBtn = target.closest<HTMLElement>('[data-cal-mode]');
    if (modeBtn) {
      const next = modeBtn.dataset.calMode;
      const live = next === 'day' || next === 'week' || next === 'month' || next === 'year';
      if (live && next !== mode) {
        if (next === 'week') cursorWeek = selectedDay;
        else if (mode === 'week') cursorMonth = firstOfMonth(cursorWeek);
        mode = next;
        renderTasksCalendar();
      }
      return;
    }
    // A year view's month name — zoom into that month (Apple's click).
    const jump = target.closest<HTMLElement>('[data-cal-jump]');
    if (jump) {
      const date = parseWhen(`${jump.dataset.calJump ?? ''}T00:00:00`);
      if (date) {
        cursorMonth = firstOfMonth(date);
        mode = 'month';
        renderTasksCalendar();
      }
      return;
    }
    if (target.closest('[data-cal-today]')) {
      const today = startOfDay(new Date());
      selectedDay = today;
      cursorMonth = firstOfMonth(today);
      cursorWeek = today;
      renderTasksCalendar();
      return;
    }
    // A sidebar checkbox — sweep that list's reminders off the grid.
    const listToggle = target.closest<HTMLElement>('[data-cal-list]');
    if (listToggle) {
      const id = listToggle.dataset.calList ?? '';
      if (hiddenLists.has(id)) hiddenLists.delete(id);
      else hiddenLists.add(id);
      renderTasksCalendar();
      return;
    }
    // A bare hour slot: two quick clicks open the quick-add aimed at
    // that exact hour (a chip or row under the pointer keeps its own
    // acts; the browser's dblclick can't see through the re-render the
    // first click causes, so the pair is matched here by hand). Week
    // slots fall through — the click still picks the day below.
    const slotCell = target.closest<HTMLElement>(
      '.tkcal-wk-slot[data-hour], .tkcal-day-slot[data-hour]',
    );
    if (slotCell && !target.closest('.tk-task-wrap')) {
      const key = `${slotCell.dataset.calDay ?? dayKey(selectedDay)}T${slotCell.dataset.hour ?? ''}`;
      const stamp = Date.now();
      if (lastSlotClick && lastSlotClick.key === key && stamp - lastSlotClick.at < 600) {
        lastSlotClick = null;
        openQuickAddForSlot(sections, slotCell);
        return;
      }
      lastSlotClick = { key, at: stamp };
      if (slotCell.classList.contains('tkcal-day-slot')) return;
    }
    const dayCell = target.closest<HTMLElement>('[data-cal-day]');
    if (dayCell) {
      const date = parseWhen(`${dayCell.dataset.calDay}T00:00:00`);
      if (date) {
        selectedDay = startOfDay(date);
        // The cursor follows selections in other months (Apple's rule:
        // picking a day outside the current page moves the page too).
        if (
          date.getMonth() !== cursorMonth.getMonth() ||
          date.getFullYear() !== cursorMonth.getFullYear()
        ) {
          cursorMonth = firstOfMonth(date);
        }
        renderTasksCalendar();
      }
    }
  });

  // The retime drag — chips between the hours, rows across the sheet.
  wireRetime(sections);
}

/**
 * The hub's quick-add callback, remembered between renders. The calendar
 * re-renders itself constantly — day picks, month flips, list toggles —
 * and those internal calls don't carry the callback, so it's kept here:
 * without it the Add button (and the inline row) would vanish the moment
 * a day gets selected.
 */
let quickAddFn: ((title: string, iso: string) => void) | undefined;

/**
 * Renders the calendar page into the hub's sections container.
 *
 * `quickAdd` — when the hub offers it — is how the day pane's inline
 * row files a reminder: it gets the typed title and the selected day
 * (9:00 ISO) and owns the creation. Without it the Add button (and the
 * row) don't render at all.
 */
export function renderTasksCalendar(quickAdd?: (title: string, iso: string) => void): void {
  if (quickAdd) quickAddFn = quickAdd;
  const add = quickAddFn;
  const hub = document.getElementById('tasksHub');
  const sections = hub?.querySelector<HTMLElement>('#tkhSections');
  if (!sections) return;

  const now = new Date();
  const today = startOfDay(now);
  const lists = taskNotes.lists();
  const byDay = collectByDay();

  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(cursorMonth);
  const yearLabel = String(cursorMonth.getFullYear());

  // The segmented control: all four pages are live.
  const modes = ['day', 'week', 'month', 'year']
    .map((name) => {
      const label = name[0].toUpperCase() + name.slice(1);
      const on = name === mode;
      return `<button type="button" class="tkcal-mode${on ? ' is-on' : ''}" data-cal-mode="${name}" aria-pressed="${String(on)}">${label}</button>`;
    })
    .join('');

  const gridHtml = monthCells(cursorMonth)
    .map((cell) => {
      const inMonth = cell.date.getMonth() === cursorMonth.getMonth();
      const isToday = sameDay(cell.date, today);
      const isSelected = sameDay(cell.date, selectedDay);
      const weekend = cell.date.getDay() === 0 || cell.date.getDay() === 6;
      const events = inMonth ? (byDay.get(dayKey(cell.date)) ?? []) : [];
      const visible = events.slice(0, 3);
      const more = events.length > 3 ? events.length - 3 : 0;
      const chipsHtml =
        visible
          .map(
            (row) =>
              `<span class="tkcal-chip tk-c-${row.note.color}" title="${escapeHtml(
                row.task.title,
              )}">${escapeHtml(row.task.title)}</span>`,
          )
          .join('') + (more > 0 ? `<span class="tkcal-chip-more">+${more} More</span>` : '');
      const classes = [
        'tkcal-day',
        inMonth ? '' : 'is-outside',
        weekend ? 'is-weekend' : '',
        isToday ? ' is-today' : '',
        isSelected ? ' is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <button type="button" class="${classes}" data-cal-day="${dayKey(cell.date)}" aria-label="${new Intl.DateTimeFormat(
          undefined,
          {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          },
        ).format(cell.date)}${events.length > 0 ? `, ${events.length} reminders` : ''}">
            <span class="tkcal-num">${cell.date.getDate()}</span>
            <span class="tkcal-events">${chipsHtml}</span>
        </button>`;
    })
    .join('');

  const weekdays = weekdayLabels()
    .map((label) => `<span class="tkcal-weekday">${label}</span>`)
    .join('');

  const dayRows = dayTasks(selectedDay, now);
  const dayLabel = dayHeading(selectedDay, today);

  // The quick-add row wears the target list's color — the same list the
  // reminder will file into (the hub remembers the last one used). The
  // Add button and the inline row render in the day pane's head — or,
  // in Day view, in the wide sheet's head (the pane stands down there;
  // the sheet IS the day inspector).
  const targetColor = quickAddTargetColor();
  const addBtnHtml = add
    ? `<button type="button" class="tk-chip-btn" data-cal-add title="Add a reminder on this day" aria-label="Add a reminder on this day"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add</span></button>`
    : '';
  const quickAddHtml = add
    ? `<form class="tkcal-quickadd" data-cal-quickadd hidden>
                    <span class="tkcal-quickadd-dot tk-c-${targetColor}" aria-hidden="true"></span>
                    <input type="text" class="tkcal-quickadd-input" data-cal-quickadd-input
                      placeholder="New Reminder" autocomplete="off"
                      aria-label="New reminder on ${dayLabel}">
                  </form>`
    : '';

  // The Year page: twelve little months, numbers only. The Week and
  // Day pages are the timed pair — day headers over the hour ruling
  // (Week), one wide ruled sheet (Day). The sidebar stays on all of
  // them (lists +, on every page but Day, the day inspector — Day's
  // sheet IS the inspector, wide); the mini month sits out — a year
  // page already shows twelve months, and its arrows would step weeks
  // in Week view where it has no business.
  const yearHtml =
    mode === 'year'
      ? monthsOfYear(cursorMonth)
          .map((month) => yearMonthHtml(month, selectedDay, today, byDay))
          .join('')
      : '';
  const gridPaneHtml =
    mode === 'year'
      ? `<div class="tkcal-year">${yearHtml}</div>`
      : mode === 'week'
        ? `<div class="tkcal-week">${weekPageHtml(cursorWeek, selectedDay, today)}</div>`
        : mode === 'day'
          ? dayPageHtml(selectedDay, today, addBtnHtml, quickAddHtml)
          : `<div class="tkcal-weekdays">${weekdays}</div><div class="tkcal-grid" role="grid">${gridHtml}</div>`;

  const rowsHtml = dayRows.length
    ? dayRows.map((row) => taskRow(row.task, now, row.note.color, false, row.note)).join('')
    : `<div class="tk-empty tk-empty-day"><span class="tk-empty-day-mark">${calendarMark(
        selectedDay,
        today,
      )}</span><p class="tk-empty-day-copy">${emptyDayCopy(selectedDay, today)}</p></div>`;

  const upNext = upcomingAfter(selectedDay, now, 5);
  const upNextHtml = upNext.length
    ? `
        <div class="tkcal-upnext">
          <header class="tkcal-upnext-head">
            <span class="tkcal-upnext-label">Up Next</span>
            <span class="tkcal-upnext-count">${upNext.length}</span>
          </header>
          <div class="tk-rows" role="list" data-cal-upnext-rows>${upNext
            .map((row) => taskRow(row.task, now, row.note.color, false, row.note))
            .join('')}</div>
        </div>`
    : '';

  const listsHtml = lists.length
    ? lists
        .map((list) => {
          const shown = !hiddenLists.has(list.id);
          return `
          <button type="button" class="tkcal-list" data-cal-list="${escapeHtml(
            list.id,
          )}" aria-pressed="${String(shown)}" title="${
            shown ? 'Hide' : 'Show'
          } ${escapeHtml(list.name)} on the calendar">
            <span class="tkcal-box tk-c-${list.color}" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
            </span>
            <span class="tkcal-list-name">${escapeHtml(list.name)}</span>
          </button>`;
        })
        .join('')
    : `<p class="tkcal-lists-empty">No lists yet — add the first reminder and its list appears.</p>`;

  // The timed pages' scroll: where the box sat before this render.
  // A same-page re-render (completing a row, toggling a list) restores
  // it — completing must never fling the hours back to morning — while
  // a fresh page (a step, a flip) opens at the working hours. The box
  // carries its own page key, because the cursors have already moved
  // by the time this code runs.
  const prevTimed = sections.querySelector<HTMLElement>('.tkcal-wk-time, .tkcal-daypage-scroll');
  const prevTimedKey = prevTimed?.dataset.timedKey ?? '';
  const prevTimedTop = prevTimed?.scrollTop ?? -1;

  // The inline add row rides the render too: an open row survives it
  // (with the caret, if the user was mid-thought), because a render is
  // allowed to arrive at any moment — the persistence write completes
  // after the Enter that queued it — and the row must not blink shut
  // out from under the next reminder. A closed row stays closed.
  const prevQuickAdd = sections.querySelector<HTMLElement>('[data-cal-quickadd]');
  const prevQuickAddInput = prevQuickAdd?.querySelector<HTMLInputElement>(
    '[data-cal-quickadd-input]',
  );
  const quickAddWasOpen = prevQuickAdd != null && !prevQuickAdd.hidden;
  const quickAddHadFocus = quickAddWasOpen && document.activeElement === prevQuickAddInput;
  const quickAddText = prevQuickAddInput?.value ?? '';

  sections.innerHTML = `
    <div class="tkcal">
      <header class="tkcal-top">
        <h5 class="tkcal-month">${
          mode === 'year'
            ? yearLabel
            : mode === 'week'
              ? weekLabel(cursorWeek)
              : mode === 'day'
                ? dayPageLabel(selectedDay, today)
                : monthLabel
        }</h5>
        <div class="tkcal-modes" role="group" aria-label="Calendar view">${modes}</div>
        <div class="tkcal-navs">
          <button type="button" class="tkcal-nav" data-cal-prev title="Previous ${mode}" aria-label="Previous ${mode}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>
          </button>
          <button type="button" class="tkcal-today" data-cal-today>Today</button>
          <button type="button" class="tkcal-nav" data-cal-next title="Next ${mode}" aria-label="Next ${mode}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        </div>
      </header>
      <div class="tkcal-body">
        <div class="tkcal-grid-pane">${gridPaneHtml}</div>
        <aside class="tkcal-side">
          <nav class="tkcal-dests" aria-label="Reminders views">${destinationsHtml()}</nav>
          <div class="tkcal-lists">
            <div class="tkcal-side-eyebrow">My Lists</div>
            ${listsHtml}
          </div>
          ${
            mode === 'day'
              ? ''
              : `<div class="tkcal-day-pane">
            <header class="tkcal-day-head">
              <div class="tkcal-day-heading">
                <h5 class="tkcal-day-title">${dayLabel}</h5>
                <span class="tkcal-day-count">${
                  dayRows.length > 0
                    ? `${dayRows.length} reminder${dayRows.length === 1 ? '' : 's'}`
                    : ''
                }</span>
              </div>
              ${addBtnHtml}
            </header>
            ${quickAddHtml}
            <div class="tk-rows" role="list" data-cal-day-rows>${rowsHtml}</div>
            ${upNextHtml}
          </div>`
          }
          ${
            mode === 'month'
              ? `<div class="tkcal-mini">
            <header class="tkcal-mini-head">
              <button type="button" class="tkcal-mini-nav" data-cal-prev title="Previous month" aria-label="Previous month">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>
              </button>
              <span class="tkcal-mini-month">${monthLabel}</span>
              <button type="button" class="tkcal-mini-nav" data-cal-next title="Next month" aria-label="Next month">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
              </button>
            </header>
            <div class="tkcal-mini-grid">${miniCells(cursorMonth, selectedDay, today)}</div>
          </div>`
              : ''
          }
        </aside>
      </div>
    </div>`;

  // A retime that just landed: pulse the chip (or row) at its new
  // hour, so the drop reads as something that happened. One render
  // only — the next paints plain again.
  if (landedTaskId) {
    if (Date.now() - landedAt < 2000) {
      const landed = sections.querySelector(
        `[data-cal-task="${CSS.escape(landedTaskId)}"], .tk-task-wrap[data-id="${CSS.escape(
          landedTaskId,
        )}"]`,
      );
      landed?.classList.add('is-landed');
    }
    landedTaskId = null;
  }

  const timedBox = sections.querySelector<HTMLElement>('.tkcal-wk-time, .tkcal-daypage-scroll');
  if (timedBox) {
    const showsToday =
      mode === 'day'
        ? sameDay(selectedDay, today)
        : today.getTime() >= weekStart(cursorWeek).getTime() &&
          today.getTime() <= shiftDay(weekStart(cursorWeek), 6).getTime();
    const key = `${mode}:${mode === 'day' ? dayKey(selectedDay) : dayKey(weekStart(cursorWeek))}`;
    timedBox.dataset.timedKey = key;
    timedBox.scrollTop =
      key === prevTimedKey && prevTimedTop >= 0
        ? prevTimedTop
        : defaultTimedScroll(timedBox, showsToday);
  }

  if (add) {
    wireQuickAdd(sections, add);
  }

  if (quickAddWasOpen) {
    const row = sections.querySelector<HTMLElement>('[data-cal-quickadd]');
    const input = row?.querySelector<HTMLInputElement>('[data-cal-quickadd-input]');
    if (row && input) {
      row.hidden = false;
      if (quickAddText) input.value = quickAddText;
      if (quickAddSlot) applySlotPlaceholder(input);
      if (quickAddHadFocus) input.focus();
    }
  }
}

/** Where a timed page opens scrolled to: around now when it holds
 * today, the working hours (7 AM) otherwise — anchored to the hour
 * label's real offset, so stretched rows above can't skew it. */
function defaultTimedScroll(box: HTMLElement, showsToday: boolean): number {
  let hour = 7;
  if (showsToday) hour = Math.max(0, Math.min(23, new Date().getHours() - 1));
  const mark = box.querySelector<HTMLElement>(`.tkcal-hour[data-hour="${hour}"]`);
  const max = box.scrollHeight - box.clientHeight;
  const top = mark ? mark.offsetTop - 8 : 0;
  return Math.max(0, Math.min(max, top));
}

/**
 * The day pane's inline add: the Add button reveals the row, Enter
 * files the reminder onto the selected day (9:00) and the row stays
 * open for the next one; Esc — or a blur with nothing typed — puts it
 * away. Re-bound on every render; the nodes it touches are always the
 * fresh ones.
 */
function wireQuickAdd(sections: HTMLElement, quickAdd: (title: string, iso: string) => void): void {
  const row = sections.querySelector<HTMLElement>('[data-cal-quickadd]');
  const input = row?.querySelector<HTMLInputElement>('[data-cal-quickadd-input]');
  if (!row || !input) return;

  const openRow = (): void => {
    // The Add button aims plain: the selected day at 9:00 (a slot
    // double-click aims its own hour instead, and it goes with the row).
    quickAddSlot = null;
    input.placeholder = 'New Reminder';
    row.hidden = false;
    input.focus();
  };

  sections.querySelector('[data-cal-add]')?.addEventListener('click', openRow);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      quickAddSlot = null;
      row.hidden = true;
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    // The words go with the submit: the row survives the re-render now
    // (the preserve below re-opens it), and it opens empty for the
    // next reminder — the just-added title must not read as pending.
    input.value = '';
    // The aimed hour when a slot double-click opened the row, else the
    // day at 9:00 — the same anchor the day pane shows.
    const at = new Date(quickAddSlot ? quickAddSlot.day : selectedDay);
    at.setHours(quickAddSlot ? quickAddSlot.hour : 9, 0, 0, 0);
    quickAdd(title, at.toISOString());
    // The hub re-renders the page (the chip lands on the grid, the row
    // lands in the pane) — the fresh row paints closed, so open it and
    // keep the caret there for the next reminder. If the page went away
    // with the add (the create-first-list rescue closes the hub), the
    // row sits in a hidden hub and stays put.
    const fresh = sections.querySelector<HTMLElement>('[data-cal-quickadd]');
    const freshInput = fresh?.querySelector<HTMLInputElement>('[data-cal-quickadd-input]');
    const hubLive = !sections.closest<HTMLElement>('#tasksHub')?.hidden;
    if (fresh && freshInput && hubLive) {
      fresh.hidden = false;
      if (quickAddSlot) applySlotPlaceholder(freshInput);
      freshInput.focus();
    }
  });

  input.addEventListener('focusout', () => {
    if (input.value === '') {
      quickAddSlot = null;
      row.hidden = true;
    }
  });
}

/** The color of the list the quick-add files into (muted when none). */
function quickAddTargetColor(): string {
  const lists = taskNotes.lists();
  if (lists.length === 0) return '';
  const id = taskNotes.targetListId();
  const target = lists.find((list) => list.id === id) ?? lists[0]!;
  return target.color;
}

/**
 * Whether the day pane's inline add row is on screen right now — the
 * hub's Escape bookkeeping counts it as an inner consumer, so closing
 * the row never closes the page with it.
 */
export function calendarQuickAddOpen(): boolean {
  const row = document
    .getElementById('tasksHub')
    ?.querySelector<HTMLElement>('[data-cal-quickadd]');
  return row != null && !row.hidden;
}

/** Puts the inline add row away — the hub's Escape dispatcher's act. */
export function closeCalendarQuickAdd(): void {
  const row = document
    .getElementById('tasksHub')
    ?.querySelector<HTMLElement>('[data-cal-quickadd]');
  if (!row || row.hidden) return;
  const input = row.querySelector<HTMLInputElement>('[data-cal-quickadd-input]');
  if (input) input.value = '';
  quickAddSlot = null;
  row.hidden = true;
}

// ---------------------------------------------------------------------------
// Drag a chip between the hours — the retime
// ---------------------------------------------------------------------------

/**
 * The retime drag, wired once on the sections container: chips (Week)
 * and the Day sheet's rows are draggable; the hour slots and the
 * All-Day cells are the targets. Hovering paints the accent drop line
 * with the exact minute as a bubble; dropping rewrites the stamp that
 * anchored the chip on the day it was picked from (reminderAt first,
 * then dueDate — the same anchor the ruling shows) to the drop's day
 * and minute. The All-Day band takes a chip back out of the hours (the
 * time comes off), an hour slot puts one in, and a cross-column drop
 * moves the day with it. The inline editor's inputs keep their text
 * selection: a drag started inside an open editor is cancelled.
 */
function wireRetime(sections: HTMLElement): void {
  sections.addEventListener('dragstart', (event) => {
    const target = event.target as Element;
    const wrap = target.closest<HTMLElement>('.tk-task-wrap[draggable]');
    let picked: DragRetime;
    if (wrap) {
      if (wrap.classList.contains('is-editing')) {
        event.preventDefault();
        return;
      }
      const fromKey = wrap.closest('.tkcal-daypage')
        ? dayKey(selectedDay)
        : (wrap.getAttribute('data-cal-from') ?? '');
      picked = { taskId: wrap.dataset.id ?? '', fromKey, el: wrap };
      wrap.classList.add('is-dragging');
    } else {
      const chip = target.closest<HTMLElement>('.tkcal-chip[draggable]');
      if (!chip) return;
      picked = {
        taskId: chip.dataset.calTask ?? '',
        fromKey: chip.dataset.calFrom ?? '',
        el: chip,
      };
      chip.classList.add('is-dragging');
    }
    dragRetime = picked;
    event.dataTransfer?.setData('text/plain', picked.taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });

  sections.addEventListener('dragover', (event) => {
    if (!dragRetime) return;
    const hit = dropTargetAt(event.target as Element);
    if (!hit) {
      clearDropPaint();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    paintDrop(hit, event.clientY);
    nudgeScroll(hit.el, event.clientY);
  });

  sections.addEventListener('drop', (event) => {
    if (!dragRetime) return;
    const hit = dropTargetAt(event.target as Element);
    if (hit) {
      event.preventDefault();
      commitRetime(dragRetime.taskId, dragRetime.fromKey, hit, event.clientY);
    }
    endRetime();
  });

  sections.addEventListener('dragend', () => endRetime());

  // Leaving the glass — not just crossing between children — puts the
  // drop paint away; dragend closes whatever remains.
  sections.addEventListener('dragleave', (event) => {
    if (!dragRetime) return;
    const next = event.relatedTarget;
    if (next instanceof Node && sections.contains(next)) return;
    clearDropPaint();
  });
}

/** Where a drop would land: an hour slot (it wears data-hour) or an
 * All-Day cell — the Day sheet's slots resolve their day through the
 * picked day, the Week's carry it in plain sight. */
function dropTargetAt(
  target: Element,
): { kind: 'hour'; el: HTMLElement } | { kind: 'allday'; el: HTMLElement } | null {
  const slot = target.closest<HTMLElement>('.tkcal-wk-slot[data-hour], .tkcal-day-slot[data-hour]');
  if (slot) return { kind: 'hour', el: slot };
  const cell = target.closest<HTMLElement>('.tkcal-wk-allday-cell, .tkcal-day-allday-body');
  if (cell) return { kind: 'allday', el: cell };
  return null;
}

/** The minute a drop at `clientY` means inside `slot`: the slot IS the
 * hour, so its height maps to sixty minutes, snapped to five. */
function minuteAt(slot: HTMLElement, clientY: number): number {
  const rect = slot.getBoundingClientRect();
  const frac = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  const clamped = Math.max(0, Math.min(0.999, frac));
  return Math.min(55, Math.floor(clamped * 12) * 5);
}

/** Paints the target: the slot wears the wash and carries the accent
 * drop line with the exact minute as a bubble; the All-Day cell just
 * the wash (its label already says All-Day). */
function paintDrop(
  hit: { kind: 'hour'; el: HTMLElement } | { kind: 'allday'; el: HTMLElement },
  clientY: number,
): void {
  if (dropOver !== hit.el) {
    dropOver?.classList.remove('is-drop-over');
    hit.el.classList.add('is-drop-over');
    dropOver = hit.el;
  }
  if (hit.kind !== 'hour') {
    dropMarker?.remove();
    dropMarker = null;
    return;
  }
  if (!dropMarker) {
    dropMarker = document.createElement('span');
    dropMarker.className = 'tkcal-dropline';
    dropMarker.setAttribute('aria-hidden', 'true');
    const bubble = document.createElement('span');
    bubble.className = 'tkcal-dropline-time';
    dropMarker.appendChild(bubble);
  }
  const slot = hit.el;
  const rect = slot.getBoundingClientRect();
  const top = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
  const bubble = dropMarker.querySelector<HTMLElement>('.tkcal-dropline-time');
  if (bubble) bubble.textContent = dropTimeLabel(slot, minuteAt(slot, clientY));
  dropMarker.style.top = `${top}px`;
  slot.appendChild(dropMarker);
}

/** The time the bubble promises: the slot's day and hour plus the
 * dragged minute — "2:35 PM". */
function dropTimeLabel(slot: HTMLElement, minute: number): string {
  const day = parseWhen(`${slot.dataset.calDay ?? dayKey(selectedDay)}T00:00:00`);
  const at = day ? new Date(day) : new Date();
  at.setHours(Number(slot.dataset.hour ?? 0), minute, 0, 0);
  return chipTimeLabel(at);
}

/** Sliding near a timed page's top or bottom edge scrolls the hours —
 * a drag can reach an hour that isn't on screen yet. */
function nudgeScroll(el: HTMLElement, clientY: number): void {
  const box = el.closest<HTMLElement>('.tkcal-wk-time, .tkcal-daypage-scroll');
  if (!box) return;
  const rect = box.getBoundingClientRect();
  if (clientY < rect.top + 36) box.scrollTop -= 14;
  else if (clientY > rect.bottom - 36) box.scrollTop += 14;
}

function clearDropPaint(): void {
  dropOver?.classList.remove('is-drop-over');
  dropOver = null;
  dropMarker?.remove();
  dropMarker = null;
}

function endRetime(): void {
  dragRetime?.el.classList.remove('is-dragging');
  dragRetime = null;
  clearDropPaint();
}

/** Writes the drop. The stamp that anchored the chip on the day it was
 * picked from moves to the drop's day and minute; into the All-Day
 * band it lands at midnight — this model's "no time set". Midnight
 * itself is never written (it would read as All-Day), so the earliest
 * minute in the 12 AM slot is 12:01. A no-op drop — the chip's own
 * slot, the same minute — writes nothing at all. */
function commitRetime(
  taskId: string,
  fromKey: string,
  hit: { kind: 'hour'; el: HTMLElement } | { kind: 'allday'; el: HTMLElement },
  clientY: number,
): void {
  const found = taskNotes.taskById(taskId);
  if (!found) return;
  const sourceDay = parseWhen(`${fromKey}T00:00:00`) ?? startOfDay(new Date());
  const field = retimeField(found.task, sourceDay);
  if (!field) return;
  const day = parseWhen(`${hit.el.dataset.calDay ?? dayKey(selectedDay)}T00:00:00`) ?? sourceDay;
  const stamp = startOfDay(day);
  if (hit.kind === 'allday') {
    applyRetime(taskId, field, stamp.toISOString());
    return;
  }
  const hour = Number(hit.el.dataset.hour ?? 0);
  const minute = minuteAt(hit.el, clientY);
  stamp.setHours(hour, hour === 0 && minute === 0 ? 1 : minute, 0, 0);
  applyRetime(taskId, field, stamp.toISOString());
}

function applyRetime(taskId: string, field: 'reminderAt' | 'dueDate', iso: string): void {
  const found = taskNotes.taskById(taskId);
  if (!found || found.task[field] === iso) return;
  landedTaskId = taskId;
  landedAt = Date.now();
  if (field === 'reminderAt') taskNotes.updateTask(taskId, { reminderAt: iso });
  else taskNotes.updateTask(taskId, { dueDate: iso });
}

/** Which stamp a drag retimes: the one anchoring the chip on the day
 * it was picked from — a stamp carrying a real time wins (the
 * reminder time first, then the due date, the ruling's own order),
 * else whichever date-only stamp put it on that day. */
function retimeField(task: Task, sourceDay: Date): 'reminderAt' | 'dueDate' | null {
  for (const field of ['reminderAt', 'dueDate'] as const) {
    const date = parseWhen(task[field]);
    if (date && hasTime(date) && sameDay(date, sourceDay)) return field;
  }
  for (const field of ['reminderAt', 'dueDate'] as const) {
    const date = parseWhen(task[field]);
    if (date && sameDay(date, sourceDay)) return field;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Double-click a bare hour — quick-add aimed at that exact hour
// ---------------------------------------------------------------------------

/**
 * Opens the page's quick-add row aiming at the double-clicked slot:
 * Enter files at that day and hour instead of the 9:00 default, and
 * the placeholder says so ("New Reminder on Tue at 2 PM"). The aim
 * rides the module state — it goes with the row across the re-render
 * each filed reminder causes, and clears the moment the row closes.
 */
function openQuickAddForSlot(sections: HTMLElement, slot: HTMLElement): void {
  const day = parseWhen(`${slot.dataset.calDay ?? dayKey(selectedDay)}T00:00:00`);
  const hour = Number(slot.dataset.hour ?? NaN);
  if (!day || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
  const row = sections.querySelector<HTMLElement>('[data-cal-quickadd]');
  const input = row?.querySelector<HTMLInputElement>('[data-cal-quickadd-input]');
  if (!row || !input) return;
  quickAddSlot = { day, hour };
  applySlotPlaceholder(input);
  row.hidden = false;
  input.focus();
}

/** The placeholder while the row aims at a slot — the exact hour spelled out. */
function applySlotPlaceholder(input: HTMLInputElement): void {
  if (!quickAddSlot) return;
  const at = new Date(quickAddSlot.day);
  at.setHours(quickAddSlot.hour, 0, 0, 0);
  const time = chipTimeLabel(at);
  const word = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(quickAddSlot.day);
  input.placeholder =
    mode === 'day' ? `New Reminder at ${time}` : `New Reminder on ${word} at ${time}`;
}

// ---------------------------------------------------------------------------
// Day math + collection
// ---------------------------------------------------------------------------

function firstOfMonth(date: Date): Date {
  const copy = startOfDay(date);
  copy.setDate(1);
  return copy;
}

function shiftMonth(month: Date, delta: number): Date {
  const copy = new Date(month);
  copy.setMonth(copy.getMonth() + delta);
  return copy;
}

function shiftYear(month: Date, delta: number): Date {
  const copy = new Date(month);
  copy.setFullYear(copy.getFullYear() + delta);
  return copy;
}

function shiftWeek(day: Date, delta: number): Date {
  const copy = new Date(day);
  copy.setDate(copy.getDate() + delta * 7);
  return copy;
}

function shiftDay(day: Date, delta: number): Date {
  const copy = new Date(day);
  copy.setDate(copy.getDate() + delta);
  return copy;
}

/** Day view's arrows move the picked day itself — and keep the other
 * pages' cursors riding on it, so a later flip lands where the user
 * just was. */
function stepSelectedDay(delta: number): void {
  selectedDay = startOfDay(shiftDay(selectedDay, delta));
  cursorMonth = firstOfMonth(selectedDay);
  cursorWeek = selectedDay;
}

/** The Sunday that opens the week containing `day`. */
function weekStart(day: Date): Date {
  const copy = startOfDay(day);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

/** The Week page's title — the range on the glass, Apple-style:
 * "Oct 19 – 25, 2026", crossing months "Sep 28 – Oct 4, 2026",
 * crossing years "Dec 28, 2026 – Jan 3, 2027". */
function weekLabel(anchor: Date): string {
  const start = weekStart(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  if (start.getFullYear() !== end.getFullYear()) {
    const fullFmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return `${fullFmt.format(start)} – ${fullFmt.format(end)}`;
  }
  if (start.getMonth() === end.getMonth()) {
    return `${dayFmt.format(start)} – ${end.getDate()}, ${start.getFullYear()}`;
  }
  return `${dayFmt.format(start)} – ${dayFmt.format(end)}, ${start.getFullYear()}`;
}

/** The Day page's title — the whole day spelled out, Apple-style:
 * "Sunday, October 18", with the year riding along once it's not this
 * one (stepping across December 31 keeps its bearings). */
function dayPageLabel(day: Date, today: Date): string {
  const base = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(day);
  return day.getFullYear() === today.getFullYear() ? base : `${base}, ${day.getFullYear()}`;
}

/**
 * The Day page — one wide sheet, hour-ruled. The head pairs the big
 * numeral with the weekday word (both Apple red when the day is
 * today) and carries the Add button — the sidebar's day inspector
 * stands down here, because the sheet IS the inspector. Below it the
 * day's reminders anchor under their hour down a time gutter as the
 * same real rows every page wears (completing and the inline editor
 * work right on them), date-only ones in an All-Day band up top, and
 * Apple's red now-line runs through the current hour. A quiet day
 * keeps the ruling and floats the friendly copy over it, centered.
 */
function dayPageHtml(day: Date, today: Date, addBtnHtml: string, quickAddHtml: string): string {
  const wordFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const schedule = daySchedule(day);
  const empty = schedule.allDay.length === 0 && schedule.timed.length === 0;
  const now = new Date();
  const nowHour = now.getHours();

  const allDayHtml = schedule.allDay.length
    ? `<div class="tkcal-day-allday"><span class="tkcal-hour">All-Day</span><div class="tkcal-day-allday-body tk-rows" role="list">${schedule.allDay
        .map((row) => taskRow(row.task, now, row.note.color, true, row.note))
        .join('')}</div></div>`
    : '';

  const gutter = hourGutterLabels();
  const slots = gutter.map((_, hour) => {
    const rows = schedule.timed.filter((t) => t.at.getHours() === hour);
    const render = (t: { row: AggTask }): string =>
      taskRow(t.row.task, now, t.row.note.color, true, t.row.note);
    let inner: string;
    if (sameDay(day, today) && hour === nowHour) {
      const split = nowSplit(
        rows.length,
        (index) => rows[index]!.at.getMinutes(),
        now.getMinutes(),
      );
      const nudge = rows.length === 0 ? Math.round((now.getMinutes() / 60) * 56) : 0;
      inner =
        rows.slice(0, split).map(render).join('') +
        nowDividerHtml(nudge) +
        rows.slice(split).map(render).join('');
    } else {
      inner = rows.map(render).join('');
    }
    return `<div class="tkcal-day-slot" data-hour="${hour}">${inner}</div>`;
  });

  const classes = [
    'tkcal-daypage',
    day.getDay() === 0 || day.getDay() === 6 ? 'is-weekend' : '',
    sameDay(day, today) ? 'is-today' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
      <div class="${classes}">
        <div class="tkcal-daypage-head">
          <span class="tkcal-daypage-num">${day.getDate()}</span>
          <span class="tkcal-daypage-word">${wordFmt.format(day)}</span>
          ${addBtnHtml}
        </div>
        ${quickAddHtml}
        <div class="tkcal-daypage-body">
          <div class="tkcal-daypage-scroll" data-cal-daypage-rows>
            ${allDayHtml}
            <div class="tkcal-day-hours">${gutter
              .map((label, hour) => label + slots[hour])
              .join('')}</div>
          </div>
          ${
            empty
              ? `<div class="tkcal-daypage-empty"><div class="tk-empty tk-empty-day"><span class="tk-empty-day-mark">${calendarMark(
                  day,
                  today,
                )}</span><p class="tk-empty-day-copy">${dayPageEmptyCopy(day, today)}</p></div></div>`
              : ''
          }
        </div>
      </div>`;
}

/** The year's twelve cursor months — January through December. */
function monthsOfYear(year: Date): Date[] {
  return Array.from({ length: 12 }, (_, i) => new Date(year.getFullYear(), i, 1));
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function weekdayLabels(): string[] {
  // Sunday-first, matching the grid below (the US convention the app's
  // English UI ships with). Short names — the iCloud header.
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const labels: string[] = [];
  const anchor = new Date(2023, 9, 1); // a Sunday
  for (let i = 0; i < 7; i += 1) {
    labels.push(
      fmt.format(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i)),
    );
  }
  return labels;
}

/**
 * The cells covering the cursor month, Sunday-first — exactly as many
 * weeks as the month needs (five or six, never padding rows), the way
 * the macOS calendar lays a month out.
 */
function monthCells(month: Date): { date: Date; key: string }[] {
  const start = new Date(month);
  start.setDate(1 - start.getDay()); // back to Sunday
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((month.getDay() + daysInMonth) / 7);
  const cells: { date: Date; key: string }[] = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    cells.push({ date, key: dayKey(date) });
  }
  return cells;
}

/**
 * The mini month — only this month's days, six-wide tiny numbers, the
 * sidebar's bottom fixture. Today rides a red dot; the selected day a
 * ring. Both are pure CSS states on the buttons.
 */
function miniCells(month: Date, selected: Date, today: Date): string {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const anchor = new Date(2023, 9, 1); // a Sunday
  const head = Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i)),
  )
    .map((label) => `<span class="tkcal-mini-wd">${label}</span>`)
    .join('');
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = month.getDay();
  const blanks = Array.from(
    { length: lead },
    () => `<span class="tkcal-mini-day is-blank"></span>`,
  );
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
    const isToday = sameDay(date, today);
    const isSelected = sameDay(date, selected);
    const classes = ['tkcal-mini-day', isToday ? 'is-today' : '', isSelected ? 'is-selected' : '']
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${classes}" data-cal-day="${dayKey(date)}" aria-label="${
      i + 1
    }">${i + 1}</button>`;
  });
  return head + blanks.join('') + days.join('');
}

/**
 * One little month on the Year page — the month's name (a button that
 * zooms into Month view) over a seven-wide run of bare numerals, no
 * weekday letters (the macOS year spread). A day carrying reminders
 * reads darker and medium; today rides the red circle, the picked day
 * a ring — the same states the mini month wears.
 */
function yearMonthHtml(
  month: Date,
  selected: Date,
  today: Date,
  byDay: Map<string, AggTask[]>,
): string {
  const name = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(month);
  const labelFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const blanks = Array.from(
    { length: month.getDay() },
    () => `<span class="tkcal-year-day is-blank" aria-hidden="true"></span>`,
  );
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
    const count = byDay.get(dayKey(date))?.length ?? 0;
    const classes = [
      'tkcal-year-day',
      count > 0 ? 'has-events' : '',
      sameDay(date, today) ? 'is-today' : '',
      sameDay(date, selected) ? 'is-selected' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${classes}" data-cal-day="${dayKey(
      date,
    )}" aria-label="${labelFmt.format(date)}${
      count > 0 ? `, ${count} reminders` : ''
    }">${i + 1}</button>`;
  });
  return `
      <section class="tkcal-year-month">
        <button type="button" class="tkcal-year-name" data-cal-jump="${dayKey(
          month,
        )}" title="Open ${name} in Month view">${name}</button>
        <div class="tkcal-year-grid">${blanks.join('')}${days.join('')}</div>
      </section>`;
}

// ---------------------------------------------------------------------------
// The timed pages — the hour ruling Day and Week share
// ---------------------------------------------------------------------------

/** One day's reminders, split the way the timed pages show them: the
 * date-only ones (the All-Day band) and the ones carrying a real
 * time, soonest first. */
interface DaySchedule {
  allDay: AggTask[];
  timed: { row: AggTask; at: Date }[];
}

function daySchedule(day: Date): DaySchedule {
  const allDay: AggTask[] = [];
  const timed: { row: AggTask; at: Date }[] = [];
  for (const row of dayTasks(day, new Date())) {
    const at = timedAnchorOn(row.task, day);
    if (at) timed.push({ row, at });
    else allDay.push(row);
  }
  timed.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { allDay, timed };
}

/** The stamp that anchors a reminder inside its hour — the first of
 * the reminder time and the due date that carries a real time on this
 * day. Midnight means "no time set": those land in All-Day, the same
 * call the due chips make. */
function timedAnchorOn(task: Task, day: Date): Date | null {
  for (const iso of [task.reminderAt, task.dueDate]) {
    if (!iso) continue;
    const date = parseWhen(iso);
    if (date && hasTime(date) && sameDay(date, day)) return date;
  }
  return null;
}

/** The gutter: the 24 hour labels, 12 AM through 11 PM in the
 * locale's own spelling, one per ruled row (`data-hour` is the
 * scroll anchor the timed pages open at). */
function hourGutterLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
  return Array.from({ length: 24 }, (_, hour) => {
    const at = new Date(2023, 0, 1, hour);
    return `<span class="tkcal-hour" data-hour="${hour}">${fmt.format(at)}</span>`;
  });
}

/** A chip's time tag — "9 AM", or "9:30 AM" once minutes join. */
function chipTimeLabel(at: Date): string {
  if (at.getMinutes() === 0) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(at);
  }
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** Apple's red now-line, dot and all. `nudge` pushes it down an empty
 * hour slot so it sits at the real minute instead of the slot's top
 * edge — a populated slot gets it in flow, between its children. */
function nowDividerHtml(nudge: number): string {
  return `<span class="tkcal-now"${
    nudge > 0 ? ` style="margin-top:${nudge}px"` : ''
  } aria-hidden="true"></span>`;
}

/** Where the now-line goes among a slot's children: before the first
 * that starts after now, else last — chronology the ruling can trust
 * even when a busy hour has stretched. */
function nowSplit(count: number, minutesOf: (index: number) => number, nowMinute: number): number {
  for (let i = 0; i < count; i += 1) {
    if (minutesOf(i) > nowMinute) return i;
  }
  return count;
}

/** The washes a week day wears wherever it appears — header, All-Day
 * cell, hour slot: the weekend whisper, today, the picked day's
 * accent. */
function weekDayClasses(date: Date, selected: Date, today: Date): string {
  return [
    date.getDay() === 0 || date.getDay() === 6 ? 'is-weekend' : '',
    sameDay(date, today) ? 'is-today' : '',
    sameDay(date, selected) ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The week chip — the month chip's tint, wearing its hour when the
 * reminder carries a time ("9 AM · Title"), draggable so it can be
 * dropped into another hour (or day, or the All-Day band) to retime;
 * `from` is the day column it was rendered in — the stamp that gets
 * retimed is the one anchoring it there. Every one on the glass. */
function weekChipHtml(row: AggTask, at?: Date, from?: string): string {
  const time = at ? chipTimeLabel(at) : '';
  return `<span class="tkcal-chip tk-c-${row.note.color}" draggable="true" data-cal-task="${escapeHtml(
    row.task.id,
  )}"${from ? ` data-cal-from="${from}"` : ''} title="${escapeHtml(
    time ? `${time} · ${row.task.title}` : row.task.title,
  )}">${time ? `<span class="tkcal-chip-time">${escapeHtml(time)}</span>` : ''}${escapeHtml(
    row.task.title,
  )}</span>`;
}

/**
 * The Week page — seven day headers over the hour ruling the Day page
 * wears: a time gutter down the left, twenty-four ruled rows the
 * columns share, reminders as chips anchored under their hour, the
 * date-only ones in an All-Day band pinned under the headers. A busy
 * hour stretches its row for every column at once, so the ruling
 * never lies. The headers are the day buttons — the month grid's
 * picking, keyboard-reachable — and the hour slots pick too: every
 * pixel of a day's column belongs to some slot of that day.
 */
function weekPageHtml(anchor: Date, selected: Date, today: Date): string {
  const start = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return date;
  });
  const schedules = days.map((day) => daySchedule(day));
  const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const labelFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const heads = days
    .map((date, i) => {
      const count = schedules[i]!.allDay.length + schedules[i]!.timed.length;
      return `<button type="button" class="tkcal-wk-head ${weekDayClasses(
        date,
        selected,
        today,
      )}" data-cal-day="${dayKey(date)}" aria-label="${labelFmt.format(date)}${
        count > 0 ? `, ${count} reminders` : ''
      }"><span class="tkcal-week-head"><span class="tkcal-week-wd">${wdFmt.format(
        date,
      )}</span><span class="tkcal-week-num">${date.getDate()}</span></span></button>`;
    })
    .join('');

  const hasAllDay = schedules.some((s) => s.allDay.length > 0);
  const allDayHtml = hasAllDay
    ? `<div class="tkcal-wk-allday"><span class="tkcal-hour">All-Day</span>${days
        .map(
          (date, i) =>
            `<span class="tkcal-wk-allday-cell ${weekDayClasses(
              date,
              selected,
              today,
            )}" data-cal-day="${dayKey(date)}">${schedules[i]!.allDay.map((row) =>
              weekChipHtml(row, undefined, dayKey(date)),
            ).join('')}</span>`,
        )
        .join('')}</div>`
    : '';

  const now = new Date();
  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();
  const gutter = hourGutterLabels();
  const rows = gutter.map((_, hour) => {
    const cells = days
      .map((date, i) => {
        const chips = schedules[i]!.timed.filter((t) => t.at.getHours() === hour);
        let inner: string;
        if (sameDay(date, today) && hour === nowHour) {
          const split = nowSplit(chips.length, (index) => chips[index]!.at.getMinutes(), nowMinute);
          const nudge = chips.length === 0 ? Math.round((nowMinute / 60) * 56) : 0;
          const before = chips
            .slice(0, split)
            .map((t) => weekChipHtml(t.row, t.at, dayKey(date)))
            .join('');
          const after = chips
            .slice(split)
            .map((t) => weekChipHtml(t.row, t.at, dayKey(date)))
            .join('');
          inner = before + nowDividerHtml(nudge) + after;
        } else {
          inner = chips.map((t) => weekChipHtml(t.row, t.at, dayKey(date))).join('');
        }
        return `<span class="tkcal-wk-slot ${weekDayClasses(
          date,
          selected,
          today,
        )}" data-cal-day="${dayKey(date)}" data-hour="${hour}">${inner}</span>`;
      })
      .join('');
    return gutter[hour] + cells;
  });

  return `<div class="tkcal-wk-heads"><span class="tkcal-wk-corner" aria-hidden="true"></span>${heads}</div>${allDayHtml}<div class="tkcal-wk-time">${rows.join(
    '',
  )}</div>`;
}

/**
 * The chips: for every day, the visible tasks due or reminding that day
 * (hidden lists swept out), soonest first.
 */
function collectByDay(): Map<string, AggTask[]> {
  const byDay = new Map<string, AggTask[]>();
  for (const row of allActiveTasks()) {
    for (const iso of [row.task.dueDate, row.task.reminderAt]) {
      if (!iso) continue;
      const date = parseWhen(iso);
      if (!date) continue;
      const key = dayKey(date);
      const rows = byDay.get(key) ?? [];
      if (!rows.some((candidate) => candidate.task.id === row.task.id)) {
        rows.push(row);
        byDay.set(key, rows);
      }
    }
  }
  for (const rows of byDay.values()) {
    rows.sort((a, b) => anchorTime(a.task) - anchorTime(b.task));
  }
  return byDay;
}

/** The selected day's tasks: due that day or reminding that day, by time. */
function dayTasks(day: Date, now: Date): AggTask[] {
  return allActiveTasks()
    .filter((row) => {
      for (const iso of [row.task.dueDate, row.task.reminderAt]) {
        if (!iso) continue;
        const date = parseWhen(iso);
        if (date && sameDay(date, day)) return true;
      }
      return false;
    })
    .sort((a, b) => anchorTime(a.task, now) - anchorTime(b.task, now));
}

/**
 * How many active reminders the selected day shows — the hub's confetti
 * check (complete the day's last reminder on the calendar and the day
 * empties, exactly like the smart views empty). Lives here because the
 * selection + the hidden lists are this module's state.
 */
export function selectedDayCount(): number {
  return dayTasks(selectedDay, new Date()).length;
}

/** The next few dated reminders after the selected day, soonest first. */
function upcomingAfter(day: Date, now: Date, limit: number): AggTask[] {
  const endOfDay = startOfDay(day);
  endOfDay.setDate(endOfDay.getDate() + 1);
  return allActiveTasks()
    .map((row) => ({ row, at: anchorTime(row.task, now) }))
    .filter(({ at }) => at >= endOfDay.getTime())
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ row }) => row);
}

function anchorTime(task: Task, now: Date = new Date()): number {
  const anchor = parseWhen(task.dueDate || task.reminderAt);
  return anchor?.getTime() ?? now.getTime();
}

function allActiveTasks(): AggTask[] {
  const out: AggTask[] = [];
  for (const list of taskNotes.lists()) {
    if (hiddenLists.has(list.id)) continue;
    const entry = taskNotes.noteById(list.id);
    if (!entry) continue;
    for (const task of entry.model.tasks) {
      if (!task.completed) out.push({ task, note: list });
    }
  }
  return out;
}

function dayHeading(day: Date, today: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  // Compact — "Wed, Oct 21", Apple's inspector style. The long spelling
  // wraps in a 264px pane that also carries the Add button.
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(day);
}

function calendarMark(day: Date, today: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff > 0) return 'Nothing scheduled yet';
  if (diff < 0) return 'Nothing was due';
  return 'Nothing due today';
}

function emptyDayCopy(day: Date, today: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff === 0) return 'Pick a day with chips, or add the first one.';
  if (diff > 0) return 'Add a reminder from this day to fill it in.';
  return 'A quiet day, in the books.';
}

/** The Day sheet's empty copy — there are no chips to pick out here,
 * the Add button is in the head, so the hint just says so. */
function dayPageEmptyCopy(day: Date, today: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff < 0) return 'A quiet day, in the books.';
  return 'Add a reminder and it lands right here.';
}
