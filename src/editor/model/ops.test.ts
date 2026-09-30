import { describe, expect, it } from 'vitest';
import { parse, serialize } from './document';
import {
  applyBlockTag,
  clearInlineStyle,
  flipChecklistItem,
  insertPlainText,
  nestListItem,
  plantLink,
  plantMath,
  plantRule,
  plantStyledCaret,
  plantTable,
  removeInlineFormatting,
  retargetAnchorAt,
  runTableActionAt,
  setBlockStyleProp,
  setInlineStyle,
  shiftBlockIndent,
  splitScriptChain,
  toggleListKind,
  toggleMark,
  uncheckEmptyItems,
  unnestListItem,
  unwrapLinkAt,
  wrapLink,
} from './ops';

/**
 * The typed operations, one block per family: parse a model, run the
 * operation over a hand-built coverage, assert the serialized tree. No
 * surface, no port, no browser — the operation layer is pure.
 */

function modelOf(html: string): HTMLElement {
  return parse(html);
}

function out(model: HTMLElement): string {
  return serialize(model);
}

describe('toggleMark', () => {
  it('wraps the uncovered runs, unwraps on the second press', () => {
    const model = modelOf('hello plain world');
    expect(toggleMark(model, [6, 11], 'b').changed).toBe(true);
    expect(out(model)).toBe('hello <b>plain</b> world');

    const again = toggleMark(model, [6, 11], 'b');
    expect(again.changed).toBe(true);
    expect(again.intent).toEqual({ range: [6, 11] });
    expect(out(model)).toBe('hello plain world');
  });

  it('toggles off across nested wrappers in one press', () => {
    const model = modelOf('ab<sup>X<sup>Y</sup>u</sup>cd');
    // Covers X and Y — both wrapped (outer and inner); one press unwraps
    // every level, outermost first.
    expect(toggleMark(model, [2, 4], 'sup').changed).toBe(true);
    expect(out(model)).toBe('abXYucd');
  });

  it('cross-block coverage wraps per run', () => {
    const model = modelOf('<div>aa</div><div>bb</div>');
    toggleMark(model, [0, 4], 'b');
    expect(out(model)).toBe('<div><b>aa</b></div><div><b>bb</b></div>');
  });
});

describe('inline styles', () => {
  it("merges into the covered run's parent span", () => {
    const model = modelOf('<span style="font-size: 24px">Styled line</span>');
    setInlineStyle(model, [0, 11], 'color', '#4285f4');
    expect(out(model)).toBe('<span style="color: #4285f4; font-size: 24px">Styled line</span>');
  });

  it('clearing a declaration unwraps emptied spans entirely', () => {
    const model = modelOf('x<span style="background-color: #d0ebff">glow</span>y');
    clearInlineStyle(model, [0, 7], 'background-color');
    expect(out(model)).toBe('xglowy');
  });

  it('plantStyledCaret drops a zero-width run at the caret', () => {
    const model = modelOf('before');
    const result = plantStyledCaret(model, 6, { 'font-size': '24px' });
    expect(result.changed).toBe(true);
    expect(out(model)).toBe('before<span style="font-size: 24px">\u200B</span>');
  });

  it('removeInlineFormatting strips marks and styled spans, keeps links', () => {
    const model = modelOf(
      '<b>bold</b> and <a href="https://example.test">a link</a> <span style="color: #ff0000">red</span>',
    );
    removeInlineFormatting(model, [0, 26]);
    expect(out(model)).toBe('bold and <a href="https://example.test">a link</a> red');
  });
});

describe('blocks', () => {
  it('applyBlockTag rewrites the covered block, root text materializes', () => {
    const model = modelOf('big title');
    applyBlockTag(model, [0, 9], 'h1');
    expect(out(model)).toBe('<h1>big title</h1>');

    const back = modelOf('<h1>big title</h1>');
    applyBlockTag(back, [0, 9], 'p');
    expect(out(back)).toBe('<p>big title</p>');
  });

  it('setBlockStyleProp materializes root text into a styled div', () => {
    const model = modelOf('Styled line');
    setBlockStyleProp(model, [0, 11], 'text-align', 'center');
    expect(out(model)).toBe('<div style="text-align: center">Styled line</div>');
  });

  it('shiftBlockIndent steps the margin and clamps at zero and the cap', () => {
    const model = modelOf('indented paragraph');
    shiftBlockIndent(model, [0, 18], 1);
    expect(out(model)).toBe('<div style="margin-left: 40px">indented paragraph</div>');
    shiftBlockIndent(model, [0, 18], 1);
    expect(out(model)).toBe('<div style="margin-left: 80px">indented paragraph</div>');
    shiftBlockIndent(model, [0, 18], -1);
    shiftBlockIndent(model, [0, 18], -1);
    expect(out(model)).toBe('<div>indented paragraph</div>');
    shiftBlockIndent(model, [0, 18], -1);
    expect(out(model)).toBe('<div>indented paragraph</div>'); // never negative
  });
});

describe('lists and checklists', () => {
  it('wrap: root text becomes a checklist with the unchecked default', () => {
    const model = modelOf('milk');
    toggleListKind(model, [0, 4], 'checklist');
    expect(out(model)).toBe(
      '<ul data-rich-checklist="true"><li data-checked="false">milk</li></ul>',
    );
  });

  it('conversion: a checklist becomes bullets without dying, then numbers', () => {
    const model = modelOf('<ul data-rich-checklist="true"><li data-checked="true">done</li></ul>');
    toggleListKind(model, [0, 4], 'ul');
    expect(out(model)).toBe('<ul><li>done</li></ul>');
    toggleListKind(model, [0, 4], 'ol');
    expect(out(model)).toBe('<ol><li>done</li></ol>');
  });

  it('checklist OFF lifts items out as paragraphs', () => {
    const model = modelOf(
      '<ul data-rich-checklist="true"><li data-checked="false">a</li><li data-checked="false">b</li></ul>',
    );
    toggleListKind(model, [0, 2], 'checklist');
    expect(out(model)).toBe('<div>a</div><div>b</div>');
  });

  it('flipChecklistItem toggles by (list, item) indices', () => {
    const model = modelOf(
      '<ul data-rich-checklist="true"><li data-checked="false">a</li><li data-checked="false">b</li></ul>',
    );
    flipChecklistItem(model, 0, 1);
    expect(out(model)).toContain('<li data-checked="true">b</li>');
    expect(out(model)).toContain('<li data-checked="false">a</li>');
  });

  it("nest and unnest move the caret's item", () => {
    const model = modelOf('<ul><li>one</li><li>two</li><li>three</li></ul>');
    nestListItem(model, 5); // caret in "two"
    expect(out(model)).toBe('<ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>');
    unnestListItem(model, 5);
    expect(out(model)).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  it('uncheckEmptyItem only touches an empty checked item in a checklist', () => {
    const model = modelOf(
      '<ul data-rich-checklist="true"><li data-checked="true">\u200B</li></ul>',
    );
    uncheckEmptyItems(model);
    expect(out(model)).toContain('data-checked="false"');

    const plain = modelOf('<ul><li data-checked="true"></li></ul>');
    uncheckEmptyItems(plain);
    expect(out(plain)).toContain('data-checked="true"'); // not a checklist — untouched
  });
});

describe('links and math', () => {
  it('wrapLink retargets anchors already covering a segment', () => {
    const model = modelOf('read <a href="https://old.test">this</a> please');
    wrapLink(model, [5, 8], 'https://new.test');
    expect(out(model)).toBe('read <a href="https://new.test">this</a> please');
  });

  it('plantLink drops the href itself as linked text', () => {
    const model = modelOf('see ');
    plantLink(model, 4, 'https://example.test/manual');
    expect(out(model)).toBe(
      'see <a href="https://example.test/manual">https://example.test/manual</a>',
    );
  });

  it('unwrapLinkAt and retargetAnchorAt address the anchor at the caret', () => {
    const model = modelOf('go <a href="https://a.test">there</a> now');
    retargetAnchorAt(model, 4, 'https://b.test');
    expect(out(model)).toContain('href="https://b.test"');
    unwrapLinkAt(model, 4);
    expect(out(model)).toBe('go there now');
  });

  it('plantMath drops an empty shell at the caret', () => {
    const model = modelOf('Euler said ');
    plantMath(model, 11, 'e^{i\\pi} + 1 = 0');
    expect(out(model)).toBe(
      'Euler said <span class="padify-math" data-latex="e^{i\\pi} + 1 = 0"></span>',
    );
  });
});

describe('tables', () => {
  it('plantTable splices a rows×cols table at the caret', () => {
    const model = modelOf('');
    plantTable(model, 0, 2, 3);
    expect(out(model)).toBe(
      '<table><tbody><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></tbody></table><div><br></div>',
    );
    expect(model.querySelectorAll('tr').length).toBe(2);
    expect(model.querySelectorAll('td').length).toBe(6);
  });

  it('plantTable from inside a list item escapes the list (ul followed by div)', () => {
    const model = modelOf(
      '<ul data-rich-checklist="true"><li data-checked="false">groceries</li></ul>',
    );
    plantTable(model, 9, 2, 1); // caret at the end of the item
    const painted = model;
    const ul = painted.querySelector('ul')!;
    expect(ul.nextElementSibling?.tagName).toBe('DIV'); // the pin the e2e makes
    expect(painted.querySelector('li table')).toBeNull(); // never nested in the item
  });

  it('runTableAction inserts and deletes rows and columns', () => {
    const model = modelOf(
      '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    );
    const table = model.querySelector('table') as HTMLTableElement;
    const cell = table.querySelector('td') as HTMLTableCellElement;
    runTableActionAt(model, table, cell, 'col-right');
    expect(out(model)).toBe(
      '<table><tbody><tr><td>a</td><td></td><td>b</td></tr><tr><td>c</td><td></td><td>d</td></tr></tbody></table>',
    );
    runTableActionAt(model, table, cell, 'row-below');
    expect(model.querySelectorAll('tr').length).toBe(3);
    runTableActionAt(model, table, cell, 'table-delete');
    expect(out(model)).toBe('');
  });

  it('plantRule inserts a divider and a trailing paragraph at the end', () => {
    const model = modelOf('text end');
    plantRule(model, 8);
    const markup = out(model);
    expect(markup).toContain('<hr>');
    expect(markup.endsWith('<div><br></div>')).toBe(true);
  });

  it('plantRule from inside a list escapes it', () => {
    const model = modelOf('<ul><li>item</li></ul>');
    plantRule(model, 4);
    expect(model.querySelector('li hr')).toBeNull();
    expect(out(model)).toContain('<hr>');
  });
});

describe('scripts', () => {
  it('splitScriptChain splits nested wrappers at the caret with a guard', () => {
    const model = modelOf('ab<sup>X<sup>Y</sup>u</sup>cd');
    // Caret between Y and u — after Y, before the outer's 'u': the e2e
    // seed position (a0 b1 X2 Y3 — the caret at Y's end, offset 4).
    const result = splitScriptChain(model, 4, 'sup', null);
    expect(result.changed).toBe(true);
    const markup = out(model);
    // A guard carries the caret out of every level; the scripted ink keeps
    // its runs (X in the outer, Y in the inner); the sup count is 2.
    expect(markup).toContain('\u200B');
    expect(markup).toContain('<sup>Y</sup>');
    expect(markup).toContain('X');
    expect(model.querySelectorAll('sup').length).toBe(2);
  });
});

describe('insertPlainText', () => {
  it('inserts at the caret and replaces a coverage', () => {
    const model = modelOf('hello ');
    const result = insertPlainText(model, [6, 6], 'world');
    expect(result.changed).toBe(true);
    expect(out(model)).toBe('hello world');
    expect(result.intent).toEqual({
      spot: { kind: 'text', node: model.lastChild as Text, raw: 5 },
    });

    insertPlainText(model, [0, 5], 'goodbye');
    expect(out(model)).toBe('goodbye world');
  });
});
