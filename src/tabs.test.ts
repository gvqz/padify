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

  it('strips every attribute from surviving tags', () => {
    expect(sanitizeNoteHtml('<span style="color:red">s</span>')).toBe('<span>s</span>');
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
});

describe('htmlToText', () => {
  it('reads block boundaries as newlines', () => {
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('renders empty paragraphs as blank lines', () => {
    expect(htmlToText('<p></p>')).toBe('\n');
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
