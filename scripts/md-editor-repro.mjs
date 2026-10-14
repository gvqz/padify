// Repro harness: the user's markdown torture doc through every editor mode.
// Boots nothing itself — point it at a running dev server (see run.sh).
// Usage: node md-editor-repro.mjs [baseURL]
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:5199';
const DOC = readFileSync(new URL('./md-torture-doc.md', import.meta.url), 'utf8');

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on(
  'console',
  (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 300)}`),
);
page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));

await page.goto(BASE);

// New markdown note
await page.locator('#addTabTypeMenu').click();
await page
  .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
  .click();
await page.waitForSelector('#markdownToolbar', { timeout: 10000 });

// Source mode → set the full document at once
await page.locator('[data-md-view="source"]').click();
const source = page.locator('#note .markdown-source');
await source.waitFor({ timeout: 5000 });
await source.fill(DOC);
await page.waitForTimeout(600); // let the change announce

// VISUAL mode — the WYSIWYG parse of the doc
await page.locator('[data-md-view="edit"]').click();
await page.waitForSelector('#note .ProseMirror', { timeout: 5000 });
await page.waitForTimeout(800);
await page.screenshot({ path: 'md-torture-visual.png', fullPage: false });

const visualAudit = await page.evaluate(() => {
  const pm = document.querySelector('#note .ProseMirror');
  const q = (s) => pm.querySelectorAll(s).length;
  return {
    h1: q('h1'),
    h2: q('h2'),
    h3: q('h3'),
    h4: q('h4'),
    blockquote: q('blockquote'),
    table: q('table'),
    pre: q('pre'),
    taskChecked: q('li[data-checked="true"], li.checked'),
    taskUnchecked: q('li[data-checked="false"], li[data-task-item]'),
    mathInline: q('.md-math-inline'),
    mathBlock: q('.md-math-block'),
    footnoteRef: q('.md-footnote-ref, sup[data-type="footnote_reference"]'),
    footnoteDef: q('section.md-footnotes, dl[data-type="footnote_definition"]'),
    orderList: q('ol'),
    bulletList: q('ul'),
    hr: q('hr'),
    htmlInert: q('[data-type="html"]'),
  };
});
console.log('VISUAL MODE STRUCTURE:', JSON.stringify(visualAudit, null, 1));

// SPLIT mode
await page.locator('[data-md-view="split"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: 'md-torture-split.png', fullPage: false });

// PREVIEW mode
await page.locator('[data-md-view="preview"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: 'md-torture-preview.png', fullPage: false });

const previewAudit = await page.evaluate(() => {
  const pv = document.querySelector('#note .markdown-preview');
  const q = (s) => pv.querySelectorAll(s).length;
  return {
    h1: q('h1'),
    h2: q('h2'),
    h4: q('h4'),
    table: q('table'),
    pre: q('pre'),
    mathRendered: q('.katex'),
    mathShell: q('.padify-math'),
    taskInput: q('input[type="checkbox"]'),
    footnoteRef: q('.md-footnote-ref'),
    footnoteItem: q('.md-footnote-item'),
    hr: q('hr'),
    blockquote: q('blockquote'),
    ol: q('ol'),
  };
});
console.log('PREVIEW MODE STRUCTURE:', JSON.stringify(previewAudit, null, 1));

// Back to source: did the visual round-trip mangle the source?
await page.locator('[data-md-view="source"]').click();
await page.waitForTimeout(400);
const roundTrip = await page.locator('#note .markdown-source').inputValue();
const roundTripIssues = [];
if (!roundTrip.includes('#### Header 4: Deep nesting')) roundTripIssues.push('h4 lost');
if (!roundTrip.includes('$$\\int_{0}^{\\infty}')) roundTripIssues.push('block math lost');
// Alignment survives as `:----:` / `----:` — Milkdown pads cells and
// widens the dashes; the markers are what matter, not their width.
if (!/\| -+ \| :-+: \| -+: \|/.test(roundTrip) || !roundTrip.includes(':'))
  roundTripIssues.push('table alignment lost');
if (!roundTrip.includes('* [x] Completed task item')) roundTripIssues.push('task syntax lost');
if (!roundTrip.includes('[^1]:')) roundTripIssues.push('footnote def lost');
if (!roundTrip.includes('[^1]')) roundTripIssues.push('footnote ref lost');
if (!roundTrip.includes('```typescript')) roundTripIssues.push('ts fence lost');
if (!roundTrip.includes('interface User {')) roundTripIssues.push('ts body lost');
if (!roundTrip.includes('> > This is a nested')) roundTripIssues.push('nested quote lost');
if (!roundTrip.includes('$x = \\frac{-b')) roundTripIssues.push('inline math lost');
console.log('ROUND-TRIP ISSUES:', roundTripIssues.length ? roundTripIssues : 'none');

console.log('\nCONSOLE/PAGE ERRORS:', errors.length ? errors : 'none');
await browser.close();
