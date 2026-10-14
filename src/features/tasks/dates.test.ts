/**
 * dates.ts — the calendar math behind the chips, buckets and presets.
 * Every test passes `now` explicitly: nothing here may read the clock.
 */

import { describe, expect, it } from 'vitest';
import {
  dateAndTimeToIso,
  daysAway,
  dueBucket,
  formatCompletedSection,
  formatDueChip,
  isOverdue,
  isToday,
  isTomorrow,
  isoToDateAndTime,
  isoToLocalInput,
  localInputToIso,
  nextWeekendEvening,
  parseWhen,
  quickPresetIso,
} from './dates';

/** A fixed "now": Wednesday, March 12 2025, 14:30 local. */
const NOW = new Date(2025, 2, 12, 14, 30);
/** ISO helpers build from local components — mirror that. */
const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

describe('parseWhen', () => {
  it('parses valid ISO and rejects empty or garbage', () => {
    expect(parseWhen('')).toBeNull();
    expect(parseWhen('not a date')).toBeNull();
    expect(parseWhen(iso(2025, 3, 12))?.getTime()).toBe(new Date(2025, 2, 12).getTime());
  });
});

describe('day predicates', () => {
  it('isToday / isTomorrow match across midnight math', () => {
    expect(isToday(iso(2025, 3, 12), NOW)).toBe(true);
    expect(isToday(iso(2025, 3, 12, 23, 59), NOW)).toBe(true);
    expect(isToday(iso(2025, 3, 13), NOW)).toBe(false);
    expect(isTomorrow(iso(2025, 3, 13), NOW)).toBe(true);
    expect(isTomorrow(iso(2025, 3, 12), NOW)).toBe(false);
  });

  it('daysAway counts whole days, negative = past', () => {
    expect(daysAway(iso(2025, 3, 12), NOW)).toBe(0);
    expect(daysAway(iso(2025, 3, 11), NOW)).toBe(-1);
    expect(daysAway(iso(2025, 3, 18), NOW)).toBe(6);
    expect(daysAway('', NOW)).toBe(0);
  });

  it('overdue is strictly before today — today at any hour is never overdue', () => {
    expect(isOverdue(iso(2025, 3, 11, 23, 59), NOW)).toBe(true);
    expect(isOverdue(iso(2025, 3, 12, 0, 1), NOW)).toBe(false);
    expect(isOverdue(iso(2025, 3, 12, 23, 59), NOW)).toBe(false);
    expect(isOverdue(iso(2025, 3, 13), NOW)).toBe(false);
  });
});

describe('dueBucket — the Scheduled view sections', () => {
  it('sorts every distance into its bucket', () => {
    expect(dueBucket(iso(2025, 3, 11), NOW)).toBe('overdue');
    expect(dueBucket(iso(2025, 3, 12), NOW)).toBe('today');
    expect(dueBucket(iso(2025, 3, 13), NOW)).toBe('tomorrow');
    expect(dueBucket(iso(2025, 3, 14), NOW)).toBe('week');
    expect(dueBucket(iso(2025, 3, 19), NOW)).toBe('week'); // 7 days out
    expect(dueBucket(iso(2025, 3, 20), NOW)).toBe('upcoming');
  });
});

describe('formatDueChip — the compression Apple uses', () => {
  it('relative words for ±1 day', () => {
    expect(formatDueChip(iso(2025, 3, 12), NOW)).toBe('Today');
    expect(formatDueChip(iso(2025, 3, 12, 17, 0), NOW)).toBe('Today 5:00 PM');
    expect(formatDueChip(iso(2025, 3, 13), NOW)).toBe('Tomorrow');
    expect(formatDueChip(iso(2025, 3, 11), NOW)).toBe('Yesterday');
  });

  it('weekday inside the week, month-day beyond it', () => {
    expect(formatDueChip(iso(2025, 3, 15), NOW)).toMatch(/^Sat/);
    expect(formatDueChip(iso(2025, 3, 20), NOW)).toMatch(/^Mar 20/);
  });

  it('midnight times are suppressed, non-midnight kept', () => {
    expect(formatDueChip(iso(2025, 3, 14), NOW)).not.toContain(':');
    expect(formatDueChip(iso(2025, 3, 14, 9, 5), NOW)).toContain('9:05');
  });

  it('completed-section headings group by day', () => {
    expect(formatCompletedSection(iso(2025, 3, 12, 8, 0), NOW)).toBe('Today');
    expect(formatCompletedSection(iso(2025, 3, 11, 8, 0), NOW)).toBe('Yesterday');
    expect(formatCompletedSection(iso(2025, 3, 8, 8, 0), NOW)).toMatch(/^Sat/);
    expect(formatCompletedSection(iso(2025, 3, 1, 8, 0), NOW)).toBe('Mar 1');
    expect(formatCompletedSection('', NOW)).toBe('Earlier');
  });
});

describe('datetime-local bridge', () => {
  it('round-trips ISO ↔ inputs', () => {
    const value = iso(2025, 3, 12, 14, 30);
    const local = isoToLocalInput(value);
    expect(local).toBe('2025-03-12T14:30');
    expect(localInputToIso(local)).toBe(value);
    expect(isoToLocalInput('')).toBe('');
    expect(localInputToIso('garbage')).toBe('');
  });

  it('dateAndTimeToIso keeps midnight date-only, joins when both set', () => {
    expect(dateAndTimeToIso('2025-03-12', '')).toBe(iso(2025, 3, 12));
    expect(dateAndTimeToIso('2025-03-12', '09:00')).toBe(iso(2025, 3, 12, 9, 0));
    expect(dateAndTimeToIso('', '09:00')).toBe('');
  });

  it('isoToDateAndTime splits and hides midnight times', () => {
    expect(isoToDateAndTime(iso(2025, 3, 12))).toEqual({ date: '2025-03-12', time: '' });
    expect(isoToDateAndTime(iso(2025, 3, 12, 9, 5))).toEqual({ date: '2025-03-12', time: '09:05' });
    expect(isoToDateAndTime('')).toEqual({ date: '', time: '' });
  });
});

describe('quick presets', () => {
  it('today / tomorrow / nextWeek build from the typed time', () => {
    expect(quickPresetIso('today', NOW)).toBe(iso(2025, 3, 12));
    expect(quickPresetIso('today', NOW, '17:00')).toBe(iso(2025, 3, 12, 17, 0));
    expect(quickPresetIso('tomorrow', NOW, '08:15')).toBe(iso(2025, 3, 13, 8, 15));
    expect(quickPresetIso('nextWeek', NOW, '09:00')).toBe(iso(2025, 3, 19, 9, 0));
  });

  it('weekend lands on the next Saturday 9:00 still ahead', () => {
    // NOW is Wednesday Mar 12 2025 → Saturday Mar 15, 9:00.
    const saturday = nextWeekendEvening(NOW);
    expect(saturday.getDay()).toBe(6);
    expect(saturday.getHours()).toBe(9);
    expect(quickPresetIso('weekend', NOW)).toBe(saturday.toISOString());

    // Saturday afternoon → the NEXT Saturday, not one already past.
    const satAfternoon = new Date(2025, 2, 15, 15, 0);
    const next = nextWeekendEvening(satAfternoon);
    expect(next.getDate()).toBe(22);
    expect(next.getTime()).toBeGreaterThan(satAfternoon.getTime());
  });
});
