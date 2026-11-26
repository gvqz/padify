/** Does the tab strip stay clickable after the export dialog flows? */
import { chromium } from '@playwright/test';
const URL = process.env.REPRO_URL ?? 'https://padify.netlify.app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).split('\n')[0]));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 150));
});
await page.goto(URL, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
// second note so there is something to switch to
await page.locator('#addTab').click();
await page.waitForTimeout(800);
// back to drawing
await page.locator('.tab-strip-tab', { hasText: 'Drawing' }).first().click();
await page.locator('#note .excalidraw').waitFor({ timeout: 15_000 });
// export dialog: open, escape
await page.locator('[data-testid="main-menu-trigger"]').click();
await page.locator('#note .excalidraw .dropdown-menu [data-testid="image-export-button"]').click();
await page.locator('.ImageExportModal').waitFor({ timeout: 5000 });
console.log('export dialog open');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log('export modal hidden:', await page.locator('.ImageExportModal').isHidden());
// the Find-on-canvas flow too (Ctrl+F dialog)
await page.keyboard.press('Control+f');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// now the switch
try {
  await page.locator('.tab-strip-tab').first().click({ timeout: 5000 });
  console.log('tab switch after export dialog: OK');
} catch (e) {
  console.log('tab switch FAILED:', String(e).split('\n')[0].slice(0, 120));
  await page.screenshot({ path: '/tmp/tabswitch-fail.png' });
  const modals = await page.locator('[role="dialog"], .ImageExportModal, .Modal').allTextContents();
  console.log(
    'open modals:',
    modals.map((t) => t.replace(/\s+/g, ' ').slice(0, 60)),
  );
}
console.log('errors:', errs.length ? errs.slice(0, 3) : 'none');
await browser.close();
