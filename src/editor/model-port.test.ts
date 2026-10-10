import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeNoteHtml } from './storage-subset';
import { ModelPort } from './model-port';
import { migrateMarginIndentsToTabs } from './plain-indent';

/**
 * The engine pipeline, end to end, in jsdom: commands through the port,
 * one history across native edits and commands, the pending-mark arm,
 * the delete normalization, the checklist gutter, math shells, and the
 * getHtml contract (canonical, sanitized, corpus-shaped).
 */

function makePort(html = ''): { port: ModelPort; surface: HTMLElement } {
  const surface = document.createElement('div');
  surface.setAttribute('contenteditable', 'true');
  document.body.append(surface);
  const port = new ModelPort(surface, { sanitize: sanitizeNoteHtml });
  if (html !== '') {
    port.renderHtml(html);
  }
  return { port, surface };
}

/** Dispatches a beforeinput/input pair the way the browser would. */
function nativeEdit(
  surface: HTMLElement,
  inputType: string,
  apply: () => void,
  data?: string,
): void {
  const before = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(before, 'inputType', { value: inputType });
  if (data !== undefined) {
    Object.defineProperty(before, 'data', { value: data });
  }
  surface.dispatchEvent(before);
  apply();
  const after = new Event('input', { bubbles: true });
  Object.defineProperty(after, 'inputType', { value: inputType });
  if (data !== undefined) {
    Object.defineProperty(after, 'data', { value: data });
  }
  surface.dispatchEvent(after);
}

/**
 * Places the caret at raw offset 0 of the nth block's first text node —
 * the BLOCK-START caret. A stream-offset caretAt() call cannot express
 * this position (the offset belongs to the previous block's end too),
 * which is exactly why the live spot has to win the tie.
 */
function caretAtNodeStart(surface: HTMLElement, blockIndex: number): void {
  const block = surface.children[blockIndex] as HTMLElement | undefined;
  const text = block?.firstChild;
  if (!block || !text || text.nodeType !== Node.TEXT_NODE) {
    throw new Error(`block ${blockIndex} has no leading text node`);
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(text, 0);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Places the caret at a stream offset on the surface (end-safe). */
function caretAt(surface: HTMLElement, at: number): void {
  const selection = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let target: { node: Text; raw: number } | null = null;
  let last: { node: Text; raw: number } | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('.padify-math')) {
      continue;
    }
    const visible = (node.nodeValue ?? '').replace(/\u200B/g, '');
    if (consumed + visible.length > at) {
      target = { node: node as Text, raw: at - consumed };
      break;
    }
    consumed += visible.length;
    last = { node: node as Text, raw: visible.length };
  }
  const spot = target ?? last;
  if (spot && spot.raw <= (spot.node.nodeValue ?? '').length) {
    range.setStart(spot.node, spot.raw);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  if (!spot) {
    // An empty surface: the caret anchors at the surface's start.
    range.setStart(surface, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

/** The caret's stream offset on the surface (how much content sits
 *  before it) — the merge-proof way to pin caret placement. */
function caretStreamOffset(surface: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return -1;
  }
  const range = selection.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(surface);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().replace(/\u200B/g, '').length;
}

/** Selects a stream range on the surface (end-safe: a target at the
 *  stream's end resolves to the last text node's tail; each target
 *  resolves ONCE — the first node that reaches past it — so a range
 *  starting at 0 across many blocks cannot re-match later nodes). */
function selectRange(surface: HTMLElement, from: number, to: number): void {
  const selection = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  const resolved = new Map<number, { node: Text; raw: number }>();
  let consumed = 0;
  let last: { node: Text; raw: number } | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('.padify-math')) {
      continue;
    }
    const visible = (node.nodeValue ?? '').replace(/\u200B/g, '');
    for (const target of [from, to]) {
      if (!resolved.has(target) && consumed + visible.length > target) {
        resolved.set(target, { node: node as Text, raw: target - consumed });
      }
    }
    consumed += visible.length;
    last = { node: node as Text, raw: visible.length };
  }
  const start = resolved.get(from) ?? last;
  const end = resolved.get(to) ?? last;
  if (start && end) {
    range.setStart(start.node, start.raw);
    range.setEnd(end.node, end.raw);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the command pipeline', () => {
  it('bolds a range, keeps it selected, untoggles on the second press', () => {
    const { port, surface } = makePort('hello world');
    selectRange(surface, 6, 11);
    expect(port.applyFormat('bold')).toBe(true);
    expect(surface.innerHTML).toBe('hello <b>world</b>');
    // The covered range stays selected — the second press untoggles.
    expect(port.queryFormat('bold')).toBe(true);
    expect(port.applyFormat('bold')).toBe(true);
    expect(surface.innerHTML).toBe('hello world');
    expect(port.queryFormat('bold')).toBe(false);
  });

  it('getHtml is canonical and a fixed point of the sanitizer', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('one ');
    caretAt(surface, 4);
    port.insertText('two');
    const html = port.getHtml();
    expect(html).toBe('one two');
    expect(sanitizeNoteHtml(html)).toBe(html);
  });

  it('insertText places the caret at the end of the inserted text', () => {
    const { port, surface } = makePort('ab');
    caretAt(surface, 2);
    expect(port.insertText('cd')).toBe(true);
    expect(surface.innerHTML).toBe('abcd');
    // The caret sits at the tail of the inserted run — stream offset 4,
    // the end of 'cd'. Pinned as a stream offset (not a node identity):
    // the surface re-parses markup, so the fresh run merges into its
    // neighbour text node and a node-identity assert would pass for the
    // wrong reason (this test used to pin the pre-edit offset that way —
    // the cursor-doesn't-move-with-the-paste bug).
    expect(caretStreamOffset(surface)).toBe(4);
  });

  it('insertText mid-run leaves the caret right after the inserted text', () => {
    const { port, surface } = makePort('hello world');
    caretAt(surface, 5);
    expect(port.insertText(' brave')).toBe(true);
    expect(port.getText()).toBe('hello brave world');
    // 5 + 6 = 11 — the caret moved along with the insertion, exactly the
    // pasted-text expectation from tasks.txt.
    expect(caretStreamOffset(surface)).toBe(11);
  });

  it('insertText after a block keeps the caret in the continuation block', () => {
    const { port, surface } = makePort('<p>first</p><p>second</p>');
    caretAt(surface, 11); // end of 'second' — the two blocks hold 11 stream chars
    expect(port.insertText(' tail')).toBe(true);
    expect(surface.innerHTML).toBe('<p>first</p><p>second tail</p>');
    expect(caretStreamOffset(surface)).toBe(16);
  });

  it('insertText at a BLOCK START lands in that block, not the previous one', () => {
    const { port, surface } = makePort('<p>first</p><p>second</p>');
    // The raw DOM caret at (second's text, 0). Its stream offset (5) is
    // the SAME number as the previous block's end — blocks hold no
    // stream — and the offset resolver answers the A side. The live spot
    // is the one place the boundary's side survives; without it the
    // paste landed one line up (the cursor-where bug from tasks.txt).
    caretAtNodeStart(surface, 1);
    expect(port.insertText('XYZ')).toBe(true);
    expect(surface.innerHTML).toBe('<p>first</p><p>XYZsecond</p>');
    // The caret follows the paste: after 'XYZ' inside 'second'.
    expect(caretStreamOffset(surface)).toBe(8);
  });

  it('indent at a BLOCK START steps that block, not the previous one', () => {
    const { port, surface } = makePort('<p>first</p><p>second</p>');
    caretAtNodeStart(surface, 1);
    expect(port.indent()).toBe(true);
    expect(surface.innerHTML).toBe('<p>first</p><p style="margin-left: 40px">second</p>');
  });

  it('Tab at a block start leaves the caret on that block start, not the line above', () => {
    const { port, surface } = makePort('<p>first</p><p>second</p>');
    caretAtNodeStart(surface, 1);
    expect(port.indent()).toBe(true);
    // The offset of second's start (5) is ALSO first's end — a numeric
    // restore resolves that boundary to the A side and the next
    // keystroke typed into 'first' (the selecting/backspacing-tabs bug).
    // The spot intent pins the B side.
    const selection = window.getSelection();
    expect(selection?.getRangeAt(0).startContainer).toBe(
      surface.querySelectorAll('p')[1]!.firstChild,
    );
    expect(selection?.getRangeAt(0).startOffset).toBe(0);
  });

  it('Backspace at an indented block start unwinds the indent, keeping the block', () => {
    const { port, surface } = makePort('<p>first</p><p style="margin-left: 40px">second</p>');
    caretAtNodeStart(surface, 1);
    expect(port.unindentAtBlockStart?.()).toBe(true);
    expect(surface.innerHTML).toBe('<p>first</p><p>second</p>');
    // Docs parity: the block survives with the caret at its start — the
    // native delete would have merged it into 'first' in the same press.
    const selection = window.getSelection();
    expect(selection?.getRangeAt(0).startContainer).toBe(
      surface.querySelectorAll('p')[1]!.firstChild,
    );
    expect(selection?.getRangeAt(0).startOffset).toBe(0);
  });

  it('Backspace at a plain block start declines — the native merge proceeds', () => {
    const { port, surface } = makePort('<p>first</p><p>second</p>');
    caretAtNodeStart(surface, 1);
    expect(port.unindentAtBlockStart?.()).toBeNull();
  });

  it('Backspace mid-block declines — the native delete takes the character', () => {
    const { port, surface } = makePort('<p>first</p><p style="margin-left: 40px">second</p>');
    caretAt(surface, 7); // 'se|cond' — inside second, past its start
    expect(port.unindentAtBlockStart?.()).toBeNull();
  });

  it('Backspace inside a list declines — lists own their structure', () => {
    const { port, surface } = makePort('<ul><li>alpha</li><li>beta</li></ul>');
    caretAt(surface, 6); // 'b|eta'
    expect(port.unindentAtBlockStart?.()).toBeNull();
  });

  it('a native block merge leaves no transparent-background wrapper behind', () => {
    const { surface } = makePort('<p>first</p><p>second</p>');
    caretAtNodeStart(surface, 1);
    // Chromium's native merge: second's run moves into first wrapped in
    // a span carrying its computed background (transparent = nothing).
    nativeEdit(surface, 'deleteContentBackward', () => {
      const first = surface.querySelector('p')!;
      const span = document.createElement('span');
      span.setAttribute('style', 'background-color: transparent');
      span.textContent = 'second';
      first.appendChild(span);
      surface.querySelector('p + p')?.remove();
    });
    expect(surface.innerHTML).toBe('<p>firstsecond</p>');
  });

  it('nesting at an ITEM START nests that item, not the previous one', () => {
    const { port, surface } = makePort('<ul><li>alpha</li><li>beta</li></ul>');
    const beta = surface.querySelectorAll('li')[1]!.firstChild as Text;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(beta, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(port.indent()).toBe(true);
    expect(surface.innerHTML).toBe('<ul><li>alpha<ul><li>beta</li></ul></li></ul>');
  });

  it('toggleList wraps root text and keeps the caret at the same text offset', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('milk');
    expect(port.toggleList('checklist')).toBe(true);
    expect(surface.innerHTML).toBe(
      '<ul data-rich-checklist="true"><li data-checked="false">milk</li></ul>',
    );
    // The caret survived the wrap at the item's end — typing continues the
    // item (Chrome resets list carets to the item start; the model keeps
    // the offset).
    const selection = window.getSelection();
    expect(selection?.getRangeAt(0).startContainer).toBe(surface.querySelector('li')!.firstChild);
    expect(selection?.getRangeAt(0).startOffset).toBe(4);
  });

  it('applyBlockFormat materializes root text into the tag', () => {
    const { port, surface } = makePort('big title');
    caretAt(surface, 4);
    expect(port.applyBlockFormat('h1')).toBe(true);
    expect(surface.innerHTML).toBe('<h1>big title</h1>');
    expect(port.queryBlockFormat()).toBe('h1');
  });

  it('alignment and indent materialize and step the root run', () => {
    const { port, surface } = makePort('indented paragraph');
    selectRange(surface, 0, 18);
    expect(port.applyAlignment('center')).toBe(true);
    expect(surface.innerHTML).toBe('<div style="text-align: center">indented paragraph</div>');
    expect(port.queryAlignment()).toBe('center');
    expect(port.indent()).toBe(true);
    expect(surface.innerHTML).toBe(
      '<div style="text-align: center; margin-left: 40px">indented paragraph</div>',
    );
    expect(port.outdent()).toBe(true);
    expect(port.queryAlignment()).toBe('center');
  });
});

describe('Tab over the bare stream — the classic plain note', () => {
  it('a collapsed caret takes a literal tab, not a document-wide margin', () => {
    const { port, surface } = makePort('first line\n\nsecond line');
    caretAt(surface, 4);
    expect(port.tabStream(false)).toBe(true);
    expect(surface.innerHTML).toBe('firs\tt line\n\nsecond line');
    // The stream stayed a stream — no margin block materialized over it.
    expect(surface.querySelector('[style]')).toBeNull();
  });

  it('a spanning selection tabs every line and keeps it selected for repeats', () => {
    const { port, surface } = makePort('alpha\nbeta\ngamma');
    selectRange(surface, 0, 17);
    expect(port.tabStream(false)).toBe(true);
    expect(surface.textContent).toBe('\talpha\n\tbeta\n\tgamma');
    const selection = window.getSelection();
    expect(selection?.toString()).toBe('\talpha\n\tbeta\n\tgamma');
  });

  it('Shift+Tab over tabbed lines unwinds one tab per line', () => {
    const { port, surface } = makePort('\talpha\n\tbeta');
    selectRange(surface, 0, 12);
    expect(port.tabStream(true)).toBe(true);
    expect(surface.textContent).toBe('alpha\nbeta');
  });

  it('a collapsed Shift+Tab is a no-op — nothing to unwind at the caret', () => {
    const { port, surface } = makePort('\tindented');
    caretAt(surface, 3);
    expect(port.tabStream(true)).toBe(false);
    expect(surface.textContent).toBe('\tindented');
  });

  it('an element block declines the gesture (null) and takes the margin step', () => {
    const { port, surface } = makePort('<div>block one</div><div>block two</div>');
    caretAt(surface, 14); // inside the second block
    // null = "not a bare stream" — the key handler falls back to the
    // formatting commands (the toolbar's indent button rides those too).
    expect(port.tabStream(false)).toBeNull();
    expect(port.indent()).toBe(true);
    expect(surface.innerHTML).toBe(
      '<div>block one</div><div style="margin-left: 40px">block two</div>',
    );
  });

  it('the toolbar path on a bare stream still formats the block', () => {
    // The Tab KEY takes tabStream(); the indent BUTTON takes indent() —
    // on a bare stream that materializes the block and steps its margin,
    // exactly what the docs-toolbar e2e pins through the real toolbar.
    const { port, surface } = makePort('indented paragraph');
    caretAt(surface, 4);
    expect(port.tabStream(false)).toBe(true);
    expect(surface.textContent).toBe('inde\tnted paragraph');
    expect(port.indent()).toBe(true);
    expect(surface.innerHTML).toBe('<div style="margin-left: 40px">inde\tnted paragraph</div>');
  });

  it('the bare-stream tab is one undo step', () => {
    const { port, surface } = makePort('plain words');
    caretAt(surface, 5);
    expect(port.tabStream(false)).toBe(true);
    expect(surface.textContent).toBe('plain\t words');
    expect(port.undo()).toBe(true);
    expect(surface.textContent).toBe('plain words');
  });
});

describe('tabPlainText — the plain note tab is TEXT, never a margin', () => {
  it('a collapsed caret in a block inserts a literal tab at the caret', () => {
    const { port, surface } = makePort('<div>alpha</div><div>beta</div>');
    caretAt(surface, 7); // 'be|ta' — beta spans stream 5..9
    expect(port.tabPlainText(false)).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div>be\tta</div>');
    // The indent is text — no style attribute, nothing for the selection
    // highlight to skip.
    expect(surface.querySelector('[style]')).toBeNull();
  });

  it('a spanning selection tabs every covered block and keeps the lines selected', () => {
    const { port, surface } = makePort('<div>alpha</div><div>beta</div><div>gamma</div>');
    selectRange(surface, 1, 7); // from inside 'alpha' through 'be|ta'
    expect(port.tabPlainText(false)).toBe(true);
    expect(surface.innerHTML).toBe('<div>\talpha</div><div>\tbeta</div><div>gamma</div>');
    // Whole covered lines stay selected — the re-pinned range runs from
    // the first covered block's start (tab included) to its end. (jsdom's
    // Range.toString does not interleave \n at block boundaries the way a
    // browser's Selection.toString does — the tabs are the assertion.)
    const selection = window.getSelection();
    expect(selection?.toString()).toBe('\talpha\tbeta');
  });

  it('blocks never merge — the tab-per-block op is not the old \\n splice', () => {
    const { port, surface } = makePort('<div>alpha</div><div>beta</div>');
    selectRange(surface, 0, 9);
    expect(port.tabPlainText(false)).toBe(true);
    expect(surface.querySelectorAll('div').length).toBe(2);
  });

  it('Shift+Tab over tabbed blocks strips one tab per block', () => {
    const { port, surface } = makePort('<div>\talpha</div><div>\tbeta</div>');
    selectRange(surface, 0, 12);
    expect(port.tabPlainText(true)).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div>beta</div>');
  });

  it('a stripped-empty block regains its placeholder br', () => {
    const { port, surface } = makePort('<div>alpha</div><div>\t</div>');
    selectRange(surface, 0, 6);
    expect(port.tabPlainText(true)).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div><br></div>');
  });

  it('a collapsed Shift+Tab at a tabbed line start unwinds that line', () => {
    const { port, surface } = makePort('<div>alpha</div><div>\tbeta</div>');
    caretAtNodeStart(surface, 1);
    expect(port.tabPlainText(true)).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div>beta</div>');
    // The caret stayed on the unwound line's start.
    const selection = window.getSelection();
    expect(selection?.getRangeAt(0).startContainer).toBe(
      surface.querySelectorAll('div')[1]!.firstChild,
    );
    expect(selection?.getRangeAt(0).startOffset).toBe(0);
  });

  it('a collapsed Shift+Tab with no leading tab declines (null) — margins stay reachable', () => {
    const { port, surface } = makePort('<div style="margin-left: 40px">legacy</div>');
    caretAt(surface, 3);
    expect(port.tabPlainText(true)).toBeNull();
    // The caller's fallback steps the legacy margin down.
    expect(port.outdent()).toBe(true);
    expect(surface.innerHTML).toBe('<div>legacy</div>');
  });

  it('Backspace at a tabbed block start unwinds the tab; the merge waits', () => {
    const { port, surface } = makePort('<div>alpha</div><div>\tbeta</div>');
    caretAtNodeStart(surface, 1);
    expect(port.unindentTabAtBlockStart?.()).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div>beta</div>');
    // The block survived — the native delete would have merged it into
    // 'alpha' in the same press.
    expect(surface.querySelectorAll('div').length).toBe(2);
  });

  it('Backspace mid-block or without a tab declines (null)', () => {
    const { port, surface } = makePort('<div>alpha</div><div>\tbeta</div>');
    caretAt(surface, 8); // 'be|ta' — past the block start
    expect(port.unindentTabAtBlockStart?.()).toBeNull();
    caretAtNodeStart(surface, 0); // no tab on this line
    expect(port.unindentTabAtBlockStart?.()).toBeNull();
  });

  it('inside a list the gesture declines — lists nest natively', () => {
    const { port, surface } = makePort('<ul><li>alpha</li><li>beta</li></ul>');
    caretAt(surface, 6); // 'b|eta'
    expect(port.tabPlainText(false)).toBeNull();
    expect(port.tabPlainText(true)).toBeNull();
  });

  it('the tab text op is one undo step', () => {
    const { port, surface } = makePort('<div>alpha</div><div>beta</div>');
    selectRange(surface, 0, 10);
    expect(port.tabPlainText(false)).toBe(true);
    expect(surface.querySelectorAll('div')[0]!.firstChild!.textContent).toBe('\talpha');
    expect(port.undo()).toBe(true);
    expect(surface.innerHTML).toBe('<div>alpha</div><div>beta</div>');
  });
});

describe('plain-indent migration — legacy margins become tabs on display', () => {
  it('rewrites margin steps into the equivalent leading tabs', () => {
    const { surface } = makePort();
    surface.innerHTML = migrateMarginIndentsToTabs(
      '<div>alpha</div><div style="margin-left: 40px">beta</div>' +
        '<div style="margin-left: 120px">gamma</div>',
    );
    expect(surface.innerHTML).toBe('<div>alpha</div><div>\tbeta</div><div>\t\t\tgamma</div>');
  });

  it('keeps other block declarations while dropping the margin', () => {
    const migrated = migrateMarginIndentsToTabs(
      '<div style="text-align: center; margin-left: 40px">centered</div>',
    );
    expect(migrated).toBe('<div style="text-align: center">\tcentered</div>');
  });

  it('empty margin blocks take the tab in place of the placeholder br', () => {
    const migrated = migrateMarginIndentsToTabs('<div style="margin-left: 80px"><br></div>');
    expect(migrated).toBe('<div>\t\t</div>');
  });

  it('notes without margins round-trip byte-exact', () => {
    const html = '<div>alpha</div><div>beta</div>';
    expect(migrateMarginIndentsToTabs(html)).toBe(html);
  });

  it('a nested margin pair migrates into the innermost text start', () => {
    const migrated = migrateMarginIndentsToTabs(
      '<div style="margin-left: 40px"><div style="margin-left: 80px">deep</div></div>',
    );
    // Both wrappers' tabs collapse onto the innermost text start (each
    // block's stream start IS there), and no margin survives to fight
    // the tab gesture: 40px + 80px = three tab steps.
    expect(migrated).toBe('<div><div>\t\t\tdeep</div></div>');
  });
});

describe('history — one undo discipline for everything', () => {
  it('typing bursts, deletes and commands undo in the pinned dance', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    // Type "survives undo" as one burst.
    nativeEdit(surface, 'insertText', () => {
      surface.append('survives undo');
    });
    // Select-all + backspace: a delete group, then the normalization.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(surface);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    nativeEdit(surface, 'deleteContentBackward', () => {
      surface.innerHTML = '<br>'; // the skeleton Chrome would leave
    });
    expect(surface.innerHTML).toBe(''); // the normalization collapsed it
    // Type "x" as another burst.
    nativeEdit(
      surface,
      'insertText',
      () => {
        surface.append('x');
      },
      'x',
    );
    expect(surface.innerHTML).toBe('x');

    // First undo removes "x"; the second brings the text back.
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('');
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('survives undo');
    expect(port.redo()).toBe(true);
    expect(port.getHtml()).toBe('');
    // A second redo walks forward to the retyped state; then it drains.
    expect(port.canRedo()).toBe(true);
    expect(port.redo()).toBe(true);
    expect(port.getHtml()).toBe('x');
    expect(port.canRedo()).toBe(false);
  });

  it('one command is one undo step (an equation appears and vanishes whole)', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('Euler said ');
    caretAt(surface, 11);
    expect(port.insertMath('x^2')).toBe(true);
    expect(surface.querySelectorAll('.padify-math').length).toBe(1);
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('Euler said ');
    expect(surface.querySelectorAll('.padify-math').length).toBe(0);
  });

  it('undo never walks across documents (renderHtml resets)', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('first note');
    expect(port.canUndo()).toBe(true);
    port.renderHtml('<p>another note</p>');
    expect(port.canUndo()).toBe(false);
    expect(port.undo()).toBe(false);
  });
});

describe('the pending mark (Docs typing style)', () => {
  it('arms at a collapsed caret and wraps the first inserted text', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('ab');
    caretAt(surface, 2);
    expect(port.applyScript('super')).toBe(true); // armed, nothing in the DOM
    expect(surface.innerHTML).toBe('ab');
    expect(port.queryScript('super')).toBe(true);
    nativeEdit(
      surface,
      'insertText',
      () => {
        // Real typing appends AND leaves the caret after the insertion.
        const text = surface.firstChild as Text;
        text.appendData('XY');
        const sel = window.getSelection();
        const r = document.createRange();
        r.setStart(text, text.length);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
      },
      'XY',
    );
    expect(surface.innerHTML).toBe('ab<sup>XY</sup>');
    expect(port.queryScript('super')).toBe(true);
    // Continuation typing joins natively — no marker ever pollutes the text.
    const text = surface.querySelector('sup')!.firstChild as Text;
    text.appendData('Z');
    surface.dispatchEvent(new Event('input'));
    expect(surface.querySelector('sup')!.textContent).toBe('XYZ');
  });

  it('a collapsed caret inside a live script leaves it in one press', () => {
    const { port, surface } = makePort('ab<sup>X<sup>Y</sup>u</sup>cd');
    // Caret between Y and u — inside the inner script.
    const innerText = surface.querySelectorAll('sup')[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(innerText, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(port.applyScript('super')).toBe(true);
    // The caret escaped every level; the guard carries it.
    expect(surface.querySelectorAll('sup').length).toBe(2);
    const markup = surface.innerHTML;
    expect(markup).toContain('\u200B');
  });
});

describe('the styled caret run', () => {
  it('plants a zero-width run; typed text joins it through storage', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('before');
    caretAt(surface, 6);
    expect(port.setFontSize(24)).toBe(true);
    expect(surface.innerHTML).toBe('before<span style="font-size: 24px">\u200B</span>');
    // The caret sits inside the run, past the marker — native typing joins.
    const marker = surface.querySelector('span')!.firstChild as Text;
    marker.appendData('AFTER24');
    expect(port.getHtml()).toBe('before<span style="font-size: 24px">\u200BAFTER24</span>');
  });

  it('highlight None clears the styled run at the caret', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    port.insertText('note');
    caretAt(surface, 4);
    port.setHighlight('#d0ebff');
    expect(surface.innerHTML).toBe('note<span style="background-color: #d0ebff">\u200B</span>');
    expect(port.setHighlight('transparent')).toBe(true);
    expect(surface.innerHTML).toBe('note');
  });

  it('highlight None over a range strips every touched span entirely', () => {
    const { port, surface } = makePort('glow zone');
    selectRange(surface, 0, 9);
    port.setHighlight('#d0ebff');
    expect(surface.innerHTML).toBe('<span style="background-color: #d0ebff">glow zone</span>');
    selectRange(surface, 0, 9);
    port.setHighlight('transparent');
    expect(surface.innerHTML).toBe('glow zone');
  });
});

describe('surface interactions', () => {
  it('the checklist gutter click toggles through the model', () => {
    const { port, surface } = makePort(
      '<ul data-rich-checklist="true"><li data-checked="false">milk</li><li data-checked="false">eggs</li></ul>',
    );
    // Click the second item's gutter: clientX within 30px of rect.left
    // (zeros in jsdom — any small clientX lands in the gutter).
    const item = surface.querySelectorAll('li')[1]!;
    caretAt(surface, 6);
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 8, clientY: 0 }));
    expect(surface.querySelectorAll('li')[1]!.getAttribute('data-checked')).toBe('true');
    expect(port.getHtml()).toContain('<li data-checked="true">eggs</li>');
    // Clicking outside the gutter (on the text) does not toggle.
    const first = surface.querySelectorAll('li')[0]!;
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 0 }));
    expect(first.getAttribute('data-checked')).toBe('false');
  });

  it('math shells render on paint and store as the shell alone', () => {
    const { port, surface } = makePort('Euler said ');
    caretAt(surface, 11);
    port.insertMath('e^{i\\pi} + 1 = 0');
    const shell = surface.querySelector('.padify-math') as HTMLElement;
    expect(shell).not.toBeNull();
    expect(shell.getAttribute('data-latex')).toBe('e^{i\\pi} + 1 = 0');
    expect(port.getHtml()).toBe(
      'Euler said <span class="padify-math" data-latex="e^{i\\pi} + 1 = 0"></span>',
    );
    // updateMath by handle — the handle comes from the shell's click (the
    // padify:math-click path the toolbar listens to), like the app does.
    let handle = '';
    document.addEventListener('padify:math-click', (event) => {
      handle = (event as CustomEvent).detail.id;
    });
    shell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle).not.toBe('');
    expect(port.updateMath(handle, 'z^4')).toBe(true);
    expect((surface.querySelector('.padify-math') as HTMLElement).getAttribute('data-latex')).toBe(
      'z^4',
    );
  });

  it('links: insert, retarget, remove, and the chip query', () => {
    const { port, surface } = makePort('read this please');
    selectRange(surface, 5, 9);
    expect(port.insertLink('https://example.com/guide')).toBe(true);
    expect(surface.innerHTML).toBe('read <a href="https://example.com/guide">this</a> please');
    caretAt(surface, 7);
    expect(port.queryLinkHref()).toBe('https://example.com/guide');
    expect(port.retargetLink('https://other.test')).toBe(true);
    expect(port.queryLinkHref()).toBe('https://other.test');
    expect(port.removeLink()).toBe(true);
    expect(surface.innerHTML).toBe('read this please');
    expect(port.insertLink('https://x.test')).toBe(false); // collapsed — contract
    expect(port.insertLinkAsText('https://y.test')).toBe(true);
    expect(surface.innerHTML).toContain('href="https://y.test"');
  });
});

describe('reading the note', () => {
  it('getText, isEmpty, caret helpers', () => {
    const { port, surface } = makePort('hello <b>big</b> tail');
    expect(port.getText()).toBe('hello big tail');
    expect(port.isEmpty()).toBe(false);
    port.renderHtml('');
    expect(port.isEmpty()).toBe(true);
    caretAt(surface, 0);
    port.insertText('plain');
    expect(port.normalizeEmptySurface()).toBe(false);
    caretAt(surface, 2);
    expect(port.isCaretInside()).toBe(true);
    expect(port.charBeforeCaret()).toBe('l');
    window.getSelection()!.removeAllRanges();
    expect(port.isCaretInside()).toBe(false);
    expect(port.ensureCaretInside()).toBe(true);
    expect(port.charBeforeCaret()).toBe('n'); // end of 'plain'
  });

  it('renderHtml collapses a stored bare-br empty state', () => {
    const { port, surface } = makePort();
    port.renderHtml('<br>');
    expect(surface.innerHTML).toBe('');
    port.renderHtml('<h1><br></h1>');
    expect(surface.innerHTML).toBe('');
  });

  it('setHtml commits through the hook', () => {
    let committed = '';
    const surface = document.createElement('div');
    document.body.append(surface);
    const port = new ModelPort(surface, {
      sanitize: sanitizeNoteHtml,
      onDocumentReplaced: () => {
        committed = port.getHtml();
      },
    });
    port.setHtml('committed <b>content</b>');
    expect(committed).toBe('committed <b>content</b>');
  });
});

describe('insertText with selectInserted — the multi-line indent gesture', () => {
  it('replaces the selection, keeps the replacement selected, undoes whole', () => {
    const { port, surface } = makePort();
    port.renderHtml('one\ntwo');
    // "one\ntwo" renders as a single text node (pre-wrap renders the \n).
    selectRange(surface, 0, 7);
    const replacement = '\tone\n\ttwo';

    expect(port.insertText(replacement, { selectInserted: true })).toBe(true);

    // The port owns the change: the surface holds the replacement …
    expect(port.getText()).toBe(replacement);
    // … and it stays SELECTED, so a repeated Tab/Shift+Tab applies to the
    // same lines.
    const selection = window.getSelection();
    expect(selection?.toString()).toBe(replacement);

    // One command, one undo step: the whole indent vanishes in one press.
    expect(port.undo()).toBe(true);
    expect(port.getText()).toBe('one\ntwo');
  });

  it('a plain insertText still collapses the caret at the end', () => {
    const { port, surface } = makePort();
    port.renderHtml('hello');
    selectRange(surface, 0, 5);
    port.insertText('world');
    const selection = window.getSelection();
    expect(selection?.isCollapsed).toBe(true);
  });
});

describe('IME composition — composed input joins the history', () => {
  it('a composition is one undo step (undo restores the pre-composition state)', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);

    // The browser's IME sequence: compositionstart, the composed text
    // lands natively (insertCompositionText), compositionend.
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    // No beforeinput/input of the engine's own pipeline fires mid-IME
    // (the guards return early), the text arrives by native edit:
    surface.append('こんにちは');
    surface.dispatchEvent(new Event('compositionend', { bubbles: true }));

    expect(port.getText()).toBe('こんにちは');

    // THE regression: undo must remove the composed phrase — before the
    // fix, no group ever opened and undo walked straight past it.
    expect(port.undo()).toBe(true);
    expect(port.getText()).toBe('');
  });

  it('typing before the composition shares its burst (one undo for the phrase)', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);

    nativeEdit(
      surface,
      'insertText',
      () => {
        surface.append('ka');
      },
      'ka',
    );
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    surface.append('nn');
    surface.dispatchEvent(new Event('compositionend', { bubbles: true }));

    // "ka" + composition = the one burst the group opened before "ka".
    expect(port.undo()).toBe(true);
    expect(port.getText()).toBe('');
  });
});

describe('the placeholder mirror — [data-empty] tracks text, not element shape', () => {
  /** MutationObserver callbacks land as microtasks — flush them out. */
  const flushObservers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('THE GLITCH: a stored "text + br" surface (legacy soft breaks) keeps the placeholder off', async () => {
    // Older builds stored their line breaks as brs next to text. CSS
    // cannot see text nodes — :has(> br:only-child) matched this shape and
    // painted the placeholder over the user's typed words.
    const { surface } = makePort('fffffffffffff<br>second line');
    expect(surface.innerHTML).toBe('fffffffffffff<br>second line');
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);
  });

  it('an empty surface carries it, a bare stored br collapses and still carries it', async () => {
    const { surface } = makePort();
    expect(surface.hasAttribute('data-empty')).toBe(true);

    const other = makePort('<br>');
    expect(other.surface.innerHTML).toBe(''); // the load path collapses it
    await flushObservers();
    expect(other.surface.hasAttribute('data-empty')).toBe(true);
  });

  it('native typing drops it; deleting everything brings it back', async () => {
    const { port, surface } = makePort();
    caretAt(surface, 0);

    nativeEdit(
      surface,
      'insertText',
      () => {
        surface.textContent = 'words';
      },
      'words',
    );
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);

    caretAt(surface, 0);
    nativeEdit(surface, 'deleteContentBackward', () => {
      surface.innerHTML = '';
    });
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(true);
    expect(port.getText()).toBe('');
  });

  it('an armed empty list keeps it off (deliberate structure, not an empty note)', async () => {
    const { surface } = makePort();
    surface.innerHTML = '<ul><li><br></li></ul>';
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);
  });

  it('a styled caret run keeps it off (the armed-format empty state)', async () => {
    const { surface } = makePort();
    surface.innerHTML = '<span style="color: red">\u200b</span>';
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);
  });

  it('media keeps it off (an hr alone is content)', async () => {
    const { surface } = makePort('<hr>');
    expect(surface.innerHTML).toBe('<hr>');
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);
  });

  it('whitespace-only reads empty (the app\u2019s own empty rule for text)', async () => {
    const { surface } = makePort('   ');
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(true);
  });

  it('parks with the engine and resyncs on unpark', async () => {
    const { port, surface } = makePort('words');
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);

    // A Markdown note takes the host: the mirror must stop answering.
    port.setInert(true);
    surface.innerHTML = '<div class="markdown-surface"><p><br></p></div>';
    await flushObservers();
    expect(surface.hasAttribute('data-empty')).toBe(false);

    // Coming home: the mirror reads the host as it stands.
    surface.innerHTML = '';
    port.setInert(false);
    expect(surface.hasAttribute('data-empty')).toBe(true);
  });
});

/** Enter, the way the browser sends it — with the default action only
 *  applied when nothing intercepted the beforeinput. */
function nativeEnter(surface: HTMLElement, apply: () => void): boolean {
  const before = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(before, 'inputType', { value: 'insertParagraph' });
  surface.dispatchEvent(before);
  const handled = before.defaultPrevented;
  if (!handled) {
    apply();
    const after = new Event('input', { bubbles: true });
    Object.defineProperty(after, 'inputType', { value: 'insertParagraph' });
    surface.dispatchEvent(after);
  }
  return handled;
}

/** Places the collapsed caret at raw offset 0 of a list item's text. */
function caretAtListItemStart(surface: HTMLElement, itemIndex: number): void {
  const item = surface.querySelectorAll('li')[itemIndex];
  const text = item?.firstChild;
  if (!item || !text || text.nodeType !== Node.TEXT_NODE) {
    throw new Error(`list item ${itemIndex} has no leading text node`);
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(text, 0);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Places the collapsed caret on a block's childIndex (an element caret). */
function caretAtBlockChild(surface: HTMLElement, blockIndex: number, childIndex: number): void {
  const block = surface.children[blockIndex] as HTMLElement | undefined;
  if (!block) {
    throw new Error(`no block ${blockIndex}`);
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(block, childIndex);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The closest block tag around the caret, or null at bare root text. */
function caretBlockTag(surface: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  let el =
    selection.getRangeAt(0).startContainer instanceof HTMLElement
      ? (selection.getRangeAt(0).startContainer as HTMLElement)
      : selection.getRangeAt(0).startContainer.parentElement;
  while (el && el !== surface) {
    if (/^(DIV|P|H1|H2|H3|BLOCKQUOTE|PRE|LI|TD|TH)$/.test(el.tagName)) {
      return el.tagName;
    }
    el = el.parentElement;
  }
  return null;
}

describe('history — the burst flag survives every history walk', () => {
  it('typing after an undo opens a NEW group (type, undo, type, undo)', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    nativeEdit(surface, 'insertText', () => {
      surface.append('first burst');
    });
    expect(port.canUndo()).toBe(true);
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('');
    // The regression: the burst flag stayed armed after the undo, so this
    // burst "continued" a popped group — nothing it typed was undoable.
    nativeEdit(surface, 'insertText', () => {
      surface.append('second burst');
    });
    expect(port.canUndo()).toBe(true);
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('');
  });

  it('typing after a document switch opens a NEW group', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    nativeEdit(surface, 'insertText', () => {
      surface.append('note a');
    });
    // Switching notes renders a fresh document into the host.
    port.renderHtml('');
    nativeEdit(surface, 'insertText', () => {
      surface.append('note b');
    });
    expect(port.canUndo()).toBe(true);
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('');
  });

  it('a parked engine carries no open burst home', () => {
    const { port, surface } = makePort();
    port.renderHtml('');
    caretAt(surface, 0);
    nativeEdit(surface, 'insertText', () => {
      surface.append('before the park');
    });
    port.setInert(true);
    port.setInert(false);
    nativeEdit(surface, 'insertText', () => {
      surface.append('after the park');
    });
    expect(port.canUndo()).toBe(true);
    expect(port.undo()).toBe(true);
    expect(port.getHtml()).toBe('before the park');
  });
});

describe('Backspace at the start of the first list item leaves the list', () => {
  it('a single top-level item becomes a plain paragraph', () => {
    const { port, surface } = makePort('<ul><li>solo item</li></ul>');
    caretAtListItemStart(surface, 0);
    expect(port.unindentAtBlockStart()).toBe(true);
    expect(port.getHtml()).toBe('<div>solo item</div>');
  });

  it('the first of several items lifts out, the list keeps the rest', () => {
    const { port, surface } = makePort('<ul><li>head item</li><li>tail item</li></ul>');
    caretAtListItemStart(surface, 0);
    expect(port.unindentAtBlockStart()).toBe(true);
    expect(port.getHtml()).toBe('<div>head item</div><ul><li>tail item</li></ul>');
  });

  it('an item with content above keeps the native merge (null)', () => {
    const { port, surface } = makePort('<ul><li>item one</li><li>item two</li></ul>');
    caretAtListItemStart(surface, 1);
    expect(port.unindentAtBlockStart()).toBeNull();
  });

  it('an item after a nested sublist keeps the native merge (null)', () => {
    const { port, surface } = makePort(
      '<ul><li>outer<ul><li>sub</li></ul></li><li>after the sublist</li></ul>',
    );
    // querySelectorAll('li') is flat: [outer, sub, after the sublist]
    caretAtListItemStart(surface, 2);
    expect(port.unindentAtBlockStart()).toBeNull();
  });

  it('a nested first item lifts one level', () => {
    const { port, surface } = makePort('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    caretAtListItemStart(surface, 1);
    expect(port.unindentAtBlockStart()).toBe(true);
    expect(port.getHtml()).toBe('<ul><li>outer</li><li>inner</li></ul>');
  });

  it('a checklist first item exits the same way (checkbox gone)', () => {
    const { port, surface } = makePort(
      '<ul data-rich-checklist="true"><li data-checked="false">task one</li><li data-checked="true">task two</li></ul>',
    );
    caretAtListItemStart(surface, 0);
    expect(port.unindentAtBlockStart()).toBe(true);
    expect(port.getHtml()).toBe(
      '<div>task one</div><ul data-rich-checklist="true"><li data-checked="true">task two</li></ul>',
    );
  });

  it('the caret mid-item does not lift (null — native delete runs)', () => {
    const { port, surface } = makePort('<ul><li>item text</li></ul>');
    const text = surface.querySelector('li')!.firstChild as Text;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, 5);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(port.unindentAtBlockStart()).toBeNull();
  });
});

describe("Enter's block escapes (the double-Enter exit)", () => {
  it('the style buttons work on an EMPTY note (the block materializes empty)', () => {
    const { port, surface } = makePort('');
    caretAt(surface, 0);
    // Heading 1 on a fresh note: the block appears, the typing lands in it.
    expect(port.applyBlockFormat('h1')).toBe(true);
    expect(port.getHtml()).toBe('<h1><br></h1>');
    nativeEdit(surface, 'insertText', () => {
      const h1 = surface.querySelector('h1')!;
      h1.innerHTML = 'typed title'; // Chromium replaces the br skeleton
    });
    expect(port.getHtml()).toBe('<h1>typed title</h1>');
    // Same for a quote and a code block on a fresh note.
    const quote = makePort('');
    caretAt(quote.surface, 0);
    expect(quote.port.applyBlockFormat('blockquote')).toBe(true);
    expect(quote.port.getHtml()).toBe('<blockquote><br></blockquote>');
    const code = makePort('');
    caretAt(code.surface, 0);
    expect(code.port.applyBlockFormat('pre')).toBe(true);
    expect(code.port.getHtml()).toBe('<pre><br></pre>');
  });

  it('Enter on an EMPTY quote line leaves the quote', () => {
    const { port, surface } = makePort('<blockquote>quoted words</blockquote>');
    caretAt(surface, 12); // end of the quote text
    // First Enter: native continues the quote with an empty line.
    const first = nativeEnter(surface, () => {
      surface.innerHTML = '<blockquote>quoted words</blockquote><blockquote><br></blockquote>';
      caretAtBlockChild(surface, 1, 0);
    });
    expect(first).toBe(false);
    expect(port.getHtml()).toBe(
      '<blockquote>quoted words</blockquote><blockquote><br></blockquote>',
    );
    // Second Enter on the empty line: the quote converts to a paragraph.
    const second = nativeEnter(surface, () => {
      throw new Error('the native Enter must not run when the escape handled it');
    });
    expect(second).toBe(true);
    expect(port.getHtml()).toBe('<blockquote>quoted words</blockquote><p><br></p>');
  });

  it('Enter at the end of quote TEXT keeps the native continuation', () => {
    const { surface } = makePort('<blockquote>quoted words</blockquote>');
    caretAt(surface, 12);
    const handled = nativeEnter(surface, () => {
      surface.innerHTML = '<blockquote>quoted words</blockquote><blockquote><br></blockquote>';
      caretAtBlockChild(surface, 1, 0);
    });
    expect(handled).toBe(false);
  });

  it('Enter on the code block\u2019s trailing empty line leaves the code', () => {
    const { port, surface } = makePort('<pre>code line</pre>');
    caretAt(surface, 9); // end of the code text
    // First Enter: native appends the line break inside the pre.
    const first = nativeEnter(surface, () => {
      surface.innerHTML = '<pre>code line<br></pre>';
      caretAtBlockChild(surface, 0, 2); // Chromium leaves the caret after the br
    });
    expect(first).toBe(false);
    expect(port.getHtml()).toBe('<pre>code line<br></pre>');
    // Second Enter on the empty last line: the code keeps its text, the
    // trailing break splits off into a plain paragraph that takes the caret.
    const second = nativeEnter(surface, () => {
      throw new Error('the native Enter must not run when the escape handled it');
    });
    expect(second).toBe(true);
    expect(port.getHtml()).toBe('<pre>code line</pre><p><br></p>');
    expect(caretBlockTag(surface)).toBe('P');
    expect(caretStreamOffset(surface)).toBe(9);
  });

  it('Enter at the end of code TEXT (before the trailing break) stays native', () => {
    const { port, surface } = makePort('<pre>code line<br></pre>');
    caretAt(surface, 9); // a text caret at the end of "code line"
    const handled = nativeEnter(surface, () => {
      surface.innerHTML = '<pre>code line<br><br></pre>';
      caretAtBlockChild(surface, 0, 3);
    });
    expect(handled).toBe(false);
    expect(port.getHtml()).toBe('<pre>code line<br><br></pre>');
  });

  it('Enter mid-code (a blank line BETWEEN code lines) stays native', () => {
    const { surface } = makePort('<pre>one<br><br>two</pre>');
    // A text caret at the start of "two" — inside the code, not on its tail.
    caretAt(surface, 3);
    const handled = nativeEnter(surface, () => {
      surface.innerHTML = '<pre>one<br><br><br>two</pre>';
    });
    expect(handled).toBe(false);
  });

  it('an entirely blank code block becomes a paragraph outright', () => {
    // Built through the command pipeline (the toolbar's Code block click):
    // renderHtml would collapse the blank pre away as an empty surface.
    const { port, surface } = makePort('');
    caretAt(surface, 0);
    expect(port.applyBlockFormat('pre')).toBe(true);
    caretAtBlockChild(surface, 0, 0);
    const handled = nativeEnter(surface, () => {
      throw new Error('the native Enter must not run when the escape handled it');
    });
    expect(handled).toBe(true);
    expect(port.getHtml()).toBe('<p><br></p>');
  });

  it('paragraphs, headings and cells keep the native Enter', () => {
    const { port, surface } = makePort('<h1>Title</h1><p>body words</p>');
    caretAt(surface, 5);
    expect(nativeEnter(surface, () => undefined)).toBe(false);
    caretAt(surface, 5);
    expect(nativeEnter(surface, () => undefined)).toBe(false);
    void port;
  });
});
