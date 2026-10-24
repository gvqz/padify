/**
 * The picker's insert gate across note kinds — the surface-seam
 * discipline, pinned with a REAL TabManager.
 *
 * insertSymbol serves TWO worlds: the html surface (whose host the
 * caret-parking, the port rung and the raw-DOM rung exist for) and every
 * other kind (which speaks — or refuses — through its own surface inside
 * insertTextIntoActiveNote). The regression this guards against is the
 * ladder's old habit of parking a caret on ANOTHER surface's markup and
 * splicing a text node into it: with a drawing's placeholder card open,
 * every symbol insert painted ghost glyphs onto the card (the note's
 * bytes stayed safe — its capture answers null — but the display lied
 * until the next repaint, and the symbol was recorded in recents as if
 * it had landed). The gate answers the active note's kind first; a kind
 * whose surface cannot take text is refused with a toast, cleanly.
 *
 * A real TabManager (the same boot the rich-toolbar characterization
 * suite uses) drives the kinds: the welcome note for the html path, a
 * drawing note for the refusal path. The port is a stub so the html
 * rung's call is observable without a live editor engine.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { $ } from '../lib/q';
import { initUnicodePicker } from './picker';
import { UNICODE_SYMBOLS } from './symbols-data';
import { setEditorPort, type EditorPort } from '../editor/port';
import { setTabManager, TabManager } from '../tabs';
import { resetStorageForTests, stateGet, storageReady } from '../storage';
import type { NotepadUI } from '../selector';
// Importing the surface registers its type-keyed claim — the same import
// app.ts performs at boot.
import '../editor/drawing/surface';

// jsdom specifics: the picker constructs a ResizeObserver at bind time
// (no-op polyfill), and the manager's projections read innerText /
// scrollIntoView (polyfilled to their textContent / no-op twins).
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
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

/** The full fake-port contract the picker ladder may consult. */
function fakePort(): EditorPort {
  const emptyAnswer = () => false;
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
    insertHtml: emptyAnswer,
    applyFormat: emptyAnswer,
    queryFormat: emptyAnswer,
    applyBlockFormat: emptyAnswer,
    queryBlockFormat: () => null,
    toggleList: emptyAnswer,
    queryListKind: () => null,
    insertLink: emptyAnswer,
    insertLinkAsText: emptyAnswer,
    removeLink: emptyAnswer,
    queryLinkHref: () => null,
    retargetLink: emptyAnswer,
    insertMath: emptyAnswer,
    queryMathAtCaret: () => null,
    updateMath: emptyAnswer,
    undo: emptyAnswer,
    redo: emptyAnswer,
    canUndo: () => false,
    canRedo: () => false,
    setFontSize: emptyAnswer,
    setFontFamily: emptyAnswer,
    setTextColor: emptyAnswer,
    queryTextColor: () => null,
    setHighlight: emptyAnswer,
    applyScript: emptyAnswer,
    queryScript: emptyAnswer,
    applyAlignment: emptyAnswer,
    queryAlignment: () => null,
    indent: emptyAnswer,
    outdent: emptyAnswer,
    insertHorizontalRule: emptyAnswer,
    insertTable: emptyAnswer,
    queryTableContext: () => null,
    moveTableCellFocus: emptyAnswer,
    runTableAction: emptyAnswer,
    onInput: () => () => {},
  };
}

let picker: ReturnType<typeof initUnicodePicker>;
let port: EditorPort;
let manager: TabManager;
let standardTabId: string;
let drawingTabId: string;

beforeAll(async () => {
  // The REAL editor shell — the same markup the vite include plugin
  // expands into index.html, so the TabManager boots against every id it
  // expects. #toast lives in topbar.html; mounted by hand (showToast
  // writes into it).
  const shell = readFileSync(resolve(process.cwd(), 'src/ui/editor-shell.html'), 'utf-8');
  document.body.insertAdjacentHTML('afterbegin', shell);
  if (!document.getElementById('toast')) {
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }

  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Mounts the picker modal's skeleton, mirroring the real markup ids. */
function mountPickerDom(): void {
  const existing = document.getElementById('unicodePickerModal');
  if (existing) {
    existing.remove();
  }
  document.body.insertAdjacentHTML(
    'beforeend',
    `
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
  `,
  );
}

beforeEach(async () => {
  mountPickerDom();
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

  port = fakePort();
  setEditorPort(port);

  manager = new TabManager($('#note'));
  await manager.init();
  setTabManager(manager);
  standardTabId = manager.getActive()!.id;

  picker = initUnicodePicker({ note: $('#note') } as unknown as NotepadUI);
  picker.open();
  // The dataset load rides a promise (lazy import of symbols-data).
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
});

describe('insertSymbol across note kinds — the surface seam', () => {
  it('a drawing note refuses the insert: toast, no ghost glyph, no recents entry', () => {
    manager.addTab(false, 'drawing');
    drawingTabId = manager.getActive()!.id;
    expect(drawingTabId).not.toBe(standardTabId);

    // The scaffold's placeholder card is the paint.
    const card = document.querySelector('#note .unsupported-note');
    expect(card).not.toBeNull();
    const cardTextBefore = (card as HTMLElement).textContent ?? '';

    const target = UNICODE_SYMBOLS[5]!;
    picker.insertSymbol(target);

    // The refusal is explained, the card is untouched (no ghost glyph
    // spliced into a display the note never owned)...
    expect(document.getElementById('toast')!.textContent).toBe(
      "Symbols can't be typed into this note.",
    );
    expect((card as HTMLElement).textContent).toBe(cardTextBefore);
    expect(document.getElementById('note')!.textContent).not.toContain(target.char);
    // ...and the symbol is NOT recorded as a recent insertion.
    expect(stateGet('recentUnicodeSymbols')).toBeNull();

    // The html ladder never ran for the drawing's host.
    expect(port.insertText).not.toHaveBeenCalled();
  });

  it('an html note keeps the ladder: the port takes the symbol and recents record it', () => {
    const target = UNICODE_SYMBOLS[7]!;

    picker.insertSymbol(target);

    expect(port.insertText).toHaveBeenCalledWith(target.char);
    expect(stateGet('recentUnicodeSymbols')).toBe(JSON.stringify([target.char]));
  });

  it('switching back to the html note restores the ladder after a refusal', () => {
    manager.addTab(false, 'drawing');
    const refused = UNICODE_SYMBOLS[3]!;
    picker.insertSymbol(refused);
    expect(port.insertText).not.toHaveBeenCalled();

    manager.switchTo(standardTabId);
    const accepted = UNICODE_SYMBOLS[9]!;
    picker.insertSymbol(accepted);

    expect(port.insertText).toHaveBeenCalledWith(accepted.char);
    expect(stateGet('recentUnicodeSymbols')).toBe(JSON.stringify([accepted.char]));
  });
});
