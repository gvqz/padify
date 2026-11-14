#!/usr/bin/env node
/**
 * css-fold-check.mjs — prove a CSS file-consolidation plan flips no cascade tie.
 *
 * The Phase-1 fold moves rules from the legacy sheets into the vercel/
 * design-system files (and moves tasks.css / music-player.css in as numbered
 * feature files). Moving a rule cannot change specificity — the ONE thing a
 * move can change is which of two SAME-SELECTOR rules comes later, and for
 * equal-specificity same-selector rules "later wins" is the whole cascade.
 *
 * So this tool answers exactly that question, nothing else:
 *
 *   For every selector that appears in 2+ rules anywhere in the stylesheet
 *   chain, does the plan change the per-property winner?
 *
 * How it compares:
 *   - "today": the rule order index.html currently loads (the plan's input).
 *   - "after": the order the plan produces — for every target file in plan
 *     order, the rules folded INTO it (in their legacy order) first, then the
 *     file's own rules. Deleted/renamed-away sources contribute nothing.
 *   - Rules are matched per COMMA-EXPLODED complex selector, so a legacy
 *     ".a, .b" collides with a vercel ".b" the way the browser sees it.
 *   - A property's winner = the last rule declaring it that is "active":
 *     !important beats non-important regardless of position; among equals,
 *     later position wins. Media contexts are deliberately IGNORED (any two
 *     rules are treated as co-active) — over-conservative by design, because
 *     a false alarm costs a look while a missed flip costs a regression.
 *   - Rules may be routed per-selector: a mixed source file can split across
 *     targets; the "selectors" map keys are EXACT normalized selector texts.
 *
 * Out of scope (as in dead-css-audit.mjs): different-selector overrides —
 * those never flip when a rule moves, because relative specificity is
 * untouched. The browser-level proof is the computed-style diff + pixel
 * diff pair, not this tool.
 *
 * Usage:
 *   node scripts/css-fold-check.mjs scripts/css-fold-plan.json
 * The plan file shape (all paths /css/-rooted, as in index.html hrefs):
 *   {
 *     "route": {
 *       "source.css": { "default": "target.css",
 *                       "selectors": { "<exact normalized selector>": "target.css" } }
 *     },
 *     "deletes": ["source.css", ...],            // remove files entirely
 *     "renames": [["old.css", "new.css"], ...]   // move files as-is, appended at chain end
 *   }
 *   Route entry order = fold order: sources listed earlier land earlier inside
 *   their target. Exit code 1 on any flip, 0 on a clean plan.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseCss, stylesheetOrder, LONGHANDS_OF } = await import('./dead-css-audit.mjs');

// ---------------------------------------------------------------------------
// Load the plan and today's chain.
// ---------------------------------------------------------------------------

const planPath = process.argv[2];
if (!planPath) {
  console.error('usage: node scripts/css-fold-check.mjs <plan.json> [--exclude-deletes]');
  process.exit(2);
}
const excludeDeletes = process.argv.includes('--exclude-deletes');
const planFile = process.argv.slice(2).find((a) => !a.startsWith('--'));
const plan = JSON.parse(readFileSync(planFile, 'utf-8'));
const route = plan.route ?? {}; // href -> { default, selectors: {text: target} }
const deletes = new Set(plan.deletes ?? []);
const renames = plan.renames ?? [];

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf-8');
const order = stylesheetOrder(indexHtml); // e.g. ['/css/base.css', ..., '/css/vercel/01-tokens.css']

/** Every rule in the chain, tagged with its href. */
function loadChain(hrefs) {
  const rules = [];
  for (const href of hrefs) {
    const file = join(ROOT, 'public', href.replace(/^\//, ''));
    const parsed = parseCss(readFileSync(file, 'utf-8'), file);
    for (const r of parsed.rules) rules.push({ ...r, href, nested: r.nested });
  }
  return rules;
}

/** Comma-explode a normalized selector into individual complex selectors. */
function explode(selector) {
  // Split on top-level commas only (none of these sheets nest commas inside
  // :is()/:not() arguments; the parser keeps parens intact).
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Validate targets up front so typos fail loudly, not silently.
for (const [src, spec] of Object.entries(route)) {
  const targets = new Set([spec.default, ...Object.values(spec.selectors ?? {})]);
  for (const tgt of targets) {
    if (!order.includes(tgt) && !renames.some(([, n]) => n === tgt)) {
      throw new Error(`plan target not in chain: ${tgt} (from ${src})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Build the "after" order: the file sequence the plan implies.
// ---------------------------------------------------------------------------

const afterHrefs = [];
for (const href of order) {
  if (deletes.has(href) || route[href]) continue;
  if (renames.some(([o]) => o === href)) continue;
  afterHrefs.push(href);
}
for (const [, newName] of renames) afterHrefs.push(newName);

const todayRules = loadChain(order).filter((r) => !(excludeDeletes && deletes.has(r.href)));
const afterRules = [];
const foldSeq = Object.keys(route); // plan order = fold order within targets
for (const href of afterHrefs) {
  // Rules folded into this target come first, sources in plan order.
  for (const src of foldSeq) {
    const spec = route[src];
    for (const r of loadChain([src])) {
      const tgt = spec.selectors?.[r.selector] ?? spec.default;
      if (tgt === href) afterRules.push(r);
    }
  }
  // Then the file's own rules (a rename target loads its old file's rules;
  // identity keeps the ORIGINAL href so a pure rename is not a "flip").
  const rename = renames.find(([, n]) => n === href);
  if (rename) {
    for (const r of loadChain([rename[0]])) afterRules.push(r);
  } else if (!deletes.has(href)) {
    for (const r of loadChain([href])) afterRules.push(r);
  }
}

// ---------------------------------------------------------------------------
// Winner computation per (selector, property).
// ---------------------------------------------------------------------------

/** rules -> Map(selector, Map(prop, {href, line, important})) — the winner
 *  under "last active declaration wins; !important jumps the queue". Nested
 *  rules are skipped (order-stable relocations; no nesting in these files). */
function winners(rules) {
  const bySelector = new Map();
  rules.forEach((rule, idx) => {
    if (rule.nested) return;
    for (const sel of explode(rule.selector)) {
      if (!bySelector.has(sel)) bySelector.set(sel, []);
      bySelector.get(sel).push({ rule, idx });
    }
  });
  const result = new Map();
  for (const [sel, entries] of bySelector) {
    const props = new Map();
    for (const { rule, idx } of entries) {
      for (const d of rule.declarations) {
        // A shorthand resets every longhand it expands to, so `border: 1px
        // solid` and a later `border-color: X` from another same-selector
        // rule ARE in cascade competition at the longhand level — the
        // #note border flip slipped through exactly this gap when the
        // comparison was property-name-exact. Record both the shorthand
        // and each expanded longhand.
        const propsToSet = [d.prop, ...(LONGHANDS_OF[d.prop] ?? [])];
        for (const prop of propsToSet) {
          const prev = props.get(prop);
          // Cascade among same-selector rules: !important beats plain;
          // among equals, the LATER rule wins. (Media contexts are
          // deliberately treated as co-active — conservative on purpose.)
          if (prev && !d.important && prev.important) continue;
          props.set(prop, { important: d.important, idx, href: rule.href, line: rule.line });
        }
      }
    }
    if (props.size) result.set(sel, props);
  }
  return result;
}

const todayWinners = winners(todayRules);
const afterWinners = winners(afterRules);

// ---------------------------------------------------------------------------
// Report flips.
// ---------------------------------------------------------------------------

let flips = 0;
const keys = new Set([...todayWinners.keys(), ...afterWinners.keys()]);
for (const sel of [...keys].sort()) {
  const t = todayWinners.get(sel) ?? new Map();
  const a = afterWinners.get(sel) ?? new Map();
  const props = new Set([...t.keys(), ...a.keys()]);
  for (const prop of [...props].sort()) {
    const tw = t.get(prop);
    const aw = a.get(prop);
    // Identity = (file, line) of the winning rule. A rule that moved files
    // keeps its line; only the winner CHANGE matters.
    const tid = tw ? `${tw.href}:${tw.line}` : '(none)';
    const aid = aw ? `${aw.href}:${aw.line}` : '(none)';
    if (tid !== aid) {
      flips++;
      console.log(`FLIP  ${sel}  { ${prop} }`);
      console.log(`      today: ${tid}`);
      console.log(`      after: ${aid}`);
    }
  }
}

console.log(
  `\nplan: ${foldSeq.length} routed source(s), ${deletes.size} delete(s), ${renames.length} rename(s)`,
);
console.log(`today: ${order.length} files -> after: ${afterHrefs.length} files`);
console.log(`rules: today ${todayRules.length} -> after ${afterRules.length}`);
console.log(`selectors compared: ${keys.size}, flips: ${flips}`);
if (flips > 0) {
  console.log('\nREFUSED — the plan changes at least one cascade tie. Fix the targets.');
  process.exit(1);
}
console.log('\nOK — no same-selector tie flips under this plan.');
