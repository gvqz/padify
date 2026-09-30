import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeNoteHtml } from './storage-subset';
import { ModelPort } from './model-port';

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

/** Selects a stream range on the surface (end-safe: a target at the
 *  stream's end resolves to the last text node's tail). */
function selectRange(surface: HTMLElement, from: number, to: number): void {
  const selection = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  const found: { node: Text; raw: number }[] = [];
  let last: { node: Text; raw: number } | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('.padify-math')) {
      continue;
    }
    const visible = (node.nodeValue ?? '').replace(/\u200B/g, '');
    for (const target of [from, to]) {
      if (consumed + visible.length > target) {
        found.push({ node: node as Text, raw: target - consumed });
      }
    }
    consumed += visible.length;
    last = { node: node as Text, raw: visible.length };
  }
  while (found.length < 2 && last) {
    found.push(last);
  }
  if (found.length >= 2) {
    range.setStart(found[0]!.node, found[0]!.raw);
    range.setEnd(found[1]!.node, found[1]!.raw);
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
    // The caret sits at the tail of the inserted run — typing continues
    // natively there (the run is its own text node; the caret is at its end).
    const selection = window.getSelection();
    expect(selection?.getRangeAt(0).startContainer).toBe(surface.lastChild);
    expect(selection?.getRangeAt(0).startOffset).toBe(2);
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
