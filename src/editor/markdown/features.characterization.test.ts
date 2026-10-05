/**
 * The Markdown surface's FEATURE characterization — everything the note
 * type's second act added on top of the v1 surface (see
 * surface.characterization.test.ts for the base contract):
 *
 *  • live math: $…$ / $$…$$ parse into math nodes, render through the
 *    app's ONE KaTeX pipeline (gate and error display included), click
 *    to edit, and serialize back to the exact source syntax;
 *  • task lists: the GFM checkbox column — click to toggle, the Docs
 *    grammar on the toolbar button, markdown round-trip;
 *  • images: a chip, never an <img> (the owned renderer's policy);
 *  • the equation bubble: symbol palette + live preview + Insert
 *    (inline/block) + Apply over a selected node;
 *  • table operations, clear formatting, the link chip;
 *  • the clipboard: copy answers the markdown SOURCE;
 *  • the slash menu: "/" → filter → Enter inserts the block;
 *  • Tab/Shift-Tab list indentation;
 *  • voice typing and the context menu's markdown layer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { $ } from '../../lib/q';
import { TabManager, getTabManager, insertTextIntoActiveNote, setTabManager } from '../../tabs';
import { resetStorageForTests, storageReady } from '../../storage';
import { markdownEditorHandle } from './surface';
import { noteSurfaceForKind } from '../surface';
import {
  initMarkdownToolbar,
  openMarkdownEquationBubble,
  resetMarkdownToolbarForTests,
  runMarkdownBlockStyle,
  runMarkdownTableAction,
  runMarkdownToolbarAction,
} from './toolbar';
import {
  initMarkdownSlash,
  markdownSlashPanel,
  notifyMarkdownSlashInput,
  resetMarkdownSlashForTests,
} from './slash';
import { MD_MATH_CLICK_EVENT } from './nodes';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { getMarkdownFileName } from '../../exports';
import { initVoiceTyping, stopVoiceTyping, toggleVoiceTyping } from '../../voice';
import { initContextMenu } from '../../context-menu';

// Swal is modal UI — mocked so close-with-content paths can be driven.
vi.mock('sweetalert2', () => ({
  default: { fire: vi.fn(() => Promise.resolve({ isConfirmed: false })) },
}));

// jsdom lacks scrollIntoView (rendering-dependent); TabManager calls it
// best-effort after addTab.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  });
}

// jsdom's Range lacks geometry — PM's scrollToSelection measures it when a
// dispatched transaction moves the selection.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

const surface = noteSurfaceForKind('text');

/** The editor's ready promise (mount is async) — awaited per test. */
async function ready(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!markdownEditorHandle() && Date.now() < deadline) {
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
  }
  expect(markdownEditorHandle()).not.toBeNull();
}

/** Lets the listener plugin's 200ms debounce run to completion. */
async function settled(ms = 300): Promise<void> {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms));
}

/**
 * Boots the editor shell + a markdown note + the markdown chrome (toolbar,
 * slash menu). Each test gets a fresh store; the shell accumulates (ids are
 * resolved to the FIRST occurrence, which stays the live one).
 */
async function bootMarkdown(content = ''): Promise<HTMLElement> {
  resetStorageForTests();
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  localStorage.clear();
  await storageReady();
  if (!document.getElementById('markdownToolbar')) {
    const shell = readFileSync(resolve(process.cwd(), 'src/ui/editor-shell.html'), 'utf-8');
    document.body.insertAdjacentHTML('afterbegin', shell);
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.append(toast);
  }
  const host = document.getElementById('note') as HTMLElement;
  if (!getTabManager()) {
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();
  }
  // A fresh toolbar wiring needs fresh buttons: the previous boot's
  // listeners still ride the same DOM (reset clears module state only).
  // cloneNode keeps ids/markup and drops every listener.
  const oldToolbar = document.getElementById('markdownToolbar');
  if (oldToolbar) {
    oldToolbar.replaceWith(oldToolbar.cloneNode(true));
  }
  resetMarkdownToolbarForTests();
  initMarkdownToolbar(getTabManager()!);
  resetMarkdownSlashForTests();
  initMarkdownSlash({
    runToolbarAction: runMarkdownToolbarAction,
    runBlockStyle: runMarkdownBlockStyle,
    openEquation: openMarkdownEquationBubble,
  });
  getTabManager()!.addTab(true, 'markdown');
  await ready();
  await settled();
  surface.display(host, { content });
  await settled(120);
  return host;
}

/** Types one character the way ProseMirror's input pipeline does. */
function inputChar(
  view: NonNullable<ReturnType<typeof markdownEditorHandle>>['view'],
  char: string,
): void {
  const from = view.state.selection.from;
  view.someProp('handleTextInput', (handler) =>
    handler(view, from, from, char, () => view.state.tr.insertText(char, from, from)),
  );
}

// ---------------------------------------------------------------------------
// Live math
// ---------------------------------------------------------------------------

describe('the markdown surface — live math', () => {
  it('parses $…$ and $$…$$ into math nodes and round-trips the exact source', async () => {
    const host = await bootMarkdown(
      ['Inline $x^2$ math', '', '$$', 'e^{i\\pi} + 1 = 0', '$$'].join('\n'),
    );
    const handle = markdownEditorHandle()!;

    let mathInline = 0;
    let mathBlock = 0;
    handle.view.state.doc.descendants((node) => {
      if (node.type.name === 'math_inline') mathInline += 1;
      if (node.type.name === 'math_block') mathBlock += 1;
      return true;
    });
    expect(mathInline).toBe(1);
    expect(mathBlock).toBe(1);

    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('$x^2$');
    expect(captured).toContain('$$');
    expect(captured).toContain('e^{i\\pi} + 1 = 0');
  });

  it('renders equations through the app KaTeX pipeline — the preview is the same truth', async () => {
    await bootMarkdown('Inline $x^2$ math\n\n$$\n\\frac{1}{2}\n$$');
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;

    // Both nodes rendered through math.ts: padify-math shells with KaTeX output.
    const shells = dom.querySelectorAll('.padify-math');
    expect(shells.length).toBe(2);
    expect(dom.querySelectorAll('.padify-math .katex').length).toBe(2);
    expect(dom.querySelector('.md-math-inline .padify-math')?.getAttribute('data-latex')).toBe(
      'x^2',
    );
    expect(dom.querySelector('.md-math-block .padify-math')?.getAttribute('data-latex')).toBe(
      '\\frac{1}{2}',
    );
  });

  it('forbidden macros render as source, never as live markup', async () => {
    await bootMarkdown('$\\href{javascript:alert(1)}{click}$');
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;
    // The gate refuses the render — the source shows instead, and no
    // anchor ever exists inside the math node view.
    const shell = dom.querySelector('.md-math-inline .padify-math') as HTMLElement;
    expect(shell.textContent).toContain('\\href');
    expect(shell.querySelector('a')).toBeNull();
  });

  it('typing $x$ triggers the inline math input rule', async () => {
    const host = await bootMarkdown();
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    view.focus();
    view.dispatch(view.state.tr.insertText('cost $5'));
    inputChar(view, '$');
    await settled(120);

    let mathInline = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'math_inline') mathInline += 1;
      return true;
    });
    expect(mathInline).toBe(1);
    expect(surface.capture(host)).toContain('$5$');
  });

  it('a click on a rendered equation reports itself (the bubble opens in edit mode)', async () => {
    await bootMarkdown('$x^2$');
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;
    const inline = dom.querySelector('.md-math-inline') as HTMLElement;

    const clicks: unknown[] = [];
    const listener = (event: Event): void => {
      clicks.push((event as CustomEvent).detail);
    };
    document.addEventListener(MD_MATH_CLICK_EVENT, listener);
    inline.click();
    document.removeEventListener(MD_MATH_CLICK_EVENT, listener);

    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ latex: 'x^2', kind: 'inline' });
  });

  it('a click on a rendered equation opens the bubble AND keeps it open (the same click must not close it)', async () => {
    await bootMarkdown('$x^2$');
    const inline = markdownEditorHandle()!.view.dom.querySelector('.md-math-inline') as HTMLElement;

    // The click opens the bubble, and the same bubbling click reaches the
    // outside-click listener — which must spare the equation (the e2e
    // suite's catch, pinned here). In a real browser PM node-selects the
    // atom on mousedown first, so the bubble is in Apply mode with the
    // LaTeX prefilled; jsdom cannot run PM's pointer hit-testing, so the
    // pin here is the OPEN itself plus the outside-click guard.
    inline.click();

    const popover = document.getElementById('markdownMathPopover') as HTMLElement;
    expect(popover.hidden).toBe(false);
    // In a real browser PM node-selects the atom on mousedown, so the
    // bubble is in Apply mode with the LaTeX prefilled (the e2e pins
    // that); jsdom cannot run PM's pointer hit-testing, so here the pin
    // is the OPEN itself plus the outside-click guard.
    expect(popover.hidden).toBe(false);
  });

  it('an empty display equation paints the affordance', async () => {
    await bootMarkdown('$$\n$$');
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;
    expect(dom.querySelector('.md-math-block.md-math-empty')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task lists
// ---------------------------------------------------------------------------

describe('the markdown surface — task lists', () => {
  it('parses task items with their checked state and round-trips them', async () => {
    const host = await bootMarkdown('- [ ] open task\n- [x] done task');
    const handle = markdownEditorHandle()!;

    let taskItems = 0;
    handle.view.state.doc.descendants((node) => {
      if (node.type.name === 'list_item' && node.attrs.checked != null) taskItems += 1;
      return true;
    });
    expect(taskItems).toBe(2);
    expect(handle.view.dom.querySelectorAll('li[data-item-type="task"]').length).toBe(2);

    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('* [ ] open task');
    expect(captured).toContain('* [x] done task');
  });

  it('clicking the marker zone flips the checked state', async () => {
    const host = await bootMarkdown('* [ ] flip me');
    const handle = markdownEditorHandle()!;
    const { view } = handle;

    let itemPos = 0;
    let itemNode: ProseNode | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'list_item' && !itemNode) {
        itemNode = node;
        itemPos = pos;
      }
      return true;
    });

    const event = new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 });
    const handled = view.someProp('handleClickOn', (prop) =>
      prop(view, itemPos + 1, itemNode as ProseNode, itemPos, event, true),
    );
    expect(handled).toBe(true);
    await settled(120);
    expect(surface.capture(host)).toContain('* [x] flip me');
  });

  it("the toolbar's task button arms, then disarms (the Docs grammar)", async () => {
    const host = await bootMarkdown('plain item');

    expect(runMarkdownToolbarAction('task')).toBe(true);
    await settled(120);
    expect(surface.capture(host)).toContain('* [ ] plain item');

    expect(runMarkdownToolbarAction('task')).toBe(true);
    await settled(120);
    expect(surface.capture(host)).toContain('* plain item');
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('the markdown surface — images are chips, never fetches', () => {
  it('renders the image node as a chip with the alt text; no <img src> ever mounts', async () => {
    const host = await bootMarkdown('![logo](https://example.com/logo.png)');
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;

    expect(dom.querySelectorAll('.md-image-chip').length).toBe(1);
    expect((dom.querySelector('.md-image-chip') as HTMLElement).textContent).toBe('logo');
    expect(dom.querySelectorAll('img[src]').length).toBe(0);
    // The source round-trips untouched.
    expect(surface.capture(host)).toContain('![logo](https://example.com/logo.png)');
  });

  it('image markdown without an alt or title parses cleanly (the hardened schema)', async () => {
    const host = await bootMarkdown('![](https://example.com/plain.png)');
    const handle = markdownEditorHandle()!;
    let images = 0;
    handle.view.state.doc.descendants((node) => {
      if (node.type.name === 'image') images += 1;
      return true;
    });
    expect(images).toBe(1);
    expect(surface.capture(host)).toContain('![](https://example.com/plain.png)');
  });
});

// ---------------------------------------------------------------------------
// The equation bubble
// ---------------------------------------------------------------------------

describe('the equation bubble', () => {
  it('inserts an inline equation at the caret', async () => {
    const host = await bootMarkdown();
    openMarkdownEquationBubble({ kind: 'inline' });
    const input = document.getElementById('markdownMathInput') as HTMLInputElement;
    const insert = document.getElementById('markdownMathInsert') as HTMLButtonElement;
    input.value = 'a^2 + b^2 = c^2';
    insert.click();
    await settled(120);
    expect(surface.capture(host)).toContain('$a^2 + b^2 = c^2$');
    // And it rendered live.
    expect(markdownEditorHandle()!.view.dom.querySelectorAll('.md-math-inline .katex').length).toBe(
      1,
    );
  });

  it('inserts a block equation ($$…$$)', async () => {
    const host = await bootMarkdown();
    openMarkdownEquationBubble({ kind: 'block' });
    const input = document.getElementById('markdownMathInput') as HTMLInputElement;
    const insert = document.getElementById('markdownMathInsert') as HTMLButtonElement;
    input.value = '\\int_0^1 x dx';
    insert.click();
    await settled(120);
    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('$$');
    expect(captured).toContain('\\int_0^1 x dx');
  });

  it('a node-selected equation opens in edit mode and Apply rewrites it in place', async () => {
    const host = await bootMarkdown('$a^2 + b^2 = c^2$');
    const handle = markdownEditorHandle()!;
    const { view } = handle;

    let pos = 0;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'math_inline') {
        pos = p;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));

    openMarkdownEquationBubble();
    const input = document.getElementById('markdownMathInput') as HTMLInputElement;
    const insert = document.getElementById('markdownMathInsert') as HTMLButtonElement;
    expect(insert.textContent).toBe('Apply');
    expect(input.value).toBe('a^2 + b^2 = c^2');

    input.value = 'E = mc^2';
    insert.click();
    await settled(120);
    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('$E = mc^2$');
    expect(captured).not.toContain('a^2');
  });

  it('the live preview renders through the app KaTeX pass', async () => {
    await bootMarkdown();
    openMarkdownEquationBubble({ kind: 'inline' });
    const input = document.getElementById('markdownMathInput') as HTMLInputElement;
    input.value = '\\sqrt{2}';
    input.dispatchEvent(new Event('input'));
    const preview = document.getElementById('markdownMathPreview') as HTMLElement;
    expect(preview.querySelectorAll('.katex').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Table operations
// ---------------------------------------------------------------------------

describe('table operations', () => {
  it('inserts a table, adds a row, deletes the table', async () => {
    const host = await bootMarkdown();
    expect(runMarkdownToolbarAction('table')).toBe(true);
    await settled(120);
    let captured = surface.capture(host) ?? '';
    expect(captured).toContain('| :-');

    const handle = markdownEditorHandle()!;
    const { view } = handle;
    let cellPos = 0;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'table_cell' && !cellPos) {
        cellPos = p + 1;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos)));

    expect(runMarkdownTableAction('row-below')).toBe(true);
    await settled(120);
    captured = surface.capture(host) ?? '';
    expect(captured.split('\n').filter((line) => line.startsWith('|')).length).toBe(4);

    expect(runMarkdownTableAction('table-delete')).toBe(true);
    await settled(120);
    expect(surface.capture(host) ?? '').not.toContain('|');
  });

  it('the table-ops menu follows the caret (inTable state)', async () => {
    await bootMarkdown('| a | b |\n| :- | :- |\n| 1 | 2 |');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const menu = document.querySelector('.markdown-table-ops') as HTMLElement;
    // The boot content's caret sits at the doc start (before the table): hidden.
    expect(menu.hidden).toBe(true);

    let cellPos = 0;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'table_cell' && !cellPos) {
        cellPos = p + 1;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos)));
    await settled(120);
    expect(menu.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clear formatting + the link chip
// ---------------------------------------------------------------------------

describe('clear formatting and the link chip', () => {
  it('clear formatting strips every mark from the selection', async () => {
    const host = await bootMarkdown('some **bold** words and a [link](https://example.com)');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const to = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, to)));

    expect(runMarkdownToolbarAction('clear')).toBe(true);
    await settled(120);
    const captured = surface.capture(host) ?? '';
    expect(captured).not.toContain('**');
    expect(captured).not.toContain('[link](');
    expect(captured).toContain('some bold words and a link');
  });

  it('the link popover opens in chip mode when the caret sits on a link', async () => {
    await bootMarkdown('visit [the docs](https://example.com/docs) now');
    const handle = markdownEditorHandle()!;
    const { view } = handle;

    let linkPos = 0;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'text' && node.marks.some((mark) => mark.type.name === 'link')) {
        linkPos = p + 1;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linkPos + 4)));

    document.dispatchEvent(new CustomEvent('padify:open-link'));
    const popover = document.getElementById('markdownLinkPopover') as HTMLElement;
    const chipRow = popover.querySelector('[data-md-link-mode="chip"]') as HTMLElement;
    const editRow = popover.querySelector('[data-md-link-mode="edit"]') as HTMLElement;
    expect(popover.hidden).toBe(false);
    expect(chipRow.hidden).toBe(false);
    expect(editRow.hidden).toBe(true);
    expect((document.getElementById('markdownLinkHrefLabel') as HTMLElement).textContent).toBe(
      'https://example.com/docs',
    );
  });

  it("chip mode's Edit row retargets the link in place", async () => {
    const host = await bootMarkdown('visit [the docs](https://example.com/docs) now');
    const handle = markdownEditorHandle()!;
    const { view } = handle;

    let linkPos = 0;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'text' && node.marks.some((mark) => mark.type.name === 'link')) {
        linkPos = p + 1;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linkPos + 4)));
    document.dispatchEvent(new CustomEvent('padify:open-link'));

    const edit = document.getElementById('markdownLinkEdit') as HTMLButtonElement;
    edit.click();
    const input = document.getElementById('markdownLinkInput') as HTMLInputElement;
    expect(input.value).toBe('example.com/docs');

    const apply = document.getElementById('markdownLinkApply') as HTMLButtonElement;
    input.value = 'example.com/retargeted';
    apply.click();
    await settled(120);
    expect(surface.capture(host)).toContain('https://example.com/retargeted');
    expect(surface.capture(host)).not.toContain('example.com/docs)');
  });
});

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

describe('the markdown clipboard', () => {
  it('copy serializes the selection as markdown source', async () => {
    await bootMarkdown('a **bold** thing');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    // A whole-block selection is what the real copy flow serializes.
    const slice = view.state.doc.slice(0, view.state.doc.content.size);
    const text = view.someProp('clipboardTextSerializer', (prop) => prop(slice, view));
    expect(String(text)).toContain('**bold**');
  });
});

// ---------------------------------------------------------------------------
// The slash menu
// ---------------------------------------------------------------------------

describe('the slash menu', () => {
  it('"/" shows the block menu; typing filters; Enter inserts', async () => {
    const host = await bootMarkdown();
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    view.focus();

    // Type '/' (the native insert + the plugin's input notification).
    view.dispatch(view.state.tr.insertText('/'));
    notifyMarkdownSlashInput(view);
    await settled(120);

    const panel = markdownSlashPanel();
    expect(panel?.dataset.show).toBe('true');
    expect(panel!.querySelectorAll('.markdown-slash-item').length).toBeGreaterThan(5);

    view.dispatch(view.state.tr.insertText('head'));
    notifyMarkdownSlashInput(view);
    await settled(120);
    const labels = Array.from(panel!.querySelectorAll('.markdown-slash-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await settled(120);
    expect(surface.capture(host)).toMatch(/^#\s*$/);
    expect(panel?.dataset.show).toBe('false');
  });

  it('a query with no matches shows the empty state and leaves the document alone', async () => {
    const host = await bootMarkdown();
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    view.focus();
    view.dispatch(view.state.tr.insertText('/'));
    notifyMarkdownSlashInput(view);
    await settled(120);
    view.dispatch(view.state.tr.insertText('zzzz'));
    notifyMarkdownSlashInput(view);
    await settled(120);

    const panel = markdownSlashPanel();
    expect(panel?.querySelectorAll('.markdown-slash-item').length).toBe(0);
    expect(panel?.querySelector('.markdown-slash-empty')).not.toBeNull();

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settled(120);
    expect(panel?.dataset.show).toBe('false');
    expect(surface.capture(host) ?? '').not.toContain('#');
  });
});

// ---------------------------------------------------------------------------
// Tab indentation
// ---------------------------------------------------------------------------

describe('Tab indentation', () => {
  it('Tab sinks the list item; Shift-Tab lifts it back', async () => {
    const host = await bootMarkdown('* one\n* two');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const pos = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), -1)));
    view.focus();

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await settled(80);
    expect(surface.capture(host) ?? '').toContain('  * two');

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    await settled(80);
    expect((surface.capture(host) ?? '').trimEnd()).toBe('* one\n* two');
  });

  it('Tab on a plain paragraph types two spaces and never releases focus', async () => {
    await bootMarkdown('plain paragraph');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const pos = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), -1)));
    view.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    await settled(80);
    // The gesture claims the key — the browser focus-move (which used to
    // throw the author out of the note to the topbar) is suppressed…
    expect(event.defaultPrevented).toBe(true);
    // …the two spaces land in the paragraph…
    expect(view.state.doc.textContent).toBe('plain paragraph  ');
    // …and the surface keeps the focus the browser would have taken.
    expect(view.hasFocus()).toBe(true);

    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(back);
    await settled(80);
    expect(back.defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('plain paragraph');
    expect(view.hasFocus()).toBe(true);
  });

  it('Tab over a spanning paragraph selection holds everything in place', async () => {
    await bootMarkdown('select me');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, end)));
    view.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    await settled(80);
    // Claimed, focused, and the selected text is not eaten by the gesture.
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('select me');
    expect(view.hasFocus()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Voice typing
// ---------------------------------------------------------------------------

describe('voice typing dictates into markdown notes', () => {
  it('final results land at the caret with smart spacing and capitalisation', async () => {
    const host = await bootMarkdown('Note.');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    // Park the caret at the end of the existing text.
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));

    // A minimal Web Speech mock: the module only needs start/stop/onresult.
    const instances: {
      onresult: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      onstart: (() => void) | null;
      start: () => void;
      stop: () => void;
      abort: () => void;
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      maxAlternatives: number;
    }[] = [];
    class MockRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      lang = 'en-US';
      continuous = true;
      interimResults = true;
      maxAlternatives = 1;
      start(): void {
        /* jsdom has no audio — the mock just holds the session open */
      }
      stop(): void {
        /* no-op */
      }
      abort(): void {
        /* no-op */
      }
      constructor() {
        instances.push(this);
      }
    }
    const w = window as unknown as { SpeechRecognition?: unknown };
    w.SpeechRecognition = MockRecognition;
    initVoiceTyping();

    toggleVoiceTyping();
    expect(instances).toHaveLength(1);

    instances[0].onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          length: 1,
          0: { transcript: 'hello there' },
        },
      ],
    });
    await settled(120);
    stopVoiceTyping();
    delete w.SpeechRecognition;

    const captured = surface.capture(host) ?? '';
    // New sentence → capitalised + space-separated.
    expect(captured).toContain('Note. Hello there ');
  });

  it('the surface answers charBeforeCaret for the spacing logic', async () => {
    await bootMarkdown('abc');
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
    const { markdownCharBeforeCaret } = await import('./surface');
    expect(markdownCharBeforeCaret()).toBe('c');
  });

  it('insertTextIntoActiveNote routes through the surface (the dictation path)', async () => {
    const host = await bootMarkdown('abc');
    expect(insertTextIntoActiveNote('def')).toBe(true);
    await settled(120);
    expect(surface.capture(host)).toContain('abcdef');
  });
});

// ---------------------------------------------------------------------------
// The context menu's markdown layer
// ---------------------------------------------------------------------------

describe("the context menu's markdown layer", () => {
  it('right-click inside the markdown editor opens the menu with the md vocabulary', async () => {
    await bootMarkdown('some words');
    if (!document.getElementById('padifyCtxMenu')) {
      initContextMenu();
    }
    const handle = markdownEditorHandle()!;
    const menu = document.getElementById('padifyCtxMenu') as HTMLElement;

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    handle.view.dom.dispatchEvent(event);

    expect(menu.hidden).toBe(false);
    // Markdown rows visible; rich rows hidden; the equation row is
    // SHARED (one row, both editing kinds).
    const mdFormats = menu.querySelector('.padify-ctx-formats.padify-ctx-md') as HTMLElement;
    expect(mdFormats.hidden).toBe(false);
    const richFormats = menu.querySelector('.padify-ctx-formats.padify-ctx-rich') as HTMLElement;
    expect(richFormats.hidden).toBe(true);
    const equationRow = menu.querySelector('.padify-ctx-equation') as HTMLElement;
    expect(equationRow.hidden).toBe(false);
  });

  it("the md format row's bold toggles strong around the selection", async () => {
    const host = await bootMarkdown('bold me');
    if (!document.getElementById('padifyCtxMenu')) {
      initContextMenu();
    }
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const to = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, to)));

    const menu = document.getElementById('padifyCtxMenu') as HTMLElement;
    const boldRow = menu.querySelector(
      '.padify-ctx-md .padify-ctx-fmt[data-format="bold"]',
    ) as HTMLButtonElement;
    boldRow.click();
    await settled(120);
    expect(surface.capture(host)).toContain('**bold me**');
  });

  it('"Insert equation" hands the bubble the markdown edition', async () => {
    await bootMarkdown();
    if (!document.getElementById('padifyCtxMenu')) {
      initContextMenu();
    }
    const menu = document.getElementById('padifyCtxMenu') as HTMLElement;
    const equationRow = menu.querySelector('.padify-ctx-equation') as HTMLButtonElement;
    equationRow.click();

    const popover = document.getElementById('markdownMathPopover') as HTMLElement;
    expect(popover.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The .md export
// ---------------------------------------------------------------------------

describe('the .md export', () => {
  it('follows the Notes-<date>.<ext> convention', () => {
    expect(getMarkdownFileName()).toMatch(/^Notes-\d{1,2}-\d{1,2}-\d{4}\.md$/);
  });
});
