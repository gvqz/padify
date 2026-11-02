/**
 * End-to-end proof of the "Update available" popup after the focus-listener
 * fix in src/install-pwa.ts.
 *
 * Flow (against a real PROD build served by `vite preview`):
 *   1. fresh visit → first worker installs and claims the page (no popup —
 *      first-install semantics, controller must appear)
 *   2. "deploy" happens: dist/sw.js bytes are rewritten on disk
 *   3. wait ~6s WITHOUT any focus/visibility event → the dialog must NOT
 *      appear (proves the popup is event-driven, not spontaneous)
 *   4. dispatch window 'focus' (the refocus an installed window fires
 *      without a visibilitychange) → the dialog MUST appear
 *   5. accept ("Reload now") → page reloads under the new worker, waiting
 *      slot empties
 */
import { chromium } from '@playwright/test';
import { appendFileSync } from 'node:fs';

const BASE = 'http://localhost:4173/';
const shot = '/home/z/my-project/download/update-prompt-proof.png';
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') console.log(`[console] ${m.text()}`);
});

// 1. First visit — registration + claim, no prompt expected.
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
  timeout: 30000,
});
console.log('OK: first worker controls the page (controller set, no popup)');

const dialogVisible = () =>
  page.evaluate(() => {
    const d = document.querySelector('dialog.vz-dialog');
    return !!d && d.open && d.textContent.includes('Update available');
  });

// 2. Simulate a deploy: change the sw.js bytes the server will hand out.
appendFileSync('dist/sw.js', `\n/* deploy-poke ${Date.now()} */\n`);
console.log('OK: sw.js bytes changed on the "server"');

// 3. Idle 6s with NO events — the prompt must stay hidden.
await page.waitForTimeout(6000);
if (await dialogVisible()) fail('dialog appeared with no focus/visibility event');
console.log('OK: 6s idle, no dialog (prompt is event-driven)');

// 4. Refocus WITHOUT a visibilitychange → the fix must check and prompt.
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForFunction(
  () => {
    const d = document.querySelector('dialog.vz-dialog');
    return !!d && d.open && d.textContent.includes('Update available');
  },
  null,
  { timeout: 30000 },
);
console.log('OK: window focus → "Update available" dialog is up');

await page.screenshot({ path: shot });
console.log(`OK: screenshot saved to ${shot}`);

// 5. Accept the update → takeover + reload under the new worker.
await page.getByRole('button', { name: 'Reload now' }).click();
await page.waitForLoadState('load');
await page.waitForTimeout(1500);
const state = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { controlled: !!navigator.serviceWorker.controller, waiting: !!r?.waiting };
});
if (!state.controlled) fail('page is not controlled after accepting the update');
if (state.waiting) fail('a worker is still waiting after accepting the update');
console.log('OK: accepted → reloaded under the new worker, nothing left waiting');

await browser.close();
console.log('\nALL CHECKS PASSED');
