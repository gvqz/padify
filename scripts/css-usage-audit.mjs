#!/usr/bin/env node
/**
 * css-usage-audit.mjs — which stylesheet files have selectors the app never uses.
 *
 * Sibling of the retired dead-css-audit (override analysis): a legacy
 * sheet can be fully "alive" by override rules yet dead by USAGE if the
 * markup only ever matched its vercel twin's class names. This script
 * answers the usage question: for every class selector in every sheet
 * loaded by index.html, does that class string appear anywhere the app
 * could emit it?
 *
 * Corpus: index.html, every .ts/.html under src, and the share island's
 * sources (public/share) — every place a class name can be written (static
 * markup, TS template strings, classList.add/toggle arguments, mounted
 * modal HTML).
 *
 * Selectors are extracted with a depth-aware scanner, so classes inside
 * @media blocks count (the first version's chunk splitter silently missed
 * them — .statistics-grid was reported "used" only because it was never
 * reported at all).
 *
 * Known limitations (why this is an audit, not a pruner): dynamically
 * built class names ('tk-c-' + color, 'padify-fmt-' + id) and
 * library-emitted vocabulary (katex-*) undercount usage; every dead
 * verdict is a lead to verify by grep, not a deletion order. Exit code
 * is always 0.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// The corpus: everything that can emit markup.
const corpus = [
  join(repo, 'index.html'),
  ...walk(join(repo, 'src')),
  ...walk(join(repo, 'public', 'share')),
]
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n');

// The sheets index.html loads.
const indexHtml = readFileSync(join(repo, 'index.html'), 'utf-8');
const links = [...indexHtml.matchAll(/href="(\/css\/[^"]+\.css)"/g)].map((m) => m[1]);

/** Class tokens from every selector position, @media nesting included. */
function sheetClasses(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set();
  let selectorStart = 0;
  let depth = 0;
  for (let i = 0; i <= noComments.length; i++) {
    const ch = noComments[i];
    if (ch === '{' || ch === '}' || i === noComments.length) {
      if (ch === '{') {
        // The text before this brace is a selector — unless it is an
        // at-rule prelude (@media, @keyframes, @supports...).
        const selector = noComments.slice(selectorStart, i).trim();
        if (selector && !selector.startsWith('@')) {
          for (const m of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
            classes.add(m[1]);
          }
        }
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
      // After a closing brace (or a rule body), the next selector starts.
      if (ch === '}' || depth === 0) {
        selectorStart = i + 1;
      }
    }
  }
  return [...classes].sort();
}

const report = [];
for (const link of links) {
  const path = join(repo, 'public', link.replace('/css/', 'css/'));
  const css = readFileSync(path, 'utf-8');
  const classes = sheetClasses(css);
  const unused = classes.filter((name) => !corpus.includes(name));
  report.push({ link, total: classes.length, unused: unused.length, unusedList: unused });
}

report.sort((a, b) => a.unused / Math.max(1, a.total) - b.unused / Math.max(1, b.total));
for (const r of report) {
  const pct = r.total ? Math.round((100 * r.unused) / r.total) : 0;
  const flag = r.unused === 0 ? 'ALL USED' : pct >= 90 ? 'DEAD-ish' : pct >= 60 ? 'mostly??' : '';
  console.log(
    `${flag.padEnd(9)} ${String(pct).padStart(3)}% unused  ${r.unused}/${r.total}  ${r.link}`,
  );
  if (r.unused > 0 && r.link !== '/css/bootstrap.min.css') {
    console.log(`          unused: ${r.unusedList.join(' ')}`);
  }
}
