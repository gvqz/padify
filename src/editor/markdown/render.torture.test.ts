/**
 * The GFM torture corpus — the giellalt MarkdownTestReference document
 * (the same doc https://giellalt.github.io/infra/
 * MarkdownTestReference.html renders, and whose GitHub-rendered twin at
 * giellalt/giellalt.github.io is the parity target) through the owned
 * renderer, whole: the security walk must stay clean over every construct
 * at once, and the constructs GitHub's own pipeline shows — every heading
 * level, tables with alignments, the emoji shortcode, the nested-fence
 * geojson blocks, and the raw-HTML section (where the "encoded using <"
 * list stays escaped and the benign vocabulary — ruby, rt, rp, kbd,
 * strong — renders live) — must each be present and shaped the way
 * GitHub shapes them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './render';
import { canonicalizeHtml, walkInvariants } from './render.testkit';

const torture = readFileSync(
  resolve(process.cwd(), 'src/editor/markdown/__fixtures__/gfm-torture.md'),
  'utf-8',
);

describe('renderMarkdownToHtml — the giellalt GFM torture corpus', () => {
  const html = renderMarkdownToHtml(torture);

  it('the whole document renders through the security walk clean', () => {
    expect(walkInvariants(html)).toEqual([]);
  });

  it('every heading level renders, closing hashes stripped', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(html, `h${level}`).toContain(`<h${level}>foo ${level}</h${level}>`);
      expect(html, `h${level}a`).toContain(`<h${level}>foo ${level}a</h${level}>`);
    }
    // The setext forms too (plain and multi-line).
    expect(html).toContain('<h1>Header text</h1>');
    expect(html).toContain('<h2>Another header text</h2>');
    expect(html).toContain('<h1>Header with a\nlot of text</h1>');
  });

  it('tables carry their alignments and the ***Cell 4*** nesting', () => {
    expect(html).toMatch(/<th style="text-align:\s?left">THead1</);
    expect(html).toMatch(/<th style="text-align:\s?center">THead2</);
    expect(html).toMatch(/<th style="text-align:\s?right">THead3</);
    // ***x*** is em-around-strong, the reference's own nesting.
    expect(html).toContain('<i><b>Cell 4</b></i>');
    expect(html).toMatch(/<td[^>]*><code>Cell 8<\/code><\/td>/);
  });

  it('the emoji shortcode expands', () => {
    expect(html).toContain('rendering has been enabled! \u{1f44d}');
  });

  it('nested fences keep their payload intact (geojson/topojson)', () => {
    // The doc wraps ```-fences inside ````-fences; the inner fence must
    // survive as code, not close the outer block — and the bare geojson
    // blocks keep their language class.
    expect(html).toContain('class="language-geojson"');
    expect(html).toContain('class="language-topojson"');
    expect(html).toContain('marker-color');
  });

  it('raw HTML: the benign vocabulary renders, the encoded list stays text', () => {
    // <ruby>/<rt>/<rp> and <kbd> render live…
    expect(html).toMatch(/<ruby>tekst<rt>ja<\/rt><\/ruby>/);
    expect(html).toMatch(/<ruby><strong>cromulent<\/strong>/);
    expect(html).toContain('<kbd>\u16cc\u16c1\u16a2\u16b1</kbd>');
    // …while the torture doc's own "encoded using <" list (title,
    // textarea, style, xmp, iframe, noembed, noframes, script,
    // plaintext) stays escaped text, exactly as GitHub inactivates them.
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;textarea&gt;');
    expect(html).toContain('&lt;iframe&gt;');
    expect(html).not.toMatch(
      /<(script|iframe|style|textarea|xmp|noembed|noframes|plaintext|title)\b/,
    );
  });

  it('links harden with rel hardening; code spans render', () => {
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code>#</code>');
    expect(html).toContain('<code>radius</code>');
  });

  it('canonicalizes to something non-trivial (the render completed)', () => {
    const canon = canonicalizeHtml(html);
    expect(canon.length).toBeGreaterThan(10_000);
    expect(canon.startsWith('<h1>')).toBe(true);
  });
});
