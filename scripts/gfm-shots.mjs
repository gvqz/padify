// Visual evidence for the GFM renderer: a torture document through the
// preview pane, light and dark, desktop + narrow — the same shots/ flow
// the retime work used. Run: node scripts/gfm-shots.mjs
import { chromium } from '/home/z/my-project/padify/node_modules/playwright-core/index.mjs';

const BASE = 'http://localhost:3000';
const TORTURE = [
  '# The GFM Tour',
  '',
  'Text with **bold**, *italic*, ~~struck~~, `code`, and an entity: &copy; &mdash; &#x2713;.',
  '',
  'Autolinks: https://example.com/x?a=1&b=2, www.example.com, and mail@gvz.dev.',
  '',
  '## Lists & tasks',
  '',
  '- [x] ship the renderer',
  '- [ ] verify ~everything~',
  '  - nested one',
  '    - nested two',
  '',
  '1. first',
  '2. second',
  '   1. deep',
  '',
  '## Quotes & code',
  '',
  '> A quote with **weight**',
  '> > and a nested line',
  '',
  '```ts',
  'const GFM = "tables, tasks, strike, autolinks";',
  '```',
  '',
  '    indented code, four spaces',
  '',
  '## Table',
  '',
  '| Feature | Spec | Ours |',
  '| --- | :---: | ---: |',
  '| Tables | yes | yes |',
  '| Task lists | yes | **yes** |',
  '| Footnotes[^1] | yes | yes |',
  '',
  '[^1]: The footnote body with a [link](https://example.com).',
  '',
  '[ref-link]: https://example.com/reference',
  'A [reference link][ref-link] and a ~~deleted~~ claim.',
  '',
  '---',
  '',
  'Hard break next  ',
  'line. Math: $E = mc^2$.',
].join('\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(BASE);
await page.locator('#addTabTypeMenu').click();
await page
  .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
  .click();
await page.locator('[data-md-view="source"]').click();
const textarea = page.locator('#note .markdown-source');
await textarea.fill(TORTURE);
await page.waitForTimeout(400);

// Split (source + preview), light.
await page.locator('[data-md-view="split"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/shots/gfm-split-light.png' });

// Preview full-width, light.
await page.locator('[data-md-view="preview"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/shots/gfm-preview-light.png' });

// Toggle the first task checkbox live, then re-shoot (the toggle visible).
await page.locator('.markdown-preview li', { hasText: 'verify' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/shots/gfm-preview-toggled.png' });

// Dark ink.
await page.evaluate(() => localStorage.setItem('mode', 'dark'));
await page.reload();
await page.locator('#addTabTypeMenu').click();
await page
  .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
  .click();
await page.locator('[data-md-view="source"]').click();
await page.locator('#note .markdown-source').fill(TORTURE);
await page.waitForTimeout(400);
await page.locator('[data-md-view="preview"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/shots/gfm-preview-dark.png' });

// Narrow (phone) preview.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: '/home/z/my-project/shots/gfm-preview-narrow.png' });

await browser.close();
console.log('shots written');
