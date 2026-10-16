/**
 * The ONE calendar — every dated task, one grid.
 *
 * The rail's Calendar destination: a month grid whose days carry dots
 * (one per contributing list's color, up to three, then a count), and a
 * day panel beside it with that day's reminders — due or reminding —
 * using the same rows as every tasks page, so completing, the inline
 * editor and moving work here too. Quick-add on a day pre-fills the hub
 * composer's date chip.
 *
 * State is module-local (the cursor month + the selected day) and
 * survives view switches; the aggregate is re-read on every render, so
 * edits elsewhere reflect immediately. Rendered INTO the hub's sections
 * container, which means the hub's delegated row handlers serve these
 * rows for free.
 */

import { taskNotes, type AggTask } from './aggregate';
import { taskRow } from '../../editor/tasks/rows';
import { parseWhen, startOfDay } from '../../editor/tasks/dates';
import type { Task } from '../../editor/tasks/content';

/** The cursor month (a date on its first day) + the selected day. */
let cursorMonth = firstOfMonth(new Date());
let selectedDay = startOfDay(new Date());

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
    const dayCell = target.closest<HTMLElement>('[data-cal-day]');
    if (dayCell) {
      const date = parseWhen(`${dayCell.dataset.calDay}T00:00:00`);
      if (date) {
        selectedDay = startOfDay(date);
        renderTasksCalendar();
      }
      return;
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
  const byDay = collectByDay();

  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(cursorMonth);
  const isThisMonth =
    cursorMonth.getFullYear() === today.getFullYear() &&
    cursorMonth.getMonth() === today.getMonth();

  const gridHtml = monthCells(cursorMonth)
    .map((cell) => {
      const inMonth = cell.date.getMonth() === cursorMonth.getMonth();
      const isToday = sameDay(cell.date, today);
      const isSelected = sameDay(cell.date, selectedDay);
      const dots = byDay.get(dayKey(cell.date)) ?? [];
      const visibleDots = dots.slice(0, 3);
      const more = dots.length > 3 ? dots.length - 3 : 0;
      const dotsHtml =
        visibleDots
          .map((color) => `<span class="tkcal-dot tk-c-${color}" aria-hidden="true"></span>`)
          .join('') + (more > 0 ? `<span class="tkcal-more">+${more}</span>` : '');
      return `
        <button type="button" class="tkcal-day${inMonth ? '' : ' is-outside'}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}" data-cal-day="${dayKey(
          cell.date,
        )}" aria-label="${new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }).format(cell.date)}${dots.length > 0 ? `, ${dots.length} reminders` : ''}">
            <span class="tkcal-num">${cell.date.getDate()}</span>
            <span class="tkcal-dots">${dotsHtml}</span>
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
    : `<div class="tk-empty tk-empty-day">${emptyDayCopy(selectedDay, today)}</div>`;

  sections.innerHTML = `
    <div class="tkcal">
      <div class="tkcal-grid-pane">
        <header class="tkcal-head">
          <button type="button" class="tkcal-nav" data-cal-prev title="Previous month" aria-label="Previous month">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>
          </button>
          <h5 class="tkcal-month">${monthLabel}</h5>
          <button type="button" class="tkcal-nav" data-cal-next title="Next month" aria-label="Next month">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </button>
          ${isThisMonth ? '' : '<button type="button" class="tk-chip-btn tkcal-today" data-cal-today>Today</button>'}
        </header>
        <div class="tkcal-weekdays">${weekdays}</div>
        <div class="tkcal-grid" role="grid">${gridHtml}</div>
      </div>
      <div class="tkcal-day-pane">
        <header class="tkcal-day-head">
          <h5 class="tkcal-day-title">${dayLabel}</h5>
          <span class="tkcal-day-count">${dayRows.length > 0 ? `${dayRows.length}` : ''}</span>
          ${
            prefillComposerDate
              ? `<button type="button" class="tk-chip-btn" data-cal-add title="Add a reminder on this day" aria-label="Add a reminder on this day"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add</span></button>`
              : ''
          }
        </header>
        <div class="tk-rows" role="list" data-cal-day-rows>${rowsHtml}</div>
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
  // English UI ships with).
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const labels: string[] = [];
  const anchor = new Date(2023, 9, 1); // a Sunday
  for (let i = 0; i < 7; i += 1) {
    labels.push(
      fmt.format(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i)),
    );
  }
  return labels;
}

/** The 42 cells (6 weeks) covering the cursor month, Sunday-first. */
function monthCells(month: Date): { date: Date; key: string }[] {
  const start = new Date(month);
  start.setDate(1 - start.getDay()); // back to Sunday
  const cells: { date: Date; key: string }[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    cells.push({ date, key: dayKey(date) });
  }
  return cells;
}

/**
 * The dots: for every day, the DISTINCT list colors of that day's active
 * tasks (due or reminding), newest-note-first capped by the caller.
 */
function collectByDay(): Map<string, string[]> {
  const byDay = new Map<string, string[]>();
  for (const row of allActiveTasks()) {
    for (const iso of [row.task.dueDate, row.task.reminderAt]) {
      if (!iso) continue;
      const date = parseWhen(iso);
      if (!date) continue;
      const key = dayKey(date);
      const colors = byDay.get(key) ?? [];
      if (!colors.includes(row.note.color)) {
        colors.push(row.note.color);
        byDay.set(key, colors);
      }
    }
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

function anchorTime(task: Task, now: Date): number {
  const anchor = parseWhen(task.dueDate || task.reminderAt);
  return anchor?.getTime() ?? now.getTime();
}

function allActiveTasks(): AggTask[] {
  const out: AggTask[] = [];
  for (const list of taskNotes.lists()) {
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

function emptyDayCopy(day: Date, today: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff === 0) return 'Nothing due today';
  if (diff > 0) return 'Nothing due this day yet';
  return 'Nothing was due this day';
}
