/** Visual pass: the drawingpad's export is the vendor's own — the native
 *  ImageExportDialog from the app-level download button, the native
 *  "Save to…" jsonExport dialog, and the menu that carries both rows.
 *  Runs against the PRODUCTION build (vite preview). */
import { chromium } from '@playwright/test';

const URL = process.env.REPRO_URL ?? 'http://localhost:5199/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
// Force the anchor-download fallback (as a Safari/Firefox user sees) so
// the filename field renders and the presses answer downloads.
await page.addInitScript(() => {
  for (const key of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    try {
      delete window[key];
    } catch {}
    try {
      delete Window.prototype[key];
    } catch {}
  }
});
await page.goto(URL, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
await page.waitForTimeout(1200);
const box = await page.locator('#note .excalidraw canvas.interactive').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.keyboard.press('r');
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.62, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(1500);

// 1) The app-level download button opens the VENDOR's own dialog.
await page.locator('#downloadNotes').click();
await page.locator('.ImageExportModal').waitFor({ timeout: 10_000 });
await page.waitForTimeout(1500); // the live preview renders
await page.screenshot({ path: 'qa/evidence/pf-native-export-dialog.png' });
console.log('shot: pf-native-export-dialog.png');

// 2) The canvas menu carries both native rows (Save to… / Export image…).
await page
  .locator('.excalidraw-modal-container', { hasText: 'Export image' })
  .locator('.Modal__background')
  .first()
  .click({ position: { x: 30, y: 200 } });
await page.locator('[data-testid="main-menu-trigger"]').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'qa/evidence/pf-native-menu.png' });
console.log('shot: pf-native-menu.png');

// 3) The jsonExport dialog (the native .excalidraw door).
const menu = page.locator('#note .excalidraw .dropdown-menu');
await menu.locator('[data-testid="json-export-button"]').click();
await page.locator('.ExportDialog--json').waitFor({ timeout: 5_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: 'qa/evidence/pf-json-export-dialog.png' });
console.log('shot: pf-json-export-dialog.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 4) The rail's Export… row opens the center (the Padify envelopes).
const tab = page.locator('#tabStripTabs .tab-strip-tab').first();
await tab.click({ button: 'right' });
await page.locator('#noteCtxMenu').waitFor({ timeout: 3_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: 'qa/evidence/pf-note-menu.png' });
await page.locator('#noteCtxMenu [data-action="export"]').click();
await page.locator('dialog.export-center').waitFor({ timeout: 5_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'qa/evidence/pf-center-envelopes.png' });
console.log('shot: pf-center-envelopes.png + pf-note-menu.png');
await browser.close();
