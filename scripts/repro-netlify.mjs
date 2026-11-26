/** Evidence run: the live netlify hamburger crash — card, console errors, shot. */
import { chromium } from '@playwright/test';
const TARGET = process.env.REPRO_URL ?? 'https://padify.netlify.app/';
const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrs = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 500));
});
await page.goto(TARGET, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
await page.waitForTimeout(600);
await page.locator('[data-testid="main-menu-trigger"]').click();
await page.waitForTimeout(2500);
const card = await page.locator('.unsupported-note-title').count();
const menu = await page.locator('.dropdown-menu.main-menu').count();
console.log(`[${new URL(TARGET).host}] crash card: ${card} | menu open: ${menu}`);
if (card) {
  const txt = await page
    .locator('.unsupported-note-card, .unsupported-note-title')
    .first()
    .textContent()
    .catch(() => null);
  console.log('card title text:', txt);
}
console.log('console errors (first 3):');
for (const e of consoleErrs.slice(0, 3)) console.log('  >', e.replace(/\s+/g, ' ').slice(0, 400));
await page.screenshot({ path: 'qa/evidence/bt22-netlify-hamburger-crash.png', fullPage: false });
await browser.close();
