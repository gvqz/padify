/**
 * css-shot's cousin for the voice feature: deterministic screenshots of
 * the recording bar, the landed card (light + dark), the playing state
 * and the missing-bytes state. Drives the REAL app on the dev server
 * (:5199) with Chromium's fake media device, so what lands is exactly
 * what a user gets.
 *
 * Usage: node scripts/voice-shots.mjs /tmp/voice-shots
 *   (start `npx vite --port 5199` first)
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
)('@playwright/test');
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? '/tmp/voice-shots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await page.goto('http://localhost:5199/');

// A rich note, caret parked, a line of context typed.
await page.locator('#addTabTypeMenu').click();
await page
  .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
  .click();
await page.locator('#note').click();
await page.keyboard.type('Standup notes — ');
await page.keyboard.press('Enter');
await page.keyboard.type('The recording below captures the demo walkthrough.');

// ---- shot 1: the recording bar mid-session ----
await page.locator('#richToolbar [data-rich-action="voice"]').click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/1-record-bar.png` });
await page.locator('#voiceRecordStop').click();

// The card lands; give the store write a beat. The wrapper is the card
// (the stored audio inside stays hidden — see the CSS note).
await page.waitForSelector('#note figure.padify-voice', { timeout: 10_000 });
await page.waitForTimeout(600);

// A line under the card so the composition reads like a real note.
await page.locator('#note').click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('Key moment at 0:12 — pause here and discuss.');

await page.screenshot({ path: `${outDir}/2-card-light.png` });

// ---- shot 2: dark ----
await page.evaluate(() => {
  document.body.classList.add('dark');
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/3-card-dark.png` });

// ---- shot 3: playing state ----
await page.locator('#note figure.padify-voice').first().click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${outDir}/4-card-playing.png` });
await page.evaluate(() => document.body.classList.remove('dark'));

// ---- shot 4: the missing-bytes state (a ref the store cannot answer) ----
await page
  .locator('#note figure.padify-voice')
  .first()
  .evaluate((card) => {
    card.setAttribute('data-padify-missing', '');
    const time = card.querySelector('.padify-voice-time');
    if (time) time.textContent = 'unavailable';
  });
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/5-card-missing.png` });

// ---- shot 5: zoomed card, light, for the fine detail ----
const card = page.locator('#note figure.padify-voice').first();
const zoom = await card.boundingBox();
if (zoom) {
  await page.screenshot({
    path: `${outDir}/6-card-zoom.png`,
    clip: { x: zoom.x - 40, y: zoom.y - 40, width: zoom.width + 80, height: zoom.height + 80 },
  });
}

await browser.close();
console.log(`shots in ${outDir}`);
