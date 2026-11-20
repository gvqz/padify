#!/usr/bin/env node
/**
 * hover-deck-test.mjs — proves the wordmark hover is a rotating deck.
 *
 * (Repo tooling lives in scripts/; evidence lands in qa/evidence/.)
 * Hover no longer plays ONE move — each pointerenter deals the NEXT card
 * from a ten-card deck, in the owner's order, wrapping forever:
 *
 *   02 magnetic   04 typo   05 wire re-ink   06 wet ink   07 inhale
 *   08 misreg.    10 stamp  11 circle        13 mirror    14 armed key
 *
 * The selection band survives as the STATE indicator (keyboard focus and
 * the open menu hold it); hover belongs to the deck. The brand-caret is
 * gone entirely — the drag it served was a hover move, and hover has a
 * new job.
 *
 * Asserts:
 *   1. the accessible name is exactly "Padify" — six letter spans, the
 *      typo ghost and four overlay copies never leak into it
 *   2. rest: band fully clipped, every overlay dark, ring undrawn,
 *      letters untransformed, the caret element GONE from the anatomy,
 *      and the band pixel-coincident with the split-letter base word
 *      (font-kerning: none keeps six atomic spans and plain text equal)
 *   3. the deal: 21 pointerenters read data-move in the owner's order
 *      and wrap — card 11 is card 1 again; no card ever repeats in place
 *   4. per-card deep checks across two full wraps, one byte-compared
 *      rest frame after each fold:
 *        mag    — letters lean toward the pointer (clamped), spring back
 *        typo   — ghost reads b then e in provisional ink while the real
 *                 d goes transparent, restores to d, the word shakes
 *        wire   — frozen mid-drain: word opacity 0, wire opacity 1
 *        wet    — frozen early: letters blurred, unevenly drying
 *        inhale — settled: letters converged on the optical center,
 *                 symmetric; leave relaxes them
 *        reg    — frozen mid-hold: word out +1.4px, ghost plate out
 *                 -1.6px at 0.4 ink
 *        stamp  — frozen at the press: word dipped and squashed, the
 *                 blurred impression at full ink
 *        ring   — drawn to dashoffset 0 while dealt, un-drawn on leave
 *        flip   — frozen mid-turn: the stage is mid-rotateY with a
 *                 NEGATIVE cosine — the mirrored back showing through
 *        arm    — settled: the word half a pixel up; leave settles it
 *   5. the link box byte-matches the rest box during every check — the
 *      navbar never moves, not even mid-flip (3D projects, layout holds)
 *   6. leave folds the card: data-move drops and the button frame
 *      byte-compares to rest — nothing carries over, per card
 *   7. menu open: the band holds with the pointer gone, a re-entered
 *      card deals UNDER the state, closing the menu deselects
 *   8. keyboard focus-visible holds the band and deals NO card
 *   9. prefers-reduced-motion: reduce — no cards are dealt, the overlay
 *      machinery displays none, hover keeps the plain opacity dim
 *
 * Frozen poses (Web Animations API) hold each card at a fixed progress;
 * realtime frames race the runs. Evidence lands in qa/evidence/ (rd20-*);
 * the assertion log prints and saves next to them (rd20-story-assertions.txt).
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

// The owner's order: shortlist cards 2, 4, 5, 6, 7, 8, 10, 11, 13, 14.
const DECK = ['mag', 'typo', 'wire', 'wet', 'inhale', 'reg', 'stamp', 'ring', 'flip', 'arm'];

// The whole deck state in ONE evaluate round-trip — sequential reads drift
// ~30ms each on the protocol and a frozen pose read twice is no longer one
// pose. Atomic or nothing.
const deckState = (page) =>
  page.locator('#brandMenuButton').evaluate((el) => {
    const stage = el.querySelector('.brand-stage');
    const q = (s) => stage.querySelector(s);
    const word = q('.brand-word');
    const letters = [...stage.querySelectorAll('.brand-word > .brand-L')];
    const rect = (n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const tf = (n) => getComputedStyle(n).transform;
    const parseM = (m) => {
      if (!m || m === 'none') return null;
      const v = m.match(/matrix(3d)?\(([^)]+)\)/);
      if (!v) return null;
      const p = v[2].split(',').map(parseFloat);
      return p.length === 6
        ? { a: p[0], tx: p[4], ty: p[5] }
        : { a: p[0], tx: p[12], ty: p[13], m3: true };
    };
    const blurOf = (n) => {
      const f = getComputedStyle(n).filter;
      const m = f.match(/blur\(([\d.]+)px\)/);
      return m ? parseFloat(m[1]) : 0;
    };
    const clip = getComputedStyle(q('.brand-sel')).clipPath;
    const insetMatch = clip.match(/inset\(([^)]+)\)/);
    const path = q('.brand-ring path');
    return {
      move: stage.getAttribute('data-move'),
      caretGone: !stage.querySelector('.brand-caret'),
      clip,
      rightInset: insetMatch ? parseFloat(insetMatch[1].split(' ')[1]) : null,
      bandBg: getComputedStyle(q('.brand-sel')).backgroundColor,
      bandColor: getComputedStyle(q('.brand-sel')).color,
      wordOpacity: parseFloat(getComputedStyle(word).opacity),
      wireOpacity: parseFloat(getComputedStyle(q('.brand-wire')).opacity),
      regOpacity: parseFloat(getComputedStyle(q('.brand-reg')).opacity),
      impOpacity: parseFloat(getComputedStyle(q('.brand-imp')).opacity),
      ringOffset: path ? parseFloat(getComputedStyle(path).strokeDashoffset) : null,
      wordM: parseM(tf(word)),
      lettersInline: letters.map((l) => l.style.transform),
      lettersTx: letters.map((l) => (parseM(tf(l)) || { tx: 0 }).tx),
      lettersBlur: letters.map(blurOf),
      typoGhostText: q('.brand-typo').textContent,
      typoGhostOpacity: parseFloat(getComputedStyle(q('.brand-typo')).opacity),
      typoLetterColor: getComputedStyle(q('.brand-L-typo')).color,
      glitching: stage.classList.contains('glitching'),
      stageM: parseM(tf(stage)),
      stageRect: rect(stage),
      wordRect: rect(word),
      selRect: rect(q('.brand-sel')),
      linkRect: rect(el),
      linkOpacity: parseFloat(getComputedStyle(el).opacity),
      fg: getComputedStyle(el).color,
      navbarBg: getComputedStyle(el.closest('.navbar-fixed-top')).backgroundColor,
      overlayDisplays: ['.brand-wire', '.brand-reg', '.brand-imp', '.brand-ring'].map(
        (s) => getComputedStyle(q(s)).display,
      ),
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
          inStage: !!a.effect.target.closest('.brand-stage'),
          prop: a.transitionProperty || a.animationName || 'kf',
          state: a.playState,
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

const AWAY = { x: 640, y: 500 };

// Deal the next card: cross onto the button (pointerenter fires), read the
// attribute the dealer set. The attribute is set synchronously in the
// handler — 60ms is protocol slack, not animation wait.
const dealCard = async (page) => {
  const box = await page.locator('#brandMenuButton').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(60);
  return deckState(page);
};

// Fold the card: walk the pointer away, give transitions their run.
const foldCard = async (page, settle = 700) => {
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(settle);
  return deckState(page);
};

const buttonShot = (page, path) => page.locator('#brandMenuButton').screenshot({ path });

const runSequence = async (page, scheme, prefix, full) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // --- rest: the word carries nothing but its own ink ----------------------
  const rest = await deckState(page);
  const restShot = join(evidenceDir, `${prefix}-rest.png`);
  await buttonShot(page, restShot);
  await page.screenshot({ path: join(evidenceDir, `${prefix}-rest-page.png`) });
  expect(rest.rightInset === 100, `${scheme}: band fully clipped at rest`, rest.clip);
  expect(rest.caretGone, `${scheme}: the brand-caret element is gone from the anatomy`);
  expect(
    rest.wireOpacity === 0 && rest.regOpacity === 0 && rest.impOpacity === 0,
    `${scheme}: wire, register and impression plates are dark at rest`,
    `${rest.wireOpacity}/${rest.regOpacity}/${rest.impOpacity}`,
  );
  expect(
    rest.ringOffset === 100,
    `${scheme}: the editor's circle is undrawn at rest`,
    `dashoffset ${rest.ringOffset}`,
  );
  expect(
    rest.lettersInline.every((t) => t === '') && rest.move === null,
    `${scheme}: letters carry no inline transforms and no card is dealt`,
  );
  expect(
    coincident(rest.selRect, rest.wordRect, 0.75),
    `${scheme}: band pixel-coincident with the split-letter base word`,
    `sel=${boxStr(rest.selRect)} word=${boxStr(rest.wordRect)}`,
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
    `${scheme}: accessible name is exactly "Padify" (letters, ghost and copies never leak)`,
  );

  // --- the deal: order + deep checks over two full wraps -------------------
  if (!full) return;

  for (let i = 0; i < 20; i += 1) {
    const card = DECK[i % DECK.length];
    const dealt = await dealCard(page);
    expect(dealt.move === card, `deal ${i + 1}: ${scheme} deals "${card}"`, `got "${dealt.move}"`);
    expect(
      boxStr(dealt.linkRect) === boxStr(rest.linkRect),
      `deal ${i + 1}: link box identical while "${card}" is dealt`,
    );

    if (card === 'mag') {
      const box = await page.locator('#brandMenuButton').boundingBox();
      await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
      await page.waitForTimeout(120);
      const pulled = await deckState(page);
      const leaning = pulled.lettersInline.filter((t) => t !== '' && t !== 'translateX(0px)');
      expect(
        leaning.length >= 3,
        `mag: letters lean toward the pointer (${leaning.length}/6 pulled)`,
      );
      expect(
        pulled.lettersTx.every((tx) => Math.abs(tx) <= 2.3),
        `mag: the lean is clamped`,
        pulled.lettersTx.map((t) => t.toFixed(1)).join(','),
      );
      expect(
        boxStr(pulled.linkRect) === boxStr(rest.linkRect),
        `mag: link box identical while bent`,
      );
      await buttonShot(page, join(evidenceDir, `rd20-light-card-mag.png`));
      await page.mouse.move(AWAY.x, AWAY.y);
      await page.waitForTimeout(450);
      const folded = await deckState(page);
      expect(
        folded.lettersInline.every((t) => t === ''),
        `mag: letters spring home on leave`,
      );
    } else if (card === 'typo') {
      await page.waitForTimeout(160);
      const mid = await deckState(page);
      const alpha = (mid.typoLetterColor.match(/rgba?\(([^)]+)\)/) || [])[1];
      const a = alpha ? parseFloat(alpha.split(',')[3] ?? '1') : 1;
      expect(
        (mid.typoGhostText === 'b' || mid.typoGhostText === 'e') && mid.typoGhostOpacity > 0.9,
        `typo: the ghost reads a wrong key in provisional ink ('${mid.typoGhostText}')`,
      );
      expect(a < 0.5, `typo: the real d is transparent while the ghost shows`, mid.typoLetterColor);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-typo.png`));
      await page.waitForTimeout(230);
      const shook = await deckState(page);
      expect(shook.glitching, `typo: the word shakes as the fix lands`);
      expect(
        shook.typoGhostText === 'd' && shook.typoGhostOpacity < 0.15,
        `typo: the ghost folds back to d`,
      );
      await page.waitForTimeout(400);
      const settled = await deckState(page);
      expect(!settled.glitching, `typo: the shake dies with the fix`);
    } else if (card === 'wire') {
      await freezeBrand(page, 350);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-${scheme}-card-wire-freeze-350.png`));
      expect(
        frozen.wordOpacity < 0.1,
        `wire: frozen t=350ms — the fill has drained`,
        `word opacity ${frozen.wordOpacity}`,
      );
      expect(
        frozen.wireOpacity > 0.9,
        `wire: frozen t=350ms — the outline plate shows`,
        `wire opacity ${frozen.wireOpacity}`,
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
    } else if (card === 'wet') {
      await freezeBrand(page, 120);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-wet-freeze-120.png`));
      const wet = frozen.lettersBlur.filter((b) => b > 1).length;
      expect(
        wet >= 3,
        `wet: frozen t=120ms — letters are soft, mid-dry (${wet}/6 blurred)`,
        frozen.lettersBlur.join(','),
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
      const dried = await deckState(page);
      expect(
        dried.lettersBlur.every((b) => b === 0),
        `wet: the word dries crisp`,
      );
    } else if (card === 'inhale') {
      await page.waitForTimeout(500);
      const held = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-inhale.png`));
      expect(
        near(held.lettersTx[0], 2.4, 0.3) && near(held.lettersTx[5], -2.4, 0.3),
        `inhale: the word converged on its center`,
        held.lettersTx.map((t) => t.toFixed(1)).join(','),
      );
      expect(
        near(held.lettersTx[0], -held.lettersTx[5], 0.05),
        `inhale: the convergence is symmetric`,
      );
    } else if (card === 'reg') {
      await freezeBrand(page, 300);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-reg-freeze-300.png`));
      expect(
        frozen.wordM && near(frozen.wordM.tx, 1.4, 0.25),
        `reg: frozen mid-hold — the base plate is out +1.4px`,
        frozen.wordM && frozen.wordM.tx.toFixed(2),
      );
      expect(
        near(frozen.regOpacity, 0.4, 0.06),
        `reg: frozen mid-hold — the ghost plate is at 0.4 ink`,
        frozen.regOpacity.toFixed(2),
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
    } else if (card === 'stamp') {
      await freezeBrand(page, 140);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-stamp-freeze-140.png`));
      expect(
        frozen.wordM && frozen.wordM.ty > 0.8 && near(frozen.wordM.a, 0.985, 0.02),
        `stamp: frozen at the press — the word is dipped and squashed`,
        frozen.wordM && `ty ${frozen.wordM.ty.toFixed(2)}, a ${frozen.wordM.a.toFixed(3)}`,
      );
      expect(
        near(frozen.impOpacity, 0.32, 0.08),
        `stamp: frozen at the press — the impression carries ink`,
        frozen.impOpacity.toFixed(2),
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
    } else if (card === 'ring') {
      await page.waitForTimeout(550);
      const drawn = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-ring.png`));
      expect(
        drawn.ringOffset === 0,
        `ring: the circle is fully drawn while dealt`,
        `dashoffset ${drawn.ringOffset}`,
      );
    } else if (card === 'flip') {
      await freezeBrand(page, 150);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-flip-freeze-150.png`));
      expect(
        frozen.stageM && frozen.stageM.m3 === true,
        `flip: frozen mid-turn — the stage is in a 3D rotate`,
      );
      expect(
        frozen.stageM && frozen.stageM.a < -0.1,
        `flip: frozen mid-turn — the cosine is negative, the mirrored back shows`,
        frozen.stageM && frozen.stageM.a.toFixed(2),
      );
      expect(
        boxStr(frozen.linkRect) === boxStr(rest.linkRect),
        `flip: the link box holds while the word projects`,
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
    } else if (card === 'arm') {
      await page.waitForTimeout(300);
      const armed = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-light-card-arm.png`));
      expect(
        armed.wordM && near(armed.wordM.ty, -0.5, 0.12),
        `arm: the word sits half a pixel up`,
        armed.wordM && armed.wordM.ty.toFixed(2),
      );
    }

    // fold: the card drops, and the frame byte-compares to rest
    const folded = await foldCard(page);
    expect(
      folded.move === null,
      `deal ${i + 1}: leave folds "${card}"`,
      `data-move="${folded.move}"`,
    );
    const shot = join(evidenceDir, `rd20-light-fold-${String(i + 1).padStart(2, '0')}.png`);
    await buttonShot(page, shot);
    expect(
      readFileSync(shot).equals(readFileSync(restShot)),
      `deal ${i + 1}: "${card}" leaves nothing — frame byte-compares to rest`,
    );
  }

  // --- menu open: the band is the state, cards play under it ---------------
  await page.locator('#brandMenuButton').click();
  await page.waitForTimeout(650);
  const open = await deckState(page);
  await page.screenshot({ path: join(evidenceDir, `rd20-${scheme}-menu-open.png`) });
  expect(
    (await page.locator('#brandMenuButton').getAttribute('aria-expanded')) === 'true',
    `${scheme}: brand menu opens on click`,
  );
  expect(open.rightInset === 0, `${scheme}: the band holds while the menu is open`, open.clip);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(400);
  const openUnhovered = await deckState(page);
  await page.screenshot({
    path: join(evidenceDir, `rd20-${scheme}-menu-open-unhovered.png`),
  });
  expect(
    openUnhovered.rightInset === 0,
    `${scheme}: the band persists with the pointer gone — state, not hover echo`,
  );
  expect(
    openUnhovered.move === null,
    `${scheme}: the dealt card folded even while the state holds`,
  );
  // re-enter: the deck keeps dealing, UNDER the state
  const again = await dealCard(page);
  expect(
    again.move !== null && DECK.includes(again.move),
    `${scheme}: re-entering deals the next card`,
    `"${again.move}"`,
  );
  expect(again.rightInset === 0, `${scheme}: the card plays under the held band, never over it`);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(300);
  await page.mouse.click(AWAY.x, AWAY.y);
  await page.waitForTimeout(450);
  expect((await deckState(page)).rightInset === 100, `${scheme}: closing the menu deselects`);

  // --- keyboard: focus-visible holds the band and deals no card ------------
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
  const focusState = await deckState(page);
  await page.screenshot({ path: join(evidenceDir, `rd20-light-focus.png`) });
  expect(focused, `light: Tab reaches the brand button`);
  expect(
    focused && focusState.rightInset === 0,
    `light: focus-visible holds the band`,
    focusState.clip,
  );
  expect(focusState.move === null, `light: keyboard focus deals no card`);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  expect((await deckState(page)).rightInset === 100, `light: blur releases the band`);
};

const browser = await chromium.launch();

// --- desktop light: the full pass ------------------------------------------
for (const scheme of ['light']) {
  say(`\n== ${scheme} / desktop 1280x800 ==`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await runSequence(page, scheme, `rd20-${scheme}`, true);
  await context.close();
}

// --- desktop dark: token remap + state + one frozen card -------------------
say('\n== dark / desktop 1280x800 ==');
{
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await runSequence(page, 'dark', 'rd20-dark', false);

  // five deals in order (folding between them — the pointer must leave and
  // re-cross for the next pointerenter to fire), freezing the wire card
  // mid-drain when it comes up
  for (let i = 0; i < 5; i += 1) {
    const dealt = await dealCard(page);
    expect(dealt.move === DECK[i], `dark deal ${i + 1}: "${DECK[i]}"`, `got "${dealt.move}"`);
    if (DECK[i] === 'wire') {
      await freezeBrand(page, 350);
      const frozen = await deckState(page);
      await buttonShot(page, join(evidenceDir, `rd20-dark-card-wire-freeze-350.png`));
      expect(
        frozen.wordOpacity < 0.1 && frozen.wireOpacity > 0.9,
        `dark: wire card drains to the outline plate`,
        `${frozen.wordOpacity}/${frozen.wireOpacity}`,
      );
      await finishBrand(page);
      await page.waitForTimeout(120);
    }
    await foldCard(page, 420);
  }
  await context.close();
}

// --- mobile pass (light) -----------------------------------------------------
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
  await page.screenshot({ path: join(evidenceDir, 'rd20-mobile-rest.png') });
  const brand = page.locator('#brandMenuButton');
  await brand.click();
  await page.waitForTimeout(650);
  const opened = await deckState(page);
  await page.screenshot({ path: join(evidenceDir, 'rd20-mobile-menu-open.png') });
  expect((await brand.getAttribute('aria-expanded')) === 'true', 'mobile: brand menu opens on tap');
  expect(opened.rightInset === 0, 'mobile: tap holds the band', opened.clip);
  await page.mouse.click(360, 500);
  await page.waitForTimeout(450);
  expect((await deckState(page)).rightInset === 100, 'mobile: outside tap deselects');
  await context.close();
}

// --- reduced motion: no cards, plain dim, instant state ----------------------
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
  const dimBefore = await brand.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  const rm = await deckState(page);
  await page.screenshot({ path: join(evidenceDir, 'rd20-reduced-motion-hover.png') });
  expect(rm.move === null, 'reduced motion: no card is dealt on hover', `data-move="${rm.move}"`);
  expect(
    rm.brandAnims.every((a) => !a.inStage),
    'reduced motion: nothing in the stage animates',
    JSON.stringify(rm.brandAnims),
  );
  expect(
    rm.overlayDisplays.every((d) => d === 'none'),
    'reduced motion: the overlay machinery displays none',
    rm.overlayDisplays.join('/'),
  );
  expect(
    parseFloat(dimBefore) === 1 && rm.linkOpacity < 1,
    'reduced motion: plain opacity dim on hover',
    `${dimBefore} -> ${rm.linkOpacity}`,
  );
  await brand.click();
  await page.waitForTimeout(250);
  expect(
    (await deckState(page)).rightInset === 0,
    'reduced motion: the band applies instantly as the state',
  );
  await page.mouse.click(AWAY.x, AWAY.y);
  await page.waitForTimeout(300);
  expect((await deckState(page)).rightInset === 100, 'reduced motion: leave deselects instantly');
  await context.close();
}

await browser.close();
server.kill();

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
writeFileSync(join(evidenceDir, 'rd20-story-assertions.txt'), log.join('\n') + '\n');
process.exit(failures === 0 ? 0 : 1);
