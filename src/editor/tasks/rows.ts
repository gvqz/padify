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
import { PRIORITY_MARKS, type Priority, type Task } from './content';
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

/** The little chips under a title: due date, reminder, priority marks, flag. */
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
  if (task.priority !== 'none') {
    chips.push(priorityMarks(task.priority));
  }
  if (task.flagged) {
    chips.push(
      `<span class="tk-flag" title="Flagged" aria-label="Flagged">${ICONS.flagFilled}</span>`,
    );
  }
  return chips.join('');
}

/** The ! marks — count carries the level, color is the garnish. */
export function priorityMarks(priority: Priority): string {
  const marks = '!'.repeat(PRIORITY_MARKS[priority]);
  return `<span class="tk-prio tk-prio-${priority}" aria-label="${priority} priority">${escapeHtml(
    marks,
  )}</span>`;
}

/**
 * One task row. The editor expands under .tk-task-wrap. `list` adds the
 * origin chip (the hub's aggregated views); color classes ride the wrap.
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
                <span class="tk-title">${title}</span>
                ${notes}
                ${origin}
                ${rowChips(task, now)}
            </button>
            <button type="button" class="tk-info" title="Details" aria-label="Reminder details">${ICONS.info}</button>
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
                    <button type="button" class="tk-chip-btn tk-chip-has${task.priority !== 'none' ? ' is-set' : ''}" data-editor-priority>${ICONS.chevron}<span>${priorityLabel(
                      task.priority,
                    )}</span></button>
                    ${moveChip}
                    <span class="tk-editor-spacer"></span>
                    <button type="button" class="tk-chip-btn tk-chip-danger" data-editor-delete title="Delete reminder" aria-label="Delete reminder">${ICONS.trash}<span>Delete</span></button>
                </div>
            </div>`;
}

export function priorityLabel(priority: Priority): string {
  if (priority === 'none') return 'Priority';
  return `${'!'.repeat(PRIORITY_MARKS[priority])} ${priority} priority`;
}

// ---------------------------------------------------------------------------
// Popovers (one shared element each, appended + positioned by the caller)
// ---------------------------------------------------------------------------

export function whenPopover(mode: 'date' | 'remind'): string {
  const heading = mode === 'date' ? 'Due date' : 'Remind me';
  return `
        <div class="tk-when-presets">
            <button type="button" class="tk-chip-btn" data-when-preset="today">Today</button>
            <button type="button" class="tk-chip-btn" data-when-preset="tomorrow">Tomorrow</button>
            <button type="button" class="tk-chip-btn" data-when-preset="weekend">This Weekend</button>
            <button type="button" class="tk-chip-btn" data-when-preset="nextWeek">Next Week</button>
        </div>
        <div class="tk-when-inputs">
            <label class="tk-when-field"><span>${heading}</span><input type="date" data-when-date aria-label="${
              mode === 'date' ? 'Due date' : 'Reminder date'
            }"></label>
            <label class="tk-when-field"><span>Time</span><input type="time" data-when-time aria-label="${
              mode === 'date' ? 'Due time (optional)' : 'Reminder time'
            }"${mode === 'remind' ? ' required' : ''}></label>
        </div>
        <div class="tk-when-foot">
            <button type="button" class="tk-chip-btn" data-when-clear>Clear</button>
        </div>`;
}

export function priorityMenu(priority: Priority): string {
  const item = (value: Priority, label: string): string =>
    `<button type="button" class="tk-menu-item${priority === value ? ' is-on' : ''}" data-priority="${value}">${escapeHtml(
      label,
    )}</button>`;
  return [
    item('none', 'None'),
    item('low', '!  Low'),
    item('medium', '!!  Medium'),
    item('high', '!!!  High'),
  ].join('');
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
      'Reminders you give today’s date land here.',
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
    return emptyState(ICONS.all, 'No reminders', 'Write one down in the bar below.');
  }
  return emptyState(ICONS.done, 'This list is empty', 'Add a reminder below.');
}
