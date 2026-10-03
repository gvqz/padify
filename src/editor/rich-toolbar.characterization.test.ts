/**
 * Characterization suite for the rich text toolbar
 * (src/editor/rich-toolbar.ts) — the last big interactive module from the
 * original review's coverage-gap list (1,179 lines, previously zero unit
 * tests).
 *
 * What this pins, and why it matters:
 *  - the fixture is the REAL editor shell (src/ui/editor-shell.html, read
 *    from disk and injected) — the toolbar's markup assumptions (ids, the
 *    data-rich-* vocabulary, the popover rows) cannot drift from the
 *    shipped markup without failing here;
 *  - visibility follows the ACTIVE NOTE through a real TabManager: rich
 *    notes show the toolbar, standard notes hide it, and hiding also tears
 *    down whatever the user had open (link popover, equation bubble,
 *    dropdown menus);
 *  - the pressed states follow the caret (selectionchange + input, rAF-
 *    batched): bold/italic/… from queryFormat, the block label from
 *    queryBlockFormat, list/script/alignment/link state, undo/redo ink
 *    from canUndo/canRedo, the table-ops host from queryTableContext —
 *    and a caret OUTSIDE the note clears every pressed state;
 *  - every mutation routes through the EditorPort seam (applyFormat,
 *    applyBlockFormat, toggleList, setFontSize, insertLink, insertMath,
 *    …) — the contract that lets the document-model editor swap in under
 *    this toolbar unchanged;
 *  - the dropdown menus behave Docs-style: one open at a time, first item
 *    focused, arrow/Home/End roving (list menus step one — jsdom reports
 *    no grid columns), Escape refocuses the note, Tab does not;
 *  - the link popover: caret-parked selection restored on apply, bare
 *    domains completed to https://, hostile schemes refused with a toast,
 *    chip mode for an existing link (edit → retargetLink), copy with the
 *    async clipboard first and the execCommand fallback;
 *  - the equation bubble: Insert vs Apply (padify:math-click edit mode
 *    retargets through updateMath), live KaTeX preview;
 *  - the color pickers: palette keys resolve through the theme (light
 *    mode here) before reaching setTextColor; the glyph-bar previews and
 *    the padify:theme reset.
 *
 * Deliberately left to e2e (docs-toolbar.spec.ts): real caret rendering
 * inside a browser selection, panel clamping geometry against a real
 * viewport, palette hover previews, KaTeX's visual output.
 *
 * Everything here was written against the behaviour of the live app at the
 * commit this file landed. If a test fails after an intentional behavior
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { $ } from '../lib/q';
import { initRichToolbar } from './rich-toolbar';
import {
  setEditorPort,
  type Alignment,
  type BlockFormat,
  type EditorPort,
  type ListKind,
  type TableCellContext,
} from './port';
import { setTabManager, TabManager } from '../tabs';
import { resetStorageForTests, storageReady } from '../storage';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // The REAL editor shell — the same markup the vite include plugin expands
  // into index.html at build time. Reading it from disk keeps the fixture
  // honest: a markup change that breaks the toolbar's assumptions fails
  // this suite instead of silently shipping.
  const shell = readFileSync(resolve(process.cwd(), 'src/ui/editor-shell.html'), 'utf-8');
  document.body.insertAdjacentHTML('afterbegin', shell);
  // #toast lives in topbar.html, not the editor shell — mounted by hand
  // (showToast writes into it).
  if (!document.getElementById('toast')) {
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }

  // jsdom does not implement innerText (it depends on CSS rendering). The
  // TabManager's text projection reads it; textContent agrees on every
  // string these tests use.
  if (typeof HTMLElement.prototype.innerText === 'undefined') {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      get(this: HTMLElement) {
        return this.textContent;
      },
      configurable: true,
    });
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {},
      configurable: true,
    });
  }

  // A storage boot from truly nothing — kv mirror AND localStorage wiped.
  resetStorageForTests();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await new Promise<void>((resolvePromise) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolvePromise();
    request.onerror = () => resolvePromise();
    request.onblocked = () => resolvePromise();
  });
  localStorage.clear();
  await storageReady();

  // The port is installed BEFORE the toolbar initializes so the init-time
  // onInput registration lands on a spy we can assert against.
  bootPort = createFakePort();
  setEditorPort(bootPort);

  manager = new TabManager($('#note'));
  await manager.init();
  setTabManager(manager);

  initRichToolbar(manager);

  // Two notes to switch between: the welcome note (standard, no type) the
  // manager booted with, and a rich note.
  standardTabId = manager.getActive()!.id;
  manager.addTab(false, 'rich');
  richTabId = manager.getActive()!.id;
  // Most of the suite runs on the rich note; the visibility describe
  // switches around from here.
});

let manager: TabManager;
let bootPort: EditorPort;
let standardTabId: string;
let richTabId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lets jsdom's timer-driven requestAnimationFrame callbacks run. */
async function flushFrames(frames = 2): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function toolbar(): HTMLElement {
  return document.getElementById('richToolbar')!;
}

function note(): HTMLElement {
  return document.getElementById('note')!;
}

function toastText(): string {
  return document.getElementById('toast')!.textContent ?? '';
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function key(element: Element, keyName: string): void {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }),
  );
}

/** A real selection over the element's contents, as a user drag would leave. */
function selectContentsOf(element: Element): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Drives the caret-following refresh: selectionchange + a frame. */
async function driveSelectionRefresh(): Promise<void> {
  document.dispatchEvent(new Event('selectionchange'));
  await flushFrames();
}

/** Clicks the note-type's tab strip button — the real switch gesture. */
async function activateTab(tabId: string): Promise<void> {
  const button = document.querySelector(`.tab-strip-tab[data-tab-id="${tabId}"]`);
  expect(button).toBeTruthy();
  click(button!);
  await flushFrames(1);
}

async function ensureRichActive(): Promise<void> {
  if (manager.getActive()?.noteType !== 'rich') {
    await activateTab(richTabId);
  }
}

/** A full EditorPort stub — the swap-in contract the toolbar must speak. */
function createFakePort(overrides: Partial<EditorPort> = {}): EditorPort {
  const base: EditorPort = {
    getHtml: vi.fn(() => ''),
    setHtml: vi.fn(),
    renderHtml: vi.fn(),
    getText: vi.fn(() => ''),
    isEmpty: vi.fn(() => true),
    normalizeEmptySurface: vi.fn(() => false),
    focus: vi.fn(),
    isCaretInside: vi.fn(() => true),
    ensureCaretInside: vi.fn(() => true),
    charBeforeCaret: vi.fn(() => ''),
    insertText: vi.fn(() => true),
    applyFormat: vi.fn(() => true),
    queryFormat: vi.fn(() => false),
    applyBlockFormat: vi.fn(() => true),
    queryBlockFormat: vi.fn((): BlockFormat | null => null),
    toggleList: vi.fn(() => true),
    queryListKind: vi.fn((): ListKind | null => null),
    insertLink: vi.fn(() => true),
    insertLinkAsText: vi.fn(() => true),
    removeLink: vi.fn(() => true),
    queryLinkHref: vi.fn((): string | null => null),
    retargetLink: vi.fn(() => false),
    insertMath: vi.fn(() => true),
    queryMathAtCaret: vi.fn((): { latex: string; id: string } | null => null),
    updateMath: vi.fn(() => true),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    canUndo: vi.fn(() => false),
    canRedo: vi.fn(() => false),
    setFontSize: vi.fn(() => true),
    setFontFamily: vi.fn(() => true),
    setTextColor: vi.fn(() => true),
    queryTextColor: vi.fn((): string | null => null),
    setHighlight: vi.fn(() => true),
    applyScript: vi.fn(() => true),
    queryScript: vi.fn(() => false),
    applyAlignment: vi.fn(() => true),
    queryAlignment: vi.fn((): Alignment | null => null),
    indent: vi.fn(() => true),
    outdent: vi.fn(() => true),
    insertHorizontalRule: vi.fn(() => true),
    insertTable: vi.fn(() => true),
    queryTableContext: vi.fn((): TableCellContext | null => null),
    moveTableCellFocus: vi.fn(() => false),
    runTableAction: vi.fn(() => true),
    onInput: vi.fn(() => () => {}),
  };
  return Object.assign(base, overrides);
}

beforeEach(async () => {
  // Every test gets a fresh port at the seam — the module reads
  // getEditorPort() dynamically on every gesture, so this is the one
  // piece of global state the suite controls per test.
  setEditorPort(createFakePort());
  // Tear down whatever the previous test left open (the document-level
  // Escape handler closes popover, bubble and menus alike).
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flushFrames(1);
  const toast = document.getElementById('toast')!;
  toast.textContent = '';
  toast.className = '';
  note().innerHTML = '';
  await ensureRichActive();
});

// ---------------------------------------------------------------------------
// boot + visibility
// ---------------------------------------------------------------------------

describe('boot + visibility (characterization)', () => {
  it('registers for editor input through the port seam at init', () => {
    expect(bootPort.onInput).toHaveBeenCalled();
  });

  it('the toolbar rests hidden on a standard note and shows on a rich note', async () => {
    await activateTab(standardTabId);
    expect(toolbar().hidden).toBe(true);

    await activateTab(richTabId);
    expect(toolbar().hidden).toBe(false);
  });

  it('switching to a standard note tears down the open link popover', async () => {
    const port = createFakePort({ queryLinkHref: vi.fn(() => null) });
    setEditorPort(port);
    const linkButton = document.getElementById('richLinkButton')!;
    click(linkButton);
    expect(document.getElementById('richLinkPopover')!.hidden).toBe(false);

    await activateTab(standardTabId);
    expect(document.getElementById('richLinkPopover')!.hidden).toBe(true);
    expect(linkButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('switching to a standard note closes the open dropdown menus', async () => {
    const sizeButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
    click(sizeButton);
    const panel = sizeButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    expect(panel.hidden).toBe(false);

    await activateTab(standardTabId);
    expect(panel.hidden).toBe(true);
    expect(sizeButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('switching to a standard note closes the equation bubble', async () => {
    const mathButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-action="math"]')!;
    click(mathButton);
    const popover = document.getElementById('richMathPopover')!;
    expect(popover.hidden).toBe(false);

    await activateTab(standardTabId);
    expect(popover.hidden).toBe(true);
  });

  it('the Ctrl/Cmd+K event opens the popover only while a rich note is active', async () => {
    document.dispatchEvent(new Event('padify:open-link'));
    expect(document.getElementById('richLinkPopover')!.hidden).toBe(false);

    await activateTab(standardTabId);
    document.dispatchEvent(new Event('padify:open-link'));
    expect(document.getElementById('richLinkPopover')!.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pressed states — the caret-following contract
// ---------------------------------------------------------------------------

describe('pressed states follow the caret (characterization)', () => {
  it('queryFormat lights the matching state buttons only', async () => {
    const port = createFakePort({
      queryFormat: vi.fn((command: string) => command === 'bold'),
    });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();

    const bold = toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="bold"]')!;
    const italic = toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="italic"]')!;
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(italic.getAttribute('aria-pressed')).toBe('false');
  });

  it('the block label echoes queryBlockFormat; null and throwing both read as Normal text', async () => {
    const label = toolbar().querySelector<HTMLElement>('[data-rich-label="block"]')!;
    const port = createFakePort({ queryBlockFormat: vi.fn((): BlockFormat | null => 'h2') });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();
    expect(label.textContent).toBe('Heading 2');

    setEditorPort(createFakePort({ queryBlockFormat: vi.fn((): BlockFormat | null => null) }));
    await driveSelectionRefresh();
    expect(label.textContent).toBe('Normal text');

    // queryCommand* can throw in odd selection states — never crash the UI.
    setEditorPort(
      createFakePort({
        queryBlockFormat: vi.fn((): BlockFormat | null => {
          throw new Error('queryCommandState is fussy');
        }),
      }),
    );
    await driveSelectionRefresh();
    expect(label.textContent).toBe('Normal text');
  });

  it("the list buttons press for the caret's list kind", async () => {
    const port = createFakePort({ queryListKind: vi.fn((): ListKind | null => 'ol') });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();

    const ul = toolbar().querySelector<HTMLButtonElement>('[data-rich-list="ul"]')!;
    const ol = toolbar().querySelector<HTMLButtonElement>('[data-rich-list="ol"]')!;
    const checklist = toolbar().querySelector<HTMLButtonElement>('[data-rich-list="checklist"]')!;
    expect(ul.getAttribute('aria-pressed')).toBe('false');
    expect(ol.getAttribute('aria-pressed')).toBe('true');
    expect(checklist.getAttribute('aria-pressed')).toBe('false');
  });

  it('script and alignment buttons press from their queries', async () => {
    const port = createFakePort({
      queryScript: vi.fn((script: string) => script === 'super'),
      queryAlignment: vi.fn((): Alignment | null => 'center'),
    });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();

    const sup = toolbar().querySelector<HTMLButtonElement>('[data-rich-query="super"]')!;
    const sub = toolbar().querySelector<HTMLButtonElement>('[data-rich-query="sub"]')!;
    const center = toolbar().querySelector<HTMLButtonElement>('[data-rich-query="align-center"]')!;
    const left = toolbar().querySelector<HTMLButtonElement>('[data-rich-query="align-left"]')!;
    expect(sup.getAttribute('aria-pressed')).toBe('true');
    expect(sub.getAttribute('aria-pressed')).toBe('false');
    expect(center.getAttribute('aria-pressed')).toBe('true');
    expect(left.getAttribute('aria-pressed')).toBe('false');
  });

  it('the link button presses while the caret sits in a link', async () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://in-link.dev'),
    });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();
    expect(document.getElementById('richLinkButton')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('undo/redo ink follows the history answer', async () => {
    const port = createFakePort({ canUndo: vi.fn(() => true), canRedo: vi.fn(() => false) });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();

    const undo = toolbar().querySelector<HTMLElement>('[data-rich-action="undo"]')!;
    const redo = toolbar().querySelector<HTMLElement>('[data-rich-action="redo"]')!;
    expect(undo.getAttribute('aria-disabled')).toBe('false');
    expect(redo.getAttribute('aria-disabled')).toBe('true');
  });

  it('the table-ops host appears with the caret inside a table only', async () => {
    const host = document.getElementById('richTableMenuHost')!;
    const inTable = createFakePort({
      queryTableContext: vi.fn((): TableCellContext | null => ({
        rows: 3,
        cols: 4,
        rowIndex: 1,
        colIndex: 2,
      })),
    });
    setEditorPort(inTable);
    selectContentsOf(note());
    await driveSelectionRefresh();
    expect(host.hidden).toBe(false);

    setEditorPort(
      createFakePort({ queryTableContext: vi.fn((): TableCellContext | null => null) }),
    );
    await driveSelectionRefresh();
    expect(host.hidden).toBe(true);
  });

  it('a caret outside the note clears every pressed state', async () => {
    const port = createFakePort({
      queryFormat: vi.fn(() => true),
      queryListKind: vi.fn((): ListKind | null => 'ul'),
      queryLinkHref: vi.fn((): string | null => 'https://stale.dev'),
      isCaretInside: vi.fn(() => false),
    });
    setEditorPort(port);
    selectContentsOf(note());
    await driveSelectionRefresh();

    const bold = toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="bold"]')!;
    const ul = toolbar().querySelector<HTMLButtonElement>('[data-rich-list="ul"]')!;
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    expect(ul.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('richLinkButton')!.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('richTableMenuHost')!.hidden).toBe(true);
  });

  it("the size label echoes the caret element's computed font size", async () => {
    const span = document.createElement('span');
    span.textContent = 'twenty four pixels';
    span.style.fontSize = '24px';
    note().appendChild(span);
    selectContentsOf(span);
    await driveSelectionRefresh();

    const label = toolbar().querySelector<HTMLElement>('[data-rich-label="size"]')!;
    expect(label.textContent).toBe('24');
  });

  it('the font label title-cases a known font, or reads Font for anything else', async () => {
    const georgia = document.createElement('span');
    georgia.textContent = 'serif country';
    georgia.style.fontFamily = 'Georgia';
    note().appendChild(georgia);
    selectContentsOf(georgia);
    await driveSelectionRefresh();
    expect(toolbar().querySelector<HTMLElement>('[data-rich-label="font"]')!.textContent).toBe(
      'Georgia',
    );

    const comic = document.createElement('span');
    comic.textContent = 'comic thoughts';
    comic.style.fontFamily = 'Comic Sans MS';
    note().appendChild(comic);
    selectContentsOf(comic);
    await driveSelectionRefresh();
    expect(toolbar().querySelector<HTMLElement>('[data-rich-label="font"]')!.textContent).toBe(
      'Font',
    );
  });
});

// ---------------------------------------------------------------------------
// the Docs-style dropdown menus
// ---------------------------------------------------------------------------

describe('the dropdown menus (characterization)', () => {
  function sizeButton(): HTMLButtonElement {
    return toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
  }

  function sizePanel(): HTMLElement {
    return sizeButton().parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
  }

  it('opening a menu reveals the panel, expands the button and focuses the first item', () => {
    click(sizeButton());
    const panel = sizePanel();
    expect(panel.hidden).toBe(false);
    expect(sizeButton().getAttribute('aria-expanded')).toBe('true');
    const first = panel.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
  });

  it('clicking the button again closes the menu and hands focus back to the note', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(sizeButton());
    click(sizeButton());
    expect(sizePanel().hidden).toBe(true);
    expect(sizeButton().getAttribute('aria-expanded')).toBe('false');
    expect(port.focus).toHaveBeenCalled();
  });

  it('only one menu is open at a time', () => {
    const fontButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="font"]')!;
    click(sizeButton());
    click(fontButton);
    expect(sizePanel().hidden).toBe(true);
    expect(sizeButton().getAttribute('aria-expanded')).toBe('false');
    const fontPanel = fontButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    expect(fontPanel.hidden).toBe(false);
    expect(fontButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('the size menu marks the preset matching the caret label — 24 is a preset, the default 16 is not', async () => {
    const span = document.createElement('span');
    span.textContent = 'twenty four';
    span.style.fontSize = '24px';
    note().appendChild(span);
    selectContentsOf(span);
    await driveSelectionRefresh();

    click(sizeButton());
    const preset24 = sizePanel().querySelector<HTMLElement>('[data-rich-size="24"]')!;
    expect(preset24.getAttribute('aria-checked')).toBe('true');
    expect(preset24.classList.contains('rich-menu-current')).toBe(true);
    const preset18 = sizePanel().querySelector<HTMLElement>('[data-rich-size="18"]')!;
    expect(preset18.getAttribute('aria-checked')).toBe('false');
  });

  it("a non-preset caret size echoes into the custom row's input", async () => {
    // No inline size → the label falls back to the jsdom reality; both the
    // label and the echo read from the same computed source, so the pin
    // holds whichever default jsdom reports.
    const span = document.createElement('span');
    span.textContent = 'default sized';
    note().appendChild(span);
    selectContentsOf(span);
    await driveSelectionRefresh();

    const label = toolbar().querySelector<HTMLElement>('[data-rich-label="size"]')!.textContent!;
    click(sizeButton());
    const input = sizePanel().querySelector<HTMLInputElement>('[data-rich-size-custom] input')!;

    const preset = sizePanel().querySelector<HTMLElement>(`[data-rich-size="${label}"]`);
    if (preset) {
      expect(preset.getAttribute('aria-checked')).toBe('true');
    } else {
      expect(/^\d+$/.test(label)).toBe(true);
      expect(input.value).toBe(label);
    }
  });

  it('the styles menu marks the current block format', () => {
    const blockButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="block"]')!;
    click(blockButton);
    const panel = blockButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    const normal = panel.querySelector<HTMLElement>('[data-rich-block="p"]')!;
    const heading = panel.querySelector<HTMLElement>('[data-rich-block="h1"]')!;
    expect(normal.getAttribute('aria-checked')).toBe('true');
    expect(heading.getAttribute('aria-checked')).toBe('false');
  });

  it('arrow keys rove the items one step and wrap; Home/End jump the edges', () => {
    click(sizeButton());
    const items = Array.from(sizePanel().querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.length).toBeGreaterThan(4);

    key(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);

    // jsdom reports no grid columns for the panel, so every arrow steps
    // one — the list-menu behavior.
    key(document.activeElement as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(items[2]);

    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(items[1]);

    key(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(items[0]);

    key(document.activeElement as HTMLElement, 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);

    // ArrowUp from the first item wraps around.
    key(document.activeElement as HTMLElement, 'Home');
    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('Escape closes the menu and refocuses the note; Tab closes without refocusing', () => {
    const escapePort = createFakePort();
    setEditorPort(escapePort);
    click(sizeButton());
    key(document.activeElement as HTMLElement, 'Escape');
    expect(sizePanel().hidden).toBe(true);
    expect(escapePort.focus).toHaveBeenCalledTimes(1);

    const tabPort = createFakePort();
    setEditorPort(tabPort);
    click(sizeButton());
    key(document.activeElement as HTMLElement, 'Tab');
    expect(sizePanel().hidden).toBe(true);
    expect(tabPort.focus).not.toHaveBeenCalled();
  });

  it('an outside click closes the open menus; a click inside the toolbar does not', () => {
    click(sizeButton());
    expect(sizePanel().hidden).toBe(false);

    // A click on another toolbar button stays inside — menus survive.
    const bold = toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="bold"]')!;
    click(bold);
    expect(sizePanel().hidden).toBe(false);

    click(document.body);
    expect(sizePanel().hidden).toBe(true);
  });

  it("panels never paint off-screen: with jsdom's zero rects no clamp is applied", () => {
    click(sizeButton());
    expect(sizePanel().style.marginLeft).toBe('');
  });
});

// ---------------------------------------------------------------------------
// commands — every mutation through the EditorPort seam
// ---------------------------------------------------------------------------

describe('commands (characterization)', () => {
  it('pointerdown on a toolbar button never steals the editor selection', () => {
    const bold = toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="bold"]')!;
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('the state buttons apply their formats', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="bold"]')!);
    expect(port.applyFormat).toHaveBeenCalledWith('bold');
    click(toolbar().querySelector<HTMLButtonElement>('[data-rich-cmd="strikeThrough"]')!);
    expect(port.applyFormat).toHaveBeenCalledWith('strikeThrough');
  });

  it('the action buttons dispatch to their port calls', () => {
    const port = createFakePort();
    setEditorPort(port);
    const action = (name: string): HTMLButtonElement =>
      toolbar().querySelector<HTMLButtonElement>(`[data-rich-action="${name}"]`)!;

    click(action('undo'));
    expect(port.undo).toHaveBeenCalled();
    click(action('redo'));
    expect(port.redo).toHaveBeenCalled();
    click(action('sup'));
    expect(port.applyScript).toHaveBeenCalledWith('super');
    click(action('sub'));
    expect(port.applyScript).toHaveBeenCalledWith('sub');
    click(action('indent'));
    expect(port.indent).toHaveBeenCalled();
    click(action('outdent'));
    expect(port.outdent).toHaveBeenCalled();
    click(action('hr'));
    expect(port.insertHorizontalRule).toHaveBeenCalled();
    click(action('align-justify'));
    expect(port.applyAlignment).toHaveBeenCalledWith('justify');
  });

  it('the list buttons toggle their list kinds', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(toolbar().querySelector<HTMLButtonElement>('[data-rich-list="ul"]')!);
    expect(port.toggleList).toHaveBeenCalledWith('ul');
    click(toolbar().querySelector<HTMLButtonElement>('[data-rich-list="checklist"]')!);
    expect(port.toggleList).toHaveBeenCalledWith('checklist');
  });

  it('choosing a different block format applies it; choosing the active one returns to plain', () => {
    const port = createFakePort({ queryBlockFormat: vi.fn((): BlockFormat | null => 'h1') });
    setEditorPort(port);
    const blockButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="block"]')!;
    click(blockButton);
    const panel = blockButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;

    click(panel.querySelector<HTMLButtonElement>('[data-rich-block="h2"]')!);
    expect(port.applyBlockFormat).toHaveBeenCalledWith('h2');

    // The caret sits in an h1, the menu choice is h1 → back to plain text.
    (port.applyBlockFormat as ReturnType<typeof vi.fn>).mockClear();
    click(blockButton);
    click(panel.querySelector<HTMLButtonElement>('[data-rich-block="h1"]')!);
    expect(port.applyBlockFormat).toHaveBeenCalledWith('p');

    // Already plain and choosing plain → a no-op, not a redundant command.
    setEditorPort(createFakePort({ queryBlockFormat: vi.fn((): BlockFormat | null => 'p') }));
    const quiet = createFakePort({ queryBlockFormat: vi.fn((): BlockFormat | null => 'p') });
    setEditorPort(quiet);
    click(blockButton);
    click(panel.querySelector<HTMLButtonElement>('[data-rich-block="p"]')!);
    expect(quiet.applyBlockFormat).not.toHaveBeenCalled();
  });

  it('a preset size click applies the size and closes the menu', () => {
    const port = createFakePort();
    setEditorPort(port);
    const sizeButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
    click(sizeButton);
    const panel = sizeButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    click(panel.querySelector<HTMLButtonElement>('[data-rich-size="18"]')!);
    expect(port.setFontSize).toHaveBeenCalledWith(18);
    expect(panel.hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('the custom size row: Enter applies a valid size after refocusing the note', () => {
    const port = createFakePort();
    setEditorPort(port);
    const sizeButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
    click(sizeButton);
    const panel = sizeButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    const input = panel.querySelector<HTMLInputElement>('[data-rich-size-custom] input')!;
    input.focus(); // the user clicks into the field before typing
    input.value = '50';
    key(input, 'Enter');
    expect(port.setFontSize).toHaveBeenCalledWith(50);
    expect(port.focus).toHaveBeenCalled();
    expect(panel.hidden).toBe(true);
  });

  it('the custom size row refuses out-of-range sizes with a toast and keeps the menu', () => {
    const port = createFakePort();
    setEditorPort(port);
    const sizeButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
    click(sizeButton);
    const panel = sizeButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    const input = panel.querySelector<HTMLInputElement>('[data-rich-size-custom] input')!;
    input.focus();
    input.value = '401';
    key(input, 'Enter');
    expect(port.setFontSize).not.toHaveBeenCalled();
    expect(toastText()).toBe('Font size must be between 1 and 400.');
    expect(panel.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('the custom size row with an empty field just returns to the input', () => {
    const port = createFakePort();
    setEditorPort(port);
    const sizeButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="size"]')!;
    click(sizeButton);
    const panel = sizeButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    const input = panel.querySelector<HTMLInputElement>('[data-rich-size-custom] input')!;
    input.focus();
    input.value = '';
    key(input, 'Enter');
    expect(port.setFontSize).not.toHaveBeenCalled();
    expect(toastText()).toBe('');
    expect(document.activeElement).toBe(input);
    expect(panel.hidden).toBe(false);
  });

  it('the font menu applies the chosen family', () => {
    const port = createFakePort();
    setEditorPort(port);
    const fontButton = toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="font"]')!;
    click(fontButton);
    const panel = fontButton.parentElement!.querySelector<HTMLElement>('.rich-menu-panel')!;
    click(panel.querySelector<HTMLButtonElement>('[data-rich-font="Courier New"]')!);
    expect(port.setFontFamily).toHaveBeenCalledWith('Courier New');
    expect(panel.hidden).toBe(true);
  });

  it('the table grid picker inserts an (r+1)x(c+1) table', () => {
    const port = createFakePort();
    setEditorPort(port);
    const gridCell = toolbar().querySelector<HTMLButtonElement>('[data-rich-grid="2,3"]')!;
    click(gridCell);
    expect(port.insertTable).toHaveBeenCalledWith(3, 4);
  });

  it('the grid previews the hovered rectangle, and mouseleave clears it', () => {
    const gridPanel = toolbar().querySelector<HTMLElement>('.rich-menu-panel-grid')!;
    const cell = gridPanel.querySelector<HTMLElement>('[data-rich-grid="1,1"]')!;
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const on = gridPanel.querySelectorAll<HTMLElement>('.rich-grid-on');
    expect(on.length).toBe(4); // rows 0-1 x cols 0-1

    gridPanel.dispatchEvent(new MouseEvent('mouseleave'));
    expect(gridPanel.querySelectorAll<HTMLElement>('.rich-grid-on').length).toBe(0);
  });

  it('the table-ops menu runs its actions', () => {
    const port = createFakePort();
    setEditorPort(port);
    const action = toolbar().querySelector<HTMLButtonElement>('[data-rich-table="row-above"]')!;
    click(action);
    expect(port.runTableAction).toHaveBeenCalledWith('row-above');
  });
});

// ---------------------------------------------------------------------------
// the link popover
// ---------------------------------------------------------------------------

describe('the link popover (characterization)', () => {
  function linkButton(): HTMLButtonElement {
    return document.getElementById('richLinkButton') as HTMLButtonElement;
  }

  function popover(): HTMLElement {
    return document.getElementById('richLinkPopover')!;
  }

  function input(): HTMLInputElement {
    return document.getElementById('richLinkInput') as HTMLInputElement;
  }

  function applyLink(raw: string, port: EditorPort): void {
    input().value = raw;
    key(input(), 'Enter');
    void port;
  }

  it('opens in edit mode with a clean input when the caret carries no link', () => {
    const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
    setEditorPort(port);
    click(linkButton());
    expect(popover().hidden).toBe(false);
    expect(linkButton().getAttribute('aria-expanded')).toBe('true');
    expect(popover().querySelector<HTMLElement>('[data-link-mode="edit"]')!.hidden).toBe(false);
    expect(popover().querySelector<HTMLElement>('[data-link-mode="view"]')!.hidden).toBe(true);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('completes bare domains into https:// and passes real schemes through', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['example.com', 'https://example.com'],
      ['https://plain.dev/path', 'https://plain.dev/path'],
      ['mailto:someone@example.org', 'mailto:someone@example.org'],
      ['#anchor', '#anchor'],
      ['/relative/path', '/relative/path'],
    ];
    for (const [raw, expected] of cases) {
      const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
      setEditorPort(port);
      click(linkButton());
      applyLink(raw, port);
      expect(port.insertLink, `raw input was: ${raw}`).toHaveBeenCalledWith(expected);
      expect(popover().hidden, `popover closes after applying: ${raw}`).toBe(true);
    }
  });

  it('refuses hostile and non-web schemes with a toast and keeps the popover open', () => {
    for (const hostile of ['javascript:alert(1)', 'ftp://files.example.net', 'data:text/html,x']) {
      const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
      setEditorPort(port);
      click(linkButton());
      input().value = hostile;
      key(input(), 'Enter');
      // completeHref passes any scheme:… through verbatim; the SAFE_HREF
      // gate then refuses everything but http(s), mailto, # and /.
      expect(port.insertLink, `input was: ${hostile}`).not.toHaveBeenCalled();
      expect(toastText(), `input was: ${hostile}`).toBe(
        'Links must start with http://, https:// or mailto:',
      );
      expect(popover().hidden).toBe(false);
      expect(document.activeElement).toBe(input());
      key(input(), 'Escape');
    }
  });

  it('falls back to inserting the URL as text when nothing is selected', () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => null),
      insertLink: vi.fn(() => false),
      insertLinkAsText: vi.fn(() => true),
    });
    setEditorPort(port);
    click(linkButton());
    applyLink('https://as-text.dev', port);
    expect(port.insertLink).toHaveBeenCalledWith('https://as-text.dev');
    expect(port.insertLinkAsText).toHaveBeenCalledWith('https://as-text.dev');
    expect(popover().hidden).toBe(true);
  });

  it('an empty input just closes the popover without touching the port', () => {
    const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
    setEditorPort(port);
    click(linkButton());
    applyLink('   ', port);
    expect(port.insertLink).not.toHaveBeenCalled();
    expect(port.insertLinkAsText).not.toHaveBeenCalled();
    expect(popover().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('the parked selection is restored before the link lands', () => {
    const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
    setEditorPort(port);

    const target = document.createElement('span');
    target.textContent = 'link me';
    note().appendChild(target);
    selectContentsOf(target);

    click(linkButton());
    applyLink('https://parked.dev', port);

    // The popover parked the range when it opened and put it back before
    // applying — what every word processor does.
    expect(port.insertLink).toHaveBeenCalledWith('https://parked.dev');
    const selection = window.getSelection();
    expect(selection?.toString()).toBe('link me');
    expect(note().contains(selection?.anchorNode ?? null)).toBe(true);
  });

  it('the caret in an existing link opens the chip with its actions', () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://existing.dev/docs'),
    });
    setEditorPort(port);
    click(linkButton());
    expect(popover().hidden).toBe(false);
    const view = document.getElementById('richLinkView') as HTMLAnchorElement;
    expect(view.textContent).toBe('https://existing.dev/docs');
    expect(view.getAttribute('href')).toBe('https://existing.dev/docs');
    expect(popover().querySelector<HTMLElement>('[data-link-mode="view"]')!.hidden).toBe(false);
    expect(popover().querySelector<HTMLElement>('[data-link-mode="edit"]')!.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('richLinkEdit'));
  });

  it('Edit prefills the input; applying retargets the existing link and saves', () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://old.dev'),
      retargetLink: vi.fn(() => true),
    });
    setEditorPort(port);
    click(linkButton());
    click(document.getElementById('richLinkEdit')!);
    expect(input().value).toBe('https://old.dev');
    expect(popover().querySelector<HTMLElement>('[data-link-mode="edit"]')!.hidden).toBe(false);

    input().value = 'https://new.dev';
    key(input(), 'Enter');
    expect(port.retargetLink).toHaveBeenCalledWith('https://new.dev');
    expect(port.insertLink).not.toHaveBeenCalled();
    expect(popover().hidden).toBe(true);
    // Editing an existing link persists through the TabManager.
    expect(port.getHtml).toHaveBeenCalled();
  });

  it('a failed retarget falls back to inserting the link', () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://old.dev'),
      retargetLink: vi.fn(() => false),
    });
    setEditorPort(port);
    click(linkButton());
    click(document.getElementById('richLinkEdit')!);
    input().value = 'https://fallback.dev';
    key(input(), 'Enter');
    expect(port.retargetLink).toHaveBeenCalledWith('https://fallback.dev');
    expect(port.insertLink).toHaveBeenCalledWith('https://fallback.dev');
  });

  it('Remove unlinks through the port and saves', () => {
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://bye.dev'),
    });
    setEditorPort(port);
    click(linkButton());
    click(document.getElementById('richLinkChipRemove')!);
    expect(port.removeLink).toHaveBeenCalled();
    expect(port.getHtml).toHaveBeenCalled();
    expect(popover().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('Copy goes through the async clipboard when it cooperates', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://copy-me.dev'),
    });
    setEditorPort(port);
    click(linkButton());
    click(document.getElementById('richLinkCopy')!);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(writeText).toHaveBeenCalledWith('https://copy-me.dev');
    expect(toastText()).toBe('Link copied.');
  });

  it('Copy falls back to the legacy path when the clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permissions')));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const port = createFakePort({
      queryLinkHref: vi.fn((): string | null => 'https://refused.dev'),
    });
    setEditorPort(port);
    click(linkButton());
    click(document.getElementById('richLinkCopy')!);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    // jsdom has no execCommand either — the last-ditch answer is the
    // failure toast, which is exactly the legacy path's contract.
    expect(toastText()).toBe('Could not copy the link.');
  });

  it('Escape in the input closes the popover and refocuses the note', () => {
    const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
    setEditorPort(port);
    click(linkButton());
    key(input(), 'Escape');
    expect(popover().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('an outside click closes the popover; the button toggles it closed too', () => {
    const port = createFakePort({ queryLinkHref: vi.fn((): string | null => null) });
    setEditorPort(port);
    click(linkButton());
    expect(popover().hidden).toBe(false);

    click(linkButton());
    expect(popover().hidden).toBe(true);

    click(linkButton());
    expect(popover().hidden).toBe(false);
    click(document.body);
    expect(popover().hidden).toBe(true);
  });

  it('a click on a note link floats the chip under it; the link-click policy decides', () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://float.dev';
    anchor.textContent = 'float me';
    note().appendChild(anchor);

    document.dispatchEvent(
      new CustomEvent('padify:link-click', {
        detail: { href: 'https://float.dev', anchor, openInNewTab: false },
      }),
    );
    expect(popover().hidden).toBe(false);
    expect(popover().classList.contains('rich-link-popover-floating')).toBe(true);
    // jsdom's zero rects + 1024x768 viewport clamp to the 8px origin.
    expect(popover().style.left).toBe('8px');
    expect(popover().style.top).toBe('8px');
    expect(document.getElementById('richLinkView')!.textContent).toBe('https://float.dev');

    // Clicking the very link that floated the chip keeps it open.
    click(anchor);
    expect(popover().hidden).toBe(false);
    // Clicking anywhere else closes it.
    click(document.body);
    expect(popover().hidden).toBe(true);
    expect(popover().classList.contains('rich-link-popover-floating')).toBe(false);
  });

  it('a Ctrl/Cmd-modified link click opens the URL instead', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = document.createElement('a');
    anchor.href = 'https://new-tab.dev';
    note().appendChild(anchor);

    document.dispatchEvent(
      new CustomEvent('padify:link-click', {
        detail: { href: 'https://new-tab.dev', anchor, openInNewTab: true },
      }),
    );
    expect(open).toHaveBeenCalledWith('https://new-tab.dev', '_blank', 'noopener,noreferrer');
    expect(popover().hidden).toBe(true);
    open.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// the equation bubble
// ---------------------------------------------------------------------------

describe('the equation bubble (characterization)', () => {
  function mathButton(): HTMLButtonElement {
    return toolbar().querySelector<HTMLButtonElement>('[data-rich-action="math"]')!;
  }

  function popover(): HTMLElement {
    return document.getElementById('richMathPopover')!;
  }

  function input(): HTMLInputElement {
    return document.getElementById('richMathInput') as HTMLInputElement;
  }

  it('opens from the toolbar button with an empty input, the palette and the Insert label', () => {
    click(mathButton());
    expect(popover().hidden).toBe(false);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(document.getElementById('richMathInsert')!.textContent).toBe('Insert');
    // The palette builds on the first open, inside its own host.
    expect(document.getElementById('richMathPalette')!.children.length).toBeGreaterThan(0);
  });

  it('Enter inserts the LaTeX through the port and refocuses the note', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(mathButton());
    input().value = 'x^2';
    key(input(), 'Enter');
    expect(port.insertMath).toHaveBeenCalledWith('x^2');
    expect(popover().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('the live preview follows the input', () => {
    click(mathButton());
    input().value = 'x^2';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    const preview = document.getElementById('richMathPreview')!;
    expect(preview.innerHTML).toContain('katex');
  });

  it('an empty LaTeX field just closes the bubble', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(mathButton());
    input().value = '   ';
    key(input(), 'Enter');
    expect(port.insertMath).not.toHaveBeenCalled();
    expect(port.updateMath).not.toHaveBeenCalled();
    expect(popover().hidden).toBe(true);
  });

  it('a click on an existing equation reopens the bubble in edit mode', () => {
    const port = createFakePort();
    setEditorPort(port);
    document.dispatchEvent(
      new CustomEvent('padify:math-click', { detail: { id: 'math-7', latex: 'y = mx + b' } }),
    );
    expect(popover().hidden).toBe(false);
    expect(input().value).toBe('y = mx + b');
    expect(document.getElementById('richMathInsert')!.textContent).toBe('Apply');

    input().value = 'y = 2x';
    key(input(), 'Enter');
    expect(port.updateMath).toHaveBeenCalledWith('math-7', 'y = 2x');
    expect(port.insertMath).not.toHaveBeenCalled();
  });

  it('Escape closes the bubble and refocuses; the button toggles; outside clicks close', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(mathButton());
    expect(popover().hidden).toBe(false);

    click(mathButton());
    expect(popover().hidden).toBe(true);

    click(mathButton());
    key(input(), 'Escape');
    expect(popover().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();

    click(mathButton());
    click(document.body);
    expect(popover().hidden).toBe(true);
  });

  it("the context menu's open-equation request opens the bubble", () => {
    document.dispatchEvent(new Event('padify:open-equation'));
    expect(popover().hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the color pickers
// ---------------------------------------------------------------------------

describe('the color pickers (characterization)', () => {
  function colorButton(): HTMLButtonElement {
    return toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="color"]')!;
  }

  function colorPanel(): HTMLElement {
    return toolbar().querySelector<HTMLElement>('[data-rich-panel-color]')!;
  }

  function highlightButton(): HTMLButtonElement {
    return toolbar().querySelector<HTMLButtonElement>('[data-rich-menu="highlight"]')!;
  }

  function highlightPanel(): HTMLElement {
    return toolbar().querySelector<HTMLElement>('[data-rich-panel-hilite]')!;
  }

  function inkPreview(): HTMLElement {
    return toolbar().querySelector<HTMLElement>('[data-rich-ink="color"]')!;
  }

  function hilitePreview(): HTMLElement {
    return toolbar().querySelector<HTMLElement>('[data-rich-hilite]')!;
  }

  it('a text palette pick resolves through the theme and applies the concrete color', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(colorButton());
    // Light mode (the test document's body carries no .dark class).
    click(colorPanel().querySelector<HTMLElement>('[data-rich-color="ink"]')!);
    expect(port.setTextColor).toHaveBeenCalledWith('#1a1a1a');
    expect(inkPreview().style.getPropertyValue('--rich-ink')).toBe('#1a1a1a');
    expect(colorPanel().hidden).toBe(true);
    expect(port.focus).toHaveBeenCalled();
  });

  it('the ink preview adapts to the theme: a padify:theme flip clears it', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(colorButton());
    click(colorPanel().querySelector<HTMLElement>('[data-rich-color="red"]')!);
    expect(inkPreview().style.getPropertyValue('--rich-ink')).toBe('#ea4335');

    document.dispatchEvent(new Event('padify:theme'));
    expect(inkPreview().style.getPropertyValue('--rich-ink')).toBe('');
  });

  it('a highlight pick applies the literal pastel and previews it', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(highlightButton());
    click(highlightPanel().querySelector<HTMLElement>('[data-rich-highlight="#fff3bf"]')!);
    expect(port.setHighlight).toHaveBeenCalledWith('#fff3bf');
    expect(hilitePreview().style.getPropertyValue('--rich-hilite')).toBe('#fff3bf');
    expect(highlightPanel().hidden).toBe(true);
  });

  it('the None swatch strips the highlight', () => {
    const port = createFakePort();
    setEditorPort(port);
    click(highlightButton());
    click(highlightPanel().querySelector<HTMLElement>('[data-rich-highlight="#d3f9d8"]')!);
    expect(hilitePreview().style.getPropertyValue('--rich-hilite')).toBe('#d3f9d8');

    click(highlightButton());
    click(highlightPanel().querySelector<HTMLElement>('[data-rich-highlight="transparent"]')!);
    expect(port.setHighlight).toHaveBeenCalledWith('transparent');
    expect(hilitePreview().style.getPropertyValue('--rich-hilite')).toBe('');
  });

  it("a pick records the color into the picker's recents row", () => {
    const port = createFakePort();
    setEditorPort(port);
    click(colorButton());
    click(colorPanel().querySelector<HTMLElement>('[data-rich-color="blue"]')!);

    click(colorButton());
    const recents = colorPanel().querySelectorAll<HTMLElement>('.rich-swatch-recent');
    // Blue in light mode.
    expect(Array.from(recents).some((swatch) => swatch.dataset.cpValue === '#4285f4')).toBe(true);
  });
});
