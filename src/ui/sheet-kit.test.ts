import { describe, expect, it } from 'vitest';
import {
  cardPageLines,
  escapeHtmlText,
  formatCardWhen,
  highlightMatches,
  renderSheetTimeline,
  sheetDayGroups,
  sheetDayKey,
  sheetDayLabel,
  sheetDiff,
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

  it('the row tooltip tells the truth about the NEXT click', () => {
    const list = mountList();
    renderSheetTimeline(list, rows, {});
    const handlers: SheetTimelineHandlers = { onAction: () => {} };
    wireSheetTimeline(list, handlers);

    const rowOf = (key: string) =>
      list.querySelector(`.snap-item[data-row-key="${key}"] .snap-row`) as HTMLElement;
    expect(rowOf('v:1').getAttribute('title')).toBe('Show details');

    // Open — the promise flips to the collapse the next click performs.
    rowOf('v:1').click();
    expect(rowOf('v:1').getAttribute('title')).toBe('Hide details');

    // The accordion closing a neighbor resets ITS promise too — a
    // tooltip that says Hide on a row that just snapped shut lies.
    rowOf('v:2').click();
    expect(rowOf('v:1').getAttribute('title')).toBe('Show details');
    expect(rowOf('v:2').getAttribute('title')).toBe('Hide details');
    list.remove();
  });
});

describe('sheetDiff — the line diff a version card shows', () => {
  it('aligns an edit into del-then-add against shared context', () => {
    const old = 'one\ntwo\nthree';
    const next = 'one\ntwo point five\nthree';
    const diff = sheetDiff(old, next);
    expect(diff).not.toBeNull();
    expect(diff!.added).toBe(1);
    expect(diff!.removed).toBe(1);
    expect(diff!.entries).toEqual([
      { kind: 'ctx', text: 'one' },
      { kind: 'del', text: 'two' },
      { kind: 'add', text: 'two point five' },
      { kind: 'ctx', text: 'three' },
    ]);
  });

  it('a pure addition keeps the old text as context', () => {
    const diff = sheetDiff('a\nb', 'a\nb\nc');
    expect(diff!.entries).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
    expect(diff!.added).toBe(1);
    expect(diff!.removed).toBe(0);
  });

  it('a deletion leaves only the survivors', () => {
    const diff = sheetDiff('a\nb\nc', 'a\nc');
    expect(diff!.entries).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('identical texts answer null — the card falls back to full text', () => {
    expect(sheetDiff('same\nlines', 'same\nlines')).toBeNull();
    expect(sheetDiff('', '')).toBeNull();
  });

  it('empty-to-content is all additions', () => {
    const diff = sheetDiff('', 'first\nsecond');
    expect(diff!.entries).toEqual([
      { kind: 'add', text: 'first' },
      { kind: 'add', text: 'second' },
    ]);
  });

  it('collapses long unchanged runs into counted gaps', () => {
    // The change sits mid-note: context on both sides, a counted gap
    // before, and the tail beyond the last change trimmed away.
    const lines = Array.from({ length: 22 }, (_, i) => `line ${i}`);
    const old = [...lines.slice(0, 10), 'the changed line', ...lines.slice(11)].join('\n');
    const next = [...lines.slice(0, 10), 'the edited line', ...lines.slice(11)].join('\n');
    const diff = sheetDiff(old, next);
    expect(diff!.entries.map((entry) => entry.kind)).toEqual([
      'gap',
      'ctx',
      'ctx',
      'del',
      'add',
      'ctx',
      'ctx',
    ]);
    // 10 unchanged lines before the change − 2 kept context = 8 folded.
    expect(diff!.entries[0]).toEqual({ kind: 'gap', count: 8 });
  });

  it('trims trailing context beyond the last change', () => {
    // The change is at the head; a tail of unchanged lines beyond the
    // kept context is padding, not orientation — no gap is minted for a
    // tail that exists only to end.
    const old = ['old head', ...Array.from({ length: 10 }, (_, i) => `l${i}`)].join('\n');
    const next = ['new head', ...Array.from({ length: 10 }, (_, i) => `l${i}`)].join('\n');
    const diff = sheetDiff(old, next);
    expect(diff!.entries.map((entry) => entry.kind)).toEqual(['del', 'add', 'ctx', 'ctx']);
    // ±2 context: l0 and l1 orient the change; l2..l9 are trimmed.
    expect(diff!.entries[diff!.entries.length - 1]).toEqual({ kind: 'ctx', text: 'l1' });
  });

  it('caps the rendered body and says so', () => {
    // Many SMALL changes spread over a long note — every line stays in
    // the kept window (±2 context around each change covers all), so
    // only the render cap can stop the body.
    const old = Array.from({ length: 200 }, (_, i) => `o${i}`).join('\n');
    const next = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? `x${i}` : `o${i}`)).join(
      '\n',
    );
    const diff = sheetDiff(old, next);
    expect(diff!.truncated).toBe(true);
    const renderedLines = diff!.entries.filter(
      (entry) => entry.kind === 'add' || entry.kind === 'del' || entry.kind === 'ctx',
    ).length;
    expect(renderedLines).toBeLessThanOrEqual(160);
  });

  it('a long same-kind run folds its tail into a counted note', () => {
    // A whole-note replacement is one wall of red — the card shows the
    // first 30 deletions and counts the rest, then the additions.
    const old = Array.from({ length: 40 }, (_, i) => `old ${i}`).join('\n');
    const next = Array.from({ length: 3 }, (_, i) => `new ${i}`).join('\n');
    const diff = sheetDiff(old, next);
    const dels = diff!.entries.filter((entry) => entry.kind === 'del').length;
    expect(dels).toBe(12);
    expect(diff!.entries).toContainEqual({ kind: 'gap', count: 28, tone: 'del' });
    // The stat still speaks the whole truth.
    expect(diff!.removed).toBe(40);
    expect(diff!.added).toBe(3);
    // No "truncated" flag — nothing was cut silently; the fold says so.
    expect(diff!.truncated).toBe(false);
  });

  it('declines sides too large to diff honestly', () => {
    const big = Array.from({ length: 601 }, (_, i) => `line ${i}`).join('\n');
    expect(sheetDiff(big, big + '\nmore')).toBeNull();
    expect(sheetDiff('small', big)).toBeNull();
  });

  it('a mid-line rewording is one del and one add, not two contexts', () => {
    const diff = sheetDiff('the kettle knows', 'the kettle knew');
    expect(diff!.entries).toEqual([
      { kind: 'del', text: 'the kettle knows' },
      { kind: 'add', text: 'the kettle knew' },
    ]);
  });
});

describe('renderSheetTimeline — the anatomy the rows wear', () => {
  const row = (key: string): SheetRowModel => ({
    key,
    timestamp: new Date(2026, 9, 25, 12, 0, 0).getTime(),
    title: 'A version',
    detailText: 'body',
  });

  it('every row carries the disclosure chevron', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [row('v:1')], {});
    expect(list.querySelector('.snap-item .snap-row .snap-caret')).not.toBeNull();
    list.remove();
  });

  it('a diff-bearing row renders the diff card in place of the full text', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const diffRow: SheetRowModel = {
      ...row('v:9'),
      detailText: 'the full text nobody should have to read here',
      diff: {
        caption: 'Changed since 11:02 AM',
        diff: {
          entries: [
            { kind: 'ctx', text: 'one' },
            { kind: 'del', text: 'two' },
            { kind: 'add', text: 'two point five' },
            { kind: 'gap', count: 5 },
          ],
          added: 1,
          removed: 1,
          truncated: false,
        },
      },
    };
    renderSheetTimeline(list, [diffRow], {});
    expect(list.querySelector('.snap-detail .snap-diff')).not.toBeNull();
    expect(list.querySelector('.snap-detail .snap-diff-cap')?.textContent).toContain(
      'Changed since 11:02 AM',
    );
    expect(list.querySelector('.snap-detail .snap-diff-line.is-del')).not.toBeNull();
    expect(list.querySelector('.snap-detail .snap-diff-line.is-add')).not.toBeNull();
    expect(list.querySelector('.snap-detail .snap-detail-text')).toBeNull();
    list.remove();
  });

  it('a diff-free row keeps the full-text card', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [row('v:1')], {});
    expect(list.querySelector('.snap-detail .snap-detail-text')).not.toBeNull();
    expect(list.querySelector('.snap-detail .snap-diff')).toBeNull();
    list.remove();
  });

  it('an expiring trash row wears the danger class; a fresh one does not', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const grave = (danger: boolean): SheetRowModel => ({
      ...row(danger ? 't:old' : 't:fresh'),
      trash: true,
      chip: { text: danger ? 'last day' : '30 days', danger },
    });
    renderSheetTimeline(list, [grave(true), grave(false)], {});
    expect(
      list.querySelector('.snap-item[data-row-key="t:old"]')?.classList.contains('is-expiring'),
    ).toBe(true);
    expect(
      list.querySelector('.snap-item[data-row-key="t:fresh"]')?.classList.contains('is-expiring'),
    ).toBe(false);
    list.remove();
  });

  it('a re-render hands focus back to the row button that held it', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [row('v:1'), row('v:2')], {});
    const first = list.querySelector<HTMLElement>('.snap-item[data-row-key="v:1"] .snap-row');
    first!.focus();
    expect(document.activeElement).toBe(first);

    // The rebuild replaces the nodes — focus survives on the
    // counterpart.
    renderSheetTimeline(list, [row('v:1'), row('v:2')], {});
    const refocused = list.querySelector<HTMLElement>('.snap-item[data-row-key="v:1"] .snap-row');
    expect(document.activeElement).toBe(refocused);
    list.remove();
  });
});

describe('cardPageLines — the page a card paints', () => {
  it('keeps the note\u2019s lines and drops the leading blanks', () => {
    const page = cardPageLines('\n\n  first line\nsecond line');
    expect(page.lines).toEqual(['  first line', 'second line']);
    expect(page.more).toBe(false);
  });

  it('collapses blank runs to one and trims the trailing blanks', () => {
    const page = cardPageLines('one\n\n\n\ntwo\n\n\n');
    expect(page.lines).toEqual(['one', '', 'two']);
  });

  it('caps at the max and flags the fade only when words remain below', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(cardPageLines(eight).more).toBe(false);
    expect(cardPageLines(`${eight}\nnine`).more).toBe(true);
    // A blank tail is the note\u2019s own padding — no fade promises it.
    expect(cardPageLines(`${eight}\n\n\n`).more).toBe(false);
    expect(cardPageLines(eight, 3).lines).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('a page with no words is no lines', () => {
    expect(cardPageLines('')).toEqual({ lines: [], more: false });
    expect(cardPageLines(' \n \t ')).toEqual({ lines: [], more: false });
  });
});

describe('formatCardWhen — the compact clock a card has room for', () => {
  const noon = new Date(2026, 10, 11, 12, 0, 0).getTime();

  it('today keeps the clock — the day is trivial', () => {
    const evening = new Date(2026, 10, 11, 18, 42, 0).getTime();
    expect(formatCardWhen(evening, noon)).toBe(
      `Trashed ${new Date(evening).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    );
  });

  it('another day keeps the day and drops the time', () => {
    const otherDay = new Date(2026, 9, 25, 12, 0, 0).getTime();
    expect(formatCardWhen(otherDay, noon)).toBe('Trashed Oct 25');
  });

  it('another year names the year — a long-lived trash can hold last year', () => {
    const otherYear = new Date(2024, 11, 31, 23, 59, 0).getTime();
    expect(formatCardWhen(otherYear, noon)).toBe('Trashed Dec 31, 2024');
  });
});

describe('renderSheetTimeline — the card gallery', () => {
  const grave = (key: string, lines: string): SheetRowModel => ({
    key,
    timestamp: new Date(2026, 9, 25, 12, 0, 0).getTime(),
    title: 'A deleted note',
    trash: true,
    chip: { text: '30 days', danger: false },
    detailText: lines,
    detailMeta: ['Trashed Oct 25, 2026, 12:00 PM', 'Plain text'],
    actions: [
      { kind: 'restore', label: 'Restore' },
      { kind: 'delete', label: 'Delete forever' },
    ],
  });

  it('a card is its detail: page, title, when, chip, actions on the face', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:1', 'first words\nsecond line')], { layout: 'cards' });
    const card = list.querySelector<HTMLElement>('.snap-card[data-row-key="t:1"]');
    expect(card).not.toBeNull();
    // The page paints the readable lines…
    expect(card!.querySelectorAll('.snap-card-line').length).toBe(2);
    expect(card!.querySelector('.snap-card-line')?.textContent).toBe('first words');
    // …the body carries the title, the compact when, the chip…
    expect(card!.querySelector('.snap-card-title')?.textContent).toBe('A deleted note');
    expect(card!.querySelector('.snap-card-when')?.textContent).toContain('Trashed Oct 25');
    expect(card!.querySelector('.snap-card-meta .snap-chip')?.textContent).toBe('30 days');
    // …and the actions sit on the face, speaking the row dialect.
    const restore = card!.querySelector<HTMLElement>('[data-sheet-action="restore"]');
    expect(restore?.dataset.rowKey).toBe('t:1');
    const purge = card!.querySelector<HTMLElement>('[data-sheet-action="delete"]');
    expect(purge?.querySelector('.confirm-label')?.textContent).toBe('Delete forever');
    // No accordion to open — the card owns everything it shows.
    expect(card!.querySelector('.snap-row')).toBeNull();
    expect(card!.querySelector('.snap-detail')).toBeNull();
    list.remove();
  });

  it('the gallery carries no rail vocabulary: no day anchors, no timeline rows', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:1', 'words')], { layout: 'cards' });
    expect(list.querySelector('.snap-day')).toBeNull();
    expect(list.querySelector('.snap-item')).toBeNull();
    list.remove();
  });

  it('a wordless grave paints the honest empty page', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:2', '\n \n')], { layout: 'cards' });
    expect(list.querySelector('.snap-card-line.is-empty')?.textContent).toBe('No content');
    expect(list.querySelector('.snap-card-page.is-cut')).toBeNull();
    list.remove();
  });

  it('the expiring grave wears the class; a fresh one does not', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const expiring = { ...grave('t:old', 'words'), chip: { text: 'last day', danger: true } };
    renderSheetTimeline(list, [expiring, grave('t:fresh', 'words')], { layout: 'cards' });
    expect(
      list.querySelector('.snap-card[data-row-key="t:old"]')?.classList.contains('is-expiring'),
    ).toBe(true);
    expect(
      list.querySelector('.snap-card[data-row-key="t:fresh"]')?.classList.contains('is-expiring'),
    ).toBe(false);
    list.remove();
  });

  it('a query highlights inside the page and the title', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:1', 'Grocery list\nbread')], {
      layout: 'cards',
      term: 'groce',
    });
    expect(list.querySelector('.snap-card-line mark')?.textContent).toBe('Groce');
    expect(list.querySelector('.snap-card-title mark')).toBeNull();
    list.remove();
  });

  it('the page drops a first line that only echoes the title', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const echo = { ...grave('t:3', 'A deleted note\n\nthe real words'), title: 'A deleted note' };
    renderSheetTimeline(list, [echo], { layout: 'cards' });
    const lines = [...list.querySelectorAll('.snap-card-line')].map((n) => n.textContent);
    expect(lines).toEqual(['the real words']);
    list.remove();
  });

  it('a first line that says MORE than the title is content and stays', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const longer = {
      ...grave('t:4', 'A deleted note, revised\nsecond line'),
      title: 'A deleted note',
    };
    renderSheetTimeline(list, [longer], { layout: 'cards' });
    const lines = [...list.querySelectorAll('.snap-card-line')].map((n) => n.textContent);
    expect(lines).toEqual(['A deleted note, revised', 'second line']);
    list.remove();
  });

  it('a re-render hands focus back to the card action that held it', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:1', 'words')], { layout: 'cards' });
    const restore = list.querySelector<HTMLElement>(
      '.snap-card[data-row-key="t:1"] [data-sheet-action="restore"]',
    );
    restore!.focus();
    expect(document.activeElement).toBe(restore);

    renderSheetTimeline(list, [grave('t:1', 'words')], { layout: 'cards' });
    const refocused = list.querySelector<HTMLElement>(
      '.snap-card[data-row-key="t:1"] [data-sheet-action="restore"]',
    );
    expect(document.activeElement).toBe(refocused);
    list.remove();
  });

  it('the timeline (the default) still paints rows, not cards', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    renderSheetTimeline(list, [grave('t:1', 'words')], {});
    expect(list.querySelector('.snap-item')).not.toBeNull();
    expect(list.querySelector('.snap-card')).toBeNull();
    list.remove();
  });

  it('a drawing grave paints the drawing itself — the scene, whole, on its own paper', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const art = {
      ...grave('t:9', 'words a text page would paint'),
      thumb: {
        markup:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect x="1" y="1" width="38" height="18"/></svg>',
        background: '#282828',
      },
    };
    renderSheetTimeline(list, [art], { layout: 'cards' });
    const page = list.querySelector<HTMLElement>('.snap-card[data-row-key="t:9"] .snap-card-page');
    // The page IS the drawing: the svg rides inline, on the canvas's own
    // color, with no ruled lines, no text page, no cut to fade.
    expect(page?.classList.contains('is-drawing')).toBe(true);
    expect(page?.getAttribute('style')).toBe('background:#282828');
    expect(page?.querySelector('svg rect')).not.toBeNull();
    expect(page?.querySelector('.snap-card-line')).toBeNull();
    expect(page?.classList.contains('is-cut')).toBe(false);
    // The body is the body — the picture changed nothing else.
    expect(list.querySelector('.snap-card-title')?.textContent).toBe('A deleted note');
    expect(list.querySelector('[data-sheet-action="restore"]')).not.toBeNull();
    list.remove();
  });

  it('a drawing with no canvas color keeps the CSS paper', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const art = {
      ...grave('t:10', 'words'),
      thumb: { markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>' },
    };
    renderSheetTimeline(list, [art], { layout: 'cards' });
    const page = list.querySelector<HTMLElement>('.snap-card-page');
    expect(page?.getAttribute('style')).toBeNull();
    expect(page?.querySelector('svg')).not.toBeNull();
    list.remove();
  });

  it('the timeline face ignores the thumb — the picture is the gallery\u2019s alone', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);
    const art = {
      ...grave('t:11', 'the readable words'),
      preview: 'the readable words',
      thumb: { markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>' },
    };
    renderSheetTimeline(list, [art], {});
    expect(list.querySelector('.snap-card-page')).toBeNull();
    expect(list.querySelector('.snap-card')).toBeNull();
    // The row still speaks text — the preview line the rail always had.
    expect(list.querySelector('.snap-preview')?.textContent).toBe('the readable words');
    list.remove();
  });
});
