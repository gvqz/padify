/**
 * The fuzzer — the differential harness fed things the spec never dreamed
 * of. Every corpus example is a HAND-EDITED sentence in the language of
 * markdown; the fuzzer speaks it like a drunk typist: characters inserted,
 * deleted, duplicated, documents spliced into each other, truncated mid-
 * construct, CRLF-ified, tab-laced, salted with unicode.
 *
 * Each mutant must:
 *   1. NOT THROW — a hand-written parser's first duty is to survive;
 *   2. satisfy the security invariants (vocabulary, attributes, hrefs) —
 *      garbage in, still no markup the renderer did not generate;
 *   3. match the oracle, whenever the mutant does not invoke a documented
 *      policy divergence — the grammar survives random edits.
 *
 * Deterministic by construction: mulberry32 with a fixed seed schedule, so
 * a failure is reproducible forever (the seed id and mutation are printed
 * with the failure).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './render';
import {
  canonicalizeHtml,
  oracleHtml,
  oracleUsesPolicyPower,
  walkInvariants,
} from './render.testkit';

// ---------------------------------------------------------------------------
// The PRNG — mulberry32, tiny and deterministic
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng: () => number, list: string[]): string {
  return list[Math.floor(rng() * list.length)]!;
}

// ---------------------------------------------------------------------------
// The seed pool — official examples plus handcrafted multi-construct docs
// ---------------------------------------------------------------------------

const spec = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'src/editor/markdown/__fixtures__/commonmark-spec.json'),
    'utf-8',
  ),
) as { markdown: string }[];

// Every third spec example keeps the pool broad (lists, tables, emphasis,
// links, code) without paying full-corpus fuzz time.
const SPEC_SEEDS = spec.filter((_, i) => i % 3 === 0).map((e) => e.markdown);

const HAND_SEEDS: string[] = [
  '# Title\n\nA paragraph with **bold**, *italic*, ~~struck~~ and `code`.',
  '- [ ] open task\n- [x] done task\n  - nested [ ] with `code|pipe`\n',
  '| left | center | right |\n| :--- | :---: | ---: |\n| a | b | c |\n| **x** | [l](https://e.co) | `c` |',
  'Footnote[^1] and another[^long-label].\n\n[^1]: the first note\n[^long-label]: with **markup** and two\n    continuation lines\n',
  'See https://example.com/x?a=1&b=2, www.example.com and <mail@e.co>.',
  '[ref]: https://example.com "the title"\n\n[ref][] and [ref] and [text][ref] and [missing][nowhere].',
  '```js\nconst x = "</script>";\n```\n\n    indented code\n    line two',
  '> quote one\n> > nested quote\n>\n> back to one\n\n1. one\n2. two\n   - inner\n   - inner\n3. three',
  'Text with &amp; &copy; &#169; &#xA9; &notarealentity; AT&T and 5 < 6 > 4 "quoted".',
  'Setext\n======\n\n***\n\nTrailing spaces  \nmake a break.',
  '$E = mc^2$ inline and $$\nx = y\n$$ block.\n\n$\\frac{1}{2}$ more.',
  '![an image](https://example.com/i.png "title") and ![ref-img][img-ref]\n\n[img-ref]: /local/path.png',
  'a *b **c** d* e\n_b _c_ d_\n***bold italic***\n**a*b**c*\n*a**b**c*',
  '- a\n  1. b\n     - [x] c\n        > quoted task\n- d',
  '| escaped \\| pipe | `code | pipe` |\n| --- | --- |\n| a \\| b | c |',
  '<https://example.com/angle> <mailto:a@b.co> <not-a-scheme>\n[javascript:alert(1)](https://safe.example.com)',
  'Escapes: \\* \\_ \\# \\\\ \\[ \\] \\( \\) \\! \\` \\| \\~ \\< \\> \\& \\$',
  '- item with hard break  \n  continuation\n\n- loose\n\n- item',
  'Term\n: definition? No — a paragraph line starting with colon.',
  '# Heading with trailing #\n## Another ##\n### Unclosed\n####### seven hashes',
];

const SEED_POOL = [...SPEC_SEEDS, ...HAND_SEEDS];

// ---------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------

/** The markdown-significant alphabet, weighted toward the delimiters that break parsers. */
const INSERT_CHARS = [
  '*',
  '_',
  '~',
  '[',
  ']',
  '(',
  ')',
  '#',
  '>',
  '-',
  '|',
  ':',
  '`',
  '!',
  '&',
  ';',
  '<',
  '=',
  '\n',
  '\n\n',
  '\r\n',
  '\t',
  ' ',
  '  ',
  '\\',
  '"',
  "'",
  '/',
  '.',
  '$',
  '^',
  '{',
  '}',
  '%',
  '@',
  '+',
  'a',
  'b',
  '1',
  '&amp;',
  '&#',
  '&#x',
  '&quot;',
  '&Tab;',
  '&NewLine;',
  '&colon;',
  'é',
  '中',
  '\u{1F600}',
  '\u0301',
  '\u200b',
  '\u202E',
  '\uFFFD',
  '\u0000',
  '\u000B',
  '\u007F',
];

const MUTATIONS = [
  'insert',
  'delete',
  'duplicate',
  'splice',
  'truncate',
  'crlf',
  'tabify',
  'append-seed',
];

function mutate(source: string, rng: () => number, pool: string[]): { text: string; kind: string } {
  const kind = pick(rng, MUTATIONS);
  const chars = [...source];
  const at = Math.floor(rng() * chars.length);
  switch (kind) {
    case 'insert': {
      const run = 1 + Math.floor(rng() * 4);
      chars.splice(at, 0, ...Array.from({ length: run }, () => pick(rng, INSERT_CHARS)));
      return { text: chars.join(''), kind };
    }
    case 'delete': {
      const run = 1 + Math.floor(rng() * 6);
      chars.splice(at, run);
      return { text: chars.join(''), kind };
    }
    case 'duplicate': {
      const run = 1 + Math.floor(rng() * 12);
      const slice = chars.slice(at, at + run);
      chars.splice(at, 0, ...slice);
      return { text: chars.join(''), kind };
    }
    case 'splice': {
      const other = pick(rng, pool);
      const oChars = [...other];
      const oAt = Math.floor(rng() * oChars.length);
      const oRun = 1 + Math.floor(rng() * Math.min(40, oChars.length));
      chars.splice(at, 0, ...oChars.slice(oAt, oAt + oRun));
      return { text: chars.join(''), kind };
    }
    case 'truncate': {
      return { text: chars.slice(0, at).join(''), kind };
    }
    case 'crlf': {
      return { text: source.replace(/\n/g, '\r\n'), kind };
    }
    case 'tabify': {
      // Replace some spaces with tabs — the documented tab-expansion
      // divergence is canonicalized away by the testkit's comparison.
      return { text: source.replace(/ {1,4}/g, (m) => (rng() < 0.5 ? '\t'.repeat(1) : m)), kind };
    }
    case 'append-seed': {
      return { text: source + '\n\n' + pick(rng, pool), kind };
    }
    default:
      return { text: source, kind };
  }
}

// ---------------------------------------------------------------------------
// The runs — deterministic batches, failures carry their provenance
// ---------------------------------------------------------------------------

const BATCHES = 8;
const SEEDS_PER_BATCH = 30;
const MUTANTS_PER_SEED = 16;

describe('fuzz — mutants of the corpus against the oracle and the security model', () => {
  it('the seed pool is broad enough to be worth fuzzing', () => {
    expect(SEED_POOL.length).toBeGreaterThan(200);
  });

  for (let batch = 0; batch < BATCHES; batch += 1) {
    it(`batch ${batch + 1}/${BATCHES} — ${(SEEDS_PER_BATCH * MUTANTS_PER_SEED).toLocaleString()} mutants survive, satisfy the invariants and match the oracle`, () => {
      const failures: string[] = [];
      let compared = 0;
      let policyExcluded = 0;
      let mutantCount = 0;

      for (let s = 0; s < SEEDS_PER_BATCH; s += 1) {
        // Deterministic seed schedule: batch, slot, fixed generation salt.
        const rng = mulberry32(0x7074_0000 + batch * 10_000 + s);
        const source = SEED_POOL[(batch * SEEDS_PER_BATCH + s) % SEED_POOL.length]!;

        for (let m = 0; m < MUTANTS_PER_SEED; m += 1) {
          const { text, kind } = mutate(source, rng, SEED_POOL);
          mutantCount += 1;
          const label = `batch${batch + 1} seed#${(batch * SEEDS_PER_BATCH + s) % SEED_POOL.length} mutant#${m} (${kind})`;

          let ours: string;
          try {
            ours = renderMarkdownToHtml(text);
          } catch (error) {
            failures.push(
              `${label}\n  THREW (ours): ${String(error)}\n  in: ${JSON.stringify(text)}`,
            );
            continue;
          }

          // Security invariants hold on garbage, not just on grammar.
          for (const violation of walkInvariants(ours)) {
            failures.push(
              `${label}\n  INVARIANT: ${violation}\n  in: ${JSON.stringify(text)}\n  out: ${JSON.stringify(ours)}`,
            );
          }

          // Math is padify's OWN extension — the oracle has no opinion on
          // any document where the owned renderer chose the math reading
          // (the same document-level exclusion the raw-HTML rule uses).
          if (ours.includes('padify-math')) {
            policyExcluded += 1;
            continue;
          }

          let oracle: string;
          try {
            oracle = oracleHtml(text);
          } catch (error) {
            // The oracle throwing is ITS failure, not ours — but record it
            // so the corpus feeding it can be inspected.
            failures.push(
              `${label}\n  ORACLE THREW: ${String(error)}\n  in: ${JSON.stringify(text)}`,
            );
            continue;
          }

          if (oracleUsesPolicyPower(text, oracle)) {
            policyExcluded += 1;
            continue;
          }
          compared += 1;
          const oursCanon = canonicalizeHtml(ours);
          const oracleCanon = canonicalizeHtml(oracle);
          let match = oursCanon === oracleCanon;
          if (!match && oracle.includes('\t')) {
            // The tab divergence: the oracle's raw tab met the owned
            // pre-expansion and the serialized column cannot reconstruct
            // the source column — retry on the divergence's own terms
            // (whitespace runs inside code and attributes equate).
            match = canonicalizeHtml(ours, true) === canonicalizeHtml(oracle, true);
          }
          if (!match) {
            failures.push(
              `${label}\n  in:     ${JSON.stringify(text)}\n  ours:   ${oursCanon}\n  oracle: ${oracleCanon}`,
            );
          }
        }
      }

      const summary = `${mutantCount} mutants, ${compared} compared, ${policyExcluded} policy-excluded, ${failures.length} failures`;
      if (failures.length > 0) {
        const shown = failures.slice(0, 10).join('\n\n');
        throw new Error(`FUZZ FAILURES — ${summary} (showing 10)\n\n${shown}`);
      }
      expect(failures, summary).toHaveLength(0);
    }, 30_000);
  }
});
