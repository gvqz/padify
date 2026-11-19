#!/usr/bin/env node
/**
 * hover-ripple-test.mjs — proves the wordmark hover story end to end.
 *
 * (Repo tooling lives in scripts/; evidence lands in qa/evidence/.)
 * The move under test is "the typo gets fixed": on hover each glyph
 * rolls to its qwerty neighbour (Padify -> Osfogu), a red spellcheck
 * squiggle flags it, then the wheels spin back and the real word
 * lands. While the brand menu is open the story is suppressed and a
 * blinking caret marks the state.
 *
 * Asserts:
 *   1. the accessible name is exactly "Padify" — typo ghosts are
 *      aria-hidden and never leak into it
 *   2. the typo beat really shows: every ghost in-window, every real
 *      glyph parked, squiggle lit, ghost optically centred
 *   3. the deal is staggered left-to-right (P swaps before Y)
 *   4. every glyph lands back at rest and the squiggle dies — the
 *      word carries nothing after the story
 *   5. the link's box never shifts (padding/negative-margin slack, no
 *      navbar movement, rest vs mid-story vs landed)
 *   6. menu open: story suppressed, caret blinking at 1px-wide
 *   7. prefers-reduced-motion: reduce — nothing moves, no squiggle,
 *      plain opacity dim, caret static
 *
 * Frozen pose captures (Web Animations API) freeze the story at fixed
 * progress — realtime screenshots race the fast beats and keep missing
 * them. Frames land in qa/evidence/ (lp20-*); the assertion log prints
 * and saves next to them (lp20-story-assertions.txt).
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

const riders = (page) => page.locator('#brandMenuButton .brand-rider');
const typos = (page) => page.locator('#brandMenuButton .brand-typo');
const riderXf = async (page, i) =>
  riders(page).nth(i).evaluate((el) => getComputedStyle(el).transform);
const typoXf = async (page, i) =>
  typos(page).nth(i).evaluate((el) => getComputedStyle(el).transform);
const squiggleOpacity = (page) =>
  page
    .locator('#brandMenuButton')
    .evaluate((el) => parseFloat(getComputedStyle(el, '::after').opacity));
const caretStyle = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return { opacity: parseFloat(s.opacity), animation: s.animationName };
  });
const linkBox = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  });
// The whole story state in ONE evaluate round-trip — sequential reads
// drift ~30ms each on the protocol, and twelve of them pushed the
// squiggle sample straight into its fade phase. Atomic or nothing.
const storyState = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const read = (nodes) =>
      Array.from(nodes).map((n) => getComputedStyle(n).transform);
    return {
      riders: read(el.querySelectorAll('.brand-rider')),
      typos: read(el.querySelectorAll('.brand-typo')),
      squiggle: parseFloat(getComputedStyle(el, '::after').opacity),
      riderColor: getComputedStyle(el.querySelector('.brand-rider')).color,
      typoColor: getComputedStyle(el.querySelector('.brand-typo')).color,
      box: (() => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
      })(),
      ghostDelta: (() => {
        const slot = el.querySelectorAll('.brand-slot')[0];
        const a = slot.querySelector('.brand-rider').getBoundingClientRect();
        const b = slot.querySelector('.brand-typo').getBoundingClientRect();
        return Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
      })(),
    };
  });

const isResting = (xf) => xf === 'none' || xf === 'matrix(1, 0, 0, 1, 0, 0)';
const isParked = (xf) => {
  const m = xf.match(/^matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)$/);
  return m !== null && Math.abs(parseFloat(m[1])) >= 21;
};

const freezeAt = async (page, t, path) => {
  await page.evaluate((ms) => {
    document
      .getAnimations()
      .filter(
        (a) =>
          a.effect &&
          a.effect.target &&
          a.effect.target.closest &&
          a.effect.target.closest('.tilt-css'),
      )
      .forEach((a) => {
        a.pause();
        a.currentTime = ms;
      });
  }, t);
  await page.screenshot({ path });
};
const finishStory = (page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (a) =>
          a.effect &&
          a.effect.target &&
          a.effect.target.closest &&
          a.effect.target.closest('.tilt-css'),
      )
      .forEach((a) => a.finish()),
  );

const runSequence = async (page, scheme, prefix) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // --- rest: the word carries nothing ------------------------------------
  const restBox = await linkBox(page);
  const restRider = await riderXf(page, 0);
  const restTypo = await typoXf(page, 0);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-rest.png`) });
  expect(isResting(restRider), `${scheme}: real glyph rests at identity`, restRider);
  expect(isParked(restTypo), `${scheme}: typo ghost parked below the window`, restTypo);
  expect(
    (await squiggleOpacity(page)) < 0.02,
    `${scheme}: no squiggle at rest — the word carries nothing`,
  );
  expect(
    (await caretStyle(page)).opacity < 0.02,
    `${scheme}: no caret at rest`,
  );
  let a11yOk = true;
  try {
    await page
      .getByRole('button', { name: 'Padify', exact: true })
      .waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    a11yOk = false;
  }
  expect(
    a11yOk,
    `${scheme}: accessible name is exactly "Padify" (ghosts never leak)`,
    a11yOk
      ? ''
      : `textContent="${await page.locator('#brandMenuButton').evaluate((el) => el.textContent)}"`,
  );

  // --- hover: the story ---------------------------------------------------
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await page.waitForTimeout(80);
  const early = await storyState(page);
  expect(
    !isResting(early.riders[0]) && isResting(early.riders[5]),
    `${scheme}: deal staggered left-to-right — P swaps before Y`,
    `P=${early.riders[0]} Y=${early.riders[5]}`,
  );

  await page.waitForTimeout(380); // ~460ms — the typo beat
  const beat = await storyState(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-typo-beat.png`) });
  expect(
    beat.riders.every(isParked),
    `${scheme}: typo beat — every real glyph parked below its window`,
  );
  expect(
    beat.typos.every(isResting),
    `${scheme}: typo beat — every qwerty neighbour in the window ("Osfogu")`,
  );
  expect(
    beat.squiggle > 0.4,
    `${scheme}: spellcheck squiggle lit under the typo`,
    `opacity ${beat.squiggle}`,
  );
  expect(
    beat.typoColor !== beat.riderColor,
    `${scheme}: ghost ink is muted — the typo reads provisional`,
    `${beat.typoColor} vs ${beat.riderColor}`,
  );
  expect(
    beat.ghostDelta < 1.5,
    `${scheme}: ghost optically centred on its slot`,
    `${beat.ghostDelta}px`,
  );
  expect(
    beat.box === restBox,
    `${scheme}: link box identical mid-story (navbar never moves)`,
    `${restBox} vs ${beat.box}`,
  );

  // --- frozen poses (light only): the story at fixed progress ------------
  if (scheme === 'light') {
    // 1050ms story, 35ms stagger: 85 = mid-swap; 430 = the typo beat
    // ("Osfogu" + squiggle); 780 = the fix rolling home; 1200 = landed.
    await freezeAt(page, 85, join(evidenceDir, `${prefix}-freeze-swap.png`));
    await freezeAt(page, 430, join(evidenceDir, `${prefix}-freeze-typo.png`));
    await freezeAt(page, 780, join(evidenceDir, `${prefix}-freeze-fix.png`));
    await freezeAt(page, 1200, join(evidenceDir, `${prefix}-freeze-landed.png`));
    await finishStory(page);
    await page.waitForTimeout(100);
  }

  await page.waitForTimeout(700); // past the last landing (~1225ms) even without the freeze shortcut
  const end = await storyState(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-landed.png`) });
  expect(
    end.riders.every(isResting),
    `${scheme}: every real glyph lands back at rest`,
  );
  expect(
    end.typos.every(isParked),
    `${scheme}: every ghost parked again after the fix`,
  );
  expect(
    end.squiggle < 0.05,
    `${scheme}: squiggle dead once the word is fixed`,
    `opacity ${end.squiggle}`,
  );
  expect(
    end.box === restBox,
    `${scheme}: link box identical after landing`,
  );

  // --- unhover -----------------------------------------------------------
  await page.mouse.move(640, 500);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-unhover.png`) });
  expect(
    (await riderXf(page, 0)) === 'none' || isResting(await riderXf(page, 0)),
    `${scheme}: clean rest after leave`,
  );

  // --- menu open: story suppressed, caret takes over ---------------------
  await brand.click();
  await page.waitForTimeout(300);
  const openCaret = await caretStyle(page);
  // Sample a full blink cycle — a stepped blink is 0 half the duty at
  // any instant; the proof is that it sweeps 1 -> 0 -> 1, not that a
  // single sample catches it lit.
  const blinkSamples = [];
  for (let i = 0; i < 5; i += 1) {
    blinkSamples.push(await caretStyle(page));
    await page.waitForTimeout(220);
  }
  await page.screenshot({ path: join(evidenceDir, `${prefix}-menu-open.png`) });
  expect(
    (await brand.getAttribute('aria-expanded')) === 'true',
    `${scheme}: brand menu opens on click`,
  );
  expect(
    openCaret.animation === 'brand-caret-blink',
    `${scheme}: caret blinks (editor's open-state cue)`,
    openCaret.animation,
  );
  expect(
    Math.max(...blinkSamples.map((c) => c.opacity)) > 0.9 &&
      Math.min(...blinkSamples.map((c) => c.opacity)) < 0.1,
    `${scheme}: caret sweeps lit -> dark -> lit over one cycle`,
    blinkSamples.map((c) => c.opacity.toFixed(2)).join(' '),
  );
  const openState = await storyState(page);
  expect(
    openState.squiggle < 0.05,
    `${scheme}: story suppressed while the menu is open`,
  );
  expect(
    openState.riders.every(isResting),
    `${scheme}: word stays still while the menu is open`,
  );
  await page.mouse.click(640, 500);
  await page.waitForTimeout(300);
};

const browser = await chromium.launch();

// --- desktop light + dark -------------------------------------------------
for (const scheme of ['light', 'dark']) {
  say(`\n== ${scheme} / desktop 1280x800 ==`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await runSequence(page, scheme, `lp20-${scheme}`);
  await context.close();
}

// --- mobile pass (light) ---------------------------------------------------
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
  await page.screenshot({ path: join(evidenceDir, 'lp20-mobile-rest.png') });
  const brand = page.locator('#brandMenuButton');
  await brand.click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(evidenceDir, 'lp20-mobile-menu-open.png') });
  expect(
    (await brand.getAttribute('aria-expanded')) === 'true',
    'mobile: brand menu opens on tap',
  );
  expect(
    (await caretStyle(page)).opacity > 0.9,
    'mobile: caret lit on tap',
  );
  await context.close();
}

// --- reduced motion: nothing moves ----------------------------------------
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
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  const dim = await brand.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(450);
  const hoverDim = await brand.evaluate((el) => getComputedStyle(el).opacity);
  await page.screenshot({ path: join(evidenceDir, 'lp20-reduced-motion-hover.png') });
  expect(
    isResting(await riderXf(page, 0)),
    'reduced motion: real glyphs never move',
  );
  expect(
    isParked(await typoXf(page, 0)),
    'reduced motion: ghost stays parked — the typo never shows',
  );
  expect(
    (await squiggleOpacity(page)) < 0.02,
    'reduced motion: no squiggle',
  );
  expect(
    parseFloat(dim) === 1 && parseFloat(hoverDim) < 1,
    'reduced motion: plain opacity dim on hover',
    `${dim} -> ${hoverDim}`,
  );
  await context.close();
}

await browser.close();
server.kill();

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
writeFileSync(join(evidenceDir, 'lp20-story-assertions.txt'), log.join('\n') + '\n');
process.exit(failures === 0 ? 0 : 1);
