import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './editor/markdown/render';

// Behavioral twin of the markdown-render drift guard in
// share-sanitizer.test.ts: the GENERATED module the browser downloads
// (public/share/markdown-render.js, imported here natively, no transform)
// and the canonical TypeScript source must answer identically across a
// hostile corpus — the generated bundle's tree-shaken inline of the
// safe-href gate could otherwise drift from the source's behavior even
// while the bytes still regenerate cleanly.

const GENERATED_PATH = resolve(process.cwd(), 'public/share/markdown-render.js');

type Renderer = (source: string) => string;

async function loadGeneratedRenderer(): Promise<Renderer> {
  // Native import of the checked-in plain-ESM file — exactly the bytes the
  // browser downloads, no transform on the way in.
  const mod = (await import(pathToFileURL(GENERATED_PATH).href)) as {
    renderMarkdownToHtml: Renderer;
  };
  return mod.renderMarkdownToHtml;
}

describe('generated markdown renderer ≡ canonical renderer', () => {
  // Hostile corpus: the documented subset plus the smuggling attempts the
  // security model exists for.
  const corpus: string[] = [
    'plain text',
    '# Heading\n\n## Smaller\n\n###### Six',
    '**bold** and *italic* and ~~struck~~ and `code`',
    '```js\nconst x = 1;\n```',
    '> quoted\n\n> > nested',
    '- one\n- two\n\n1. first\n2. second',
    '- [ ] open\n- [x] done',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '[ok](https://example.com/page)',
    '[evil](javascript:alert(1))',
    '[data](data:text/html,base64,evil)',
    '<img src=x onerror=alert(1)>',
    '<script>alert("xss")</scr' + 'ipt>',
    '<iframe src="javascript:alert(2)"></iframe>',
    '<b>bold?</b>',
    'Equation: $x^2$ and display $$\\sum_{i=1}^{n} i$$',
    '-----',
    // Footnotes — the document-scoped machinery: active refs resolve,
    // inactive ones stay literal, and definitions never leak as markup.
    'A ref[^1] with a definition.\n\n[^1]: The definition, **resolved** as inline.',
    'A ref[^1] and a second[^b] with lazy order.\n\n[^b]: second def\n[^1]: first def',
    'A ref with no definition[^ghost] stays literal brackets.',
    'A definition with no ref[^unused]: stays a paragraph line.',
    'Text[^1] then\n\n```\ncode [^1] inside\n```\n\n[^1]: fence interior is a literal',
    'Ref[^1] and a <b>hostile</b> def.\n\n[^1]: <img src=x onerror=alert(1)> escaped',
  ];

  it('answers identically on the hostile corpus', async () => {
    const generated = await loadGeneratedRenderer();

    for (const input of corpus) {
      expect(generated(input)).toBe(renderMarkdownToHtml(input));
    }
  });

  it('the shared invariants hold in the generated copy too', async () => {
    const generated = await loadGeneratedRenderer();

    // Raw HTML meets the POLICY: benign tags are rebuilt (no event
    // handlers, no hostile hrefs — the img keeps its schemeless src and
    // gains the lazy/no-referrer hardening), declined tags are escaped
    // text. Structural pins, the probe's lesson: check what the markup
    // CAN DO, not which substrings its escaped text shows.
    const hostile = generated(
      '<img src=x onerror=alert(1)>\n\n[evil](javascript:alert(1))\n\n<b>bold?</b>',
    );
    expect(hostile).not.toContain('onerror');
    expect(hostile).not.toContain('href="javascript:');
    expect(hostile).toContain(
      '<img src="x" loading="lazy" decoding="async" referrerpolicy="no-referrer">',
    );
    expect(hostile).toContain('<b>bold?</b>');
    // Declined tags still escape: script never renders.
    expect(generated('<script>alert(1)</scr' + 'ipt>')).toContain('&lt;script&gt;');
  });

  it('the footnote machinery holds in the generated copy too', async () => {
    const generated = await loadGeneratedRenderer();

    // Definitions render through the inline pass — hostile markup in a
    // footnote meets the same policy as a body paragraph (handlers
    // stripped, benign tags rebuilt).
    const hostile = generated('Ref[^1].\n\n[^1]: <img src=x onerror=alert(1)> and <b>bold?</b>');
    expect(hostile).toContain('class="md-footnote-ref"');
    expect(hostile).toContain('<section class="md-footnotes">');
    expect(hostile).not.toContain('onerror');
    expect(hostile).toContain(
      '<img src="x" loading="lazy" decoding="async" referrerpolicy="no-referrer">',
    );
    expect(hostile).toContain('<b>bold?</b>');
  });
});
