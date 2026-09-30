import { describe, expect, it } from 'vitest';

describe('jsdom capability probe (engine tests build on these)', () => {
  it('supports Selection with ranges on a detached live tree', () => {
    const div = document.createElement('div');
    div.innerHTML = '<b>hello</b> world';
    document.body.append(div);
    const range = document.createRange();
    range.setStart(div.firstChild!.firstChild!, 2);
    range.setEnd(div.lastChild!, 3);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.rangeCount).toBe(1);
    div.remove();
  });

  it('constructs InputEvent with inputType and data', () => {
    const div = document.createElement('div');
    let seen = '';
    div.addEventListener('input', (event) => {
      const input = event as InputEvent;
      seen = `${input.inputType ?? ''}|${input.data ?? ''}`;
    });
    const evt = new (window as unknown as { InputEvent: typeof InputEvent }).InputEvent('input', {
      bubbles: true,
    });
    Object.defineProperty(evt, 'inputType', { value: 'insertText' });
    Object.defineProperty(evt, 'data', { value: 'X' });
    div.dispatchEvent(evt);
    expect(seen).toBe('insertText|X');
  });

  it('splits text nodes and reports bounding rects as zeros', () => {
    const div = document.createElement('div');
    div.append('hello');
    const text = div.firstChild as Text;
    text.splitText(2);
    expect(div.childNodes.length).toBe(2);
    expect(div.getBoundingClientRect().left).toBe(0);
  });

  it('walks TreeWalker over text nodes', () => {
    const div = document.createElement('div');
    div.innerHTML = 'a<b>bc</b>d';
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    const seen: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      seen.push(node.nodeValue ?? '');
    }
    expect(seen).toEqual(['a', 'bc', 'd']);
  });
});
