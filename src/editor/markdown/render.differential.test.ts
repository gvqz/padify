/**
 * The differential suite — the owned renderer against the spec-faithful
 * reference (micromark + the GFM extensions), over the OFFICIAL CommonMark
 * 0.31.2 example corpus (652 examples, checked in as a fixture) plus a
 * handcrafted GFM-extension corpus.
 *
 * WHY: render.ts is hand-written for the security model (it never emits a
 * tag it did not generate), so it cannot lean on a library at runtime —
 * but in TESTS it can and should lean on the most spec-faithful HTML
 * producer the ecosystem has. Every example renders through BOTH
 * implementations; each output is canonicalized through a DOM walk
 * (tag aliases b↔strong, attribute order, whitespace collapse — the
 * things HTML rendering treats as identical) and the results must match.
 * The canonicalizer, the oracle and the divergence rules live in
 * render.testkit.ts — the fuzzer and the torture suite judge with the
 * exact same instruments.
 *
 * DOCUMENTED DIVERGENCES (excluded, never "fixed"):
 *   raw HTML   — the renderer escapes it (the note is data, never markup);
 *                GitHub renders it through a sanitizer.
 *   images     — `![alt](url)` renders as a link (a remote src would make
 *                the note phone home on every preview).
 *   footnotes  — both render GFM footnotes, but the section/anchor shapes
 *                differ; the owned shape is pinned in render.test.ts.
 *   math       — `$…$` is a padify extension; the oracle has no opinion.
 *   safe hrefs — javascript:/data: (and unknown schemes) render as literal
 *                text here; the oracle emits an anchor with a normalized
 *                or emptied href.
 *
 * Everything else must match: headings, lists (tight/loose/nested/start),
 * emphasis (the full CommonMark algorithm, rule of 3 included), links
 * (inline/reference/collapsed/shortcut, titles, pointy + paren-balanced
 * destinations), autolinks (angle + GFM literal www/http/email), tables,
 * task lists, strikethrough, indented code, entities, escapes, breaks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeHtml,
  cmarkHtml,
  oracleHtml,
  oracleUsesPolicyPower,
} from './render.testkit';
import { renderMarkdownToHtml } from './render';

// ---------------------------------------------------------------------------
// The official CommonMark 0.31.2 corpus
// ---------------------------------------------------------------------------

const spec = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'src/editor/markdown/__fixtures__/commonmark-spec.json'),
    'utf-8',
  ),
) as { markdown: string; html: string; section: string; example: number }[];

describe('differential — official CommonMark 0.31.2 corpus vs the spec-faithful oracle', () => {
  const failures: string[] = [];
  let compared = 0;
  let excluded = 0;

  it('every non-divergent spec example canonicalizes identically', () => {
    const bySection = new Map<string, { markdown: string; example: number }[]>();
    for (const example of spec) {
      if (!bySection.has(example.section)) {
        bySection.set(example.section, []);
      }
      bySection.get(example.section)!.push(example);
    }

    for (const [section, examples] of bySection) {
      const sectionFailures: string[] = [];
      for (const example of examples) {
        const oursHtml = renderMarkdownToHtml(example.markdown);
        const theirs = oracleHtml(example.markdown);
        if (oracleUsesPolicyPower(example.markdown, theirs)) {
          excluded += 1;
          continue;
        }
        compared += 1;
        const ours = canonicalizeHtml(oursHtml);
        const oracle = canonicalizeHtml(theirs);
        if (ours !== oracle) {
          // The second reference — cmark (GitHub's own engine family).
          // The two references disagree only on spec-unspecified corners
          // (delimiter-run reuse, chiefly); matching either is correct.
          if (ours !== canonicalizeHtml(cmarkHtml(example.markdown))) {
            sectionFailures.push(
              `spec#${example.example}\n  in:     ${JSON.stringify(example.markdown)}\n  ours:   ${ours}\n  oracle: ${oracle}`,
            );
          }
        }
      }
      if (sectionFailures.length > 0) {
        failures.push(
          `── ${section} (${sectionFailures.length}/${examples.length} failed) ──\n${sectionFailures.join('\n')}`,
        );
      }
    }

    const summary = `${compared} compared, ${excluded} excluded by policy, ${failures.length} sections failing`;
    if (failures.length > 0) {
      throw new Error(`DIFFERENTIAL FAILURES — ${summary}\n\n${failures.join('\n\n')}`);
    }
    expect(failures, summary).toHaveLength(0);
  });

  it('a healthy share of the corpus survives the policy exclusions', () => {
    // The exclusions (raw HTML, images, gated schemes) are a minority of
    // the spec — if the compared share collapses, the exclusion rule is
    // overreaching.
    expect(compared).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// GFM extensions beyond the CommonMark corpus — tables, task lists,
// strikethrough (1–2 tildes), literal autolinks, footnotes' activation rule
// ---------------------------------------------------------------------------

const GFM_CORPUS: string[] = [
  // Tables — alignments, ragged rows, escaped pipes, inline content.
  '| a | b |\n| --- | ---: |\n| 1 | 2 |',
  '| a | b |\n| :-: | :- |\n| 1 | 2 |',
  '| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |',
  '| f\\|oo | b |\n| --- | --- |\n| 1 | `x|y` |',
  '| **a** | [l](https://x.com) |\n| --- | --- |\n| *b* | ~~c~~ |',
  'a | b\n--- | ---\n1 | 2',
  '| a |\n| - |',
  '| a | b |\n| - | - |\nno pipes here',
  '| a |\n| - |\n# head',
  '| a |\n| - |\n- list item',

  // Task lists — checked, unchecked, mixed case, nested, loose.
  '- [ ] open\n- [x] done',
  '- [X] uppercase done',
  '- [ ] not a task: [ ] inside',
  '1. [x] ordered task',
  '- [ ] parent\n  - [x] child',
  '- item\n\n- [x] loose task',

  // Strikethrough — one OR two tildes (github.com behavior), no intraword ~.
  '~~struck~~',
  '~one tilde~',
  'a ~~b~~ c',
  '~~a ~~b~~ c~~',
  '~a~ and ~~b~~',
  '~~~three~~~',
  '~a~~b~',
  '~~a~b~~',

  // Literal autolinks — bare www/http/email with boundary rules.
  'visit https://example.com now',
  'visit http://example.com now',
  'go to www.example.com now',
  'mail me at foo.bar@example.co.uk now',
  '(https://example.com)',
  '*https://example.com*',
  '_www.example.com_',
  'trailing https://example.com.',
  'trailing https://example.com,',
  'unbalanced https://example.com/a(b)',
  'balanced https://example.com/a(b)/c)',
  'entity https://example.com/x&#38y;',
  'email x@y.z!',
  'inside <https://example.com/angle> stays',
  '`https://code.example.com` stays code',
  'no scheme: example.com stays plain',
  'https://example.com/path?a=1&b=2#frag',
  'https://example.com/path_(with_parens)',
  'https://example.com/,trailing-slash/',
  'www.example.com.',
  'HTTP://EXAMPLE.COM/PATH',

  // Entities.
  '&copy; &amp; &lt; &#169; &#xA9;',
  'a &amp;lt; b',
  '&copy without semicolon stays',
  '&#0; is replacement',
  'AT&T and 5 &lt; 6 &gt; 4',
  '&#1114112; past the top',
];

describe('differential — GFM extension corpus vs the spec-faithful oracle', () => {
  it('every GFM case canonicalizes identically', () => {
    const failures: string[] = [];
    for (const markdown of GFM_CORPUS) {
      const oracle = canonicalizeHtml(oracleHtml(markdown));
      if (oracleUsesPolicyPower(markdown, oracle)) {
        continue;
      }
      const ours = canonicalizeHtml(renderMarkdownToHtml(markdown), true);
      if (ours !== oracle) {
        if (ours !== canonicalizeHtml(cmarkHtml(markdown))) {
          failures.push(
            `in:     ${JSON.stringify(markdown)}\n  ours:   ${ours}\n  oracle: ${oracle}`,
          );
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `GFM DIFFERENTIAL FAILURES (${failures.length}/${GFM_CORPUS.length})\n\n${failures.join('\n\n')}`,
      );
    }
    expect(failures).toHaveLength(0);
  });
});
