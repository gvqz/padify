/**
 * Reminders — the calendar math, pure.
 *
 * Every date the UI renders goes through here so the chips read like Apple
 * ("Today 5:00 PM", "Tomorrow", "Yesterday!") and the Scheduled view
 * buckets the way Reminders does (Overdue → Today → Tomorrow → the next
 * seven days → Upcoming). No DOM, no storage — trivially testable, and
 * every function takes `now` explicitly so tests never depend on the wall
 * clock.
 */

const MS_PER_DAY = 86_400_000;

/** Parses an ISO string; null when empty, unparseable or in the future of nothing. */
export function parseWhen(iso: string): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isToday(iso: string, now: Date): boolean {
  const date = parseWhen(iso);
  return date !== null && isSameDay(date, now);
}

export function isTomorrow(iso: string, now: Date): boolean {
  const date = parseWhen(iso);
  return date !== null && isSameDay(date, new Date(now.getTime() + MS_PER_DAY));
}

export function isYesterday(iso: string, now: Date): boolean {
  const date = parseWhen(iso);
  return date !== null && isSameDay(date, new Date(now.getTime() - MS_PER_DAY));
}

/** Whole days between a due date and `now` (negative = overdue). */
export function daysAway(iso: string, now: Date): number {
  const date = parseWhen(iso);
  if (date === null) return 0;
  const due = startOfDay(date).getTime();
  const today = startOfDay(now).getTime();
  return Math.round((due - today) / MS_PER_DAY);
}

/**
 * Overdue = an ACTIVE task whose due date (day or datetime) is strictly
 * before today. A task due TODAY at any time is never overdue — Apple
 * only paints it red once the day has passed, and so do we. `active` is
 * the caller's decision; this stays pure date math.
 */
export function isOverdue(iso: string, now: Date): boolean {
  return daysAway(iso, now) < 0;
}

// ---------------------------------------------------------------------------
// Buckets — the Scheduled view's sections
// ---------------------------------------------------------------------------

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'upcoming';

/** Which Scheduled section a due date falls into. */
export function dueBucket(iso: string, now: Date): DueBucket {
  const days = daysAway(iso, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return 'week';
  return 'upcoming';
}

// ---------------------------------------------------------------------------
// Formatting — the chips
// ---------------------------------------------------------------------------

const chipTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const chipDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const chipWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fullDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** True when the ISO value carries a time other than exactly midnight. */
function hasTime(date: Date): boolean {
  return date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0;
}

/**
 * The due chip: "Today 5:00 PM" · "Tomorrow" · "Yesterday!" · "Mon" ·
 * "Mar 3" — the same compression Apple uses. Overdue callers append the
 * red tone; the exclamation lives in the CSS class, not the string.
 */
export function formatDueChip(iso: string, now: Date): string {
  const date = parseWhen(iso);
  if (date === null) return '';
  const days = daysAway(iso, now);
  const time = hasTime(date) ? ` ${chipTime.format(date)}` : '';
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days === -1) return `Yesterday${time}`;
  if (days < 0) return `${chipDate.format(date)}${time}`; // further past
  if (days <= 6) return `${chipWeekday.format(date)}${time}`;
  return `${chipDate.format(date)}${time}`;
}

/** The reminder chip: "Today 5:00 PM" · "Mar 3 9:00 AM" — always a time. */
export function formatReminderChip(iso: string, now: Date): string {
  const date = parseWhen(iso);
  if (date === null) return '';
  return formatDueChip(iso, now) || fullDateTime.format(date);
}

/** The Completed view's section heading: "Today" · "Yesterday" · "Mar 3". */
export function formatCompletedSection(iso: string, now: Date): string {
  const date = parseWhen(iso);
  if (date === null) return 'Earlier';
  const days = daysAway(iso, now);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days > -7) return chipWeekday.format(date);
  return chipDate.format(date);
}

/** The full datetime the detail editor and tooltips show. */
export function formatFull(iso: string): string {
  const date = parseWhen(iso);
  return date === null ? '' : fullDateTime.format(date);
}

// ---------------------------------------------------------------------------
// Datetime-local bridge — inputs ↔ ISO
// ---------------------------------------------------------------------------

/** ISO (or '') → the value a datetime-local input expects ('' when unset). */
export function isoToLocalInput(iso: string): string {
  const date = parseWhen(iso);
  if (date === null) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** datetime-local input value → ISO (or '' when empty/unparseable). */
export function localInputToIso(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * A date input + optional time input → ISO. Date-only due dates keep the
 * day without pinning a time (stored as that date at the time the user
 * typed, or midnight when the time field is empty — overdue math only
 * ever looks at the DAY, and the chip suppresses midnight times).
 */
export function dateAndTimeToIso(dateValue: string, timeValue: string): string {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T${timeValue || '00:00'}`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** Splits an ISO into the date + time halves the editor inputs want. */
export function isoToDateAndTime(iso: string): { date: string; time: string } {
  const local = isoToLocalInput(iso);
  if (!local) return { date: '', time: '' };
  const [date, time] = local.split('T');
  // A pure midnight stays "no time set" in the editor.
  const asDate = parseWhen(iso);
  if (asDate !== null && !hasTime(asDate)) return { date, time: '' };
  return { date, time: time ?? '' };
}

// ---------------------------------------------------------------------------
// Quick-pick presets — the date popover's chips
// ---------------------------------------------------------------------------

/** The next Saturday at 9:00 that is still ahead of `now`. */
export function nextWeekendEvening(now: Date): Date {
  const date = startOfDay(now);
  const day = date.getDay(); // 0 Sun … 6 Sat
  const add = (6 - day + 7) % 7; // days until Saturday
  date.setDate(date.getDate() + add);
  date.setHours(9, 0, 0, 0);
  if (date.getTime() <= now.getTime()) {
    // Already past this Saturday's 9:00 → the next one.
    date.setDate(date.getDate() + 7);
  }
  return date;
}

/** A Date → the yyyy-mm-dd half of a datetime-local input value. */
function dateToInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The four presets the popover offers, as ISO strings. */
export function quickPresetIso(
  preset: 'today' | 'tomorrow' | 'weekend' | 'nextWeek',
  now: Date,
  timeValue = '',
): string {
  switch (preset) {
    case 'today':
      return dateAndTimeToIso(dateToInput(now), timeValue);
    case 'tomorrow':
      return dateAndTimeToIso(dateToInput(new Date(now.getTime() + MS_PER_DAY)), timeValue);
    case 'weekend':
      return nextWeekendEvening(now).toISOString();
    case 'nextWeek':
      return dateAndTimeToIso(dateToInput(new Date(now.getTime() + 7 * MS_PER_DAY)), timeValue);
  }
}
