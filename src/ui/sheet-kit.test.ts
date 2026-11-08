import { describe, expect, it } from 'vitest';
import {
  escapeHtmlText,
  highlightMatches,
  renderSheetTimeline,
  sheetDayGroups,
  sheetDayKey,
  sheetDayLabel,
  formatSheetClock,
  wireSheetTimeline,
  type SheetRowModel,
  type SheetTimelineHandlers,
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

describe('renderSheetTimeline — the open row survives the rebuild', () => {
  // The sheet re-renders when a save lands underneath it; the reader's
  // expanded row must come back expanded. This is the contract the
  // snapshots manager leans on (it reads the open key off the old DOM
  // and hands it back) — pinned here at the kit level.
  const baseRow = (key: string, title: string): SheetRowModel => ({
    key,
    timestamp: new Date(2026, 9, 25, 12, 0, 0).getTime(),
    title,
    detailText: `${title} body`,
    detailMeta: ['October 25, 2026', 'Plain note'],
  });

  const rows = [baseRow('v:1', 'First version'), baseRow('v:2', 'Second version')];

  function mountList(): HTMLElement {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    return list;
  }

  it('openKey renders that row expanded — class, aria, and detail all agree', () => {
    const list = mountList();
    renderSheetTimeline(list, rows, { openKey: 'v:2' });

    const open = list.querySelector('.snap-item[data-row-key="v:2"]') as HTMLElement;
    expect(open.classList.contains('is-open')).toBe(true);
    expect(open.querySelector('.snap-row')?.getAttribute('aria-expanded')).toBe('true');
    expect(open.querySelector('.snap-detail')?.hasAttribute('hidden')).toBe(false);

    const closed = list.querySelector('.snap-item[data-row-key="v:1"]') as HTMLElement;
    expect(closed.classList.contains('is-open')).toBe(false);
    expect(closed.querySelector('.snap-row')?.getAttribute('aria-expanded')).toBe('false');
    expect(closed.querySelector('.snap-detail')?.hasAttribute('hidden')).toBe(true);
    list.remove();
  });

  it('a key that no longer exists quietly renders everything closed', () => {
    const list = mountList();
    renderSheetTimeline(list, rows, { openKey: 'v:gone' });
    expect(list.querySelector('.snap-item.is-open')).toBeNull();
    list.remove();
  });

  it('the restored open state still answers the accordion click', () => {
    const list = mountList();
    renderSheetTimeline(list, rows, { openKey: 'v:1' });
    const handlers: SheetTimelineHandlers = { onAction: () => {} };
    wireSheetTimeline(list, handlers);

    // Clicking the open row closes it (the toggle reads the same
    // is-open class the render restored — a half-restored state would
    // desync the accordion).
    (list.querySelector('.snap-item[data-row-key="v:1"] .snap-row') as HTMLElement).click();
    const row = list.querySelector('.snap-item[data-row-key="v:1"]') as HTMLElement;
    expect(row.classList.contains('is-open')).toBe(false);
    expect(row.querySelector('.snap-detail')?.hasAttribute('hidden')).toBe(true);

    // And clicking a closed row opens it, closing the other — one open
    // at a time still holds after a carried-open render.
    (list.querySelector('.snap-item[data-row-key="v:2"] .snap-row') as HTMLElement).click();
    expect(
      (list.querySelector('.snap-item[data-row-key="v:2"]') as HTMLElement).classList.contains(
        'is-open',
      ),
    ).toBe(true);
    expect(row.classList.contains('is-open')).toBe(false);
    list.remove();
  });
});
