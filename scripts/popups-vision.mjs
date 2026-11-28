/**
 * Vision pass — screenshot every popup face as a human sees it, light and
 * dark, and probe the outside-click behavior of each. Standalone:
 * `node scripts/popups-vision.mjs` against a running dev server (5173).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/popup-vision';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'http://localhost:5173',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const log = (...a) => console.log('[vision]', ...a);

/** Click far outside the dialog and report whether it closed. */
async function outsideClickProbe(name) {
  await page.mouse.click(40, 760); // sidebar's quiet corner
  await page.waitForTimeout(350);
  const stillOpen = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    return d ? d.className : null;
  });
  log(`${name}: after outside click, open dialog = ${stillOpen ?? 'NONE (closed)'}`);
  return stillOpen;
}

// ---------- 1. plain text note ----------
await page.goto('/');
await page.waitForSelector('#note', { timeout: 20_000 });
await page.click('#note');
await page.keyboard.type('Quarterly review\n\nPopups get one face this week:\n- export center\n- confirm asks\n- one close everywhere', { delay: 4 });
await page.waitForTimeout(300);

await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(700);
await shot('01-export-txt');
log('01 export center on text note (TXT)');

const chips = await page.locator('.export-center-chip').allTextContents();
log('chips:', chips.join(' | '));
const pdfChip = chips.find((c) => /pdf/i.test(c));
if (pdfChip) {
  await page.locator('.export-center-chip', { hasText: pdfChip }).first().click();
  await page.waitForTimeout(600);
  await shot('02-export-pdf');
  log('02 export center PDF chip');
}

await outsideClickProbe('export-center');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// ---------- 2. drawing note ----------
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
log('03 export center on drawing (PNG)');

const chipTexts = await page.locator('.export-center-chip').allTextContents();
log('drawing chips:', chipTexts.join(' | '));
for (const label of ['SVG', 'excalidraw']) {
  const t = chipTexts.find((c) => c.toLowerCase().includes(label.toLowerCase()));
  if (t) {
    await page.locator('.export-center-chip', { hasText: t }).first().click();
    await page.waitForTimeout(700);
    await shot(`04-export-drawing-${label.replace(/[^\w]/g, '')}`);
    log(`04 export center drawing ${t}`);
  }
}
await outsideClickProbe('export-center-drawing');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// ---------- 3. note context menu + confirm ask ----------
await page.click('#note .excalidraw', { button: 'right' }).catch(() => {});
// right-click the drawing note's tab row in the strip
const tabRow = page.locator('.tab-strip-tab').nth(1);
await tabRow.click({ button: 'right' });
await page.waitForTimeout(350);
await shot('05-note-context-menu');
log('05 note context menu');
// the danger row ("close") opens the confirm ask
await page.locator('.padify-ctx-item.padify-ctx-danger[data-action="close"]').click();
await page.waitForTimeout(350);
const confirmOpen = await page.evaluate(() => {
  const d = document.querySelector('dialog[open]');
  return d ? d.className : null;
});
log('confirm dialog open:', confirmOpen);
await shot('06-confirm-ask');
await outsideClickProbe('confirm-ask');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// ---------- 4. settings modal (the reference face) ----------
await page.click('#preferences');
await page.waitForTimeout(600);
await shot('07-settings-light');
log('07 settings modal (the reference face)');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------- 5. dark theme reruns ----------
await page.evaluate(() => document.body.classList.add('dark'));
await page.waitForTimeout(200);

await page.click('#downloadNotes');
await page.locator('dialog.export-center').waitFor({ state: 'visible' });
await page.waitForTimeout(900);
await shot('10-export-drawing-png-dark');
log('10 export center drawing dark');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

const tabRow2 = page.locator('.tab-strip-tab').first();
await tabRow2.click({ button: 'right' });
await page.locator('.padify-ctx-item.padify-ctx-danger[data-action="close"]').click();
await page.waitForTimeout(350);
await shot('11-confirm-ask-dark');
log('11 confirm ask dark');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

await page.click('#preferences');
await page.waitForTimeout(600);
await shot('12-settings-dark');
log('12 settings dark');
await page.keyboard.press('Escape');

await browser.close();
console.log(`shots in ${OUT}`);
