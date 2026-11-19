#!/usr/bin/env node
/**
 * hover-select-test.mjs — proves the wordmark hover is a drag-select.
 *
 * (Repo tooling lives in scripts/; evidence lands in qa/evidence/.)
 * The move under test is "select the name": on hover an I-beam caret
 * sweeps left to right across the wordmark dragging a real text
 * selection behind it (fg band, navbar-surface glyphs, revealed by
 * clip-path), and the name rests SELECTED — hover, keyboard focus and
 * the open menu all hold the band; leaving deselects. The letters
 * never move; every underline the brand ever wore (hairline,
 * squiggle, blink caret) is gone.
 *
 * Asserts:
 *   1. the accessible name is exactly "Padify" — the aria-hidden
 *      duplicate and caret never leak into it
 *   2. rest: band fully clipped, caret dark, ::after AND ::before are
 *      content:none — no underline layer of any kind survives
 *   3. the duplicate is pixel-coincident with the base word, painted
 *      in the word's own ink over the navbar surface
 *   4. hover: band lands open; link box and base glyphs never move;
 *      the caret self-conceals once the sweep lands
 *   5. frozen poses (WAAPI): caret rides the clip edge in lockstep
 *      and the band grows strictly left to right
 *   6. mid-sweep leave retracts cleanly; a full unhover
 *      byte-compares to the rest frame — the word carries nothing
 *      after
 *   7. menu open: the band persists with the pointer gone — the
 *      selection is the state, not a hover echo; no blink caret
 *   8. keyboard focus-visible selects the name too, caret-free
 *   9. prefers-reduced-motion: reduce — the band applies instantly as
 *      the state indicator, no caret, hover dim kept
 *
 * Frozen pose captures (Web Animations API) freeze the sweep at fixed
 * progress — realtime screenshots race the 380ms run and keep missing
 * the drag. Frames land in qa/evidence/ (sl20-*); the assertion log
 * prints and saves next to them (sl20-story-assertions.txt).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

// The whole selection state in ONE evaluate round-trip — sequential
// reads drift ~30ms each on the protocol and a frozen pose read twice
// is no longer one pose. Atomic or nothing.
const selState = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const stage = el.querySelector('.brand-stage');
    const sel = el.querySelector('.brand-sel');
    const caret = el.querySelector('.brand-caret');
    const rect = (n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const pseudo = (name) => getComputedStyle(el, name).content;
    const clip = getComputedStyle(sel).clipPath;
    // computed form: inset(0px 100% 0px 0px round 2px)
    const insetMatch = clip.match(/inset\(([^)]+)\)/);
    const rightInset = insetMatch ? parseFloat(insetMatch[1].split(' ')[1]) : null;
    const navbar = el.closest('.navbar-fixed-top');
    return {
      clip,
      rightInset,
      bandBg: getComputedStyle(sel).backgroundColor,
      bandColor: getComputedStyle(sel).color,
      caretOpacity: caret ? parseFloat(getComputedStyle(caret).opacity) : null,
      caretDisplay: caret ? getComputedStyle(caret).display : null,
      caretRect: caret ? rect(caret) : null,
      stage: rect(stage),
      sel: rect(sel),
      link: rect(el),
      fg: getComputedStyle(el).color,
      navbarBg: getComputedStyle(navbar).backgroundColor,
      afterContent: pseudo('::after'),
      beforeContent: pseudo('::before'),
      brandAnims: document
        .getAnimations()
        .filter(
          (a) =>
            a.effect &&
            a.effect.target &&
            a.effect.target.closest &&
            a.effect.target.closest('.tilt-css'),
        )
        .map((a) => ({
          self: a.effect.target === el,
          inStage: !!a.effect.target.closest('.brand-stage'),
          prop:
            a.transitionProperty || a.animationName || (a.effect && a.effect.getKeyframes ? 'kf' : '?'),
        })),
    };
  });

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const coincident = (a, b, tol) =>
  near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.w, b.w, tol) && near(a.h, b.h, tol);
const boxStr = (r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)}x${Math.round(r.h)}`;

const freezeBrand = async (page, t) =>
  page.evaluate((ms) => {
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

const finishBrand = (page) =>
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

// The frozen drag pose: the caret bar's right edge should sit at
// stage.left + q*(W + 4) where q = 1 - rightInset/100 — the same eased
// progress drives the clip edge and the caret (lockstep proof).
const caretLead = (s) => {
  const q = 1 - s.rightInset / 100;
  const expectedBarRight = s.stage.x + q * (s.stage.w + 4);
  const edge = s.stage.x + q * s.stage.w;
  return {
    lead: s.caretRect.x + s.caretRect.w - edge,
    lockErr: s.caretRect.x + s.caretRect.w - expectedBarRight,
    q,
  };
};

const runSequence = async (page, scheme, prefix) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // --- rest: the word carries nothing ------------------------------------
  const rest = await selState(page);
  const restShot = join(evidenceDir, `${prefix}-rest.png`);
  await page.locator('#brandMenuButton').screenshot({ path: restShot });
  await page.screenshot({ path: join(evidenceDir, `${prefix}-rest-page.png`) });
  expect(rest.rightInset === 100, `${scheme}: band fully clipped at rest`, rest.clip);
  expect(
    rest.caretOpacity !== null && rest.caretOpacity < 0.02,
    `${scheme}: caret dark at rest`,
  );
  expect(
    rest.afterContent === 'none',
    `${scheme}: ::after is gone — no underline layer of any kind`,
    rest.afterContent,
  );
  expect(
    rest.beforeContent === 'none',
    `${scheme}: ::before is gone — no blink caret layer`,
    rest.beforeContent,
  );
  expect(
    coincident(rest.sel, rest.stage, 0.75),
    `${scheme}: duplicate pixel-coincident with the base word`,
    `sel=${boxStr(rest.sel)} stage=${boxStr(rest.stage)}`,
  );
  expect(
    rest.bandBg === rest.fg,
    `${scheme}: band paints in the word's own ink`,
    `${rest.bandBg} vs ${rest.fg}`,
  );
  expect(
    rest.bandColor === rest.navbarBg,
    `${scheme}: band glyphs paint in the navbar surface`,
    `${rest.bandColor} vs ${rest.navbarBg}`,
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
    `${scheme}: accessible name is exactly "Padify" (decorations never leak)`,
    a11yOk
      ? ''
      : `textContent="${await page.locator('#brandMenuButton').evaluate((el) => el.textContent)}"`,
  );

  // --- hover: the drag-select lands ---------------------------------------
  const brand = page.locator('#brandMenuButton');
  const box = await brand.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600); // sweep 380ms + settle
  const hovered = await selState(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-selected.png`) });
  expect(
    hovered.rightInset === 0,
    `${scheme}: band lands fully open on hover`,
    hovered.clip,
  );
  expect(
    boxStr(hovered.link) === boxStr(rest.link),
    `${scheme}: link box identical while selected (navbar never moves)`,
    `${boxStr(rest.link)} vs ${boxStr(hovered.link)}`,
  );
  expect(
    boxStr(hovered.stage) === boxStr(rest.stage),
    `${scheme}: base glyphs never move (clip-path, not layout)`,
  );
  expect(
    hovered.caretOpacity < 0.02,
    `${scheme}: caret self-conceals after the sweep lands`,
  );

  // --- frozen poses (light only): the drag at fixed progress --------------
  if (scheme === 'light') {
    await page.mouse.move(640, 500);
    await page.waitForTimeout(400);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await freezeBrand(page, 70);
    const early = await selState(page);
    await page.screenshot({ path: join(evidenceDir, `${prefix}-freeze-drag-70.png`) });
    expect(
      early.rightInset > 5 && early.rightInset < 95,
      `${scheme}: frozen t=70ms — band mid-flight`,
      `rightInset ${early.rightInset}%`,
    );
    expect(
      early.caretOpacity > 0.9,
      `${scheme}: frozen t=70ms — caret visible mid-drag`,
      `opacity ${early.caretOpacity}`,
    );
    const earlyLead = caretLead(early);
    expect(
      earlyLead.lead > -1.5 && earlyLead.lead < 6 && Math.abs(earlyLead.lockErr) < 2.5,
      `${scheme}: frozen t=70ms — caret rides the clip edge (lockstep)`,
      `lead ${earlyLead.lead.toFixed(1)}px, err ${earlyLead.lockErr.toFixed(1)}px`,
    );

    await freezeBrand(page, 220);
    const late = await selState(page);
    await page.screenshot({ path: join(evidenceDir, `${prefix}-freeze-drag-220.png`) });
    expect(
      late.rightInset < early.rightInset,
      `${scheme}: frozen t=220ms — band grew strictly left to right`,
      `${early.rightInset}% -> ${late.rightInset}%`,
    );
    const lateLead = caretLead(late);
    expect(
      lateLead.lead > -1.5 && lateLead.lead < 6 && Math.abs(lateLead.lockErr) < 2.5,
      `${scheme}: frozen t=220ms — caret still riding the edge`,
      `lead ${lateLead.lead.toFixed(1)}px, err ${lateLead.lockErr.toFixed(1)}px`,
    );

    await finishBrand(page);
    await page.waitForTimeout(100);
  }

  // --- unhover: deselect returns the word to nothing ----------------------
  await page.mouse.move(640, 500);
  await page.waitForTimeout(400); // retract 200ms + settle
  const after = await selState(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-unhover-page.png`) });
  const unhoverShot = join(evidenceDir, `${prefix}-unhover.png`);
  await page.locator('#brandMenuButton').screenshot({ path: unhoverShot });
  expect(
    after.rightInset === 100,
    `${scheme}: band fully retracted after leave`,
    after.clip,
  );
  expect(after.caretOpacity < 0.02, `${scheme}: caret dark after leave`);
  const restBytes = readFileSync(restShot);
  const unhoverBytes = readFileSync(unhoverShot);
  expect(
    restBytes.equals(unhoverBytes),
    `${scheme}: unhover frame byte-compares to the rest frame — the word carries nothing after`,
  );

  // --- interrupt: leave mid-drag ------------------------------------------
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(130);
  await page.mouse.move(640, 500);
  await page.waitForTimeout(400);
  const interrupted = await selState(page);
  expect(
    interrupted.rightInset === 100,
    `${scheme}: mid-sweep leave retracts cleanly`,
    interrupted.clip,
  );
  expect(interrupted.caretOpacity < 0.02, `${scheme}: caret dark after interrupt`);

  // --- menu open: the selection is the state ------------------------------
  await brand.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-menu-open.png`) });
  expect(
    (await brand.getAttribute('aria-expanded')) === 'true',
    `${scheme}: brand menu opens on click`,
  );
  expect(
    (await selState(page)).rightInset === 0,
    `${scheme}: name stays selected while the menu is open`,
  );
  expect(
    (await selState(page)).caretOpacity < 0.02,
    `${scheme}: no caret dance on the open state`,
  );
  // The differentiator: walk the pointer away — the band holds.
  await page.mouse.move(640, 500);
  await page.waitForTimeout(350);
  const openUnhovered = await selState(page);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-menu-open-unhovered.png`) });
  expect(
    openUnhovered.rightInset === 0,
    `${scheme}: band persists with the pointer gone — state, not hover echo`,
    openUnhovered.clip,
  );
  await page.mouse.click(640, 500);
  await page.waitForTimeout(400);
  expect(
    (await selState(page)).rightInset === 100,
    `${scheme}: closing the menu deselects`,
  );

  // --- keyboard: focus-visible selects the name ---------------------------
  if (scheme === 'light') {
    // The menu was closed with a click in the editor, so focus sits deep
    // in the app (note rail, editor) — walking Tab from there has to hop
    // every tabbable. Blur first: from a clean body the brand is the
    // FIRST tabbable (the only earlier control is the desktop-hidden
    // hamburger), so one Tab lands on it with real keyboard modality.
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
    let focused = false;
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if (id === 'brandMenuButton') {
        focused = true;
        break;
      }
    }
    await page.waitForTimeout(600);
    const focusState = await selState(page);
    await page.screenshot({ path: join(evidenceDir, `${prefix}-focus.png`) });
    expect(focused, `${scheme}: Tab reaches the brand button`);
    expect(
      focused && focusState.rightInset === 0,
      `${scheme}: focus-visible selects the name`,
      focusState.clip,
    );
    expect(
      focusState.caretOpacity < 0.02,
      `${scheme}: keyboard selection is caret-free`,
    );
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    expect(
      (await selState(page)).rightInset === 100,
      `${scheme}: blur deselects`,
    );
  }
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
  await runSequence(page, scheme, `sl20-${scheme}`);
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
  await page.screenshot({ path: join(evidenceDir, 'sl20-mobile-rest.png') });
  const brand = page.locator('#brandMenuButton');
  await brand.click();
  await page.waitForTimeout(600);
  const opened = await selState(page);
  await page.screenshot({ path: join(evidenceDir, 'sl20-mobile-menu-open.png') });
  expect(
    (await brand.getAttribute('aria-expanded')) === 'true',
    'mobile: brand menu opens on tap',
  );
  expect(
    opened.rightInset === 0,
    'mobile: tap selects the name',
    opened.clip,
  );
  expect(
    opened.caretOpacity < 0.02,
    'mobile: no cursor dance on tap',
  );
  await page.mouse.click(360, 500);
  await page.waitForTimeout(400);
  expect(
    (await selState(page)).rightInset === 100,
    'mobile: outside tap deselects',
  );
  await context.close();
}

// --- reduced motion: the band applies, nothing sweeps ----------------------
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
  await page.waitForTimeout(120); // a 380ms sweep would still be mid-flight
  const rm = await selState(page);
  await page.screenshot({ path: join(evidenceDir, 'sl20-reduced-motion-selected.png') });
  expect(
    rm.rightInset === 0,
    'reduced motion: band applies instantly (no sweep ramp)',
    `at 120ms: ${rm.clip}`,
  );
  expect(
    rm.brandAnims.every((a) => !a.inStage),
    'reduced motion: nothing in the stage animates (no sweep machinery)',
    JSON.stringify(rm.brandAnims),
  );
  expect(
    rm.brandAnims.every((a) => a.self && a.prop === 'opacity'),
    'reduced motion: the only brand animation is the hover dim itself',
    JSON.stringify(rm.brandAnims),
  );
  expect(
    rm.caretDisplay === 'none',
    'reduced motion: caret removed entirely',
  );
  expect(
    parseFloat(dim) === 1 && (await brand.evaluate((el) => getComputedStyle(el).opacity)) < 1,
    'reduced motion: plain opacity dim on hover',
    `${dim} -> ${await brand.evaluate((el) => getComputedStyle(el).opacity)}`,
  );
  await page.mouse.move(640, 500);
  await page.waitForTimeout(300);
  expect(
    (await selState(page)).rightInset === 100,
    'reduced motion: leave deselects instantly',
  );
  await context.close();
}

await browser.close();
server.kill();

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
writeFileSync(join(evidenceDir, 'sl20-story-assertions.txt'), log.join('\n') + '\n');
process.exit(failures === 0 ? 0 : 1);
