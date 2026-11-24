/**
 * The canvas open-time harness — BRAINSTORM item 8's discipline, rebuilt
 * for the R3 measurement (issue #172).
 *
 * What it measures, over the REAL open path against the dist build:
 *   - five drawing→text→drawing flips, each timed from the tab-strip
 *     click to the vendor's .excalidraw being actionable (the warm open —
 *     the number a user actually experiences);
 *   - one cold open on a fresh context: the very first Drawing click
 *     after boot (the chunk-fetch window the modulepreload targets).
 *
 * Usage: bunx vite preview --port 4199 &  then  bun run scripts/measure-canvas-open.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MEASURE_BASE_URL || 'http://localhost:4199/';

async function openDrawing(page) {
  const start = Date.now();
  await page.locator('#addTabTypeMenu').click();
  await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
  await page.locator('#note .excalidraw').waitFor({ state: 'visible', timeout: 30_000 });
  // The mount must be actionable, not just painted: the vendor's canvas
  // element is the real surface.
  await page.locator('#note .excalidraw canvas.interactive').waitFor({ state: 'visible' });
  return Date.now() - start;
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

  // ---- the warm path: five flips on one session ---------------------
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(1_500); // boot settles; the idle warm gets its window

  const warm = [];
  for (let i = 0; i < 5; i++) {
    warm.push(await openDrawing(page));
    // Back to the first (text) note; the drawing note stays around.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await page.waitForTimeout(300);
  }
  const warmMedian = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)];
  console.log(`warm flips : ${JSON.stringify(warm)} median=${warmMedian}ms`);

  // ---- the cold path: fresh context, immediate open ------------------
  const coldContext = await browser.newContext();
  const coldPage = await coldContext.newPage();
  await coldPage.goto(BASE);
  // No settle: click Drawing as soon as the menu is interactive — the
  // chunk-fetch window (idle warm not yet landed) is the point.
  await coldPage.locator('#addTabTypeMenu').waitFor({ state: 'visible' });
  await coldPage.waitForTimeout(200);
  const cold = await openDrawing(coldPage);
  console.log(`cold open  : ${cold}ms (fresh context, immediate)`);

  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
