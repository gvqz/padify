/**
 * Screenshot the export UI faces as a human sees them — the honest way to
 * find the refinement gaps before touching code. Standalone (not a test):
 * `node scripts/screenshot-export-ui.mjs` against a running dev server.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/export-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'http://localhost:5199',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// --- 1. A plain text note's export center ---------------------------------
await page.goto('/');
await page.locator('#note').click();
await page.keyboard.type(
  'Quarterly review\n\nThe export flows were rebuilt this week:\n- drawing dialogs restored\n- export center healed\n- three good faces, each with its own door',
  { delay: 5 },
);
await page.locator('#downloadNotes').click();
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(600);
await shot('1-center-plain-txt');

// Select PDF
await page.locator('.export-center-type', { hasText: 'PDF' }).first().click();
await page.waitForTimeout(500);
await shot('2-center-plain-pdf');

// --- 2. A markdown note's export center ------------------------------------
await page.locator('dialog.export-center .vz-dialog-cancel').click();
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown' }).click();
await page.locator('#note').click();
await page.keyboard.type(
  '# Launch notes\n\nThe **export center** rides again.\n\n- [x] drawing exports restored\n- [ ] polish the faces\n',
  { delay: 5 },
);
await page.locator('#downloadNotes').click();
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(600);
await shot('3-center-markdown');

// --- 3. A drawing note: launchers + envelopes -------------------------------
await page.locator('dialog.export-center .vz-dialog-cancel').click();
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note [data-drawing-canvas]').waitFor({ state: 'visible' });
await page.locator('#note .excalidraw').waitFor({ timeout: 20_000 });

// Draw a rectangle + a text label
const canvas = page.locator('#note .excalidraw canvas.interactive');
await canvas.waitFor({ state: 'visible' });
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press('r');
await page.mouse.move(box.x + box.width * 0.28, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.72, { steps: 8 });
await page.mouse.up();
await page.keyboard.press('2');
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.42);
await page.keyboard.type('export flows', { delay: 20 });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.locator('#downloadNotes').click();
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(900);
await shot('4-center-drawing');

// --- 4. The drawing's own export dialog (via the launcher) -----------------
await page.locator('.export-center-type--launch', { hasText: 'PNG image' }).click();
await page.locator('dialog.drawing-export-dialog').waitFor({ state: 'visible' });
await page.waitForTimeout(400);
await shot('5-drawing-export-dialog');

// Narrow viewport check of the center (the fold)
await page.locator('dialog.drawing-export-dialog .vz-dialog-cancel').click();
await page.locator('#downloadNotes').click();
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(500);
await shot('6-center-narrow');

await browser.close();
console.log(`shots written to ${OUT}`);
