/**
 * Verification pass — the rebuilt popup faces + the outside-click close,
 * light and dark. `node scripts/popups-verify.mjs` against dev server 5173.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/popup-verify';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'http://localhost:5173',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const log = (...a) => console.log('[verify]', ...a);

/** The exact backdrop press: mousedown + mouseup on the dialog shell. */
async function backdropProbe(name) {
  await page.mouse.click(40, 760);
  await page.waitForTimeout(350);
  const open = await page.evaluate(() => Boolean(document.querySelector('dialog[open]')));
  log(`${name}: dialog ${open ? 'STILL OPEN (bug)' : 'closed on backdrop click'}`);
  return !open;
}

// ---------- export center, text note ----------
await page.goto('/');
await page.waitForSelector('#note', { timeout: 20_000 });
await page.click('#note');
await page.keyboard.type('Quarterly review\n\nPopups get one face this week:\n- export center\n- confirm asks\n- one close everywhere', { delay: 4 });
await page.waitForTimeout(300);
await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(700);
await shot('01-export-txt');
const closed1 = await backdropProbe('export-txt');
await page.waitForTimeout(300);

// reopen → outside click again (the face must survive repeated opens)
await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(500);
const chips = await page.locator('.export-center-chip').allTextContents();
const pdfChip = chips.find((c) => /pdf/i.test(c));
if (pdfChip) {
  await page.locator('.export-center-chip', { hasText: pdfChip }).first().click();
  await page.waitForTimeout(700);
  await shot('02-export-pdf');
}
const closed2 = await backdropProbe('export-pdf');

// ---------- drawing note ----------
await page.click('#addTabTypeMenu');
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note [data-drawing-canvas]').waitFor({ state: 'visible' });
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
const canvas = page.locator('#note .excalidraw canvas.interactive');
await canvas.waitFor({ state: 'visible' });
await page.waitForTimeout(600);
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press('r');
await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.28);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.72, { steps: 8 });
await page.mouse.up();
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(1000);
await shot('03-export-drawing-png');
await page.locator('.export-center-chip', { hasText: 'Excalidraw scene' }).click();
await page.waitForTimeout(500);
await shot('04-export-drawing-scene');
const closed3 = await backdropProbe('export-drawing');

// ---------- the confirm ask (lossy conversion: Drawing → Plain text) ----------
const tabRow = page.locator('.tab-strip-tab').nth(1);
await tabRow.click({ button: 'right' });
await page.waitForTimeout(300);
await page.locator('.padify-ctx-item[data-action="type-menu"]').hover();
await page.waitForTimeout(400);
const plain = page.locator('.note-ctx-submenu .padify-ctx-item', { hasText: 'Plain' }).first();
await plain.click();
await page.waitForTimeout(400);
const confirmVisible = await page.evaluate(() => Boolean(document.querySelector('dialog.vz-dialog[open]')));
log('confirm ask visible:', confirmVisible);
await shot('05-confirm-ask');
const closed4 = await backdropProbe('confirm-ask');

// ---------- dark rerun ----------
await page.evaluate(() => document.body.classList.add('dark'));
await page.waitForTimeout(200);
await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(900);
await shot('10-export-dark');
const closed5 = await backdropProbe('export-dark');

log('SUMMARY — outside-click closes:', { closed1, closed2, closed3, closed4, closed5 });
await browser.close();
console.log(`shots in ${OUT}`);
