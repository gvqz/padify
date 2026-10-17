/**
 * The ONE calendar — every dated task, one grid.
 *
 * The calendar door in the notes rail's head (and the rail's Calendar
 * destination) opens this page: an iCloud-style month view. The grid IS
 * the page — a big month title up top, the Day/Week/Month/Year modes
 * (Month for now, the rest wait), prev/Today/next beside them, and a
 * month grid whose days carry the day's reminders as colored chips (one
 * per task, tinted with its list's color, three then a count). The
 * RIGHT sidebar is the iCloud sidebar mirrored: the lists as colored
 * checkboxes (unchecking one sweeps its reminders off the grid), the
 * selected day's rows — due or reminding — using the same rows as every
 * tasks page, so completing, the inline editor and moving work here
 * too, an Up Next act so the panel is never a dead end, and the mini
 * month at the bottom. Quick-add on a day pre-fills the hub composer's
 * date chip.
 *
 * State is module-local (the cursor month + the selected day + the
 * hidden lists) and survives view switches; the aggregate is re-read on
 * every render, so edits elsewhere reflect immediately. Rendered INTO
 * the hub's sections container, which means the hub's delegated row
 * handlers serve these rows for free.
 */

import { taskNotes, type AggTask } from './aggregate';
import { taskRow } from '../../editor/tasks/rows';
import { parseWhen, startOfDay } from '../../editor/tasks/dates';
import { escapeHtml } from '../../lib/escape';
import type { Task } from '../../editor/tasks/content';

/** The cursor month (a date on its first day) + the selected day. */
let cursorMonth = firstOfMonth(new Date());
let selectedDay = startOfDay(new Date());
/** Task notes the user unchecked in the sidebar — their reminders hide. */
const hiddenLists = new Set<string>();

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

    if (target.closest('[data-cal-prev]')) {
      cursorMonth = shiftMonth(cursorMonth, -1);
      renderTasksCalendar();
      return;
    }
    if (target.closest('[data-cal-next]')) {
      cursorMonth = shiftMonth(cursorMonth, 1);
      renderTasksCalendar();
      return;
    }
    if (target.closest('[data-cal-today]')) {
      const today = startOfDay(new Date());
      selectedDay = today;
      cursorMonth = firstOfMonth(today);
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
}

/** Renders the calendar page into the hub's sections container. */
export function renderTasksCalendar(prefillComposerDate?: (iso: string) => void): void {
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

  const modes = ['day', 'week', 'month', 'year']
    .map((mode) => {
      const label = mode[0].toUpperCase() + mode.slice(1);
      const on = mode === 'month';
      return `<button type="button" class="tkcal-mode${on ? ' is-on' : ''}"${
        on
          ? ' aria-pressed="true"'
          : ' data-cal-mode-wip title="Month for now — more views soon" aria-disabled="true"'
      }>${label}</button>`;
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
          .join('') + (more > 0 ? `<span class="tkcal-chip-more">+${more} more</span>` : '');
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
    : `<p class="tkcal-lists-empty">No lists yet — make a task list and its dated reminders land here.</p>`;

  sections.innerHTML = `
    <div class="tkcal">
      <header class="tkcal-top">
        <h5 class="tkcal-month">${monthLabel}</h5>
        <div class="tkcal-modes" role="group" aria-label="Calendar view">${modes}</div>
        <div class="tkcal-navs">
          <button type="button" class="tkcal-nav" data-cal-prev title="Previous month" aria-label="Previous month">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>
          </button>
          <button type="button" class="tkcal-today" data-cal-today>Today</button>
          <button type="button" class="tkcal-nav" data-cal-next title="Next month" aria-label="Next month">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        </div>
      </header>
      <div class="tkcal-body">
        <div class="tkcal-grid-pane">
          <div class="tkcal-weekdays">${weekdays}</div>
          <div class="tkcal-grid" role="grid">${gridHtml}</div>
        </div>
        <aside class="tkcal-side">
          <div class="tkcal-lists">
            <div class="tkcal-side-eyebrow">My Lists</div>
            ${listsHtml}
          </div>
          <div class="tkcal-day-pane">
            <header class="tkcal-day-head">
              <div class="tkcal-day-heading">
                <h5 class="tkcal-day-title">${dayLabel}</h5>
                <span class="tkcal-day-count">${
                  dayRows.length > 0
                    ? `${dayRows.length} reminder${dayRows.length === 1 ? '' : 's'}`
                    : ''
                }</span>
              </div>
              ${
                prefillComposerDate
                  ? `<button type="button" class="tk-chip-btn" data-cal-add title="Add a reminder on this day" aria-label="Add a reminder on this day"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add</span></button>`
                  : ''
              }
            </header>
            <div class="tk-rows" role="list" data-cal-day-rows>${rowsHtml}</div>
            ${upNextHtml}
          </div>
          <div class="tkcal-mini">
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
          </div>
        </aside>
      </div>
    </div>`;

  if (prefillComposerDate) {
    sections.querySelector('[data-cal-add]')?.addEventListener('click', () => {
      // The day at 9:00 — the composer's date chip takes it from here.
      const at = new Date(selectedDay);
      at.setHours(9, 0, 0, 0);
      prefillComposerDate(at.toISOString());
    });
  }
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
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
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
