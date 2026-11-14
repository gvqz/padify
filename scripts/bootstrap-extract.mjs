#!/usr/bin/env node
/**
 * bootstrap-extract.mjs — reduce bootstrap.min.css to what the app still uses.
 *
 * Un-shipping bootstrap (Phase 1) must not change a single rendered pixel:
 * the rules that still match live markup, or that the app's runtime could
 * attach classes for, survive — folded into the design system. Everything
 * else (alerts, breadcrumbs, carousels, wells, panels, pager, pagination…)
 * never matches and never will.
 *
 * A rule group is KEPT when any of these hold:
 *   1. DOM-MATCHED — its selector matched at least one live element in the
 *      css-cascade-audit views (incl. hover/tooltip/shortcuts/timer states).
 *   2. CORPUS-REFERENCED — a class or id token in the selector appears in
 *      the app's emit corpus (index.html + src + public/share sources), the
 *      same corpus css-usage-audit.mjs scans. This is the safety net for
 *      states the views cannot exercise (the mobile collapse animation,
 *      .fade.in transitions on freshly-opened modals, focus classes...).
 *   3. INFRASTRUCTURE — @font-face for a family some kept rule (or the
 *      corpus) references; @keyframes referenced by a kept animation.
 *
 * Output (stdout): the kept CSS, original order preserved, comments stripped
 * except the banner. Exit code is 0 even when everything is kept — this is
 * an extractor, not a gate; the proof lives in the pixel + computed diffs.
 *
 * Usage: node scripts/bootstrap-extract.mjs <audit.json> > out.css
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseCss } = await import('./dead-css-audit.mjs');

const auditPath = process.argv[2];
if (!auditPath) {
  console.error('usage: node scripts/bootstrap-extract.mjs <audit.json>');
  process.exit(2);
}
const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
const bootAudit = audit.sheets['bootstrap.min.css'];
if (!bootAudit) {
  console.error('audit.json has no bootstrap.min.css section');
  process.exit(2);
}
const matched = new Set([...bootAudit.fully, ...bootAudit.partially].map((r) => r.selector));

/** The audit's keys come from Chrome's CSSOM selectorText serialization,
 *  which differs from raw file text in exactly three ways that matter
 *  here: legacy single-colon pseudo-elements are re-spelled with two
 *  colons, unquoted attribute values gain double quotes, and comma parts
 *  join with ' | '. Replicate that or matched rules silently miss (the
 *  `:after,:before{box-sizing}` rule was dropped exactly this way). */
function cssomKey(sel) {
  return sel
    .split(',')
    .map((part) => {
      let p = part.trim();
      p = p.replace(/(^|[\s,+>*]):(before|after|first-line|first-letter)\b/g, '$1::$2');
      p = p.replace(/\[([\w-]+)=(\w+)\]/g, '[$1="$2"]');
      return p;
    })
    .join(' | ');
}

// The corpus (same walk as css-usage-audit.mjs — every file that can emit
// markup or toggle a class at runtime).
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      walk(full, out);
    } else if (/\.(ts|html|js)$/.test(name) && !/\.test\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}
const corpus = [
  join(ROOT, 'index.html'),
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'public', 'share')),
]
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n');

/** Pre-extracted class-attribute token lists: every literal
 *  class=".." (or class='..' / class=`..`) in the corpus, split on
 *  whitespace. Hyphen-prefixed/suffixed lookalikes (menu-item emitting
 *  'item') do NOT count -- only exact tokens do. */
const classAttrTokens = new Set();
for (const m of corpus.matchAll(/class\s*=\s*(["'`][^"'`]*["'`])/g)) {
  for (const tok of m[1].slice(1, -1).split(/\s+/)) {
    if (tok) classAttrTokens.add(tok);
  }
}
/** Quoted strings used as classList/className ARGUMENTS -- the runtime
 *  toggles (classList.add('in'), className = 'modal fade'). */
const classListTokens = new Set();
for (const m of corpus.matchAll(
  /(?:classList\s*\.\s*(?:add|toggle|remove|contains)\s*\(\s*|className\s*=\s*)(["'`][^"'`]*["'`])/g,
)) {
  for (const tok of m[1].slice(1, -1).split(/\s+/)) {
    if (tok) classListTokens.add(tok);
  }
}

/** Does any class/id token in this selector get emitted by the app? */
function corpusReferenced(selector) {
  for (const m of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    if (classAttrTokens.has(m[1]) || classListTokens.has(m[1])) return true;
  }
  for (const m of selector.matchAll(/#([\w-]+)/g)) {
    if (new RegExp(`id\\s*=\\s*["']${m[1]}["']`).test(corpus)) return true;
    if (new RegExp(`["']#${m[1]}["']`).test(corpus)) return true; // querySelector('#tok')
  }
  return false;
}

const source = readFileSync(join(ROOT, 'public', 'css', 'bootstrap.min.css'), 'utf-8');
const parsed = parseCss(source, 'bootstrap.min.css');
// Pass 1: style rules (parseCss skips @keyframes/@font-face as opaque).
let kept = 0;
const keptRules = [];
for (const rule of parsed.rules) {
  const selector = rule.selector; // already normalized
  const isMatched = matched.has(cssomKey(selector));
  const isReferenced = corpusReferenced(selector);
  if (isMatched || isReferenced) {
    kept++;
    keptRules.push(rule);
  }
}

// Pass 2: opaque blocks — @font-face and @keyframes from the raw text.
const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
const fontFaces = [];
for (const m of noComments.matchAll(/@font-face\s*\{[^}]*\}/g)) fontFaces.push(m[0]);
const keyframes = [];
for (const m of noComments.matchAll(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g)) {
  keyframes.push(m[0]);
}

// A @font-face survives if its family is referenced by a kept rule's
// font-family or by the corpus (e.g. an icon class the app emits). NOTE:
// any kept face's relative url()s must be rewritten for the new file's
// depth — none are kept today (the glyphicon font is unreferenced and the
// files are not even shipped), which the extractor prints to stderr.
const keptText = keptRules.map((r) => r.selector).join('\n');
const keptFontFaces = fontFaces.filter((ff) => {
  const fam = ff.match(/font-family:\s*['"]?([^;'"}]+)/)?.[1]?.trim();
  if (!fam) return false;
  return keptText.includes(fam) || classAttrTokens.has(fam) || classListTokens.has(fam);
});

// A @keyframes survives if a kept rule references its name.
const keptDeclText = keptRules.map((r) => r.declarations.map((d) => d.value).join(' ')).join('\n');
const keptKeyframes = keyframes.filter((kf) => {
  const name = kf.match(/@keyframes\s+([\w-]+)/)?.[1];
  return name && new RegExp(`(^|[\\s,])${name}($|[\\s,])`).test(keptDeclText);
});

// Emit: the kept rules with their declarations, in original order. Byte
// offsets from parseCss (rule.start..rule.end) index the ORIGINAL minified
// source (comments included — the parser skips them without counting), so
// what ships is byte-identical to bootstrap's own declarations.
//
// @media CONTEXT IS LOAD-BEARING: parseCss flattens conditional blocks, so
// a rule that lived inside `@media print { ... }` carries its prelude in
// atContext. Splicing the inner rule out bare would un-condition it — the
// first version did exactly that and bootstrap's print-only
// `.navbar{display:none}` hid the topbar on every screen. Kept rules are
// therefore grouped into runs of identical atContext and each run is
// re-wrapped in its original prelude(s).
const out = [];
let openContext = null; // array of preludes, e.g. ['@media print']
const closeWrappers = () => {
  if (openContext) {
    for (let i = 0; i < openContext.length; i++) out.push('}');
  }
  openContext = null;
};
for (const rule of keptRules) {
  const ctx = rule.atContext.length ? rule.atContext : null;
  if (!ctx || ctx.join('|') !== (openContext ?? []).join('|')) {
    closeWrappers();
    if (ctx) {
      for (const prelude of ctx) out.push(prelude + '{');
      openContext = ctx;
    }
  }
  out.push(source.slice(rule.start, rule.end));
}
closeWrappers();

console.log('/* Bootstrap 3.4.1 — the surviving subset.');
console.log(
  ` * ${kept}/${parsed.rules.length} rule groups kept (DOM-matched or corpus-referenced);`,
);
console.log(` * ${keptFontFaces.length} @font-face, ${keptKeyframes.length} @keyframes.`);
console.log(' * Extracted mechanically by scripts/bootstrap-extract.mjs; rendering');
console.log(' * parity is proven by the computed-style and pixel diffs (see the');
console.log(' * Phase 1 notes in docs/ARCHITECTURE-REVIEW.md). */');
console.log(out.join('\n'));
if (keptFontFaces.length) console.log(keptFontFaces.join('\n'));
if (keptKeyframes.length) console.log(keptKeyframes.join('\n'));
console.error(
  `kept ${kept}/${parsed.rules.length} rules, ${keptFontFaces.length} font-faces, ${keptKeyframes.length} keyframes`,
);
