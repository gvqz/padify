#!/usr/bin/env node
/**
 * Dead-CSS audit — which legacy rules does the vercel layer fully override?
 *
 * The repo ships two CSS systems (see index.html): ~6.6k lines of legacy
 * app CSS layered UNDER ~5.4k lines of the "vercel" design-system skin.
 * The owner has been pruning the legacy layer by hand for months ("X is
 * vercel-skinned end to end" — 16 of the last 30 commits); this tool is
 * the detector that says where to cut next, and just as importantly where
 * NOT to cut yet. It is deliberately an AUDIT, not an auto-pruner: it
 * never writes files and always exits 0 — findings are information, not
 * a build failure.
 *
 * HOW IT DECIDES
 * The stylesheet order is read from index.html itself (the <link>
 * sequence is the cascade's source of truth; a hardcoded list here would
 * drift the first time someone adds a file). The link chain splits into:
 *
 *  • tokens.css — excluded entirely. It defines the CSS custom
 *    properties every other layer consumes; its declarations "lose" to
 *    later files all day long, but deleting one breaks every var()
 *    consumer, so it is not audit material.
 *  • bootstrap.min.css — audited like any legacy file (the vercel layer
 *    absolutely overrides it), but reported with a vendored marker: the
 *    file is pinned by content hash in src/architecture.test.ts and must
 *    never be pruned by hand. Bump the vendored file wholesale or not at
 *    all.
 *  • the other /css/*.css files before the vercel/ directory — the
 *    LEGACY layer, the pruning candidates.
 *  • the /css/vercel/NN-*.css files (later in the link chain) — the
 *    OVERRIDING layer.
 *
 * A legacy rule lands in TIER 1 (fully overridden — safe to delete) only
 * when ALL of these hold. Every guard exists because a naive "a later
 * same-selector rule wins" check produces false positives that break
 * the UI:
 *
 *  1. The exact same normalized selector text appears in a later vercel
 *     rule. Same text ⇒ same specificity ⇒ vercel wins purely by source
 *     order. Nearly-equal selectors prove nothing: an extra class is a
 *     specificity change, a reordered selector list is a different set
 *     of cascade participants, and whitespace noise would hide real
 *     matches — so selectors are whitespace-normalized (runs collapsed,
 *     one space around every comma/combinator) and then compared for
 *     exact equality.
 *  2. Every property the legacy rule declares is declared by the vercel
 *     side — if a single property survives, the rule still paints
 *     something and must stay. (Shorthand handling below.)
 *  3. Neither side uses !important. A legacy !important declaration
 *     BEATS a plain vercel declaration no matter how late it loads, and
 *     a vercel !important signals a cascade fight this tool refuses to
 *     referee — the whole rule is skipped on either side.
 *  4. The rule is top-level, not inside @media/@supports/… — a
 *     conditional rule and an unconditional rule are never in the
 *     cascade at the same time, so "who wins" is a category error.
 *     Vercel rules inside media queries are likewise never counted as
 *     coverers: they override nothing unconditionally.
 *  5. The selector is plain — classes, ids, element names, the
 *     universal selector and combinators only; no pseudo-classes, no
 *     pseudo-elements, no attribute selectors. ":hover" matches a
 *     different element set than the bare selector does, "::before"
 *     matches no element at all — a same-text match across layers then
 *     says nothing about the same boxes being covered.
 *  6. The rule is not written with CSS nesting ("&"). A nested rule's
 *     effective selector is computed by the engine, not written in the
 *     file, so its text proves nothing — and it taints the declarations
 *     of the rule that hosts it, so both are skipped.
 *
 * TIER 2 (lower confidence — reported, never recommended for pruning)
 * collects the rules that DID find a same-selector vercel counterpart
 * and pass the guards above, but where at least one legacy property
 * survives. Usually that means the vercel layer is mid-migration on
 * that selector: someone skinned part of it. Tier 2 is the to-do list;
 * tier 1 is the done list.
 *
 * THE SHORTHAND RULE (deliberately lopsided)
 * A shorthand declaration unambiguously RESETS every longhand it expands
 * to, regardless of its value — a vercel "margin: 0" sets all four
 * margin-* longhands, so it covers a legacy "margin-top". The reverse is
 * NOT trusted: four vercel longhands do not cover a legacy "margin"
 * shorthand unless all four sides are present AND win, which is a
 * per-side analysis this tool declines to do — a legacy shorthand is
 * covered only by a vercel shorthand of the same name. The expansion is
 * a fixed whitelist (LONGHANDS_OF below), not a value parser: anything
 * outside it requires an exact property-name match. Both directions err
 * toward NOT flagging.
 *
 * OUT OF SCOPE, ON PURPOSE
 *  • Legacy-vs-legacy shadowing (music-player.css overriding base.css):
 *    only the vercel layer is treated as an overrider — pruning within
 *    the legacy layer is a different, riskier job (early rules act as
 *    fallbacks for paint paths the later rule misses).
 *  • Different-selector overrides (a higher-specificity vercel rule
 *    beating a legacy one): requires matching selector semantics against
 *    live markup, not text. Not attempted.
 *  • Custom-property names keep their casing (they are case-sensitive,
 *    unlike normal properties, which are compared lowercased).
 *
 * Usage:
 *   node scripts/dead-css-audit.mjs          # human-readable report
 *   node scripts/dead-css-audit.mjs --json   # machine-readable; tier-1
 *                                            # entries carry byte offsets
 *                                            # into their file so an
 *                                            # editor can act precisely
 * Exit code is always 0 — this is an audit, not a gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = join(ROOT, 'index.html');

// ---------------------------------------------------------------------------
// Stylesheet order — read from index.html, never hardcoded.
// ---------------------------------------------------------------------------

/** The /css/*.css <link> hrefs in document order — the cascade order. */
export function stylesheetOrder(html) {
  const hrefs = [];
  for (const m of html.matchAll(/<link\s[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']stylesheet["']/i.test(tag)) continue;
    const href = m[1];
    if (!/^\/css\/(?:[\w.-]+\/)?[\w.-]+\.css$/.test(href)) continue;
    hrefs.push(href);
  }
  return hrefs;
}

// ---------------------------------------------------------------------------
// CSS parsing — a small state machine, no dependencies.
// ---------------------------------------------------------------------------

/** Strips CSS comments, string-aware (a quoted "/*" survives). */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parses a stylesheet into rule records with a single-pass scanner:
 *  • comments are skipped (their newlines still counted — line numbers
 *    stay truthful),
 *  • quoted strings are skipped atomically,
 *  • an at-block is "opaque" (@keyframes, @font-face, @page, …) when its
 *    contents are not style rules — anything it contains is dropped;
 *    other at-blocks (@media, @supports, …) are "conditional" and rules
 *    inside them carry the at-context (and never take part in matching),
 *  • a "{" reached while already inside a rule body is CSS nesting: the
 *    inner rule and its host are both flagged and skipped.
 *
 * @returns {{ rules: object[] }} every rule records file, line (first
 *   line of its selector), the source span (offset of the selector start
 *   through the closing brace — byte offsets into the file as read),
 *   raw + normalized selector text, at-context, nesting flag and its
 *   parsed declarations.
 */
export function parseCss(source, file) {
  const rules = [];
  const stack = [];
  let buf = '';
  let bufLine = 1;
  let bufOffset = 0;
  let line = 1;
  let i = 0;

  const append = (ch) => {
    if (buf === '') {
      bufLine = line;
      bufOffset = i;
    }
    buf += ch;
  };

  const atKind = (prelude) => {
    const name = prelude
      .slice(1)
      .split('(')[0]
      .trim()
      .toLowerCase()
      .replace(/^-(?:webkit|moz|ms|o)-/, '');
    if (
      /(keyframes|font-face|page$|viewport|counter-style|property$|font-feature-values|color-profile|namespace)/.test(
        name,
      )
    ) {
      return 'opaque';
    }
    // media, supports, container, layer, scope — and anything unknown:
    // assume conditional; rules inside get an at-context and never match.
    return 'conditional';
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += source.slice(i, stop).split('\n').length - 1;
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j++;
        j++;
      }
      line += source.slice(i, Math.min(j + 1, source.length)).split('\n').length - 1;
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      const prelude = stripComments(buf).trim();
      if (prelude.startsWith('@')) {
        stack.push({ type: 'at', kind: atKind(prelude), prelude });
      } else {
        stack.push({
          type: 'rule',
          prelude,
          startLine: bufLine,
          startOffset: bufOffset,
          bodyStart: i + 1,
        });
      }
      buf = '';
      i++;
      continue;
    }

    if (ch === '}') {
      const frame = stack.pop();
      if (frame && frame.type === 'rule') {
        const parent = stack[stack.length - 1];
        if (parent && parent.type === 'rule') parent.nestedHost = true;

        const insideOpaque = stack.some((f) => f.type === 'at' && f.kind === 'opaque');
        if (!insideOpaque) {
          const nested = Boolean(frame.nestedHost) || stack.some((f) => f.type === 'rule');
          const atContext = stack
            .filter((f) => f.type === 'at' && f.kind === 'conditional')
            .map((f) => f.prelude);
          rules.push({
            file,
            line: frame.startLine,
            start: frame.startOffset,
            end: i + 1, // includes the closing brace
            selectorRaw: frame.prelude,
            selector: normalizeSelector(frame.prelude),
            atContext,
            nested,
            declarations: parseDeclarations(source.slice(frame.bodyStart, i)),
          });
        }
      }
      buf = '';
      i++;
      continue;
    }

    if (ch === ';') {
      // End of a declaration or of an at-statement (@import/@charset).
      // A declaration's text is never prelude material — the body is
      // sliced by offsets — so the buffer can always restart clean here.
      buf = '';
      i++;
      continue;
    }

    append(ch);
    i++;
  }
  return { rules };
}

/** Whitespace-normalizes a selector: runs collapsed, single space around
 * commas and combinators. Token CONTENT (class/id/tag names, casing) is
 * untouched — selectors are case-sensitive in the ways that matter. */
export function normalizeSelector(selector) {
  return stripComments(selector)
    .replace(/\s+/g, ' ')
    .replace(/\s*([,+~>])\s*/g, ' $1 ')
    .trim();
}

/** Splits a rule body into {prop, value, important} declarations.
 * Comments are stripped first (string-aware), then ";" splits — never
 * inside quotes or unquoted url()/data: parens. A segment containing a
 * brace is nested-rule debris, not a declaration. */
export function parseDeclarations(body) {
  const clean = stripComments(body);
  const decls = [];
  let segment = '';
  let paren = 0;
  let quote = null;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quote) {
      segment += ch;
      if (ch === '\\' && i + 1 < clean.length) {
        segment += clean[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      segment += ch;
      continue;
    }
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === ';' && paren <= 0) {
      pushDeclaration(decls, segment);
      segment = '';
      paren = 0;
      continue;
    }
    segment += ch;
  }
  pushDeclaration(decls, segment);
  return decls;
}

function pushDeclaration(decls, rawSegment) {
  const segment = rawSegment.trim();
  if (!segment || /[{}]/.test(segment)) return; // empty or nested-rule debris
  // Split at the first ":" that is not inside quotes or parens
  // (url(http://…), progid: filters, data URIs).
  let quote = null;
  let paren = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && i + 1 < segment.length) {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === ':' && paren <= 0) {
      const prop = segment.slice(0, i).trim();
      const value = segment.slice(i + 1).trim();
      if (!prop) return;
      decls.push({
        prop: prop.startsWith('--') ? prop : prop.toLowerCase(),
        value,
        important: /!\s*important$/i.test(value),
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Shorthand coverage — the deliberately lopsided whitelist.
// ---------------------------------------------------------------------------

/** Longhands that a vercel shorthand unambiguously resets, so it covers
 * the same-named legacy longhand. Anything not listed requires an exact
 * property-name match. outline deliberately omits outline-offset (it is
 * not part of the shorthand); likewise border omits border-image. */
export const LONGHANDS_OF = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  border: [
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-right-width',
    'border-right-style',
    'border-right-color',
    'border-bottom-width',
    'border-bottom-style',
    'border-bottom-color',
    'border-left-width',
    'border-left-style',
    'border-left-color',
  ],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
  background: [
    'background-color',
    'background-image',
    'background-repeat',
    'background-attachment',
    'background-position',
    'background-position-x',
    'background-position-y',
    'background-size',
    'background-origin',
    'background-clip',
  ],
  font: ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'],
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  inset: ['top', 'right', 'bottom', 'left'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  overflow: ['overflow-x', 'overflow-y'],
  'overscroll-behavior': ['overscroll-behavior-x', 'overscroll-behavior-y'],
  'text-decoration': [
    'text-decoration-line',
    'text-decoration-color',
    'text-decoration-style',
    'text-decoration-thickness',
  ],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  columns: ['column-width', 'column-count'],
  'grid-area': ['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'],
};

/** True when a legacy `prop` is set by a vercel side declaring exactly
 * `vercelProps` (exact names plus whitelist shorthand expansion). */
export function coversProperty(prop, vercelProps) {
  if (vercelProps.has(prop)) return true;
  for (const [shorthand, longhands] of Object.entries(LONGHANDS_OF)) {
    if (vercelProps.has(shorthand) && longhands.includes(prop)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The audit itself.
// ---------------------------------------------------------------------------

// pseudo-classes/elements, attribute selectors, nesting, at-garbage —
// anything whose match set is not "the elements the text names".
const PLAIN_SELECTOR_REJECT = /[:\[&@]/;

/**
 * Runs the audit. Exported so a future test can pin the guards against
 * fixture stylesheets.
 *
 * @param {string} html — index.html content
 * @param {(path: string) => string} readSource — resolves a repo-relative
 *   path ("public/css/base.css") to file content
 * @returns {{ order: string[], legacyFiles: object[], vercelFiles:
 *   string[], tier1: object[], tier2: object[], skipped: object }}
 */
export function audit(html, readSource) {
  const order = stylesheetOrder(html);
  const files = order.map((href, index) => ({
    href,
    path: href.replace(/^\//, 'public/'),
    order: index,
    vercel: href.startsWith('/css/vercel/'),
    tokens: href === '/css/tokens.css',
  }));

  const legacyFiles = files.filter((f) => !f.vercel && !f.tokens);
  const vercelFiles = files.filter((f) => f.vercel);

  const parsed = new Map();
  for (const f of files) {
    parsed.set(f.href, parseCss(readSource(f.path), f.href));
  }

  // Overrider index: normalized selector -> vercel rules, top-level and
  // !important-free only (guards 3 and 4 for the covering side).
  const vercelBySelector = new Map();
  let vercelConditional = 0;
  let vercelImportant = 0;
  for (const f of vercelFiles) {
    for (const rule of parsed.get(f.href).rules) {
      if (rule.atContext.length > 0) {
        vercelConditional++;
        continue;
      }
      if (rule.nested) continue;
      if (rule.declarations.some((d) => d.important)) {
        vercelImportant++;
        continue;
      }
      if (!vercelBySelector.has(rule.selector)) vercelBySelector.set(rule.selector, []);
      vercelBySelector.get(rule.selector).push({
        file: f.href,
        order: f.order,
        line: rule.line,
        declarations: rule.declarations,
      });
    }
  }

  const tier1 = [];
  const tier2 = [];
  const skipped = {
    mediaQuery: 0,
    pseudoOrAttrSelector: 0,
    important: 0,
    nested: 0,
    noVercelMatch: 0,
    matchedNothingCovered: 0,
    vercelConditional,
    vercelImportant,
  };

  for (const f of legacyFiles) {
    for (const rule of parsed.get(f.href).rules) {
      if (rule.atContext.length > 0) {
        skipped.mediaQuery++;
        continue;
      }
      if (rule.nested) {
        skipped.nested++;
        continue;
      }
      if (rule.declarations.some((d) => d.important)) {
        skipped.important++;
        continue;
      }
      if (PLAIN_SELECTOR_REJECT.test(rule.selector)) {
        skipped.pseudoOrAttrSelector++;
        continue;
      }
      const coverers = (vercelBySelector.get(rule.selector) ?? []).filter((c) => c.order > f.order);
      if (coverers.length === 0) {
        skipped.noVercelMatch++;
        continue;
      }
      const vercelProps = new Set();
      for (const c of coverers) {
        for (const d of c.declarations) vercelProps.add(d.prop);
      }
      const covered = [];
      const uncovered = [];
      for (const d of rule.declarations) {
        (coversProperty(d.prop, vercelProps) ? covered : uncovered).push(d.prop);
      }
      const entry = {
        file: f.href,
        line: rule.line,
        selector: rule.selector,
        start: rule.start,
        end: rule.end,
        vendored: f.path.endsWith('bootstrap.min.css'),
      };
      if (uncovered.length === 0) {
        tier1.push({
          ...entry,
          properties: covered,
          coveredBy: coverers.map((c) => ({ file: c.file, line: c.line })),
        });
      } else if (covered.length > 0) {
        tier2.push({ ...entry, covered, uncovered });
      } else {
        skipped.matchedNothingCovered++;
      }
    }
  }

  return {
    order,
    legacyFiles: legacyFiles.map((f) => ({
      href: f.href,
      vendored: f.path.endsWith('bootstrap.min.css'),
    })),
    vercelFiles: vercelFiles.map((f) => f.href),
    tier1,
    tier2,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Report rendering.
// ---------------------------------------------------------------------------

function humanReport(result) {
  const lines = [];
  lines.push('dead-css audit — legacy rules the vercel layer fully overrides');
  lines.push(
    `stylesheet order: ${result.order.length} links from index.html ` +
      `(${result.legacyFiles.length} legacy [tokens.css excluded], ${result.vercelFiles.length} vercel)`,
  );
  const vendored = result.legacyFiles.filter((f) => f.vendored);
  if (vendored.length > 0) {
    lines.push(
      `vendored (report-only, hash-pinned in src/architecture.test.ts — never prune): ${vendored
        .map((f) => f.href)
        .join(', ')}`,
    );
  }
  lines.push('');
  lines.push('TIER 1 — fully overridden, all guards passed (prune candidates)');
  if (result.tier1.length === 0) {
    lines.push('  (none)');
  }
  let currentFile = null;
  for (const r of result.tier1) {
    if (r.file !== currentFile) {
      currentFile = r.file;
      lines.push(`${r.file}${r.vendored ? '  [VENDORED — do not prune]' : ''}`);
    }
    lines.push(
      `  line ${String(r.line).padStart(6)}  ${r.selector}  ` +
        `[${r.properties.length} prop${r.properties.length === 1 ? '' : 's'}: ${r.properties.join(', ')}]`,
    );
    for (const c of r.coveredBy) lines.push(`           by ${c.file}: line ${c.line}`);
  }
  lines.push('');
  lines.push('TIER 2 — same selector, partially overridden (lower confidence; keep)');
  if (result.tier2.length === 0) {
    lines.push('  (none)');
  }
  currentFile = null;
  for (const r of result.tier2) {
    if (r.file !== currentFile) {
      currentFile = r.file;
      lines.push(`${r.file}`);
    }
    lines.push(`  line ${String(r.line).padStart(6)}  ${r.selector}`);
    lines.push(`           covered:     ${r.covered.join(', ')}`);
    lines.push(`           not covered: ${r.uncovered.join(', ')}`);
  }
  lines.push('');
  const s = result.skipped;
  lines.push(
    `guards skipped: ${s.mediaQuery} in media queries, ${s.pseudoOrAttrSelector} pseudo/attr selectors, ` +
      `${s.important} legacy !important, ${s.nested} nested, ${s.noVercelMatch} without a same-selector vercel rule, ` +
      `${s.matchedNothingCovered} matched-but-intact; vercel side excluded: ` +
      `${s.vercelConditional} conditional, ${s.vercelImportant} !important`,
  );
  const prunable = result.tier1.filter((r) => !r.vendored);
  lines.push(
    `summary: tier1 = ${result.tier1.length} rule(s) in ${new Set(result.tier1.map((r) => r.file)).size} ` +
      `file(s) (${prunable.length} prunable — vendored bootstrap excluded); ` +
      `tier2 = ${result.tier2.length} rule(s) in ${new Set(result.tier2.map((r) => r.file)).size} file(s)`,
  );
  lines.push('audit only — nothing was written; exit code is always 0.');
  return lines.join('\n');
}

// CLI entry point — skip when the module is imported (e.g. by a test).
if (process.argv[1] && process.argv[1].endsWith('dead-css-audit.mjs')) {
  const asJson = process.argv.includes('--json');
  const html = readFileSync(INDEX_HTML, 'utf8');
  const result = audit(html, (path) => readFileSync(join(ROOT, path), 'utf8'));
  if (asJson) {
    console.log(JSON.stringify({ index: 'index.html', ...result }, null, 2));
  } else {
    console.log(humanReport(result));
  }
  // Deliberately exit 0 regardless of findings: an audit that failed the
  // build would train people to ignore (or worse, "fix") its output.
}
