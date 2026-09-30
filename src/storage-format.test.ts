import { describe, expect, it } from 'vitest';
import { sanitizeNoteHtml } from './tabs';

/**
 * The storage format contract — the subset a note's HTML may occupy.
 *
 * This is not a characterization of the sanitizer (that lives beside it in
 * tabs.characterization.test.ts). It is the SPEC of the format itself: the
 * canonical form of every construct the subset admits, asserted to be a
 * fixed point of sanitizeNoteHtml. Whatever serializes notes to storage —
 * today the contenteditable DOM walked by the sanitizer, tomorrow a
 * document-model engine behind editor/port.ts — must emit exactly these
 * forms, because everything downstream (the sanitizer, the share viewer,
 * the cloud round trip, byte-exact reloads) treats this subset as the
 * schema. When the editor engine is swapped, this file is the schema spec
 * the new serializer is written against; if a swap output stops being a
 * fixed point here, it is wrong, not the corpus.
 */

/**
 * Canonical form per construct family. Attribute order matters and is
 * pinned: the sanitizer re-sets attributes in its allowlist order, so a
 * canonical string carries them in that order (style before data-checked
 * on LI, class before data-latex on the math shell). Style declarations
 * are the sanitizer's own serialization: `prop: value`, joined by `; `.
 */
const CORPUS: Record<string, string> = {
  'inline emphasis': '<b>bold</b> <strong>strong</strong> <i>italic</i> <em>em</em>',
  underline_and_strike:
    '<u>underlined</u> <s>struck</s> <strike>struck</strike> <del>deleted</del>',
  superscript_subscript: 'H<sub>2</sub>O, x<sup>2</sup>',
  line_break: 'line one<br>line two',
  paragraphs: '<p>first</p><p>second</p>',
  divs: '<div>plain division</div>',
  headings: '<h1>one</h1><h2>two</h2><h3>three</h3>',
  lists: '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
  nested_lists: '<ul><li>outer<ul><li>inner</li></ul></li></ul>',
  blockquote: '<blockquote>quoted words</blockquote>',
  preformatted: '<pre>fixed\n  width</pre>',
  rule: '<p>above</p><hr><p>below</p>',
  table_full:
    '<table><thead><tr><th>head</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>',
  table_bare: '<table><tbody><tr><td>no thead</td></tr></tbody></table>', // parser-inserted tbody is canonical
  links:
    '<a href="https://example.test/page">web</a> <a href="mailto:someone@example.test">mail</a> <a href="#anchor">in-page</a> <a href="/relative">relative</a>',
  inline_color: '<span style="color: #ff0000">red words</span>',
  inline_background: '<span style="background-color: rgba(255, 235, 59, 0.5)">highlighted</span>',
  inline_size: '<span style="font-size: 18px">bigger</span>',
  inline_family: '<span style="font-family: Georgia, serif">serif words</span>',
  inline_style_stack:
    '<span style="color: #00ff00; font-size: 14px; font-family: Georgia, serif">stacked</span>',
  block_alignment:
    '<p style="text-align: center">centered</p><h2 style="text-align: right">right</h2><div style="text-align: justify">justified</div>',
  block_indent: '<blockquote style="margin-left: 40px">pushed over</blockquote>',
  // Cell styles are gated to the BLOCK property list (text-align,
  // margin-left) — background shading is not in the subset.
  table_cell_align:
    '<table><tbody><tr><td style="text-align: center">centered cell</td></tr></tbody></table>',
  checklist:
    '<ul data-rich-checklist="true"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>',
  // LI styles are gated to the BLOCK list too — item color is not in the
  // subset (only SPAN carries inline styling).
  checklist_item_block_style:
    '<ul data-rich-checklist="true"><li style="margin-left: 20px" data-checked="true">indented done</li></ul>',
  math_shell: 'Inline <span class="padify-math" data-latex="\\frac{1}{2}"></span> math.',
  math_shell_display: '<p><span class="padify-math" data-latex="x^2 + y^2 = z^2"></span></p>',
  bare_text: 'words with no markup at all',
};

/** Inputs that are NOT in the subset, in one pile — see the idempotence test. */
const HOSTILE = [
  '<script>alert(1)</script>after',
  '<b onclick="steal()">bold</b>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,evil">data</a>',
  '<a href="vbscript:x">vbs</a>',
  '<span style="color: url(javascript:alert(1))">bad color</span>',
  '<span style="background: red">shorthand not allowed</span>',
  '<span style="font-size: 18em">bad unit</span>',
  '<span style="position: fixed; top: 0">layout hijack</span>',
  '<h4>four</h4>',
  '<code>inline code unwraps</code>',
  '<font color="red">legacy font</font>',
  '<ul data-rich-checklist="maybe"><li>uncertain</li></ul>',
  '<ul data-rich-checklist="true"><li data-checked="yes">bad state</li></ul>',
  '<span class="padify-math" data-latex="">empty latex</span>',
  '<span class="padify-math" data-latex="x">rendered children never store<span>inner</span></span>',
  '<section><b>unknown wrapper</b></section>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="https://evil.test"></iframe>',
].join('\n');

describe('the storage format contract', () => {
  it('every canonical construct is a fixed point of the sanitizer', () => {
    // sanitize(x) === x for canonical x: the subset is exactly the set of
    // the sanitizer's fixed points, so a serializer emitting corpus forms
    // needs no second pass — and anything that ISN'T a fixed point would
    // be rewritten on every load/save cycle forever.
    for (const [name, canonical] of Object.entries(CORPUS)) {
      expect(sanitizeNoteHtml(canonical), name).toBe(canonical);
    }
  });

  it('the sanitizer is idempotent on hostile input', () => {
    // One pass must land on a fixed point: sanitize(sanitize(x)) ===
    // sanitize(x). A second pass that changes anything means every stored
    // note drifts on each open — the corruption the whole pipeline exists
    // to prevent.
    const once = sanitizeNoteHtml(HOSTILE);
    expect(sanitizeNoteHtml(once)).toBe(once);
  });

  it('hostile input lands inside the corpus, not beside it', () => {
    const once = sanitizeNoteHtml(HOSTILE);

    // The dangerous parts are gone…
    expect(once).not.toContain('<script');
    expect(once).not.toContain('onclick');
    expect(once).not.toContain('javascript:');
    expect(once).not.toContain('data:text/html');
    expect(once).not.toContain('url(');
    expect(once).not.toContain('<h4');
    expect(once).not.toContain('<code');
    expect(once).not.toContain('<font');
    expect(once).not.toContain('<iframe');
    expect(once).not.toContain('<img');

    // …and what survives keeps its meaning as text or subset markup.
    expect(once).toContain('<b>bold</b>');
    expect(once).toContain('click'); // the link's text outlives its href
    expect(once).toContain('after');
  });

  it('the math shell stores as the shell alone, children never', () => {
    // Whatever the engine renders into the shell, storage keeps exactly
    // class + data-latex — the KaTeX markup is a display artifact. The
    // denylisted \href survives STORAGE (render-time refusal is a
    // separate wall, see editor/math.ts): the bytes must round-trip home
    // untouched, even when this build refuses to draw them.
    const stored = sanitizeNoteHtml(
      '<span class="padify-math" data-latex="\\href{https://example.test}{link}"><span class="katex">rendered</span></span>',
    );
    expect(stored).toBe(
      '<span class="padify-math" data-latex="\\href{https://example.test}{link}"></span>',
    );
  });
});
