/**
 * GitHub parity — the giellalt torture corpus through GitHub's own
 * pipeline vs through the owned renderer.
 *
 * The oracle is the fixture `github-torture.html`: the MarkdownTestReference
 * document as github.com itself renders the file blob the user pointed at
 * (giellalt/giellalt.github.io, infra/MarkdownTestReference.md) — the
 * payload.codeViewBlobRoute.richText string the page ships, i.e. cmark-gfm
 * + html-pipeline + syntax-highlight output, verbatim.
 *
 * GitHub's pipeline dresses its grammar output in presentation the owned
 * renderer rightly declines (and vice versa); the normalizer below strips
 * exactly that dressing, nothing grammatical:
 *
 *  • Heading chrome — each heading rides inside a `div.markdown-heading`
 *    with a permalink `a.anchor` (an SVG link github.com layers on top).
 *    The div is unwrapped, the permalink dropped: the grammar is the hX
 *    and its text.
 *  • Syntax highlighting — `div.highlight highlight-text-{lang} > pre >
 *    span.pl-*` becomes `pre > code.language-{lang}` carrying the pre's
 *    plain text: the spans are a linguist paint job over the same bytes.
 *  • Viewport enrichment — mermaid/geojson/topojson blocks become live
 *    widgets (`section.js-render-needs-enrichment` with a spinner SVG and
 *    a hidden raw-source `pre[lang]` fallback). The widget is replaced by
 *    the fallback's own code block — GitHub's cmark-gfm emitted exactly
 *    that before client-side enrichment replaced it in the DOM.
 *  • The unlabeled quad fences ride in `div.snippet-clipboard-content`
 *    (a copy-button affordance) — unwrapped to the `pre > code` inside.
 *  • The accessibility table wrapper (`markdown-accessiblity-table`) is
 *    unwrapped to the table inside; the article shell is unwrapped.
 *  • `dir="auto"`, `role`, `tabindex`, `class="notranslate"` /
 *    `"heading-element"` — chrome attributes, stripped by name.
 *  • Highlight interiors lack cmark's trailing newline; it is restored so
 *    both sides carry the byte cmark-gfm (and the owned renderer) emit.
 *
 * What remains is grammar: tag shapes, nesting, text, table alignment,
 * link hrefs, code languages and payloads — compared through the same
 * canonicalizer the CommonMark differential suite uses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './render';
import { canonicalizeHtml } from './render.testkit';

const doc = readFileSync(
  resolve(process.cwd(), 'src/editor/markdown/__fixtures__/gfm-torture.md'),
  'utf-8',
);
const githubRaw = readFileSync(
  resolve(process.cwd(), 'src/editor/markdown/__fixtures__/github-torture.html'),
  'utf-8',
);

/** Strip GitHub's pipeline dressing; keep the grammar it rendered. */
export function normalizeGithubHtml(raw: string): string {
  // The suite runs under vitest's jsdom environment — the global document
  // is the parser (the testkit's own discipline).
  const body = document.createElement('body');
  body.innerHTML = raw;

  // 1. The article shell github.com mounts the body into.
  for (const article of Array.from(body.querySelectorAll('article'))) {
    article.replaceWith(...Array.from(article.childNodes));
  }

  // 2. Heading chrome: the markdown-heading wrapper unwraps, the permalink
  //    anchor (an SVG link) goes away — grammar is the hX and its text.
  for (const div of Array.from(body.querySelectorAll('div.markdown-heading'))) {
    div.replaceWith(...Array.from(div.childNodes));
  }
  for (const anchor of Array.from(body.querySelectorAll('a.anchor'))) {
    anchor.remove();
  }

  // 3. Enrichment widgets → their own raw-source fallback code block.
  for (const section of Array.from(body.querySelectorAll('section.js-render-needs-enrichment'))) {
    const pre = section.querySelector('pre[lang]');
    const lang = pre?.getAttribute('lang') ?? '';
    const text = pre?.textContent ?? '';
    section.replaceWith(codeBlock(lang, text));
  }

  // 4. Syntax-highlighted blocks → plain pre>code with the language back.
  for (const div of Array.from(body.querySelectorAll('div.highlight'))) {
    const lang = /highlight-text-([\w-]+)/.exec(div.className)?.[1] ?? '';
    const pre = div.querySelector('pre');
    let text = pre?.textContent ?? '';
    // cmark-gfm (and the owned renderer) end code interiors with a newline;
    // the highlighting pipeline drops it — restore the grammar's byte.
    if (text && !text.endsWith('\n')) {
      text += '\n';
    }
    div.replaceWith(codeBlock(lang, text));
  }

  // 5. The unlabeled quad fences: unwrap the copy-button affordance div.
  for (const div of Array.from(body.querySelectorAll('div.snippet-clipboard-content'))) {
    div.replaceWith(...Array.from(div.childNodes));
  }

  // 6. Unwrap the accessibility table chrome.
  for (const wrapper of Array.from(body.querySelectorAll('markdown-accessiblity-table'))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }

  // 7. Presentation-only attributes and classes (by name — never a
  //    grammar-carrying class like language-*).
  const CHROME_CLASSES = new Set(['notranslate', 'heading-element', 'anchor']);
  for (const el of Array.from(body.querySelectorAll('*'))) {
    el.removeAttribute('dir');
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    const classes = Array.from(el.classList).filter((c: string) => !CHROME_CLASSES.has(c));
    if (classes.length === 0) {
      el.removeAttribute('class');
    } else {
      el.setAttribute('class', classes.join(' '));
    }
  }

  return body.innerHTML;
}

function codeBlock(lang: string, text: string): HTMLElement {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (lang) {
    code.setAttribute('class', `language-${lang}`);
  }
  code.textContent = text;
  pre.append(code);
  return pre;
}

describe('GitHub parity — the torture corpus vs github.com\'s own renderer', () => {
  const owned = renderMarkdownToHtml(doc);
  const github = normalizeGithubHtml(githubRaw);
  const ownedCanon = canonicalizeHtml(owned);
  const githubCanon = canonicalizeHtml(github);

  it('both sides render at scale (the fixtures and pipeline are live)', () => {
    expect(ownedCanon.length).toBeGreaterThan(10_000);
    expect(githubCanon.length).toBeGreaterThan(10_000);
  });

  it('the block-grammar tag sequence matches GitHub\'s exactly', () => {
    const tags = (html: string): string[] =>
      Array.from(html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?(\/?)>/g))
        .map((m) => (m[1] ? `</${m[2]}>` : `<${m[2]}>`))
        .filter((t) => !t.startsWith('</code>') || true);
    const ownedTags = tags(ownedCanon);
    const githubTags = tags(githubCanon);
    expect(ownedTags.length).toBeGreaterThan(200);
    // The first divergence, with context, if any.
    const n = Math.min(ownedTags.length, githubTags.length);
    for (let i = 0; i < n; i += 1) {
      if (ownedTags[i] !== githubTags[i]) {
        expect(
          `tag ${i}: owned ${ownedTags[i]} vs github ${githubTags[i]} — owned ctx: ${ownedTags
            .slice(Math.max(0, i - 6), i + 3)
            .join('')}`,
        ).toBe(
          `tag ${i}: owned ${ownedTags[i]} vs github ${githubTags[i]} — github ctx: ${githubTags
            .slice(Math.max(0, i - 6), i + 3)
            .join('')}`,
        );
        break;
      }
    }
    expect(ownedTags.join('')).toBe(githubTags.join(''));
  });

  it('the canonicalized documents are byte-identical', () => {
    // Character-level diff at the first divergence, for a surgical report.
    const n = Math.min(ownedCanon.length, githubCanon.length);
    let i = 0;
    while (i < n && ownedCanon[i] === githubCanon[i]) {
      i += 1;
    }
    if (i < n || ownedCanon.length !== githubCanon.length) {
      const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 80), i + 80));
      expect(
        `first divergence at byte ${i}:\n  owned:   ${ctx(ownedCanon)}\n  github:  ${ctx(githubCanon)}`,
      ).toBe('no divergence');
    }
  });

  it('the code-block census matches: languages and payloads', () => {
    const census = (html: string): Array<[string, string]> => {
      const root = document.createElement('body');
      root.innerHTML = html;
      const out: Array<[string, string]> = [];
      for (const code of Array.from(root.querySelectorAll('pre > code'))) {
        const lang =
          Array.from(code.classList).find((c: string) => c.startsWith('language-'))?.slice(9) ??
          '';
        out.push([lang, code.textContent ?? '']);
      }
      return out;
    };
    const ownedCensus = census(owned);
    const githubCensus = census(github);
    expect(ownedCensus.length).toBe(githubCensus.length);
    // The owned renderer pre-expands tabs in code to 4-column stops (a
    // documented divergence — the canonicalizer's expandCodeTabs equates
    // the forms); the census compares through that same expansion.
    const expandTabs = (s: string): string => {
      let out = '';
      let col = 0;
      for (const ch of s) {
        if (ch === '\t') {
          const stop = col + 4 - (col % 4);
          while (col < stop) {
            out += ' ';
            col += 1;
          }
          continue;
        }
        col = ch === '\n' ? 0 : col + 1;
        out += ch;
      }
      return out;
    };
    const report = ownedCensus
      .map(([lang, payload], i) => {
        const [ghLang, ghPayload] = githubCensus[i] ?? ['', ''];
        if (lang === ghLang && expandTabs(payload) === expandTabs(ghPayload)) {
          return '';
        }
        return `block ${i}: owned=(${lang}, ${JSON.stringify(payload.slice(0, 50))}) github=(${ghLang}, ${JSON.stringify(ghPayload.slice(0, 50))})`;
      })
      .filter(Boolean)
      .join('\n');
    expect(report).toBe('');
  });
});
