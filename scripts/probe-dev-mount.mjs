/** Dev-mount probe: open a drawing on the dev server, dump console + page errors. */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5199/';
const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });
  await page.goto(BASE);
  await page.locator('#addTabTypeMenu').click();
  await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
  page.on('pageerror', (e) => console.log('LATE pageerror:', e.message.slice(0, 400)));
  await page.waitForTimeout(12_000);
  const mount = await page.locator('#note [data-drawing-canvas]').count();
  const excalidraw = await page.locator('#note .excalidraw').count();
  const card = await page.locator('#note .unsupported-note').count();
  const cardText = card ? await page.locator('#note .unsupported-note').textContent() : '';
  console.log('mount wrapper:', mount, '| .excalidraw:', excalidraw, '| error card:', card);
  console.log('card text:', (cardText || '').slice(0, 200));
  for (const e of errors.slice(0, 12)) console.log(e.slice(0, 300));
  // The unmount race: switch drawing → text and capture the error stack.
  await page.waitForTimeout(4_000);
  page.on('pageerror', (e) =>
    console.log('SWITCH pageerror stack:', (e.stack || e.message).slice(0, 900)),
  );
  await page.locator('#tabStripTabs .tab-strip-tab').first().click();
  await page.waitForTimeout(1_500);
  const wrapperAfter = await page.locator('#note [data-drawing-canvas]').count();
  console.log('wrapper after switch:', wrapperAfter);
  const err = await page.evaluate(async () => {
    try {
      await import('/src/editor/drawing/canvas.ts');
      return 'module ok';
    } catch (e) {
      return `import failed: ${e && e.message ? e.message : String(e)}`;
    }
  });
  console.log('direct import:', err);
  await browser.close();
};
run();
