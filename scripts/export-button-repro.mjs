/** Mini-repro: the vendor export dialog's PNG/SVG buttons on the live sites.
 *  Draws a shape first (so the canvas is NOT empty), opens the dialog via the
 *  hamburger's Export image row, clicks Export to PNG / Export to SVG, and
 *  reports whether a download event fires, plus console errors + a screenshot
 *  of whatever state the dialog is left in.
 */
import { chromium } from '@playwright/test';

const URL = process.env.REPRO_URL ?? 'https://padify.netlify.app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
// Force browser-fs-access's anchor-download fallback (no save-file picker).
await page.addInitScript(() => {
  // Shadow the prototype method with an own undefined — browser-fs-access's
  // feature check then takes the <a download> fallback (Safari/Firefox path).
  Object.defineProperty(window, 'showSaveFilePicker', {
    value: undefined,
    configurable: true,
  });
});
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).split('\n')[0].slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 250));
});

await page.goto(URL, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
// focus canvas, rectangle tool, drag
await page.waitForTimeout(1500); // surface settle — the island must be live before chords land
const box = await page.locator('#note .excalidraw canvas.interactive').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400); // focus + welcome dismissal
await page.keyboard.press('r');
await page.waitForTimeout(200);
await page.mouse.move(box.x + 60, box.y + 60);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 200, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(1500); // persist debounce
// The scene envelope must exist before export means anything.
const hasShape = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('padify');
      req.onsuccess = () => {
        const tx = req.result.transaction('notes', 'readonly');
        const cur = tx.objectStore('notes').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            const v = c.value;
            if (v.noteType === 'drawing' && (v.content || '').includes('"elements":[{'))
              resolve(true);
            c.continue();
          } else resolve(false);
        };
      };
      req.onerror = () => resolve(false);
    }),
);
console.log('shape drawn (stored envelope with elements):', hasShape);
if (!hasShape) {
  console.log('ABORT: no stored shape — export would refuse honestly');
  await browser.close();
  process.exit(0);
}

await page.locator('[data-testid="main-menu-trigger"]').click();
const menu = page.locator('#note .excalidraw .dropdown-menu');
await menu.locator('[data-testid="image-export-button"]').click();
const modal = page.locator('.ImageExportModal');
await modal.waitFor({ timeout: 5000 });
console.log('export dialog open');
await page.screenshot({ path: '/tmp/export-repro-before.png' });

for (const name of ['Export to PNG', 'Export to SVG']) {
  const dl = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
  try {
    await modal.getByRole('button', { name }).first().click({ timeout: 8000 });
  } catch (e) {
    console.log(`${name}: click failed — ${String(e).split('\n')[0].slice(0, 120)}`);
    break;
  }
  const d = await dl;
  console.log(`${name}: ${d ? 'DOWNLOAD ' + d.suggestedFilename() : 'NO DOWNLOAD EVENT'}`);
  await page.waitForTimeout(800);
  // What does the stacked modal banner say, if one appeared?
  const banner = await page
    .locator(
      '.excalidraw-modal-container .Modal, .excalidraw__errorMessage, [class*="errorMessage"]',
    )
    .allTextContents();
  if (banner.length)
    console.log(`  stacked modal text: ${banner.join(' | ').replace(/\s+/g, ' ').slice(0, 220)}`);
  // Can the export dialog still be dismissed?
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    console.log(`  Escape pressed; export modal hidden: ${await modal.isHidden()}`);
  } catch {}
  await page.screenshot({ path: `/tmp/export-repro-${name.replace(/\W+/g, '')}-after.png` });
  // reopen for the next type if the dialog closed
  if ((await modal.count()) && (await modal.isHidden())) {
    await page.locator('[data-testid="main-menu-trigger"]').click();
    const menu2 = page.locator('#note .excalidraw .dropdown-menu');
    await menu2.locator('[data-testid="image-export-button"]').click();
    await modal.waitFor({ timeout: 5000 });
  }
}
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
