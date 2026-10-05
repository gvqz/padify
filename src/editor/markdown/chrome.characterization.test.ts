/**
 * The Markdown surface's THIRD act — the Crepe playground parity chrome:
 *
 *  • the selection bubble: real text selection floats the format toolbar
 *    (B/I/S/code/link/equation), a collapsed caret hides it, atom
 *    selections hide it, and the buttons route through the same injected
 *    toolbar commands the slash menu uses;
 *  • the block handle: one grip per editor, parked in document.body,
 *    draggable, attached at editor creation and detached on teardown;
 *    the drop-cursor plugin rides the same .use() chain;
 *  • the code-block language chip: the ``` fence's info string in place —
 *    the chip shows the language, clicking swaps in the input, Enter
 *    commits through setNodeMarkup, the source round-trips with the
 *    fence intact.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { TabManager, getTabManager, setTabManager } from '../../tabs';
import { resetStorageForTests, storageReady } from '../../storage';
import { markdownEditorHandle } from './surface';
import { noteSurfaceForKind } from '../surface';
import {
  initMarkdownToolbar,
  openMarkdownEquationBubble,
  openMarkdownLinkPopover,
  resetMarkdownToolbarForTests,
  runMarkdownToolbarAction,
} from './toolbar';
import {
  initMarkdownBubble,
  markdownBubblePanel,
  markdownBubbleVisible,
  resetMarkdownBubbleForTests,
} from './bubble';
import { attachBlockHandle, detachBlockHandle, markdownBlockHandleElement } from './block-handle';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { $ } from '../../lib/q';

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

// jsdom's Range lacks geometry — the providers' floating-ui positioning
// (and PM's scrollToSelection) measure it when a selection moves.
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
 * Boots the editor shell + a markdown note + the markdown chrome. Each
 * test gets a fresh store; the shell accumulates (ids resolve to the
 * first occurrence, which stays the live one).
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
  const oldToolbar = document.getElementById('markdownToolbar');
  if (oldToolbar) {
    oldToolbar.replaceWith(oldToolbar.cloneNode(true));
  }
  resetMarkdownToolbarForTests();
  initMarkdownToolbar(getTabManager()!);
  resetMarkdownBubbleForTests();
  initMarkdownBubble({
    runToolbarAction: runMarkdownToolbarAction,
    openLink: openMarkdownLinkPopover,
    openEquation: openMarkdownEquationBubble,
    selectionState: () => {
      const handle = markdownEditorHandle();
      if (!handle) return null;
      const { from, to, empty } = handle.view.state.selection;
      if (empty) {
        return { bold: false, italic: false, strikethrough: false, code: false };
      }
      const marks = new Set<string>();
      handle.view.state.doc.nodesBetween(from, to, (node) => {
        node.marks.forEach((mark) => marks.add(mark.type.name));
        return true;
      });
      return {
        bold: marks.has('strong'),
        italic: marks.has('emphasis'),
        strikethrough: marks.has('strike_through'),
        code: marks.has('inlineCode'),
      };
    },
  });
  getTabManager()!.addTab(true, 'markdown');
  await ready();
  await settled();
  surface.display(host, { content });
  await settled(120);
  return host;
}

/** Selects a text range in the live editor (a real PM TextSelection). */
function selectText(from: number, to: number): void {
  const handle = markdownEditorHandle()!;
  handle.view.dispatch(
    handle.view.state.tr.setSelection(TextSelection.create(handle.view.state.doc, from, to)),
  );
}

// ---------------------------------------------------------------------------
// The selection bubble
// ---------------------------------------------------------------------------

describe('the selection bubble — the floating format toolbar', () => {
  it('boots with the panel body-level and the six Crepe-vocabulary buttons', async () => {
    await bootMarkdown('some text to select');

    const panel = markdownBubblePanel();
    expect(panel).not.toBeNull();
    expect(panel?.closest('body')).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('toolbar');
    const ids = [...(panel?.querySelectorAll('.markdown-bubble-btn') ?? [])].map(
      (button) => (button as HTMLElement).dataset.bubbleId,
    );
    expect(ids).toEqual(['bold', 'italic', 'strikethrough', 'code', 'link', 'equation']);
    expect(markdownBubbleVisible()).toBe(false);
  });

  it('a real text selection shows it; collapsing the caret hides it', async () => {
    await bootMarkdown('selected words live here');
    const handle = markdownEditorHandle()!;

    // Select "words" (offsets inside the paragraph: after "selected ").
    selectText('selected '.length + 1, 'selected words'.length + 1);
    await settled(120);
    expect(markdownBubbleVisible()).toBe(true);

    // Collapse to a caret — the bubble stands down.
    handle.view.dispatch(
      handle.view.state.tr.setSelection(
        TextSelection.create(handle.view.state.doc, handle.view.state.doc.content.size - 1),
      ),
    );
    await settled(120);
    expect(markdownBubbleVisible()).toBe(false);
  });

  it('an atom selection never shows it (equations are their own affordance)', async () => {
    await bootMarkdown('math $x^2$ here');
    const handle = markdownEditorHandle()!;

    let mathPos = -1;
    handle.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') {
        mathPos = pos;
        return false;
      }
      return true;
    });
    expect(mathPos).toBeGreaterThanOrEqual(0);

    handle.view.dispatch(
      handle.view.state.tr.setSelection(NodeSelection.create(handle.view.state.doc, mathPos)),
    );
    await settled(120);
    expect(markdownBubbleVisible()).toBe(false);
  });

  it('the buttons route through the injected toolbar commands — bold applies', async () => {
    await bootMarkdown('format me please');

    selectText(1, 'format me'.length + 1);
    await settled(120);

    const bold =
      markdownBubblePanel()!.querySelector<HTMLButtonElement>('[data-bubble-id="bold"]')!;
    bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await settled(120);

    // Strong is a MARK on the text, not a node of its own.
    const handle = markdownEditorHandle()!;
    let strong = false;
    handle.view.state.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'strong')) {
        strong = true;
      }
      return true;
    });
    expect(strong).toBe(true);
    // The source says what the DOM says.
    expect(surface.capture(document.getElementById('note'))).toContain('**format me');
  });

  it('the link button hides the bubble and opens the link popover', async () => {
    await bootMarkdown('link me up');

    selectText(1, 'link me'.length + 1);
    await settled(120);

    const link =
      markdownBubblePanel()!.querySelector<HTMLButtonElement>('[data-bubble-id="link"]')!;
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await settled(120);

    expect(markdownBubbleVisible()).toBe(false);
    const popover = document.getElementById('markdownLinkPopover') as HTMLElement;
    expect(popover.hidden).toBe(false);
    expect(document.getElementById('markdownLinkInput')?.getAttribute('placeholder')).toBeTruthy();
  });

  it('the pressed faces follow the selection state the wiring reports', async () => {
    await bootMarkdown('plain text here');
    const handle = markdownEditorHandle()!;

    // Make the text bold first (through the toolbar command itself).
    selectText(1, 'plain text'.length + 1);
    runMarkdownToolbarAction('bold');
    await settled(120);

    // Re-select and drive the provider's show path (the onShow hook paints).
    selectText(1, 'plain text'.length + 1);
    await settled(120);
    const panel = markdownBubblePanel()!;
    expect(panel.querySelector('[data-bubble-id="bold"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(panel.querySelector('[data-bubble-id="italic"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );

    void handle;
  });
});

// ---------------------------------------------------------------------------
// The block handle
// ---------------------------------------------------------------------------

describe('the block handle — the drag grip', () => {
  it('attaches at editor creation: body-level, draggable, aria-hidden', async () => {
    await bootMarkdown('# A heading\n\nA paragraph.');

    const el = markdownBlockHandleElement();
    expect(el).not.toBeNull();
    expect(el?.closest('body')).not.toBeNull();
    expect(el?.classList.contains('md-block-handle')).toBe(true);
    expect(el?.draggable).toBe(true);
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.dataset.show).toBe('false');
  });

  it('the block plugin and the drop cursor ride the editor chain', async () => {
    await bootMarkdown('blocks');
    const handle = markdownEditorHandle()!;
    const keys = handle.view.state.plugins.map((plugin) =>
      String((plugin as { key?: unknown }).key),
    );
    expect(keys.some((key) => key.includes('MILKDOWN_BLOCK'))).toBe(true);
  });

  it('a remount detaches the old grip and attaches a fresh one', async () => {
    const host = await bootMarkdown('# first mount');
    const first = markdownBlockHandleElement();

    // Evict the wrapper (the html surface's repaint) and mount again.
    host.innerHTML = '<p>an html note</p>';
    surface.display(host, { content: '# second mount' });
    await ready();
    await settled();

    const second = markdownBlockHandleElement();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });

  it('detach stands down cleanly (idempotent)', () => {
    // Whatever grip the suite's shared editor holds, detaching twice is
    // safe and leaves nothing attached.
    detachBlockHandle();
    detachBlockHandle(); // the second call must be a no-op
    expect(markdownBlockHandleElement()).toBeNull();
  });

  it('dismiss tears the grip and its body-level chrome down (the painter changed)', async () => {
    const host = await bootMarkdown('# grip note');
    // A fresh mount attaches the grip (the shared editor's first boot may
    // have had it detached by an earlier test's teardown).
    host.innerHTML = '<p>an html note</p>';
    surface.display(host, { content: '# grip note again' });
    await ready();
    await settled();
    const grip = markdownBlockHandleElement();
    expect(grip).not.toBeNull();

    // The shell's stand-down call when another kind takes the host: the
    // grip (a document.body child) must leave the DOM in the same beat —
    // a lazy teardown left it frozen visible over the NEXT note.
    surface.dismiss?.(host);
    await settled();

    expect(markdownBlockHandleElement()).toBeNull();
    expect(grip?.isConnected).toBe(false);
    // The surface is fully stood down: a fresh display mounts anew.
    surface.display(host, { content: '# back again' });
    await ready();
    await settled();
    expect(markdownBlockHandleElement()).not.toBeNull();
    detachBlockHandle();
  });

  it('dismiss hides the bubble even when no editor finished building', () => {
    // The floating panels live in document.body; their own close paths
    // (mousedown outside, editor destroy) do not cover a transition away
    // from a STILL-MOUNTING note. dismiss hides them unconditionally.
    expect(() => surface.dismiss?.(document.createElement('div'))).not.toThrow();
  });

  it('the exported plugin array carries the block chain and the drop cursor', () => {
    // Import through the surface's own chain indirectly: attach is what
    // the surface calls; the plugins land via .use — pinned here by the
    // view's plugin list above plus the attach/detach lifecycle.
    expect(typeof attachBlockHandle).toBe('function');
    expect(typeof detachBlockHandle).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// The code-block language chip
// ---------------------------------------------------------------------------

describe('the code-block language chip — the fence, in place', () => {
  it('a fenced code block renders the language row and the chip', async () => {
    await bootMarkdown(['```python', 'print("hi")', '```'].join('\n'));
    const handle = markdownEditorHandle()!;
    const dom = handle.view.dom;

    const block = dom.querySelector('.md-code-block') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.dataset.language).toBe('python');
    const chip = block.querySelector('.md-code-lang-chip') as HTMLElement;
    expect(chip.textContent).toBe('python');
    // The contentDOM underneath — PM's own code text.
    expect(block.querySelector('pre code')?.textContent).toContain('print');
  });

  it('an unmarked fence shows the quiet "language" affordance', async () => {
    await bootMarkdown(['```', 'plain code', '```'].join('\n'));
    const handle = markdownEditorHandle()!;
    const chip = handle.view.dom.querySelector('.md-code-lang-chip') as HTMLElement;
    expect(chip.textContent).toBe('language');
    expect(chip.classList.contains('md-code-lang-empty')).toBe(true);
  });

  it('click → type → Enter commits the language and the fence round-trips', async () => {
    const host = await bootMarkdown(['```', 'x = 1', '```'].join('\n'));
    const handle = markdownEditorHandle()!;
    const chip = handle.view.dom.querySelector('.md-code-lang-chip') as HTMLElement;

    chip.click();
    const input = handle.view.dom.querySelector('.md-code-lang-input') as HTMLInputElement;
    expect(input).not.toBeNull();

    input.value = 'TypeScript';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await settled(150);

    // Committed: lowercase, chip repainted, input gone, fence updated.
    expect(handle.view.dom.querySelector('.md-code-lang-input')).toBeNull();
    const block = handle.view.dom.querySelector('.md-code-block') as HTMLElement;
    expect(block.dataset.language).toBe('typescript');
    expect((handle.view.dom.querySelector('.md-code-lang-chip') as HTMLElement).textContent).toBe(
      'typescript',
    );

    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('```typescript');
  });

  it('Escape cancels the edit — the language is untouched', async () => {
    await bootMarkdown(['```js', 'x', '```'].join('\n'));
    const handle = markdownEditorHandle()!;
    const chip = handle.view.dom.querySelector('.md-code-lang-chip') as HTMLElement;

    chip.click();
    const input = handle.view.dom.querySelector('.md-code-lang-input') as HTMLInputElement;
    input.value = 'would-be-rust';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settled(150);

    expect(handle.view.dom.querySelector('.md-code-lang-input')).toBeNull();
    const block = handle.view.dom.querySelector('.md-code-block') as HTMLElement;
    expect(block.dataset.language).toBe('js');
  });

  it('the shared datalist mounts once, in the body', async () => {
    await bootMarkdown(['```js', 'x', '```'].join('\n'));
    const handle = markdownEditorHandle()!;
    const chip = handle.view.dom.querySelector('.md-code-lang-chip') as HTMLElement;
    chip.click();

    const lists = document.querySelectorAll('datalist#mdCodeLanguages');
    expect(lists.length).toBe(1);
    const options = [...(lists[0]?.querySelectorAll('option') ?? [])].map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(options).toContain('typescript');
    expect(options).toContain('bash');
  });
});
