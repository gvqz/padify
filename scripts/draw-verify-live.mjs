/** Did the drag actually create an element on the live site? */
import { chromium } from '@playwright/test';
const URL = process.env.REPRO_URL ?? 'https://padify.netlify.app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).split('\n')[0].slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200));
});
await page.goto(URL, { waitUntil: 'load' });
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500); // surface settle + welcome screen if any
await page.screenshot({ path: '/tmp/dv-fresh.png' });
const box = await page.locator('#note .excalidraw canvas.interactive').boundingBox();
console.log('canvas box:', JSON.stringify(box));
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400); // welcome screen dismissal, focus
await page.keyboard.press('r');
await page.waitForTimeout(200);
await page.mouse.move(box.x + 60, box.y + 60);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 200, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/dv-after-drag.png' });
const stored = await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('padify');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('notes', 'readonly');
        const cur = tx.objectStore('notes').openCursor();
        const rows = [];
        cur.onerror = () => reject(cur.error);
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            rows.push(c.value);
            c.continue();
          } else {
            resolve(
              rows.map((r) => ({
                t: r.noteType,
                len: (r.content || '').length,
                head: (r.content || '').slice(0, 120),
              })),
            );
            db.close();
          }
        };
      };
    }),
);
console.log('stored notes:', JSON.stringify(stored, null, 1));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
