/**
 * Characterization suite for the editor's right-click menu
 * (src/context-menu.ts) plus the two note-level actions that live with its
 * wiring (copyNotesToClipboard, deleteNotes).
 *
 * What this pins, and why it matters:
 *  - the menu speaks the ACTIVE NOTE's vocabulary: the rich-only rows
 *    (format row, clear formatting, insert link/equation, remove link) exist
 *    on rich notes alone — the same split e2e/context-menu.spec.ts drives,
 *    pinned here at the unit level through a real TabManager;
 *  - selection-driven enablement: cut/copy/delete/clear-formatting are dead
 *    without a selection, and a selection that lives OUTSIDE the editor
 *    counts as no selection;
 *  - every mutation routes through the EditorPort seam (applyFormat,
 *    insertText, undo/redo, removeLink, runTableAction) — the contract that
 *    lets the document-model editor swap in under this menu unchanged;
 *    the bare-DOM fallback (no port installed) is pinned for the case
 *    conversion flow, which is the pre-port code path tests exercise;
 *  - the clipboard flows go execCommand-first with the async Clipboard API
 *    as fallback (jsdom has neither execCommand nor navigator.clipboard, so
 *    both are characterized through the fallback: clipboard mocked);
 *  - deleteNotes snapshots best-effort, then clears THE ACTIVE TAB through
 *    the TabManager — never anything else.
 *
 * Deliberately left to e2e (docs-toolbar.spec.ts / context-menu.spec.ts):
 * real caret/pressed-state rendering inside a browser selection, the
 * submenu hover-timing (120ms open / 200ms close), and the reopen-gesture
 * suppression after undo.
 *
 * Everything here was written against the behaviour of the live app at the
 * commit this file landed. If a test fails after an intentional behavior
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SweetAlertResult } from 'sweetalert2';
import { $ } from './lib/q';
import { copyNotesToClipboard, deleteNotes, initContextMenu } from './context-menu';
import { setTabManager, TabManager } from './tabs';
import {
  setEditorPort,
  type Alignment,
  type BlockFormat,
  type EditorPort,
  type ListKind,
  type TableCellContext,
} from './editor/port';
import { resetStorageForTests, storageReady } from './storage';

// Swal is modal UI — mocked so confirm flows can be driven. isVisible keeps
// its false answer for the guards that read it.
vi.mock('sweetalert2', () => ({
  default: {
    fire: vi.fn(() => Promise.resolve({ isConfirmed: false } as SweetAlertResult)),
    isVisible: vi.fn(() => false),
    getInput: vi.fn(() => null),
  },
}));

import Swal from 'sweetalert2';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// jsdom does not implement innerText (it depends on CSS rendering). The
// TabManager's text projection reads it; textContent agrees on every string
// these tests use.
beforeAll(() => {
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
});

// jsdom has no navigator.clipboard (and no permissions model). The context
// menu's fallback path calls it — mocked per test so resolutions and
// rejections are both drivable.
let clipboardWriteText: Mock<(text: string) => Promise<void>>;
let clipboardReadText: Mock<() => Promise<string>>;

/**
 * The editor shell the menu needs: the contenteditable note, the tab strip
 * (for the real-TabManager tests) and the toast. #padifyCtxMenu — appended
 * to <body> by initContextMenu() once — is preserved across mounts: its
 * listeners live on the menu element, while re-running initContextMenu would
 * stack a second set of document-level capture listeners and double-fire
 * every gesture.
 */
function mountShell(): void {
  Array.from(document.body.children).forEach((child) => {
    if (child.id !== 'padifyCtxMenu') child.remove();
  });
  document.body.insertAdjacentHTML(
    'afterbegin',
    `
    <div id="tabStripTabs"></div>
    <div id="addTab"></div>
    <div id="tabRailCount"></div>
    <div id="note" contenteditable="true"></div>
    <div id="outside"><span>text outside the editor</span></div>
    <div id="toast"></div>
  `,
  );
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

/** A storage boot from truly nothing — kv mirror AND localStorage wiped. */
async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

let menuInitialized = false;

/** Mounts the menu markup + wires the document-level handlers exactly once. */
function ensureContextMenuMounted(): void {
  if (!menuInitialized) {
    initContextMenu();
    menuInitialized = true;
  }
}

/** A full EditorPort stub — the swap-in contract the menu must speak. */
function createFakePort(): EditorPort {
  return {
    getHtml: vi.fn(() => ''),
    setHtml: vi.fn(),
    setInert: vi.fn(),
    renderHtml: vi.fn(),
    getText: vi.fn(() => ''),
    isEmpty: vi.fn(() => true),
    normalizeEmptySurface: vi.fn(() => false),
    focus: vi.fn(),
    isCaretInside: vi.fn(() => true),
    ensureCaretInside: vi.fn(() => true),
    charBeforeCaret: vi.fn(() => ''),
    insertText: vi.fn(() => true),
    insertHtml: vi.fn(() => false),
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
}

/** Boots a real TabManager over the mounted shell and installs it. */
async function bootedManager(): Promise<TabManager> {
  const manager = new TabManager($('#note'));
  await manager.init();
  setTabManager(manager);
  return manager;
}

function menu(): HTMLElement {
  return document.getElementById('padifyCtxMenu')!;
}

function note(): HTMLElement {
  return document.getElementById('note')!;
}

function toastText(): string {
  return document.getElementById('toast')!.textContent ?? '';
}

/** The tone the unified toast stamped (success/error/neutral). */
function toastTone(): string | null {
  return document.getElementById('toast')!.dataset.tone ?? null;
}

/** True when the row (or its group) is not hidden. */
function visible(selector: string): boolean {
  return menu().querySelector(selector)!.closest('[hidden]') === null;
}

/**
 * Right-clicks inside the editor at the given viewport coordinates and
 * returns only once that gesture has GENUINELY opened the menu.
 *
 * Two jsdom realities are absorbed here so tests read like the browser:
 *  - the reopen gesture: restoreFocus() (undo, link hand-offs…) suppresses
 *    the NEXT contextmenu until a requestAnimationFrame clears the flag.
 *    jsdom runs rAF on a timer, so the helper lets it settle first — what a
 *    user's second right-click sees. Under load (CI runners) that timer can
 *    lag past the head start, and the suppression has two failure modes:
 *    with the menu closed, later assertions pass on STALE focus (jsdom
 *    keeps activeElement inside a hidden menu) and fail one keypress
 *    later; with the menu left open by a previous test, every assertion
 *    runs against that test's enablement and port. A fresh open always
 *    recomputes the menu's coordinates — a suppressed gesture returns
 *    before open() and leaves them untouched — so a sentinel on the
 *    position detects the real thing, and the retry re-issues the
 *    right-click until it lands. Exactly one dispatch ever opens the menu
 *    (a double open would collapse the selection twice and re-run
 *    enablement against the collapsed state).
 *  - jsdom's focus() collapses the window selection (browsers keep it).
 *    Callers that exercise selection-reading actions re-select AFTER this
 *    opens (the menu's own enablement is computed before the focus lands).
 */
async function openMenuAt(x = 300, y = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const rightClick = () =>
    note().dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  // open() always assigns a real left/top; the sentinel survives only a
  // suppressed gesture. waitFor retries every 50 ms, re-right-clicking
  // until the flag clears and the menu genuinely (re)opens.
  await vi.waitFor(() => {
    menu().style.left = '-9999px';
    rightClick();
    expect(menu().style.left).not.toBe('-9999px');
  });
}

function clickItem(selector: string): void {
  menu()
    .querySelector(selector)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Selects [start, end) inside the note's first text node. */
function selectInNote(start: number, end: number): void {
  const walker = document.createTreeWalker(note(), NodeFilter.SHOW_TEXT);
  const node = walker.nextNode() as Text;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Rich-note environment with a fresh fake port installed: boots a manager,
 * switches to a new rich note, paints text into the editor. Tests select
 * and open the menu themselves (the menu reads the selection at open).
 */
async function richNoteSetup(): Promise<EditorPort> {
  ensureContextMenuMounted();
  const manager = await bootedManager();
  manager.addTab(false, 'rich');
  const port = createFakePort();
  setEditorPort(port);
  note().textContent = 'hello world';
  return port;
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clipboardWriteText = vi.fn((_text: string) => Promise.resolve());
  clipboardReadText = vi.fn(() => Promise.resolve(''));
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText, readText: clipboardReadText },
    configurable: true,
  });
  vi.mocked(Swal.fire).mockClear();
  mountShell();
  window.getSelection()?.removeAllRanges();
  await freshBoot();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Construction — the plain-note vocabulary
// ---------------------------------------------------------------------------

describe('menu construction (plain note)', () => {
  it('right-click inside the editor opens the menu and suppresses the native one', () => {
    ensureContextMenuMounted();

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
    });
    note().dispatchEvent(event);

    expect(menu().hidden).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    // In a layout-less environment the menu falls back to its assumed
    // 232×386 box and docks 2px off the cursor.
    expect(menu().style.left).toBe('302px');
    expect(menu().style.top).toBe('202px');
  });

  it('the assumed box flips above/left of the cursor near the viewport edges', async () => {
    ensureContextMenuMounted();

    await openMenuAt(1000, 700);

    expect(menu().style.left).toBe('766px'); // 1000 - 232 - 2
    expect(menu().style.top).toBe('312px'); // 700 - 386 - 2
  });

  it('a plain note shows the classic vocabulary — the format row included', async () => {
    ensureContextMenuMounted();
    await openMenuAt();

    // What a plain note can honestly do. The B/I/U/S row is back: the
    // classic note is the same contenteditable surface the rich note is,
    // so the EditorPort answers its formats the same way. Clear
    // formatting is a plain port command too.
    expect(visible('[data-action="undo"]')).toBe(true);
    expect(visible('[data-action="redo"]')).toBe(true);
    expect(visible('[data-action="cut"]')).toBe(true);
    expect(visible('[data-action="copy"]')).toBe(true);
    expect(visible('[data-action="paste"]')).toBe(true);
    expect(visible('[data-action="delete"]')).toBe(true);
    expect(visible('[data-action="select-all"]')).toBe(true);
    expect(visible('.padify-ctx-parent')).toBe(true); // case converter
    expect(visible('.padify-ctx-formats.padify-ctx-rich')).toBe(true);
    expect(visible('.padify-ctx-fmt[data-format="bold"]')).toBe(true);
    expect(visible('.padify-ctx-fmt[data-format="underline"]')).toBe(true);
    expect(visible('[data-action="clear-formatting"]')).toBe(true);
    expect(visible('.padify-ctx-sep.padify-ctx-rich')).toBe(true);
    // The toolbar-bubble rows stay with the kinds that own the bubbles:
    // no Docs toolbar on a plain note, no equation/link popover to open.
    expect(visible('.padify-ctx-formats.padify-ctx-md')).toBe(false);
    expect(visible('[data-action="insert-link"]')).toBe(false);
    expect(visible('[data-action="insert-equation"]')).toBe(false);
    expect(visible('[data-action="remove-link"]')).toBe(false);
    // Table ops follow the caret's context — none without one.
    expect(visible('[data-action="table-op"]')).toBe(false);
  });

  it('the submenu carries the 12 case conversions; the probe exposes both lists', async () => {
    ensureContextMenuMounted();

    const submenu = menu().querySelector('.padify-ctx-submenu') as HTMLElement;
    const caseIds = Array.from(submenu.querySelectorAll('[data-case]')).map(
      (item) => (item as HTMLElement).dataset.case,
    );
    expect(caseIds).toHaveLength(12);
    expect(caseIds.slice(0, 2)).toEqual(['upper', 'lower']);

    // The E2E debug probe — the same lists the menu was built from.
    const probe = (
      window as unknown as { __padifyContextMenu?: { cases: string[]; formats: string[] } }
    ).__padifyContextMenu;
    expect(probe?.cases).toEqual(caseIds);
    expect(probe?.formats).toEqual(['bold', 'italic', 'underline', 'strike']);
  });

  it('right-click outside the editor never opens ours — and closes an open one', async () => {
    ensureContextMenuMounted();
    await openMenuAt();
    expect(menu().hidden).toBe(false);

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    document.getElementById('outside')!.dispatchEvent(event);

    expect(menu().hidden).toBe(true);
    // The native menu is NOT suppressed outside the editor.
    expect(event.defaultPrevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selection-driven enablement
// ---------------------------------------------------------------------------

describe('selection enablement', () => {
  it('without a selection, cut/copy/delete/clear-formatting are disabled', async () => {
    ensureContextMenuMounted();
    await openMenuAt();

    for (const action of ['cut', 'copy', 'delete', 'clear-formatting']) {
      const item = menu().querySelector<HTMLButtonElement>(
        `.padify-ctx-item[data-action="${action}"]`,
      )!;
      expect(item.disabled, action).toBe(true);
      expect(item.getAttribute('aria-disabled'), action).toBe('true');
    }
  });

  it('a selection inside the editor enables them', async () => {
    ensureContextMenuMounted();
    note().textContent = 'hello world';
    selectInNote(6, 11);

    await openMenuAt();

    for (const action of ['cut', 'copy', 'delete', 'clear-formatting']) {
      const item = menu().querySelector<HTMLButtonElement>(
        `.padify-ctx-item[data-action="${action}"]`,
      )!;
      expect(item.disabled, action).toBe(false);
      expect(item.getAttribute('aria-disabled'), action).toBe('false');
    }
  });

  it('a selection that lives outside the editor counts as no selection', async () => {
    ensureContextMenuMounted();
    const outside = document.getElementById('outside')!;
    const walker = document.createTreeWalker(outside, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode() as Text;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    await openMenuAt();

    const copy = menu().querySelector<HTMLButtonElement>('[data-action="copy"]')!;
    expect(copy.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The note-type vocabulary — rich vs plain through a real TabManager
// ---------------------------------------------------------------------------

describe('menu follows the note type', () => {
  it('a rich note keeps the full menu, equations included', async () => {
    ensureContextMenuMounted();
    const manager = await bootedManager();
    manager.addTab(false, 'rich');

    await openMenuAt();

    expect(visible('.padify-ctx-formats')).toBe(true);
    expect(visible('[data-action="clear-formatting"]')).toBe(true);
    expect(visible('[data-action="insert-equation"]')).toBe(true);
    expect(visible('[data-action="insert-link"]')).toBe(true);
    expect(visible('.padify-ctx-sep.padify-ctx-rich')).toBe(true);
    expect(visible('[data-action="select-all"]')).toBe(true);
  });

  it('switching back to the plain note keeps the format row, drops the bubble rows', async () => {
    ensureContextMenuMounted();
    const manager = await bootedManager();
    const plainId = manager.getActive()!.id;
    manager.addTab(false, 'rich');

    manager.switchTo(plainId, false);
    await openMenuAt();

    expect(visible('[data-action="insert-equation"]')).toBe(false);
    expect(visible('[data-action="insert-link"]')).toBe(false);
    expect(visible('.padify-ctx-fmt[data-format="bold"]')).toBe(true);
    expect(visible('[data-action="select-all"]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case conversion — the bare-DOM path (runs before any port is installed)
// ---------------------------------------------------------------------------

describe('case conversion (bare-DOM fallback)', () => {
  // The DOM fallback writes over the LIVE selection range; in a browser,
  // focusing the editor first leaves that range intact, but jsdom's
  // focus() COLLAPSES it — an environment deviation, not app behavior.
  // Neutralizing focus here is what lets the real path (deleteContents +
  // insertNode over the live range) run exactly as it does in the app.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
  });

  it('converts the selection, routes it through the DOM, and re-selects the result', async () => {
    ensureContextMenuMounted();
    note().textContent = 'hello world';
    selectInNote(0, 5);

    await openMenuAt();
    // Open the flyout, then pick UPPERCASE.
    clickItem('.padify-ctx-trigger');
    clickItem('[data-case="upper"]');

    expect(note().textContent).toBe('HELLO world');
    // The converted text stays selected — another case can be applied
    // immediately (the absolute-offset restore).
    expect(window.getSelection()!.toString()).toBe('HELLO');
    expect(toastText()).toBe('Converted to UPPERCASE.');
    expect(menu().hidden).toBe(true);
  });

  it('a conversion that changes nothing closes quietly — no toast, no edit', async () => {
    ensureContextMenuMounted();
    note().textContent = 'HELLO'; // already uppercase
    selectInNote(0, 5);

    await openMenuAt();
    clickItem('.padify-ctx-trigger');
    clickItem('[data-case="upper"]');

    expect(note().textContent).toBe('HELLO');
    expect(toastText()).toBe('');
    expect(menu().hidden).toBe(true);
  });

  it('no selection at all → the "select some text" toast', async () => {
    ensureContextMenuMounted();
    await openMenuAt();

    clickItem('.padify-ctx-trigger');
    clickItem('[data-case="upper"]');

    expect(toastText()).toBe('Select some text first, then convert its case.');
    expect(menu().hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mutations route through the EditorPort
// ---------------------------------------------------------------------------

describe('actions through the EditorPort', () => {
  it('Bold runs port.applyFormat and toasts the resulting state', async () => {
    const port = await richNoteSetup();
    vi.mocked(port.queryFormat).mockReturnValue(true);
    selectInNote(0, 5);
    await openMenuAt();
    selectInNote(0, 5); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('.padify-ctx-fmt[data-format="bold"]');

    expect(vi.mocked(port.applyFormat)).toHaveBeenCalledWith('bold');
    expect(toastText()).toBe('Bold on.');
    expect(menu().hidden).toBe(true);
  });

  it('un-formatting toasts "off"', async () => {
    const port = await richNoteSetup();
    vi.mocked(port.queryFormat).mockReturnValue(false);
    selectInNote(0, 5);
    await openMenuAt();
    selectInNote(0, 5); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('.padify-ctx-fmt[data-format="strike"]');

    expect(vi.mocked(port.applyFormat)).toHaveBeenCalledWith('strikeThrough');
    expect(toastText()).toBe('Strikethrough off.');
  });

  it('undo and redo run port.undo / port.redo and refocus the editor', async () => {
    const port = await richNoteSetup();
    selectInNote(0, 5);
    await openMenuAt();

    clickItem('[data-action="undo"]');
    expect(vi.mocked(port.undo)).toHaveBeenCalledTimes(1);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(note());

    await openMenuAt();
    clickItem('[data-action="redo"]');
    expect(vi.mocked(port.redo)).toHaveBeenCalledTimes(1);
  });

  it('delete replaces the selection through port.insertText("")', async () => {
    const port = await richNoteSetup();
    selectInNote(0, 5);
    await openMenuAt();
    selectInNote(0, 5); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="delete"]');

    expect(vi.mocked(port.insertText)).toHaveBeenCalledWith('');
    // Delete closes the menu like every other action — it used to leave
    // it hanging open over the text it had just removed.
    expect(menu().hidden).toBe(true);
  });

  it('select-all selects the whole editor contents', async () => {
    await richNoteSetup();
    selectInNote(0, 5);
    await openMenuAt();

    clickItem('[data-action="select-all"]');

    expect(window.getSelection()!.toString()).toBe('hello world');
    expect(menu().hidden).toBe(true);
  });

  it('insert link / insert equation hand over through document events', async () => {
    await richNoteSetup();
    selectInNote(0, 5);
    await openMenuAt();
    const openLink = vi.fn();
    const openEquation = vi.fn();
    document.addEventListener('padify:open-link', openLink);
    document.addEventListener('padify:open-equation', openEquation);

    clickItem('[data-action="insert-link"]');
    clickItem('[data-action="insert-equation"]');

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openEquation).toHaveBeenCalledTimes(1);
    document.removeEventListener('padify:open-link', openLink);
    document.removeEventListener('padify:open-equation', openEquation);
  });

  it('remove-link appears on a link (and insert-link flips away)', async () => {
    const port = await richNoteSetup();
    vi.mocked(port.queryLinkHref).mockReturnValue('https://padify.example');
    selectInNote(0, 5);
    await openMenuAt();

    expect(menu().querySelector<HTMLElement>('[data-action="remove-link"]')!.hidden).toBe(false);
    expect(menu().querySelector<HTMLElement>('[data-action="insert-link"]')!.hidden).toBe(true);

    clickItem('[data-action="remove-link"]');

    expect(vi.mocked(port.removeLink)).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Link removed.');
  });

  it('table operations appear in a table and run port.runTableAction', async () => {
    const port = await richNoteSetup();
    vi.mocked(port.queryTableContext).mockReturnValue({
      rows: 2,
      cols: 2,
      rowIndex: 0,
      colIndex: 1,
    });
    selectInNote(0, 5);
    await openMenuAt();

    expect(menu().querySelector<HTMLElement>('[data-op="row-above"]')!.hidden).toBe(false);
    expect(menu().querySelector<HTMLElement>('[data-op="table-delete"]')!.hidden).toBe(false);

    clickItem('[data-op="row-above"]');
    expect(vi.mocked(port.runTableAction)).toHaveBeenCalledWith('row-above');
  });

  it('format buttons reflect the port-reported state at open time', async () => {
    const port = await richNoteSetup();
    vi.mocked(port.queryFormat).mockImplementation((command) => command === 'bold');
    selectInNote(0, 5);
    await openMenuAt();

    expect(
      menu().querySelector('.padify-ctx-fmt[data-format="bold"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      menu().querySelector('.padify-ctx-fmt[data-format="italic"]')!.getAttribute('aria-checked'),
    ).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Clipboard flows
// ---------------------------------------------------------------------------

describe('clipboard flows', () => {
  it('copy falls back to the async Clipboard API and confirms', async () => {
    await richNoteSetup();
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="copy"]');

    // execCommand('copy') is unavailable in jsdom — the async API carried it.
    expect(clipboardWriteText).toHaveBeenCalledWith('world');
    await vi.waitFor(() => expect(toastText()).toBe('Copied to clipboard.'));
    expect(menu().hidden).toBe(true);
  });

  it('a blocked copy tells the user to use the keyboard shortcut', async () => {
    await richNoteSetup();
    clipboardWriteText.mockRejectedValueOnce(new Error('denied'));
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="copy"]');

    await vi.waitFor(() => expect(toastText()).toBe('Copy blocked — press Ctrl + C.'));
  });

  it('paste reads the clipboard and inserts through the port', async () => {
    const port = await richNoteSetup();
    clipboardReadText.mockResolvedValueOnce('pasted words');
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="paste"]');

    await vi.waitFor(() => expect(vi.mocked(port.insertText)).toHaveBeenCalledWith('pasted words'));
  });

  it('an empty clipboard toasts instead of inserting', async () => {
    const port = await richNoteSetup();
    clipboardReadText.mockResolvedValueOnce('');
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="paste"]');

    await vi.waitFor(() => expect(toastText()).toBe('Clipboard is empty.'));
    expect(vi.mocked(port.insertText)).not.toHaveBeenCalled();
  });

  it('a blocked paste points at the platform paste key', async () => {
    await richNoteSetup();
    clipboardReadText.mockRejectedValueOnce(new Error('denied'));
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="paste"]');

    await vi.waitFor(() =>
      expect(toastText()).toBe('Clipboard blocked by the browser — press Ctrl + V instead.'),
    );
  });

  it('cut deletes the selection and mirrors it to the clipboard in the background', async () => {
    const port = await richNoteSetup();
    selectInNote(6, 11);
    await openMenuAt();
    selectInNote(6, 11); // jsdom collapsed it on menu focus — browsers keep it

    clickItem('[data-action="cut"]');

    // The deletion never blocks on the async clipboard (jsdom has no
    // execCommand copy, so the fallback write fires in the background).
    expect(clipboardWriteText).toHaveBeenCalledWith('world');
    expect(vi.mocked(port.insertText)).toHaveBeenCalledWith('');
    // Cut closes the menu like every other action — it used to leave it
    // hanging open after the deletion.
    expect(menu().hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The note-level exports — copyNotesToClipboard / deleteNotes
// ---------------------------------------------------------------------------

describe('copyNotesToClipboard / deleteNotes', () => {
  /**
   * A manager whose port mirrors the live DOM — the capture path reads the
   * editor element, like the real engine does.
   */
  async function bootedManagerWithDomPort(): Promise<TabManager> {
    const manager = await bootedManager();
    const port = createFakePort();
    vi.mocked(port.getHtml).mockImplementation(() => note().innerHTML);
    setEditorPort(port);
    return manager;
  }

  it('copyNotesToClipboard writes the text and fires the success toast', async () => {
    ensureContextMenuMounted();

    copyNotesToClipboard('the whole note');

    expect(clipboardWriteText).toHaveBeenCalledWith('the whole note');
    await vi.waitFor(() => expect(toastText()).toBe('Notes copied to clipboard.'));
    expect(toastTone()).toBe('success');
  });

  it('copyNotesToClipboard failure fires the permissions toast', async () => {
    ensureContextMenuMounted();
    clipboardWriteText.mockRejectedValueOnce(new Error('denied'));

    copyNotesToClipboard('the whole note');

    await vi.waitFor(() =>
      expect(toastText()).toBe('Fail to copy. Check permissions for clipboard.'),
    );
    expect(toastTone()).toBe('error');
  });

  it('deleteNotes (confirmed) clears the active tab through the TabManager', async () => {
    ensureContextMenuMounted();
    const manager = await bootedManagerWithDomPort();
    const id = manager.getActive()!.id;
    note().innerHTML = '<b>precious words</b>';
    manager.saveActiveFromEditor();
    expect(manager.getActive()!.content).not.toBe('');

    vi.mocked(Swal.fire).mockResolvedValueOnce({ value: true } as SweetAlertResult);
    deleteNotes();

    // snapshotsManager is absent in jsdom — the delete proceeds anyway.
    await vi.waitFor(() => expect(vi.mocked(Swal.fire)).toHaveBeenCalledTimes(2));
    expect(manager.getActive()!.id).toBe(id); // the SAME tab, emptied — not removed
    expect(manager.getActive()!.content).toBe('');
    expect(note().innerHTML).toBe('');
    expect(manager.exportForSync().dirty).toContain(id);
    expect(vi.mocked(Swal.fire).mock.calls[1]![0]).toBe('Deleted!');
  });

  it('deleteNotes (refused) touches nothing', async () => {
    ensureContextMenuMounted();
    const manager = await bootedManagerWithDomPort();
    note().innerHTML = '<b>precious words</b>';
    manager.saveActiveFromEditor();

    vi.mocked(Swal.fire).mockResolvedValueOnce({ isConfirmed: false } as SweetAlertResult);
    deleteNotes();

    await Promise.resolve();
    expect(vi.mocked(Swal.fire)).toHaveBeenCalledTimes(1);
    expect(manager.getActive()!.content).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation — the visible-only contract
// ---------------------------------------------------------------------------

describe('keyboard navigation', () => {
  it('opening focuses the first visible row; arrows walk visible rows only', async () => {
    ensureContextMenuMounted();
    await bootedManager(); // a standard note: the plain vocabulary

    await openMenuAt();
    expect(document.activeElement?.getAttribute('data-action')).toBe('undo');

    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-action')).toBe('redo');

    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const active = document.activeElement as HTMLElement;
    // Never a hidden group's child (the format row is hidden on plain notes).
    expect(active.closest('[hidden]')).toBeNull();
  });

  it('Escape closes the menu and returns focus to the editor', async () => {
    ensureContextMenuMounted();
    await bootedManager();
    await openMenuAt();

    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(note());
  });

  it('a pointer press elsewhere in the document closes the menu', async () => {
    ensureContextMenuMounted();
    await bootedManager();
    await openMenuAt();

    // The dismissable-layer registry listens on capture-phase pointerdown
    // (earlier than any click handler, immune to stopPropagation) — a press
    // outside the menu is the gesture that closes it.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(menu().hidden).toBe(true);
  });
});
