import { describe, expect, it } from 'vitest';
import {
  collapseEmptySurface,
  formatStyleAttr,
  hasStyledCaretRun,
  parse,
  parseStyleAttr,
  serialize,
  setStyleProp,
  surfaceLooksEmpty,
} from './document';

/**
 * The model's parse/serialize round trip — the same contract the storage
 * format spec pins for the sanitizer, extended to the shapes the LEGACY
 * engine used to store (arbitrary nesting): an untouched note must cross
 * the engine byte-exact, or every save after the swap would rewrite
 * every note in existence.
 */

/** Corpus forms from storage-format.test.ts (the spec this engine emits). */
const CORPUS: Record<string, string> = {
  inline_marks: '<b>bold</b> <strong>strong</strong> <i>italic</i> <em>em</em>',
  underline_strike: '<u>underlined</u> <s>struck</s> <strike>struck</strike> <del>deleted</del>',
  scripts: 'H<sub>2</sub>O, x<sup>2</sup>',
  br: 'line one<br>line two',
  paragraphs: '<p>first</p><p>second</p>',
  divs: '<div>plain division</div>',
  headings: '<h1>one</h1><h2>two</h2><h3>three</h3>',
  lists: '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
  nested_lists: '<ul><li>outer<ul><li>inner</li></ul></li></ul>',
  quote: '<blockquote>quoted words</blockquote>',
  pre: '<pre>fixed\n  width</pre>',
  rule: '<p>above</p><hr><p>below</p>',
  table_full:
    '<table><thead><tr><th>head</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>',
  table_bare: '<table><tbody><tr><td>no thead</td></tr></tbody></table>',
  links:
    '<a href="https://example.test/page">web</a> <a href="mailto:someone@example.test">mail</a> <a href="#anchor">in-page</a> <a href="/relative">relative</a>',
  inline_color: '<span style="color: #ff0000">red words</span>',
  inline_background: '<span style="background-color: rgba(255, 235, 59, 0.5)">highlighted</span>',
  inline_size: '<span style="font-size: 18px">bigger</span>',
  inline_family: '<span style="font-family: Georgia, serif">serif words</span>',
  inline_stack:
    '<span style="color: #00ff00; font-size: 14px; font-family: Georgia, serif">stacked</span>',
  block_alignment:
    '<p style="text-align: center">centered</p><h2 style="text-align: right">right</h2><div style="text-align: justify">justified</div>',
  block_indent: '<blockquote style="margin-left: 40px">pushed over</blockquote>',
  cell_align:
    '<table><tbody><tr><td style="text-align: center">centered cell</td></tr></tbody></table>',
  checklist:
    '<ul data-rich-checklist="true"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>',
  checklist_item_style:
    '<ul data-rich-checklist="true"><li style="margin-left: 20px" data-checked="true">indented done</li></ul>',
  math: 'Inline <span class="padify-math" data-latex="\\frac{1}{2}"></span> math.',
  math_display: '<p><span class="padify-math" data-latex="x^2 + y^2 = z^2"></span></p>',
  bare_text: 'words with no markup at all',
  styled_caret_run: 'before<span style="font-size: 24px">\u200B</span>after',
};

/** Legacy shapes the old engine actually stored — nesting the subset admits. */
const LEGACY: Record<string, string> = {
  table_inside_div: '<div><table><tbody><tr><td>a</td></tr></tbody></table><div><br></div></div>',
  list_with_table: '<ul><li>item<table><tbody><tr><td>t</td></tr></tbody></table></li></ul>',
  div_in_li: '<ul><li>one<div>two</div></li></ul>',
  quote_wrapping_list: '<blockquote><ul><li>in a quote</li></ul></blockquote>',
  empty_div_br: '<div><br></div>',
  deep_marks: '<b><i><u>all three</u></i></b>',
  marker_span_stored: 'x<span>\u200B</span>y',
};

const HOSTILE = [
  '<script>alert(1)</script>after',
  '<b onclick="steal()">bold</b>',
  '<a href="javascript:alert(1)">click</a>',
  '<span style="font-size: 18em">bad unit</span>',
  '<h4>four</h4>',
  '<font color="red">legacy font</font>',
  '<img src=x onerror=alert(1)>',
].join('\n');

describe('parse/serialize round trips', () => {
  it('every corpus form is a fixed point of the model', () => {
    for (const [name, canonical] of Object.entries(CORPUS)) {
      expect(serialize(parse(canonical)), name).toBe(canonical);
    }
  });

  it('legacy nested shapes cross the model byte-exact', () => {
    for (const [name, stored] of Object.entries(LEGACY)) {
      expect(serialize(parse(stored)), name).toBe(stored);
    }
  });

  it('hostile input lands inside the subset (the sanitizer is the parse)', () => {
    const once = serialize(parse(HOSTILE));
    expect(once).not.toContain('<script');
    expect(once).not.toContain('onclick');
    expect(once).not.toContain('<font');
    expect(once).not.toContain('<img');
    expect(once).toContain('<b>bold</b>');
    expect(serialize(parse(once))).toBe(once);
  });

  it('a rendered math shell absorbs to the stored shell (children never)', () => {
    const model = parse(
      'x<span class="padify-math" data-latex="a+b" data-rendered="1" data-math-id="m3"><span class="katex">rendered junk</span></span>y',
    );
    expect(serialize(model)).toBe('x<span class="padify-math" data-latex="a+b"></span>y');
  });
});

describe('the empty-surface rules', () => {
  it('collapses bare brs and emptied skeletons', () => {
    for (const stored of ['<br>', '<h1><br></h1>', '<ul><li><br></li></ul>', '<div><br></div>']) {
      const surface = document.createElement('div');
      surface.innerHTML = stored;
      expect(collapseEmptySurface(surface), stored).toBe(true);
      expect(surface.innerHTML).toBe('');
    }
  });

  it('keeps meaningful surfaces and styled caret runs', () => {
    const withMedia = document.createElement('div');
    withMedia.innerHTML = '<p>above</p><hr>';
    expect(collapseEmptySurface(withMedia)).toBe(false);

    const withRun = document.createElement('div');
    withRun.innerHTML = 'before<span style="font-size: 24px">\u200B</span>';
    expect(collapseEmptySurface(withRun)).toBe(false);
    expect(hasStyledCaretRun(withRun)).toBe(true);

    const withText = document.createElement('div');
    withText.innerHTML = 'real words';
    expect(collapseEmptySurface(withText)).toBe(false);
    expect(surfaceLooksEmpty(withText)).toBe(false);
  });

  it('surfaceLooksEmpty agrees with the collapse guard set', () => {
    const empty = document.createElement('div');
    empty.innerHTML = '<h1><br></h1>';
    expect(surfaceLooksEmpty(empty)).toBe(true);
    const guarded = document.createElement('div');
    guarded.innerHTML = '<span>\u200B</span>';
    expect(surfaceLooksEmpty(guarded)).toBe(true); // empty of text —
    // …but the collapse pass still refuses it (the styled run is deliberate).
    expect(collapseEmptySurface(guarded)).toBe(false);
  });
});

describe('style attribute helpers', () => {
  it('parses and re-emits in canonical order', () => {
    const props = parseStyleAttr('font-size: 24px; color: #4285f4');
    expect(props.get('font-size')).toBe('24px');
    expect(formatStyleAttr(props, 'inline')).toBe('color: #4285f4; font-size: 24px');
  });

  it('setStyleProp writes, removes, and drops the attribute when empty', () => {
    const span = document.createElement('span');
    setStyleProp(span, 'color', '#ff0000', 'inline');
    setStyleProp(span, 'font-size', '18px', 'inline');
    expect(span.getAttribute('style')).toBe('color: #ff0000; font-size: 18px');
    setStyleProp(span, 'color', null, 'inline');
    expect(span.getAttribute('style')).toBe('font-size: 18px');
    setStyleProp(span, 'font-size', null, 'inline');
    expect(span.hasAttribute('style')).toBe(false);
  });
});
