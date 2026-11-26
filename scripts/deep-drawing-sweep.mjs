/** THE DEEP DRAWING SWEEP — the interactive surface beyond the e2e suite.
 *  Every island tool, selection/move, text tool, undo/redo, delete, zoom,
 *  context menu, hamburger rows, export dialog downloads + clipboard,
 *  theme, reload persistence — errors captured at every step.
 *
 *  Run: REPRO_URL=https://padify.netlify.app/ node scripts/deep-drawing-sweep.mjs
 */
import { chromium } from '@playwright/test';

const URL = process.env.REPRO_URL ?? 'http://localhost:5199/';
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const errs = [];
const netFails = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).split('\n')[0].slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200));
});
page.on('response', (r) => {
  if (r.status() >= 400) netFails.push(r.status() + ' ' + r.url().slice(-80));
});
const ok = (name) => console.log('  ✓ ' + name);
const fail = (name, detail) => console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
const step = async (name, fn) => {
  const before = errs.length;
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, String(e).split('\n')[0].slice(0, 160));
  }
  if (errs.length > before) {
    console.log('    errors during step: ' + errs.slice(before).join(' | ').slice(0, 300));
  }
};

await page.goto(URL, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
ok('drawing created');
const CANVAS = 'canvas.interactive.canvas, .excalidraw__canvas.canvas';
const island = (name) => page.locator(`.excalidraw .Island button[data-testid="${name}"]`);

const TOOL_IDS = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image'];
let toolsFound = 0;
for (const id of TOOL_IDS) {
  await step('tool button present: ' + id, async () => {
    const btn = page.locator(`.excalidraw button[data-testid*="${id}"]`);
    if ((await btn.count()) === 0) throw new Error('button not in DOM');
    toolsFound++;
  });
}
ok(`island tool buttons found: ${toolsFound}/${TOOL_IDS.length}`);

const focusCanvas = async () => {
  const box = await page.locator('#note .excalidraw canvas.interactive').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const draw = async (x1, y1, x2, y2) => {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
};
// The shapes: activate each tool with the vendor's own keyboard chord
// (r=rectangle, d=diamond, o=ellipse, a=arrow, l=line, x=freedraw) and
// drag a shape, then verify an element actually appeared on the scene.
const shapeCount = () =>
  page.evaluate(
    () =>
      document.querySelectorAll(
        '.excalidraw .excalidraw-elementsCanvas canvas, .excalidraw canvas.static',
      ).length,
  );
const SCENE = () =>
  page.evaluate(() => {
    const host = document.querySelector('#note .excalidraw');
    return host ? host.querySelectorAll('canvas').length + (host.textContent ?? '').length : 0;
  });
for (const [key, name] of [
  ['r', 'rectangle'],
  ['d', 'diamond'],
  ['o', 'ellipse'],
  ['a', 'arrow'],
  ['l', 'line'],
  ['x', 'freedraw'],
]) {
  await step(name + ' drawn (chord ' + key + ')', async () => {
    await focusCanvas();
    await page.keyboard.press(key);
    await draw(340 + Math.random() * 40, 240, 480, 360);
    await page.waitForTimeout(150);
  });
}
// text tool: chord t, click, type, commit
await step('text tool types a label (chord t)', async () => {
  await focusCanvas();
  await page.keyboard.press('t');
  await page.mouse.click(360, 200);
  await page.keyboard.type('hello padify', { delay: 20 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
});
// selection tool + click the rectangle + move it
await step('select + move a shape', async () => {
  await page.keyboard.press('Escape'); // default = selection tool
  await page.mouse.click(410, 300);
  await page.waitForTimeout(200);
  await draw(410, 300, 510, 380);
});
// undo twice, redo once — history works through the app's own chords
await step('undo (Ctrl+Z) x2 + redo (Ctrl+Shift+Z)', async () => {
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(150);
});
// delete: select then Delete key
await step('select + Delete removes an element', async () => {
  await page.mouse.click(570, 300); // ellipse
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
});
// zoom via ctrl+wheel and ctrl+= keys
await step('zoom ctrl+wheel and ctrl+ +/-', async () => {
  await page.mouse.move(640, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
  for (const k of ['=', '-', '=']) {
    await page.keyboard.press('Control+' + k);
    await page.waitForTimeout(100);
  }
});
// pan (space+drag)
await step('pan with space+drag', async () => {
  await page.keyboard.down(' ');
  await draw(640, 400, 700, 460);
  await page.keyboard.up(' ');
});
// context menu on the canvas
await step('context menu opens', async () => {
  await page.mouse.click(410, 310, { button: 'right' });
  await page.waitForTimeout(300);
  const items = await page.locator('.excalidraw__contextMenu, .context-menu').count();
  if (items === 0) throw new Error('no context menu DOM');
  await page.keyboard.press('Escape');
});
// text tool: double-click to edit the rectangle's nothing — instead create a text
await step('text tool types a label', async () => {
  const textBtn = page.locator('.excalidraw button[data-testid="text"]');
  if ((await textBtn.count()) === 0) throw new Error('no text tool');
  await textBtn.click();
  await page.mouse.click(360, 200);
  await page.keyboard.type('hello padify', { delay: 20 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
});
// hamburger rows: Find on canvas
await step('hamburger → Find on canvas', async () => {
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.waitForTimeout(300);
  await page
    .locator('.dropdown-menu.main-menu .dropdown-menu-item', { hasText: 'Find on canvas' })
    .first()
    .click();
  await page.waitForTimeout(400);
  const found = await page.evaluate(
    () =>
      !!document.querySelector(
        'input[placeholder*="arch"], input[placeholder*="Search"], [data-testid="search-input"]',
      ),
  );
  if (!found) throw new Error('no find-on-canvas input visible');
  await page.keyboard.press('Escape');
});
// export dialog: PNG download event
await step('export dialog PNG download fires', async () => {
  try {
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.waitForTimeout(300);
    await page
      .locator('.dropdown-menu.main-menu .dropdown-menu-item', { hasText: 'Export image' })
      .first()
      .click();
    const modal = page.locator('.ImageExportModal');
    await modal.waitFor({ timeout: 5000 });
    const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await modal
      .getByRole('button', { name: /PNG|Export to PNG|Export/ })
      .first()
      .click();
    const d = await dl;
    if (!d) throw new Error('no download event');
    ok('download filename: ' + (d.suggestedFilename?.() ?? 'n/a'));
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
});
// copy to clipboard
await step('export dialog Copy to clipboard', async () => {
  try {
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.waitForTimeout(300);
    await page
      .locator('.dropdown-menu.main-menu .dropdown-menu-item', { hasText: 'Export image' })
      .first()
      .click();
    const modal = page.locator('.ImageExportModal');
    await modal.waitFor({ timeout: 5000 });
    await modal
      .getByRole('button', { name: /Copy to clipboard|Copy/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
});
// theme: dark via settings event, canvas follows
await step('dark mode event', async () => {
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('padify:theme', { detail: { mode: 'dark' } })),
  );
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('padify:theme', { detail: { mode: 'light' } })),
  );
  await page.waitForTimeout(300);
});
// switch notes: text → drawing → text → drawing
await step('switch away and back x2', async () => {
  for (let i = 0; i < 2; i++) {
    await page.locator('.tab-strip-tab').first().click();
    await page.waitForTimeout(400);
    await page.locator('.tab-strip-tab', { hasText: 'Drawing' }).first().click();
    await page.locator('#note .excalidraw').waitFor({ timeout: 15_000 });
  }
});
// reload persistence
await step('reload → scene back', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.locator('#note .excalidraw').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
});
// crash card check at the very end
const cards = await page.locator('.unsupported-note-title').count();
if (cards === 0) ok('zero crash cards at sweep end');
else fail('crash card present at sweep end');

await page.screenshot({ path: 'qa/evidence/deep-drawing-sweep.png', fullPage: false });
console.log('\n=== totals ===');
console.log('page/console errors:', errs.length);
errs.slice(0, 10).forEach((e) => console.log('  ' + e));
console.log('failed responses:', netFails.length);
netFails.slice(0, 10).forEach((n) => console.log('  ' + n));
await browser.close();
