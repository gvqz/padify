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
  html: '',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
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
    expect(
      sanitizeNoteHtml('<span style="background-color: rgb(255, 243, 191)">s</span>'),
    ).toBe('<span style="background-color: rgb(255, 243, 191)">s</span>');
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

  it('unwraps unknown tags to their text content (script included)', () => {
    // Documented behaviour: unknown elements are unwrapped, not deleted —
    // script bodies degrade to inert text, images vanish (no children).
    expect(sanitizeNoteHtml('<script>alert(1)</script>hi')).toBe('alert(1)hi');
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

  it('strips inline formatting', () => {
    expect(htmlToText('<b>bold</b> <i>it</i>')).toBe('bold it');
  });
});

describe('deriveTabTitle', () => {
  it('prefers the user-provided name', () => {
    expect(deriveTabTitle(tab({ name: 'My tab' }))).toBe('My tab');
  });

  it('uses the first non-empty content line when unnamed', () => {
    expect(deriveTabTitle(tab({ html: '<div></div>second line' }))).toBe('second line');
  });

  it('truncates long derived titles at 42 characters', () => {
    const longLine = 'x'.repeat(60);
    const title = deriveTabTitle(tab({ html: longLine }));
    expect(title.length).toBe(42);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to Untitled for empty notes', () => {
    expect(deriveTabTitle(tab())).toBe('Untitled');
    expect(deriveTabTitle(tab({ html: '<div></div>' }))).toBe('Untitled');
  });
});

describe('WELCOME_HTML', () => {
  it('is non-empty and introduces the app', () => {
    expect(WELCOME_HTML.length).toBeGreaterThan(100);
    expect(WELCOME_HTML).toContain('Padify');
  });
});
