/**
 * Task list notes — the row markup builders, pure.
 *
 * Everything the surface page and the hub re-render: task sections, task
 * rows, the inline detail editor, the empty states and the shared
 * popovers (when-picker, priority menu, move-between-lists menu). No
 * lookups, no state: (task, lists, now) in, HTML out, escaped on the way
 * through.
 *
 * Rows carry an optional LIST chip: inside a task note the list is the
 * note itself (no chip), but the hub's aggregated views (Today, All…)
 * show each row's origin — Apple paints the list's name under the title
 * the same way.
 */

import { ICONS } from './icons';
import { formatDueChip, formatReminderChip, isOverdue } from './dates';
import { type Task } from './content';
import { escapeHtml } from '../../lib/escape';

/** The list facts a row chip (or a move menu) needs about a note. */
export interface ListRef {
  id: string;
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Task rows
// ---------------------------------------------------------------------------

/** The little chips under a title: due date, reminder, flag. */
export function rowChips(task: Task, now: Date): string {
  const chips: string[] = [];
  if (task.dueDate) {
    const overdue = !task.completed && isOverdue(task.dueDate, now);
    chips.push(
      `<span class="tk-chip tk-chip-due${overdue ? ' is-overdue' : ''}" title="${escapeHtml(
        `Due ${formatDueChip(task.dueDate, now)}`,
      )}">${ICONS.calendar}<span>${escapeHtml(formatDueChip(task.dueDate, now))}</span></span>`,
    );
  }
  if (task.reminderAt) {
    const overdue = !task.completed && new Date(task.reminderAt).getTime() < now.getTime();
    chips.push(
      `<span class="tk-chip tk-chip-remind${overdue ? ' is-overdue' : ''}" title="${escapeHtml(
        `Reminds ${formatReminderChip(task.reminderAt, now)}`,
      )}">${ICONS.bell}<span>${escapeHtml(formatReminderChip(task.reminderAt, now))}</span></span>`,
    );
  }
  if (task.flagged) {
    chips.push(
      `<span class="tk-flag" title="Flagged" aria-label="Flagged">${ICONS.flagFilled}</span>`,
    );
  }
  return chips.join('');
}

/**
 * One task row. The editor expands under .tk-task-wrap. `list` adds the
 * origin chip (the hub's aggregated views); color classes ride the wrap.
 *
 * The row reads on ONE line: the title carries the line, the metadata
 * chips (due, remind, flag) hug its right end, and the hover tools
 * (date, flag) sit at the row's far right — one click to the two most
 * common acts, no accordion required. Only real second-line content
 * (notes, the hub's origin chip) wraps under.
 */
export function taskRow(
  task: Task,
  now: Date,
  listColor: string,
  draggable: boolean,
  list?: ListRef,
): string {
  const title = escapeHtml(task.title);
  const notes = task.notes ? `<span class="tk-notes">${escapeHtml(task.notes)}</span>` : '';
  const origin = list
    ? `<span class="tk-origin tk-c-${list.color}" data-list-open="${escapeHtml(list.id)}" role="button" tabindex="0" title="Open ${escapeHtml(
        list.name,
      )}"><span class="tk-dot" aria-hidden="true"></span><span class="tk-origin-name">${escapeHtml(
        list.name,
      )}</span></span>`
    : '';
  const chips = rowChips(task, now);
  const chipLine = chips ? `<span class="tk-chips">${chips}</span>` : '';
  return `
    <div class="tk-task-wrap tk-c-${listColor}${draggable ? ' is-draggable' : ''}" data-id="${escapeHtml(
      task.id,
    )}"${draggable ? ' draggable="true"' : ''}>
        <div class="tk-task${task.completed ? ' is-done' : ''}">
            <button type="button" class="tk-check" role="checkbox" aria-checked="${
              task.completed
            }" aria-label="${task.completed ? 'Uncomplete' : 'Complete'} ${title}" title="${
              task.completed ? 'Mark as not done' : 'Mark as done'
            }">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 12.4 3.5 3.5 7.2-7.8"/></svg>
            </button>
            <button type="button" class="tk-task-main">
                <span class="tk-title-line"><span class="tk-title">${title}</span>${chipLine}</span>
                ${notes}
                ${origin}
            </button>
            <span class="tk-rowtools">
                <button type="button" class="tk-rowtool" data-row-when title="Add date" aria-label="Add a date to ${title}">${ICONS.calendar}</button>
                <button type="button" class="tk-rowtool" data-row-flag title="Flag" aria-label="Flag ${title}">${task.flagged ? ICONS.flagFilled : ICONS.flag}</button>
            </span>
        </div>
        <div class="tk-editor" hidden></div>
    </div>`;
}

/** A section: heading + rows. resolveColor yields the color class name;
 *  `color` paints a heading dot when the heading names a list. */
export function section(
  sectionData: { title: string; tone: 'default' | 'danger'; tasks: Task[]; color?: string },
  now: Date,
  resolveColor: (task: Task) => string,
  draggable: boolean,
  resolveList?: (task: Task) => ListRef | undefined,
): string {
  const rows = sectionData.tasks
    .map((task) => taskRow(task, now, resolveColor(task), draggable, resolveList?.(task)))
    .join('');
  const dot =
    sectionData.color && sectionData.title !== ''
      ? `<span class="tk-dot tk-c-${sectionData.color}" aria-hidden="true"></span>`
      : '';
  const heading =
    sectionData.title === ''
      ? ''
      : `<header class="tk-section-head${sectionData.tone === 'danger' ? ' is-danger' : ''}">
            <h5>${dot}${escapeHtml(sectionData.title)}</h5>
         </header>`;
  return `
        <section class="tk-section">
            ${heading}
            <div class="tk-rows" role="list">${rows}</div>
        </section>`;
}

/** The collapsed "N Completed" toggle row; expanded renders the done rows. */
export function completedToggle(count: number, expanded: boolean, doneRows: string): string {
  return `
    <div class="tk-done-block">
        <button type="button" class="tk-done-toggle" data-action="toggle-completed" aria-expanded="${expanded}">
            <svg class="tk-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            <span>${count} Completed</span>
        </button>
        <div class="tk-done-rows" data-done-rows ${expanded ? '' : 'hidden'}>${doneRows}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The inline detail editor
// ---------------------------------------------------------------------------

/**
 * The expanded editor under a row: title, notes, and the chip toolbar.
 * `lists` (other task notes) adds the Move chip — inside a single note
 * there is nothing to move to, in the hub's aggregated views there is.
 */
export function editor(task: Task, now: Date, lists: ListRef[] = []): string {
  const dateLabel = task.dueDate ? formatDueChip(task.dueDate, now) : 'Date';
  const remindLabel = task.reminderAt ? formatReminderChip(task.reminderAt, now) : 'Remind';
  const moveChip =
    lists.length > 0
      ? `<button type="button" class="tk-chip-btn" data-editor-move>${ICONS.moveTo}<span>Move</span></button>`
      : '';
  return `
            <div class="tk-editor-form">
                <input type="text" class="tk-editor-title" value="${escapeHtml(task.title)}" aria-label="Reminder title" maxlength="600">
                <textarea class="tk-editor-notes" rows="2" placeholder="Notes" aria-label="Reminder notes" maxlength="4000">${escapeHtml(
                  task.notes,
                )}</textarea>
                <div class="tk-editor-chips">
                    <button type="button" class="tk-chip-btn tk-chip-has${task.dueDate ? ' is-set' : ''}" data-editor-when="date">${ICONS.calendar}<span>${escapeHtml(
                      dateLabel,
                    )}</span></button>
                    <button type="button" class="tk-chip-btn tk-chip-has${task.reminderAt ? ' is-set' : ''}" data-editor-when="remind">${ICONS.bell}<span>${escapeHtml(
                      remindLabel,
                    )}</span></button>
                    <button type="button" class="tk-chip-btn tk-chip-has${task.flagged ? ' is-set' : ''}" data-editor-flag aria-pressed="${
                      task.flagged
                    }">${task.flagged ? ICONS.flagFilled : ICONS.flag}<span>Flag</span></button>
                    ${moveChip}
                    <span class="tk-editor-spacer"></span>
                    <button type="button" class="tk-chip-btn tk-chip-danger" data-editor-delete title="Delete reminder" aria-label="Delete reminder">${ICONS.trash}<span>Delete</span></button>
                </div>
            </div>`;
}

// ---------------------------------------------------------------------------
// The quick-add — one input at the top of every list view
// ---------------------------------------------------------------------------

/**
 * The quick-add row: plus dot, input, live NL preview slot, Date + Flag
 * chips. Sits at the TOP of every list view (the note page and the hub
 * views alike) — desktop's add-row, not a floating chat pill at the
 * floor. `withTarget` (hub views) carries the target-list chip; the
 * note page never needs one (its list IS the note).
 *
 * The Date/Flag chips edit a DRAFT; the natural-language parse runs in
 * the controller and writes the live preview into [data-quickadd-live].
 * The input keeps the `data-composer-input` name the e2e suite speaks.
 */
export function quickAddRow(opts: { withTarget?: boolean; placeholder?: string } = {}): string {
  const target = opts.withTarget ? `<span class="tkh-target" id="tkhTarget"></span>` : '';
  return `
        <div class="tk-quickadd" data-quickadd>
            ${target}
            <input type="text" data-composer-input class="tk-quickadd-input" placeholder="${escapeHtml(
              opts.placeholder ?? 'Add a reminder — “dentist tomorrow 9am” works',
            )}" autocomplete="off" aria-label="New reminder title">
            <span class="tk-quickadd-live" data-quickadd-live hidden></span>
            <span class="tk-quickadd-tools">
                <button type="button" class="tk-chip-btn tk-chip-has" data-composer-when="date">${ICONS.calendar}<span>Date</span></button>
                <button type="button" class="tk-chip-btn tk-chip-has" data-composer-flag aria-pressed="false">${ICONS.flag}<span>Flag</span></button>
            </span>
        </div>`;
}

// ---------------------------------------------------------------------------
// The when-popover — presets, a real month grid, an optional time
// ---------------------------------------------------------------------------

const WEEKDAY_HEADS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** An ISO stamp → its yyyy-mm-dd local day key. */
export function isoDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** An ISO stamp → the hh:mm a time input expects ('' when midnight). */
export function isoTimeValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getHours() === 0 && date.getMinutes() === 0) return '';
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A mini month grid: the popover's calendar. Weeks start Sunday, the
 * month's own days are buttons (data-when-day), today wears a ring,
 * the selected day a fill. Pure: callers re-render on prev/next. */
export function monthGrid(year: number, month: number, selectedIso: string, now: Date): string {
  const pad = (v: number): string => String(v).padStart(2, '0');
  const first = new Date(year, month, 1);
  const lead = first.getDay(); // blanks before the 1st
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = isoDayKey(now.toISOString());
  const selectedKey = selectedIso ? isoDayKey(selectedIso) : '';

  const heads = WEEKDAY_HEADS.map((d) => `<span class="tk-wgrid-wd">${d}</span>`).join('');
  const blanks = Array.from(
    { length: lead },
    () => `<span class="tk-wgrid-day is-blank"></span>`,
  ).join('');
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const key = `${year}-${pad(month + 1)}-${pad(day)}`;
    const classes = [
      'tk-wgrid-day',
      key === todayKey ? 'is-today' : '',
      key === selectedKey ? 'is-selected' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${classes}" data-when-day="${key}" aria-label="${month + 1}/${day}">${day}</button>`;
  }).join('');
  const monthLabel = new Date(year, month, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return `
        <div class="tk-wgrid" data-when-grid data-year="${year}" data-month="${month}">
            <header class="tk-wgrid-head">
                <button type="button" class="tk-wgrid-nav" data-when-nav="-1" title="Previous month" aria-label="Previous month"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
                <span class="tk-wgrid-month">${escapeHtml(monthLabel)}</span>
                <button type="button" class="tk-wgrid-nav" data-when-nav="1" title="Next month" aria-label="Next month"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
            </header>
            <div class="tk-wgrid-cells">${heads}${blanks}${days}</div>
        </div>`;
}

// ---------------------------------------------------------------------------
// Popovers (one shared element each, appended + positioned by the caller)
// ---------------------------------------------------------------------------

/**
 * The when-popover: quick presets, the month grid, the optional time.
 * `view` is the month the grid shows (the caller owns prev/next state
 * and re-renders); `selectedIso` fills the day it edits.
 */
export function whenPopover(
  mode: 'date' | 'remind',
  view: { year: number; month: number },
  selectedIso: string,
  now: Date,
): string {
  const heading = mode === 'date' ? 'Due date' : 'Remind me';
  const timeValue = selectedIso ? isoTimeValue(selectedIso) : '';
  const selectedKey = selectedIso ? isoDayKey(selectedIso) : '';
  return `
        <div class="tk-when-presets">
            <button type="button" class="tk-chip-btn" data-when-preset="today">Today</button>
            <button type="button" class="tk-chip-btn" data-when-preset="tomorrow">Tomorrow</button>
            <button type="button" class="tk-chip-btn" data-when-preset="weekend">This Weekend</button>
            <button type="button" class="tk-chip-btn" data-when-preset="nextWeek">Next Week</button>
        </div>
        ${monthGrid(view.year, view.month, selectedKey, now)}
        <div class="tk-when-foot">
            <span class="tk-when-heading">${heading}</span>
            <label class="tk-when-time"><input type="time" data-when-time aria-label="${
              mode === 'date' ? 'Due time (optional)' : 'Reminder time'
            }"${mode === 'remind' ? ' required' : ''} value="${timeValue}"></label>
            <button type="button" class="tk-chip-btn" data-when-clear>Clear</button>
        </div>`;
}

/** The move-between-lists menu — one item per task note, dots colored. */
export function moveMenu(lists: ListRef[], currentListId: string | null): string {
  const rows = lists
    .filter((list) => list.id !== currentListId)
    .map(
      (list) =>
        `<button type="button" class="tk-menu-item" data-move-to="${escapeHtml(list.id)}"><span class="tk-dot tk-c-${list.color}" aria-hidden="true"></span><span class="tk-menu-label">${escapeHtml(
          list.name,
        )}</span></button>`,
    );
  return `<div class="tk-menu-label">Move to list</div>${rows.join('')}`;
}

/** The list color palette — the page header's circle menu. */
export function colorMenu(current: string): string {
  const colors = ['blue', 'red', 'orange', 'green', 'purple', 'teal'] as const;
  return `<div class="tk-menu-label">List color</div>${colors
    .map(
      (color) =>
        `<button type="button" class="tk-menu-item tk-color-item${color === current ? ' is-on' : ''}" data-list-color="${color}"><span class="tk-dot tk-c-${color}" aria-hidden="true"></span><span class="tk-menu-label">${color}</span></button>`,
    )
    .join('')}`;
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

const emptyState = (iconSvg: string, title: string, sub: string): string =>
  `${iconSvg}<p class="tk-empty-title">${escapeHtml(title)}</p><p class="tk-empty-sub">${escapeHtml(sub)}</p>`;

export function emptyStateFor(view: string): string {
  if (view === 'search') {
    return emptyState(ICONS.search, 'No results', 'No reminder matches that search.');
  }
  if (view === 'today') {
    return emptyState(
      ICONS.today,
      'Nothing due today',
      'Give a reminder today’s date and it will show up here.',
    );
  }
  if (view === 'scheduled') {
    return emptyState(
      ICONS.scheduled,
      'Nothing scheduled',
      'Give any reminder a date and it will line up here.',
    );
  }
  if (view === 'flagged') {
    return emptyState(ICONS.flagged, 'No flagged reminders', 'Flag the ones that matter most.');
  }
  if (view === 'completed') {
    return emptyState(ICONS.completed, 'Nothing completed', 'Check one off and it moves here.');
  }
  if (view === 'all') {
    return emptyState(ICONS.all, 'No reminders', 'Write one down in the quick-add above.');
  }
  return emptyState(
    ICONS.done,
    'This list is empty',
    'Type in the quick-add above — “friday 3pm” works.',
  );
}
