import { describe, expect, it } from 'vitest';
import {
  escapeHtmlText,
  highlightMatches,
  sheetDayGroups,
  sheetDayKey,
  sheetDayLabel,
  formatSheetClock,
} from './sheet-kit';

/**
 * The sheet kit's pure bones, pinned: the escaping/highlighting pair a
 * search field owes its rows, and the day anchoring every timeline
 * sheet renders through (always anchored — a run of entries needs its
 * Today even when nothing is older).
 */

describe('escapeHtmlText — nothing smuggles markup in', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtmlText('<img src=x onerror="a">&\'')).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#039;',
    );
  });

  it('plain text passes through unchanged', () => {
    expect(escapeHtmlText('just words 123')).toBe('just words 123');
  });
});

describe('highlightMatches — the eye lands on WHY a row answered', () => {
  it('wraps literal matches in marks, case-insensitively', () => {
    expect(highlightMatches('Grocery Run', 'groce')).toBe('<mark>Groce</mark>ry Run');
  });

  it('a term that is markup itself cannot inject — both sides escape first', () => {
    const out = highlightMatches('a <b>bold</b> note', '<b>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;');
  });

  it('regex metacharacters in the term are literals, never patterns', () => {
    expect(highlightMatches('a.b ab', '.')).toBe('a<mark>.</mark>b ab');
    expect(highlightMatches('aaa', 'a+')).toBe('aaa');
  });

  it('an empty term highlights nothing', () => {
    expect(highlightMatches('plain words', '')).toBe('plain words');
  });
});

describe('sheetDayKey / sheetDayLabel — the local calendar day', () => {
  // A fixed 'now' (2026-10-25T12:00:00 local) so Today/Yesterday and
  // the year-rollover cases are deterministic.
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
  const sameDay = (hoursAgo: number) => now - hoursAgo * 60 * 60 * 1000;

  it('day keys are local calendar days — midnight splits, hours do not', () => {
    const morning = new Date(2026, 9, 25, 9, 30).getTime();
    const night = new Date(2026, 9, 25, 23, 45).getTime();
    const nextDay = new Date(2026, 9, 26, 0, 5).getTime();
    expect(sheetDayKey(morning)).toBe(sheetDayKey(night));
    expect(sheetDayKey(morning)).not.toBe(sheetDayKey(nextDay));
  });

  it('labels Today, Yesterday, and calendar dates', () => {
    expect(sheetDayLabel(sameDay(3), now)).toBe('Today');
    expect(sheetDayLabel(sameDay(20), now)).toBe('Yesterday');
    // Two days back in the same year: month name and day, no year.
    expect(sheetDayLabel(new Date(2026, 9, 23, 10, 0).getTime(), now)).toBe('October 23');
  });

  it('appends the year once the date leaves the current one', () => {
    expect(sheetDayLabel(new Date(2024, 11, 31, 10, 0).getTime(), now)).toBe('December 31, 2024');
  });

  it('the clock is a short time string with digits', () => {
    expect(formatSheetClock(now)).toMatch(/^\d{1,2}:\d{2}/);
  });
});

describe('sheetDayGroups — always anchored', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
  const sameDay = (hoursAgo: number) => now - hoursAgo * 60 * 60 * 1000;
  const row = (timestamp: number) => ({ timestamp });

  it('a same-day history still anchors under Today', () => {
    // The timeline's contract: a run of entries needs its label even
    // when every entry is from today — the anchor is the rail's spine.
    const groups = sheetDayGroups([row(sameDay(1)), row(sameDay(2)), row(sameDay(3))], now);
    expect(groups.map((group) => group.label)).toEqual(['Today']);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('a history that spans days splits at the boundary', () => {
    const groups = sheetDayGroups([row(sameDay(1)), row(sameDay(20))], now);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].rows).toHaveLength(1);
  });

  it('a run of only-yesterday rows keeps its day label', () => {
    const groups = sheetDayGroups([row(sameDay(20)), row(sameDay(21))], now);
    expect(groups.map((group) => group.label)).toEqual(['Yesterday']);
    expect(groups[0].rows).toHaveLength(2);
  });

  it('rows arrive newest-first and leave that way — the grouper never sorts', () => {
    // The CALLER owns the order (newest first); the grouper only merges
    // ADJACENT same-day rows — a same-day row that arrives after another
    // day's starts a new run, by contract.
    const groups = sheetDayGroups([row(sameDay(1)), row(sameDay(2)), row(sameDay(25))], now);
    expect(groups.map((group) => group.rows.length)).toEqual([2, 1]);
    expect(groups[0].rows.map((row) => row.timestamp)).toEqual([sameDay(1), sameDay(2)]);
  });

  it('empty rows answer no groups', () => {
    expect(sheetDayGroups([], now)).toEqual([]);
  });
});
