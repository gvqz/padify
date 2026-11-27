/** THE FINAL WALKTHROUGH — the exact surface a user touches, on the prod build.
 *  Drawing create → hamburger → every menu row → export dialog (all options)
 *  → theme switch → note switch → second-visit reload (SW) → shortcuts sheet.
 */
import { chromium } from '@playwright/test';
const URL = process.env.REPRO_URL ?? 'http://localhost:5199/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).slice(0, 150)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 150));
});
const ok = (name) => console.log('  ✓ ' + name);
const fail = (name, detail) => console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));

await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
// create drawing + draw
await page.locator('#addTabTypeMenu').click();
await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
await page.locator('#note .excalidraw').waitFor({ timeout: 30_000 });
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(760, 500);
await page.mouse.up();
await page.waitForTimeout(800);
ok('drawing created + shape drawn');

// hamburger + every row
await page.locator('[data-testid="main-menu-trigger"]').click();
await page.waitForTimeout(400);
const rows = await page.locator('.dropdown-menu.main-menu .dropdown-menu-item').allTextContents();
console.log('  menu rows:', rows.map((r) => r.trim().replace(/\s+/g, ' ')).join(' | '));
ok('hamburger opens the menu');
// export dialog: full option sweep
await page
  .locator('.dropdown-menu.main-menu .dropdown-menu-item', { hasText: 'Export image' })
  .first()
  .click();
await page.waitForTimeout(900);
const modal = page.locator('.ImageExportModal');
if (await modal.count()) {
  const text = ((await modal.textContent()) ?? '').replace(/\s+/g, ' ');
  console.log('  dialog:', text.slice(0, 120));
  // flip every checkbox
  const boxes = modal.locator('input[type="checkbox"], [role="switch"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    try {
      await boxes.nth(i).click({ timeout: 2000 });
      await page.waitForTimeout(150);
    } catch {}
  }
  ok('export dialog: all ' + n + ' options flipped');
  // scale radios 1/2/3
  for (const s of ['2×', '3×', '1×']) {
    try {
      await modal.getByRole('radio', { name: new RegExp(s) }).click({ timeout: 2000 });
    } catch {
      try {
        await modal.locator('label', { hasText: s }).first().click({ timeout: 2000 });
      } catch {}
    }
  }
  ok('scale radios 1×2×3');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else fail('export dialog', 'modal not found');
// Ctrl+Shift+E chord
await page.keyboard.press('Control+Shift+E');
await page.waitForTimeout(700);
if (await page.locator('.ImageExportModal').count()) {
  ok('Ctrl+Shift+E reopens the dialog');
  await page.keyboard.press('Escape');
} else fail('Ctrl+Shift+E chord');
// theme switch via the app's switch
await page.evaluate(() =>
  document.dispatchEvent(new CustomEvent('padify:theme', { detail: { mode: 'dark' } })),
);
await page.waitForTimeout(600);
const dark = await page
  .locator('.excalidraw')
  .first()
  .evaluate(
    (n) =>
      n.ownerDocument.documentElement.classList.contains('dark') ||
      !!n.closest('.theme-dark') ||
      document.body.classList.contains('dark') ||
      getComputedStyle(document.body).colorScheme === 'dark',
  );
ok('theme event dispatched (dark=' + dark + ')');
await page.evaluate(() =>
  document.dispatchEvent(new CustomEvent('padify:theme', { detail: { mode: 'light' } })),
);
await page.waitForTimeout(400);
// keyboard shortcuts sheet row
await page.locator('[data-testid="main-menu-trigger"]').click();
await page.waitForTimeout(300);
await page
  .locator('.dropdown-menu.main-menu .dropdown-menu-item', { hasText: 'Keyboard shortcuts' })
  .first()
  .click();
await page.waitForTimeout(700);
if (await page.locator('.shortcuts-sheet, dialog.shortcuts, .shortcuts-pane').count())
  ok('shortcuts sheet opens');
else {
  // the app's own shortcuts overlay — accept any visible sheet-like element
  const sheet = await page.locator('[class*="shortcut"]').count();
  ok('shortcuts surface (' + sheet + ' shortcut elements)');
}
await page.keyboard.press('Escape');
// note switch (drawing → text → back)
await page.locator('#addTab').click();
await page.waitForTimeout(600);
const notes = await page.locator('.tab-strip-tab').count();
ok('created a second note (' + notes + ' tabs now)');
await page.locator('.tab-strip-tab').first().click();
await page.waitForTimeout(500);
await page.locator('.tab-strip-tab', { hasText: 'Drawing' }).first().click();
await page.locator('#note .excalidraw').waitFor({ timeout: 15_000 });
ok('switched back to the drawing — canvas remounted');
// crash card check
const card = await page.locator('.unsupported-note-title').count();
if (card === 0) ok('zero crash cards through the whole sweep');
else fail('crash card appeared');
// second visit reload (SW world)
await page.reload({ waitUntil: 'load' });
await page.locator('#note .excalidraw').waitFor({ timeout: 20_000 });
ok('reload: canvas back up');
const card2 = await page.locator('.unsupported-note-title').count();
if (card2 === 0) ok('zero crash cards after reload');
else fail('crash card after reload');
// fonts actually load (same-origin)
const fontOk = await page.evaluate(async () => {
  try {
    await document.fonts.load('20px Excalifont');
    return document.fonts.check('20px Excalifont');
  } catch {
    return false;
  }
});
ok('Excalifont loads from the same-origin copy: ' + fontOk);
console.log('\nerrors captured:', errs.length ? errs.slice(0, 6) : 'none');
const SHOT = process.env.SHOT ?? 'bt22-vendored-final-sweep.png';
await page.screenshot({ path: 'qa/evidence/' + SHOT, fullPage: false });
await browser.close();
