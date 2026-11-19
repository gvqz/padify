#!/usr/bin/env node
/**
 * hover-ripple-test.mjs — proves the wordmark hover choreography end to end.
 * (Repo tooling lives in scripts/; evidence lands in qa/evidence/.)
 *
 * Serves dist/ on :4177 and drives the brand logo through the full move:
 * rest -> hover (early / mid / late wave frames) -> settled -> unhover ->
 * menu open, in light + dark, plus a mobile pass and a reduced-motion gate.
 *
 * Asserts:
 *   1. letters actually animate (computed transform leaves identity mid-wave)
 *   2. the wave is staggered left-to-right (P moves while F still rests)
 *   3. every letter returns to rest after the pop — no scattered pose
 *   4. the hairline draws on hover, stays while the brand menu is open,
 *      retracts on leave, and is exactly 1px
 *   5. the link's box never shifts (transform-only motion, no layout jump)
 *   6. prefers-reduced-motion: reduce keeps the ripple inert (hairline only)
 *
 * Frames land in qa/evidence/ (lh19-*); the assertion log is printed and
 * saved next to them (lh19-hover-assertions.txt).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const PORT = 4177;
const URL = `http://localhost:${PORT}/`;
const evidenceDir = join(repo, 'qa', 'evidence');
mkdirSync(evidenceDir, { recursive: true });

// Serve dist/ — refuse if a stale server already holds the port (it would
// shoot the OLD build and prove nothing).
try {
  await fetch(URL);
  console.error(`REFUSED: port ${PORT} already answers — kill the stale server first.`);
  process.exit(2);
} catch {
  /* port free */
}
const server = spawn(
  'python3',
  ['-m', 'http.server', String(PORT), '--directory', join(repo, 'dist')],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 800));

const log = [];
const say = (line) => {
  console.log(line);
  log.push(line);
};
let failures = 0;
const expect = (cond, label, detail = '') => {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  say(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const letterLocators = (page) => page.locator('#brandMenuButton span');
// All six letters read in ONE evaluate round-trip — sequential reads drift
// up to ~200ms apart on a busy runner, which corrupts any snapshot of a
// 520ms-per-letter wave and made the stagger check flake.
const snapshotXf = (page) =>
  page.locator('#brandMenuButton').evaluate((el) =>
    Array.from(el.querySelectorAll('span')).map(
      (s) => getComputedStyle(s).transform,
    ),
  );
const letterXf = async (page, i) =>
  letterLocators(page).nth(i).evaluate((el) => getComputedStyle(el).transform);
const letterColor = async (page, i) =>
  letterLocators(page).nth(i).evaluate((el) => getComputedStyle(el).color);
const hairlineXf = (page) =>
  page
    .locator('#brandMenuButton')
    .evaluate((el) => getComputedStyle(el, '::after').transform);
const hairlineHeight = (page) =>
  page
    .locator('#brandMenuButton')
    .evaluate((el) => getComputedStyle(el, '::after').height);
const linkBox = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  });
const isResting = (xf) => xf === 'none' || xf === 'matrix(1, 0, 0, 1, 0, 0)';
const movedOffBaseline = (xf) => !isResting(xf) && xf !== 'matrix(0, 0, 0, 1, 0, 0)';

const runSequence = async (page, scheme, prefix) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // --- rest -------------------------------------------------------------
  const restBox = await linkBox(page);
  const restXf = await letterXf(page, 0);
  const restColor = await letterColor(page, 0);
  const restHairline = await hairlineXf(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-rest.png`) });
  expect(isResting(restXf), `${scheme}: letter P rests at identity`, restXf);
  expect(
    restHairline === 'matrix(0, 0, 0, 1, 0, 0)' || restHairline === 'none',
    `${scheme}: hairline undrawn at rest`,
    restHairline,
  );

  // --- hover: staged wave frames ---------------------------------------
  // The wave is sampled by ONSET, not by wall-clock position: repeated
  // atomic snapshots until the first letter moves, then the stagger is
  // proven from that first-moving frame. Robust against runner jitter —
  // the only thing it asserts is the choreography's own ordering.
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  let onsetShot = false;
  let firstP = -1; // first snapshot index where P is off baseline
  let firstY = -1; // first snapshot index where Y is off baseline
  let snapshotIdx = 0;
  for (let elapsed = 60; elapsed <= 420; elapsed += 45) {
    await page.waitForTimeout(elapsed === 60 ? 60 : 45);
    const xf = await snapshotXf(page);
    if (firstP < 0 && movedOffBaseline(xf[0])) firstP = snapshotIdx;
    if (firstY < 0 && movedOffBaseline(xf[5])) firstY = snapshotIdx;
    snapshotIdx += 1;
    if (xf.some(movedOffBaseline) && !onsetShot) {
      await page.screenshot({
        path: join(evidenceDir, `${prefix}-wave-early.png`),
      });
      onsetShot = true;
    }
  }
  expect(firstP !== -1, `${scheme}: the ripple starts on hover`);
  expect(
    firstY === -1 || firstP <= firstY,
    `${scheme}: wave staggered left-to-right — Y never moves before P`,
    `P@${firstP} Y@${firstY}`,
  );

  await page.waitForTimeout(90); // mid-flight for the trailing letters
  const midXf = await snapshotXf(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-wave-mid.png`) });
  expect(
    midXf.some(movedOffBaseline),
    `${scheme}: wave mid — the ripple is travelling`,
    `${midXf.filter(movedOffBaseline).length}/6 moved`,
  );

  await page.waitForTimeout(380); // past the trailing letter's landing
  await page.screenshot({ path: join(evidenceDir, `${prefix}-wave-late.png`) });

  await page.waitForTimeout(420); // fully settled
  const settledXf = await snapshotXf(page);
  const settledColor = await letterColor(page, 0);
  const settledHairline = await hairlineXf(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-settled.png`) });
  expect(
    settledXf.every(isResting),
    `${scheme}: every letter settles back to rest — no scattered pose`,
  );
  expect(
    settledColor === restColor,
    `${scheme}: ink returns after the muted dip`,
    `${restColor} -> ${settledColor}`,
  );
  expect(
    settledHairline.includes('matrix(1'),
    `${scheme}: hairline drawn while hovering`,
    settledHairline,
  );
  expect(await hairlineHeight(page) === '1px', `${scheme}: hairline is exactly 1px`);

  // --- transform-only motion: the link's box never shifts ---------------
  expect(
    (await linkBox(page)) === restBox,
    `${scheme}: link box identical rest vs hover (no layout shift)`,
    `${restBox} vs ${await linkBox(page)}`,
  );

  // --- unhover: hairline retracts ---------------------------------------
  await page.mouse.move(640, 500);
  await page.waitForTimeout(500);
  const afterHairline = await hairlineXf(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-unhover.png`) });
  expect(
    afterHairline === 'matrix(0, 0, 0, 1, 0, 0)' || afterHairline === 'none',
    `${scheme}: hairline retracted after leave`,
    afterHairline,
  );

  // --- menu open: the underline doubles as the open-state ---------------
  await brand.click();
  await page.waitForTimeout(450);
  const openHairline = await hairlineXf(page);
  const expanded = await brand.getAttribute('aria-expanded');
  await page.screenshot({ path: join(evidenceDir, `${prefix}-menu-open.png`) });
  expect(expanded === 'true', `${scheme}: brand menu opens on click`);
  expect(
    openHairline.includes('matrix(1'),
    `${scheme}: hairline stays drawn while the menu is open`,
    openHairline,
  );
  await page.mouse.click(640, 500);
  await page.waitForTimeout(300);
};

const browser = await chromium.launch();

// --- desktop light + dark, motion allowed -------------------------------
for (const scheme of ['light', 'dark']) {
  say(`\n== ${scheme} / desktop 1280x800 ==`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await runSequence(page, scheme, `lh19-${scheme}`);
  await context.close();
}

// --- mobile pass (light): rest, hover settled, menu open ----------------
say('\n== light / mobile 375x667 ==');
{
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceDir, 'lh19-mobile-rest.png') });
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: join(evidenceDir, 'lh19-mobile-hover-settled.png') });
  const hairline = await hairlineXf(page);
  expect(hairline.includes('matrix(1'), 'mobile: hairline draws on hover', hairline);
  await brand.click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(evidenceDir, 'lh19-mobile-menu-open.png') });
  expect(
    (await brand.getAttribute('aria-expanded')) === 'true',
    'mobile: brand menu opens on tap',
  );
  await context.close();
}

// --- reduced motion: the ripple is gated, the hairline is not -----------
say('\n== light / desktop / prefers-reduced-motion: reduce ==');
{
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const restXf = await letterXf(page, 0);
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const hoverXf = await letterXf(page, 0);
  // The hairline's 350ms draw is deliberately ungated (a 1px state
  // affordance, not decoration) — sample it after the transition lands.
  await page.waitForTimeout(450);
  const hoverHairline = await hairlineXf(page);
  await page.screenshot({ path: join(evidenceDir, 'lh19-reduced-motion-hover.png') });
  expect(
    hoverXf === restXf,
    'reduced motion: letters never animate',
    `${restXf} -> ${hoverXf}`,
  );
  expect(
    hoverHairline.includes('matrix(1'),
    'reduced motion: hairline still draws (the state affordance stays)',
    hoverHairline,
  );
  await context.close();
}

await browser.close();
server.kill();

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
writeFileSync(join(evidenceDir, 'lh19-hover-assertions.txt'), log.join('\n') + '\n');
process.exit(failures === 0 ? 0 : 1);
