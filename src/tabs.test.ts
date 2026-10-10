import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  legacyTextToHtml,
  sanitizeNoteHtml,
  htmlToText,
  deriveTabTitle,
  WELCOME_HTML,
  type NoteTab,
} from './tabs';

const tab = (overrides: Partial<NoteTab> = {}): NoteTab => ({
  id: 't1',
  name: null,
  content: '',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('math shell storage', () => {
  it('keeps a padify-math shell with its latex, dropping rendered children', () => {
    const stored = sanitizeNoteHtml(
      '<p>see <span class="padify-math" data-latex="E=mc^2" contenteditable="false" data-rendered="1"><span class="katex">junk</span></span></p>',
    );
    expect(stored).toBe('<p>see <span class="padify-math" data-latex="E=mc^2"></span></p>');
  });

  it('unwraps a math span with missing latex; over-cap latex degrades to its source text', () => {
    // Missing source: a forged or hand-damaged shell unwraps to content.
    expect(sanitizeNoteHtml('<span class="padify-math">x</span>')).toBe('x');
    // Over-cap source: the equation rendered live, so deleting it at the
    // next save was silent data loss — it degrades to the LaTeX text now
    // (the reader-without-KaTeX path), never a vanish.
    expect(
      sanitizeNoteHtml(`<span class="padify-math" data-latex="${'x'.repeat(2001)}">y</span>`),
    ).toBe('x'.repeat(2001));
  });

  it('strips a plain span carrying a forged padify-math plus junk class', () => {
    const stored = sanitizeNoteHtml(
      '<span class="padify-math other" data-latex="x" style="position:fixed">q</span>',
    );
    expect(stored).toBe('<span class="padify-math" data-latex="x"></span>');
  });

  it('htmlToText reads the latex source, not the markup', () => {
    expect(htmlToText('a<span class="padify-math" data-latex="x^2"></span>b')).toBe('ax^2b');
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('legacyTextToHtml', () => {
  it('unwraps the markdown-style wrappers into the stored tag subset', () => {
    expect(legacyTextToHtml('**bold**')).toBe('<b>bold</b>');
    expect(legacyTextToHtml('*em*')).toBe('<i>em</i>');
    expect(legacyTextToHtml('__under__')).toBe('<u>under</u>');
    expect(legacyTextToHtml('~~strike~~')).toBe('<s>strike</s>');
  });

  it('combines wrappers on one line', () => {
    expect(legacyTextToHtml('**b** and *i*')).toBe('<b>b</b> and <i>i</i>');
  });

  it('escapes HTML first, so raw tags cannot survive the conversion', () => {
    expect(legacyTextToHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});

describe('sanitizeNoteHtml', () => {
  it('keeps the editor formatting subset', () => {
    expect(sanitizeNoteHtml('<b>bold</b> and <i>it</i>')).toBe('<b>bold</b> and <i>it</i>');
    expect(sanitizeNoteHtml('<div><p>keep <u>this</u></p></div>')).toBe(
      '<div><p>keep <u>this</u></p></div>',
    );
  });

  it('keeps only the allowlisted style declarations (policy: Docs-style controls, 2026-09)', () => {
    // The style attribute used to be stripped wholesale; it now survives
    // per-property for exactly the declarations the Docs-style controls
    // produce — colors and typography on spans, alignment and indent on
    // blocks. Everything else (position, url(), unknown props) is dropped.
    expect(sanitizeNoteHtml('<span style="color:#e64980">s</span>')).toBe(
      '<span style="color: #e64980">s</span>',
    );
    expect(sanitizeNoteHtml('<span style="background-color: rgb(255, 243, 191)">s</span>')).toBe(
      '<span style="background-color: rgb(255, 243, 191)">s</span>',
    );
    expect(sanitizeNoteHtml('<span style="font-size: 24px">s</span>')).toBe(
      '<span style="font-size: 24px">s</span>',
    );
    expect(sanitizeNoteHtml('<span style="font-family: Georgia">s</span>')).toBe(
      '<span style="font-family: Georgia">s</span>',
    );
    expect(sanitizeNoteHtml('<p style="text-align: center">s</p>')).toBe(
      '<p style="text-align: center">s</p>',
    );
    expect(sanitizeNoteHtml('<div style="margin-left: 40px">s</div>')).toBe(
      '<div style="margin-left: 40px">s</div>',
    );
  });

  it('drops hostile or out-of-policy style declarations', () => {
    // url() and friends cannot survive the value shapes; a block must not
    // carry inline typography and a span must not carry layout.
    expect(sanitizeNoteHtml('<span style="color: url(evil)">s</span>')).toBe('<span>s</span>');
    expect(sanitizeNoteHtml('<span style="position: fixed">s</span>')).toBe('<span>s</span>');
    expect(sanitizeNoteHtml('<span style="color: expression(alert(1))">s</span>')).toBe(
      '<span>s</span>',
    );
    expect(sanitizeNoteHtml('<p style="color: red">s</p>')).toBe('<p>s</p>');
    expect(sanitizeNoteHtml('<span style="text-align: center">s</span>')).toBe('<span>s</span>');
    expect(sanitizeNoteHtml('<p style="margin-left: -40px">s</p>')).toBe('<p>s</p>');
  });

  it('strips attributes from surviving tags it has no style for', () => {
    expect(sanitizeNoteHtml('<b onclick="evil()">bold</b>')).toBe('<b>bold</b>');
  });

  it('script drops whole; other unknown tags unwrap to their text', () => {
    // Policy change (styled paste, 2026-10): script/style/embed elements
    // drop WITH their content — a program is never the note's words, and
    // the paste path now feeds foreign markup through the sanitizer.
    expect(sanitizeNoteHtml('<script>alert(1)</script>hi')).toBe('hi');
    expect(sanitizeNoteHtml('<img src=x onerror=y>hi')).toBe('hi');
  });

  it('keeps the rich text block subset (lists, headings, quote, pre, links)', () => {
    // Policy change (rich text notes, 2026-09): the allowlist grew from the
    // inline subset to the rich toolbar's vocabulary. List markup survives
    // instead of flattening; a[href] is the single allowed attribute.
    expect(sanitizeNoteHtml('<ul><li>a</li><li>b</li></ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(sanitizeNoteHtml('<h1>t</h1><blockquote>q</blockquote><pre>c</pre>')).toBe(
      '<h1>t</h1><blockquote>q</blockquote><pre>c</pre>',
    );
    expect(sanitizeNoteHtml('<a href="https://x.y">l</a>')).toBe('<a href="https://x.y">l</a>');
  });

  it('keeps empty allowed blocks', () => {
    expect(sanitizeNoteHtml('<div></div>')).toBe('<div></div>');
  });

  it('keeps the Docs-style vocabulary (scripts, rules)', () => {
    expect(sanitizeNoteHtml('a<sup>2</sup> + b<sub>n</sub><hr>')).toBe(
      'a<sup>2</sup> + b<sub>n</sub><hr>',
    );
    // A stray legacy <font> (an old synced note) still degrades to text —
    // the editor normalizes its own font tags before storage ever sees one.
    expect(sanitizeNoteHtml('<font size="5">x</font>')).toBe('x');
  });

  it('keeps the checklist attributes with their fixed values (policy: checklists, 2026-09)', () => {
    expect(
      sanitizeNoteHtml(
        '<ul data-rich-checklist="true"><li data-checked="false">a</li><li data-checked="true">b</li></ul>',
      ),
    ).toBe(
      '<ul data-rich-checklist="true"><li data-checked="false">a</li><li data-checked="true">b</li></ul>',
    );
    // Anything but the boolean vocabulary is a crafted payload, not
    // editor output: the attribute is dropped, the markup survives.
    expect(sanitizeNoteHtml('<ul data-rich-checklist="inject">x</ul>')).toBe('<ul>x</ul>');
    expect(sanitizeNoteHtml('<li data-checked="on">x</li>')).toBe('<li>x</li>');
    // The mark never travels to a tag that does not declare it.
    expect(sanitizeNoteHtml('<div data-checked="true">x</div>')).toBe('<div>x</div>');
  });

  it('keeps the table subset with alignment styles on cells (policy: tables, 2026-09)', () => {
    expect(sanitizeNoteHtml('<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(sanitizeNoteHtml('<table><tr><th>h</th></tr></table>')).toBe(
      '<table><tbody><tr><th>h</th></tr></tbody></table>',
    );
    // Cell alignment is the one style a cell may carry (the align buttons).
    expect(
      sanitizeNoteHtml(
        '<table><tbody><tr><td style="text-align: center">c</td></tr></tbody></table>',
      ),
    ).toBe('<table><tbody><tr><td style="text-align: center">c</td></tr></tbody></table>');
    // A hostile attribute rides the same wall as everywhere else.
    expect(
      sanitizeNoteHtml('<table><tbody><tr><td bgcolor="red">c</td></tr></tbody></table>'),
    ).toBe('<table><tbody><tr><td>c</td></tr></tbody></table>');
  });
});

describe('htmlToText', () => {
  it('reads block boundaries as newlines', () => {
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('renders empty paragraphs as blank lines', () => {
    expect(htmlToText('<p></p>')).toBe('\n');
  });

  it('reads horizontal rules as line boundaries', () => {
    expect(htmlToText('a<hr>b')).toBe('a\nb');
  });

  it('reads checklist items with their box state', () => {
    expect(
      htmlToText(
        '<ul data-rich-checklist="true"><li data-checked="false">milk</li><li data-checked="true">eggs</li></ul>',
      ),
    ).toBe('[ ] milk\n[x] eggs');
  });

  it('reads table rows as lines with tab-separated cells', () => {
    expect(
      htmlToText(
        '<table><tbody><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>',
      ),
    ).toBe('a1\tb1\na2\tb2');
  });

  it('strips inline formatting', () => {
    expect(htmlToText('<b>bold</b> <i>it</i>')).toBe('bold it');
  });
});

describe('deriveTabTitle', () => {
  it('prefers the user-provided name', () => {
    expect(deriveTabTitle(tab({ name: 'My tab' }))).toBe('My tab');
  });

  it('uses the first non-empty content line when unnamed', () => {
    expect(deriveTabTitle(tab({ content: '<div></div>second line' }))).toBe('second line');
  });

  it('truncates long derived titles at 42 characters', () => {
    const longLine = 'x'.repeat(60);
    const title = deriveTabTitle(tab({ content: longLine }));
    expect(title.length).toBe(42);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to Untitled for empty notes', () => {
    expect(deriveTabTitle(tab())).toBe('Untitled');
    expect(deriveTabTitle(tab({ content: '<div></div>' }))).toBe('Untitled');
  });

  it('strips markdown furniture from derived titles', () => {
    expect(deriveTabTitle(tab({ content: '# Trip plan', noteType: 'markdown' }))).toBe('Trip plan');
    expect(deriveTabTitle(tab({ content: '> a quote', noteType: 'markdown' }))).toBe('a quote');
    expect(deriveTabTitle(tab({ content: '- pack boots', noteType: 'markdown' }))).toBe(
      'pack boots',
    );
    expect(deriveTabTitle(tab({ content: '3. drive north', noteType: 'markdown' }))).toBe(
      'drive north',
    );
    expect(deriveTabTitle(tab({ content: '[x] book cabin', noteType: 'markdown' }))).toBe(
      'book cabin',
    );
    expect(deriveTabTitle(tab({ content: '> - nested peel', noteType: 'markdown' }))).toBe(
      'nested peel',
    );
  });

  it('skips separators and wordless lines when naming', () => {
    expect(deriveTabTitle(tab({ content: '---\nReal title' }))).toBe('Real title');
    expect(deriveTabTitle(tab({ content: '***\nReal title' }))).toBe('Real title');
    expect(deriveTabTitle(tab({ content: '—\nReal title' }))).toBe('Real title');
    expect(deriveTabTitle(tab({ content: '- - -\nReal title', noteType: 'markdown' }))).toBe(
      'Real title',
    );
  });

  it('collapses internal whitespace in derived titles', () => {
    expect(deriveTabTitle(tab({ content: 'hello    spaced   title' }))).toBe('hello spaced title');
  });

  it('collapses tabs and single stray whitespace too — no holes in the chip', () => {
    expect(deriveTabTitle(tab({ content: 'line1\tline2' }))).toBe('line1 line2');
  });

  it('truncates long titles at a word boundary', () => {
    const title = deriveTabTitle(
      tab({ content: 'The quick brown fox jumps over the lazy dog and keeps running' }),
    );
    expect(title.length).toBeLessThanOrEqual(42);
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('… ')).toBe(false);
    // The word before the ellipsis is whole, not cut mid-word.
    expect(title.slice(0, -1).split(' ').pop()!.length).toBeGreaterThan(1);
  });
});

describe('WELCOME_HTML', () => {
  it('is non-empty and introduces the app', () => {
    expect(WELCOME_HTML.length).toBeGreaterThan(100);
    expect(WELCOME_HTML).toContain('Padify');
  });
});
