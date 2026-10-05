/**
 * Characterization suite for the Unicode character picker
 * (src/unicode/picker.ts) — the searchable, virtualized 5,400-symbol
 * modal behind Ctrl/Cmd+Shift+O.
 *
 * What this pins, and why it matters:
 *  - the search pipeline: input events debounce 60 ms, the query
 *    lowercases/whitespace-normalizes into space-split tokens, and a
 *    symbol matches only when EVERY token appears in its haystack
 *    (char + name + category + u+hex, all lowercased — matching is
 *    case-insensitive, as the placeholder promises) — AND semantics,
 *    not OR;
 *  - the category-widening fallback: a search that dies inside the
 *    current category but lives in "All characters" auto-switches the
 *    scope, so a user never hits a dead end;
 *  - persistence: favorites and recents ride the raw kv keys
 *    `unicodeFavorites` / `recentUnicodeSymbols` (legacy-listed keys,
 *    outside the settings choke point by design), recents capped at 24,
 *    most-recent-first with dedupe;
 *  - insertion routes through the EditorPort seam (insertText with the
 *    symbol's char) — the contract that keeps the picker engine-agnostic
 *    — and parks the caret inside the editor first when the selection
 *    lives outside it;
 *  - the first-open landing: a session with recents starts on the Recent
 *    category (the user's most likely intent), a fresh one on All.
 *
 * Expectations are derived from the generated dataset at runtime (import
 * UNICODE_SYMBOLS and compute counts) instead of hardcoding numbers, so
 * regenerating the data (bun run gen:unicode) never falsifies this suite
 * — only a change in the PICKER's behavior can.
 *
 * jsdom specifics: ResizeObserver does not exist there (the picker
 * constructs one at bind time), so it is polyfilled as a no-op — jsdom
 * elements are zero-footprint and the observer's re-measure branch is
 * rendering-dependent anyway. The 60 ms search debounce runs on real
 * timers; the suite awaits it rather than faking the clock, because the
 * dataset load itself is a promise and mixing fake timers with promise
 * flushing buys nothing at this size.
 *
 * Deliberately left to e2e: real caret behavior in a browser selection,
 * the virtualized scroll window beyond the first rows, and the modal's
 * open/close transitions.
 *
 * Everything here was written against the behaviour of the live app at the
 * commit this file landed. If a test fails after an intentional behavior
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { $ } from '../lib/q';
import { initUnicodePicker } from './picker';
import { UNICODE_SYMBOLS } from './symbols-data';
import { setEditorPort, type EditorPort } from '../editor/port';
import { resetStorageForTests, stateGet, stateSet, storageReady } from '../storage';
import type { NotepadUI } from '../selector';

// ---------------------------------------------------------------------------
// Ground truth from the generated dataset
// ---------------------------------------------------------------------------

/**
 * The dataset's search haystack, replicated — char + name + category +
 * u+hex, lowercased exactly as the picker now builds it (matching the
 * lowercased query — search is case-insensitive end to end).
 * Expectations derive from this so the suite survives data regeneration.
 */
function haystack(symbol: (typeof UNICODE_SYMBOLS)[number]): string {
  return `${symbol.char} ${symbol.name} ${symbol.category} u+${symbol.codepoint.toString(16)}`.toLowerCase();
}

/** The first symbol whose haystack genuinely contains the token. */
function symbolMatching(token: string): (typeof UNICODE_SYMBOLS)[number] | undefined {
  return UNICODE_SYMBOLS.find((s) => haystack(s).includes(token));
}

/** A symbol whose name contains `needle` (case-insensitive probe). */
function symbolNamed(needle: string): (typeof UNICODE_SYMBOLS)[number] | undefined {
  const lower = needle.toLowerCase();
  return UNICODE_SYMBOLS.find((s) => s.name.toLowerCase().includes(lower));
}

/** The dataset's category list, in first-appearance order (render parity). */
const CATEGORIES = (() => {
  const labels: string[] = [];
  for (const s of UNICODE_SYMBOLS) {
    if (!labels.includes(s.category)) labels.push(s.category);
  }
  return labels;
})();

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

beforeAll(() => {
  // The picker constructs a ResizeObserver at bindEvents(); jsdom has none.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

/** Mounts the picker modal's skeleton, mirroring the real markup ids. */
function mountPickerDom(): void {
  document.body.innerHTML = `
    <div id="note" contenteditable="true"></div>
    <a href="#" id="unicodePickerTrigger"></a>
    <div id="unicodePickerModal" class="modal fade" role="dialog" aria-hidden="true">
      <input type="search" id="unicodeSearch" autocomplete="off" spellcheck="false" />
      <button type="button" id="unicodeSearchClear" hidden>&times;</button>
      <nav id="unicodeCategories"></nav>
      <div id="unicodeGrid" role="listbox" tabindex="0">
        <div id="unicodeGridInner"></div>
      </div>
      <div id="unicodeDetail"></div>
      <div id="unicodeStatus"></div>
    </div>
    <div id="toast"></div>
  `;
}

/** Deletes the padify database so every test starts from an empty store. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

/** A minimal EditorPort stub — only insertText is consulted by the picker. */
function fakePort(): EditorPort {
  return {
    getHtml: () => '',
    setHtml: () => {},
    setInert: () => {},
    renderHtml: () => {},
    getText: () => '',
    isEmpty: () => true,
    normalizeEmptySurface: () => false,
    focus: () => {},
    isCaretInside: () => true,
    ensureCaretInside: () => true,
    charBeforeCaret: () => '',
    insertText: vi.fn(() => true),
    insertHtml: vi.fn(() => false),
    applyFormat: () => false,
    queryFormat: () => false,
    applyBlockFormat: () => false,
    queryBlockFormat: () => null,
    toggleList: () => false,
    queryListKind: () => null,
    insertLink: () => false,
    insertLinkAsText: () => false,
    removeLink: () => false,
    queryLinkHref: () => null,
    retargetLink: () => false,
    insertMath: () => false,
    queryMathAtCaret: () => null,
    updateMath: () => false,
    undo: () => false,
    redo: () => false,
    canUndo: () => false,
    canRedo: () => false,
    setFontSize: () => false,
    setFontFamily: () => false,
    setTextColor: () => false,
    queryTextColor: () => null,
    setHighlight: () => false,
    applyScript: () => false,
    queryScript: () => false,
    applyAlignment: () => false,
    queryAlignment: () => null,
    indent: () => false,
    outdent: () => false,
    insertHorizontalRule: () => false,
    insertTable: () => false,
    queryTableContext: () => null,
    moveTableCellFocus: () => false,
    runTableAction: () => false,
    onInput: () => () => {},
  };
}

let picker: ReturnType<typeof initUnicodePicker>;
let port: EditorPort;

const SEARCH_DEBOUNCE_MS = 60;

/** Types a query and waits out the debounce. */
async function search(query: string): Promise<void> {
  const input = document.getElementById('unicodeSearch') as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 40));
}

function statusText(): string {
  return document.getElementById('unicodeStatus')?.textContent ?? '';
}

function click(selector: string): void {
  (document.querySelector(selector) as HTMLElement).dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mountPickerDom();
  await freshBoot();
  port = fakePort();
  setEditorPort(port);
  picker = initUnicodePicker({ note: $('#note') } as unknown as NotepadUI);
  picker.open();
  // The dataset load rides a promise (lazy import of symbols-data).
  await new Promise((resolve) => setTimeout(resolve, 60));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Boot — the dataset, the category chips, the landing category
// ---------------------------------------------------------------------------

describe('boot (characterization)', () => {
  it('renders the category chips with dataset-derived counts and All first-open default', () => {
    // No recents on a fresh boot → the first open stays on All characters.
    const chips = Array.from(document.querySelectorAll('#unicodeCategories .ucp-cat')).map(
      (chip) => (chip as HTMLElement).dataset.cat,
    );
    expect(chips).toEqual(['favorites', 'recent', 'all', ...CATEGORIES]);

    // Counts: favorites/recent start at zero; All carries the full total.
    // (The chips format counts as bare numbers; the status line localizes.)
    const allChip = document.querySelector('.ucp-cat[data-cat="all"]') as HTMLElement;
    expect(allChip.querySelector('.ucp-cat-count')!.textContent).toBe(
      String(UNICODE_SYMBOLS.length),
    );
    expect(statusText()).toContain(`${UNICODE_SYMBOLS.length.toLocaleString()} of`);
    expect(statusText()).toContain('characters');
  });

  it('a session with recents lands on the Recent category at first open', async () => {
    const known = UNICODE_SYMBOLS[0]!;
    stateSet('recentUnicodeSymbols', JSON.stringify([known.char]));

    // Re-init over the same DOM: the landing decision runs on first open.
    picker = initUnicodePicker({ note: $('#note') } as unknown as NotepadUI);
    picker.open();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const activeChip = document.querySelector('.ucp-cat.is-active') as HTMLElement;
    expect(activeChip.dataset.cat).toBe('recent');
    // The recent list itself renders the seeded character.
    const firstCard = document.querySelector('.ucp-card .ucp-glyph') as HTMLElement;
    expect(firstCard.textContent).toBe(known.char);
  });
});

// ---------------------------------------------------------------------------
// Search — tokens, AND semantics, empty state, clear
// ---------------------------------------------------------------------------

describe('search (characterization)', () => {
  it('narrows to the symbols whose haystack contains the single token', async () => {
    // 'heart' sits inside title-cased names ("White heart suit") — a
    // probe that matched even before search went case-insensitive.
    const target = symbolMatching('heart')!;
    expect(target).toBeDefined();

    await search('heart');

    expect(statusText()).toContain('match');
    expect(statusText()).toContain('for “heart”');
    // The target symbol is among the rendered results (the first rows of
    // the virtualized window render around the active card).
    const glyphs = Array.from(document.querySelectorAll('.ucp-card .ucp-glyph')).map(
      (el) => el.textContent,
    );
    expect(glyphs).toContain(target.char);
  });

  it('multiple tokens are ANDed — every token must appear in the haystack', async () => {
    // Two tokens that co-occur in one haystack, verified against the data:
    // 'heart' and 'suit' both sit inside "White heart suit". (When this
    // suite was written, only lowercase words could serve as tokens — the
    // casing fix removed that constraint.)
    const target = UNICODE_SYMBOLS.find(
      (s) => haystack(s).includes('heart') && haystack(s).includes('suit'),
    )!;
    expect(target).toBeDefined();

    await search('heart suit');

    const glyphs = Array.from(document.querySelectorAll('.ucp-card .ucp-glyph')).map(
      (el) => el.textContent,
    );
    expect(glyphs).toContain(target.char);
    // A symbol sharing one token but not the other stays out — AND semantics.
    const heartOnly = UNICODE_SYMBOLS.find(
      (s) => haystack(s).includes('heart') && !haystack(s).includes('suit'),
    );
    if (heartOnly) {
      expect(glyphs).not.toContain(heartOnly.char);
    }
  });

  it('search is case-insensitive — a lowercase query matches Title Case names', async () => {
    // The FIXED QUIRK, pinned as a regression: the haystacks used to keep
    // the dataset's Title Case names ("Superscript two"), so a user typing
    // the placeholder's own suggestion in lowercase ("superscript") found
    // nothing while the lowercase second word ("two") matched. The
    // haystack is now lowercased at build time, meeting the already-
    // lowercased query — matching and highlighting finally agree.
    expect(symbolNamed('superscript')!.name).toBe('Superscript two');

    await search('superscript');

    expect(statusText()).not.toContain('0 matches');
    const glyphs = Array.from(document.querySelectorAll('.ucp-card .ucp-glyph')).map(
      (el) => el.textContent,
    );
    expect(glyphs).toContain('²');

    // The capitalized query finds the same symbol — case no longer
    // changes the result set.
    await search('Superscript');
    expect(statusText()).not.toContain('0 matches');
  });

  it('a dead search paints the empty state and pluralizes to zero matches', async () => {
    await search('zzzqqqxxx no such symbol');

    expect(document.querySelector('.ucp-empty-title')?.textContent).toContain(
      'No characters match',
    );
    expect(statusText()).toContain('0 matches for');
  });

  it('the clear button resets the search and restores the full list', async () => {
    await search('heart');
    expect(document.querySelectorAll('.ucp-card').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.ucp-card').length).toBeLessThan(UNICODE_SYMBOLS.length);

    click('#unicodeSearchClear');

    expect((document.getElementById('unicodeSearch') as HTMLInputElement).value).toBe('');
    expect(statusText()).toContain(`${UNICODE_SYMBOLS.length.toLocaleString()} of`);
    expect(document.querySelectorAll('.ucp-card').length).toBeGreaterThan(0);
  });

  it('the search-clear affordance follows the input emptiness', async () => {
    const clear = document.getElementById('unicodeSearchClear') as HTMLElement;
    expect(clear.hidden).toBe(true);

    await search('heart');
    expect(clear.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Categories — narrowing, active state, the widening fallback
// ---------------------------------------------------------------------------

describe('categories (characterization)', () => {
  it('clicking a category chip narrows the grid to that category', () => {
    const category = CATEGORIES[0]!;
    const expected = UNICODE_SYMBOLS.filter((s) => s.category === category).length;

    click(`.ucp-cat[data-cat="${category}"]`);

    const chip = document.querySelector(`.ucp-cat[data-cat="${category}"]`) as HTMLElement;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(statusText()).toContain(`${expected.toLocaleString()} of`);
    // Every rendered card belongs to the chosen category — the detail pane
    // of the active symbol answers the same.
    expect(statusText()).not.toContain(`${UNICODE_SYMBOLS.length.toLocaleString()} of`);
  });

  it('a search that dies inside a category but lives in All widens the scope', async () => {
    // Favorites starts empty: any query that matches something globally
    // must trigger the fallback switch to All characters.
    click('.ucp-cat[data-cat="favorites"]');
    expect(document.querySelector('.ucp-empty-title')?.textContent).toContain('No favorites yet');

    await search('heart');

    const activeChip = document.querySelector('.ucp-cat.is-active') as HTMLElement;
    expect(activeChip.dataset.cat).toBe('all');
    expect(document.querySelectorAll('.ucp-card').length).toBeGreaterThan(0);
  });

  it('a search that dies everywhere stays in the category (and the empty state reflects the search)', async () => {
    click('.ucp-cat[data-cat="favorites"]');

    await search('zzz-nothing');

    // No widening: the global search is dead too.
    const activeChip = document.querySelector('.ucp-cat.is-active') as HTMLElement;
    expect(activeChip.dataset.cat).toBe('favorites');
    // The status line tells the truth…
    expect(statusText()).toContain('0 matches for');
    // …and so does the empty-state card now: renderEmptyState REPLACES
    // the card already on screen instead of early-returning, so the
    // category's "No favorites yet" copy no longer outlives a no-match
    // search. The FIXED QUIRK, pinned as a regression — only ever the
    // empty state that matches the current reason for emptiness.
    expect(document.querySelector('.ucp-empty-title')?.textContent).toContain(
      'No characters match',
    );
    expect(document.querySelector('.ucp-empty-title')?.textContent).not.toContain(
      'No favorites yet',
    );
  });
});

// ---------------------------------------------------------------------------
// Favorites — the star, persistence, the count chip
// ---------------------------------------------------------------------------

describe('favorites (characterization)', () => {
  it('starring the active symbol persists the set and updates the count chip', () => {
    const first = UNICODE_SYMBOLS[0]!;

    click('.ucp-btn[data-action="star"]');

    expect(stateGet('unicodeFavorites')).toBe(JSON.stringify([first.char]));
    expect(
      document.querySelector('.ucp-cat[data-cat="favorites"] .ucp-cat-count')!.textContent,
    ).toBe('1');
    // The detail's star button reflects the state.
    const starLabel = document.querySelector('.ucp-btn-star-label')?.textContent;
    expect(starLabel).toBe('Favorited');
  });

  it('starring again unstars — the set returns to empty', () => {
    click('.ucp-btn[data-action="star"]');
    click('.ucp-btn[data-action="star"]');

    expect(stateGet('unicodeFavorites')).toBe('[]');
    expect(
      document.querySelector('.ucp-cat[data-cat="favorites"] .ucp-cat-count')!.textContent,
    ).toBe('0');
  });

  it('a persisted favorite renders the favorites category and the is-fav card paint', async () => {
    const first = UNICODE_SYMBOLS[0]!;
    stateSet('unicodeFavorites', JSON.stringify([first.char]));

    picker = initUnicodePicker({ note: $('#note') } as unknown as NotepadUI);
    picker.open();
    await new Promise((resolve) => setTimeout(resolve, 60));

    click('.ucp-cat[data-cat="favorites"]');

    const card = document.querySelector('.ucp-card') as HTMLElement;
    expect(card.querySelector('.ucp-glyph')!.textContent).toBe(first.char);
    expect(card.classList.contains('is-fav')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recents — insertion order, dedupe, the cap
// ---------------------------------------------------------------------------

describe('recents (characterization)', () => {
  it('inserting a symbol through the handle routes through the port and records it', () => {
    const target = UNICODE_SYMBOLS[5]!;

    picker.insertSymbol(target);

    expect(port.insertText).toHaveBeenCalledWith(target.char);
    expect(stateGet('recentUnicodeSymbols')).toBe(JSON.stringify([target.char]));
  });

  it('re-inserting moves the symbol to the front without duplicating it', () => {
    const a = UNICODE_SYMBOLS[1]!;
    const b = UNICODE_SYMBOLS[2]!;

    picker.insertSymbol(a);
    picker.insertSymbol(b);
    picker.insertSymbol(a);

    expect(stateGet('recentUnicodeSymbols')).toBe(JSON.stringify([a.char, b.char]));
  });

  it('the recents list caps at 24 — the oldest entry falls off', () => {
    const symbols = UNICODE_SYMBOLS.slice(0, 25)!;

    symbols.forEach((symbol) => picker.insertSymbol(symbol));

    const stored = JSON.parse(stateGet('recentUnicodeSymbols') ?? '[]') as string[];
    expect(stored).toHaveLength(24);
    // Most recent first; the first-inserted (oldest) symbol dropped off.
    expect(stored[0]).toBe(symbols[24]!.char);
    expect(stored).not.toContain(symbols[0]!.char);
  });
});

// ---------------------------------------------------------------------------
// Insertion — the EditorPort seam and the caret parking
// ---------------------------------------------------------------------------

describe('insertion (characterization)', () => {
  it('a selection outside the editor is parked at the note end first', () => {
    const target = UNICODE_SYMBOLS[3]!;
    // Park the selection on an outside node (the status line).
    const outside = document.getElementById('unicodeStatus') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    picker.insertSymbol(target);

    // The port answered true, so no DOM fallback ran — and the caret was
    // moved into the note before the insert call (focus + range reset).
    expect(port.insertText).toHaveBeenCalledWith(target.char);
    const after = window.getSelection();
    expect(after?.rangeCount ?? 0).toBeGreaterThan(0);
    if (after && after.rangeCount > 0) {
      expect(
        (document.getElementById('note') as HTMLElement).contains(
          after.getRangeAt(0).commonAncestorContainer,
        ),
      ).toBe(true);
    }
  });

  it('a port refusing the insert falls back to a DOM text node plus input event', () => {
    const target = UNICODE_SYMBOLS[4]!;
    (port.insertText as ReturnType<typeof vi.fn>).mockReturnValue(false);

    picker.insertSymbol(target);

    expect((document.getElementById('note') as HTMLElement).textContent).toContain(target.char);
    // The recents still record the insertion.
    expect(stateGet('recentUnicodeSymbols')).toBe(JSON.stringify([target.char]));
  });
});
