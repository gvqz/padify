#!/usr/bin/env node
/**
 * css-computed-diff.mjs — prove two builds render identically, element by
 * element, property by property.
 *
 * The pixel diff (css-shot.mjs + img-diff.py) proves "looks the same"; this
 * tool proves "IS the same" at the computed-style level and pinpoints the
 * exact element + property when it isn't — a one-pixel antialiasing doubt
 * becomes a diagnosable declaration.
 *
 * Method: serve distA and distB on two ports, drive the SAME view script in
 * both (fresh context each, so storage starts empty and identical), then
 * walk document.querySelectorAll('*') in lockstep — the DOM trees are built
 * by identical JS, so index i is the same node on both sides. For every
 * element compare:
 *   - getComputedStyle() over every supported property
 *   - ::before / ::after computed styles (content included)
 *   - getBoundingClientRect() (layout consequences)
 * Differences are printed with a DOM path for reproduction.
 *
 * Determinism guards: reduced motion on, service workers blocked, fixed
 * waits, animations force-finished before capture.
 *
 * Usage: node scripts/css-computed-diff.mjs <distA> <distB>
 * Exit 1 on any difference, 0 on identical renders.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const [distA, distB] = process.argv.slice(2);
if (!distA || !distB) {
  console.error('usage: node scripts/css-computed-diff.mjs <distA> <distB>');
  process.exit(2);
}

const PORT_A = 4191;
const PORT_B = 4192;

// Pre-flight: a zombie server from a crashed earlier run would silently
// serve STALE content and the comparison becomes A-vs-A (this exact trap
// invalidated the first fold verification — both "sides" showed the same
// folded build and reported zero diffs while the navbar was broken).
for (const port of [PORT_A, PORT_B]) {
  try {
    await fetch(`http://localhost:${port}/`);
    console.error(`REFUSED: port ${port} already answers — a stale server holds it.`);
    console.error('Kill it first (pkill -f "http.server 419") and re-run.');
    process.exit(2);
  } catch {
    /* port free — proceed */
  }
}

const servers = [
  spawn('python3', ['-m', 'http.server', String(PORT_A), '--directory', resolve(distA)], {
    stdio: 'ignore',
  }),
  spawn('python3', ['-m', 'http.server', String(PORT_B), '--directory', resolve(distB)], {
    stdio: 'ignore',
  }),
];
await new Promise((r) => setTimeout(r, 800));

// The same action list as css-shot.mjs — the shared definition of "what the
// app looks like" across this repo's CSS tooling.
const views = [
  { name: 'boot', action: async (page) => page.waitForTimeout(700) },
  {
    name: 'statistics',
    action: async (page) => {
      await page.click('#wordCount');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'preferences',
    action: async (page) => {
      await page.click('#preferences');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'snapshots',
    action: async (page) => {
      await page.click('#snapshotsButton');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'cloud',
    action: async (page) => {
      await page.click('#cloudNavButton');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'unicode',
    action: async (page) => {
      await page.keyboard.press('Control+Shift+o');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'context-menu',
    action: async (page) => {
      await page.click('#note', { position: { x: 300, y: 200 } });
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+a');
      await page.click('#note', { button: 'right', position: { x: 300, y: 200 } });
      await page.waitForTimeout(400);
    },
  },
];

/** Serialize every element COMPACTLY: path, rect, and djb2 hashes of the
 *  own/::before/::after computed styles. Full property dumps are fetched
 *  only for elements whose hashes disagree — shipping every property of
 *  every element crashes the page (learned the hard way). */
async function snapshot(page) {
  return page.evaluate(() => {
    // Freeze animations at their end state so timing never leaks into the
    // comparison (reduced-motion already blanks most of them).
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        /* infinite animations cannot finish — pause them instead */
        a.pause();
      }
    }
    const own = getComputedStyle(document.documentElement);
    const props = [];
    for (let i = 0; i < own.length; i++) props.push(own.item(i));
    // Custom properties enumerate in a randomized per-context order (found
    // by the A-vs-A self-test: index 480 differed with identical sets) —
    // sort so the hash input is deterministic.
    props.sort();

    const describe = (el) => {
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1) {
        let part = n.tagName.toLowerCase();
        if (n.id) part += `#${n.id}`;
        if (n.classList.length) part += '.' + [...n.classList].slice(0, 3).join('.');
        parts.unshift(part);
        n = n.parentElement;
      }
      return parts.join('>');
    };

    const hash = (s) => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    };

    const styleString = (el, pseudo) => {
      const cs = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
      let out = '';
      for (const p of props) out += p + ':' + cs.getPropertyValue(p) + ';';
      return out;
    };

    const out = [];
    // HEAD elements (link/meta/script/title) are not rendered — and the
    // fold intentionally changes how many <link> tags exist. Compare the
    // rendered tree only.
    const inHead = (el) => !!el.closest('head');
    for (const el of document.querySelectorAll('*')) {
      if (inHead(el)) continue;
      const r = el.getBoundingClientRect();
      out.push({
        path: describe(el),
        rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10),
        h: {
          style: hash(styleString(el)),
          before: hash(styleString(el, '::before')),
          after: hash(styleString(el, '::after')),
        },
      });
    }
    return out;
  });
}

/** Full property dump for specific element indices (diagnosis pass). */
async function detail(page, indices) {
  return page.evaluate((idxList) => {
    const own = getComputedStyle(document.documentElement);
    const props = [];
    for (let i = 0; i < own.length; i++) props.push(own.item(i));
    props.sort(); // randomized custom-property order — see snapshot()
    // Same skip as snapshot() — indices must stay aligned.
    const els = [...document.querySelectorAll('*')].filter((el) => !el.closest('head'));
    const grab = (el, pseudo) => {
      const cs = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
      const style = {};
      for (const p of props) style[p] = cs.getPropertyValue(p);
      return style;
    };
    return idxList.map((i) => {
      const el = els[i];
      return { i, style: grab(el), before: grab(el, '::before'), after: grab(el, '::after') };
    });
  }, indices);
}

const browser = await chromium.launch();
let diffs = 0;
const seenViews = [];
// Optional view filter for resuming long runs: VIEWS=dark-unicode,dark-m-boot
const only = process.env.VIEWS ? new Set(process.env.VIEWS.split(',')) : null;

for (const scheme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    for (const view of views) {
      if (mobile && !['boot', 'statistics', 'snapshots', 'preferences'].includes(view.name))
        continue;
      const tag = `${scheme}-${mobile ? 'm-' : ''}${view.name}`;
      if (only && !only.has(tag)) continue;
      seenViews.push(tag);
      console.log(`view ${tag}: running...`);

      const run = async (port, detailIndices) => {
        const context = await browser.newContext({
          viewport: mobile ? { width: 375, height: 667 } : { width: 1440, height: 900 },
          colorScheme: scheme,
          reducedMotion: 'reduce',
          deviceScaleFactor: 1,
          isMobile: mobile,
          hasTouch: mobile,
          serviceWorkers: 'block',
        });
        const page = await context.newPage();
        await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        try {
          await view.action(page);
        } catch (e) {
          console.log(`(${tag}: action unavailable — boot state compared)`);
        }
        const snap = detailIndices ? await detail(page, detailIndices) : await snapshot(page);
        await context.close();
        return snap;
      };

      const a = await run(PORT_A);
      const b = await run(PORT_B);
      console.log(`view ${tag}: snapshot A=${a.length} B=${b.length}, diagnosing...`);
      if (a.length !== b.length) {
        diffs++;
        console.log(`DIFF [${tag}] element count: A=${a.length} B=${b.length}`);
        continue;
      }
      // Indices that need the full-property diagnosis pass.
      const suspects = [];
      for (let i = 0; i < a.length; i++) {
        const ea = a[i];
        const eb = b[i];
        if (ea.path !== eb.path) {
          diffs++;
          console.log(`DIFF [${tag}] element ${i} path: A=${ea.path} B=${eb.path}`);
          continue;
        }
        if (
          ea.h.style !== eb.h.style ||
          ea.h.before !== eb.h.before ||
          ea.h.after !== eb.h.after ||
          JSON.stringify(ea.rect) !== JSON.stringify(eb.rect)
        ) {
          suspects.push(i);
          if (suspects.length <= 10 && process.env.DIFF_DEBUG) {
            console.log(
              `  suspect ${i} ${ea.path}: style ${ea.h.style === eb.h.style ? '=' : 'X'} before ${ea.h.before === eb.h.before ? '=' : 'X'} after ${ea.h.after === eb.h.after ? '=' : 'X'} rect ${JSON.stringify(ea.rect) === JSON.stringify(eb.rect) ? '=' : `${JSON.stringify(ea.rect)} vs ${JSON.stringify(eb.rect)}`}`,
            );
          }
        }
      }
      if (suspects.length) {
        // Re-run the view on both sides and pull full styles for the
        // suspects — deterministic DOMs make the indices stable. Batched:
        // one giant evaluate crashes the page (3 pseudo dumps per element).
        const BATCH = 40;
        const mapA = new Map();
        const mapB = new Map();
        for (let s = 0; s < suspects.length; s += BATCH) {
          const batch = suspects.slice(s, s + BATCH);
          const da = await run(PORT_A, batch);
          const db = await run(PORT_B, batch);
          for (const d of da) mapA.set(d.i, d);
          for (const d of db) mapB.set(d.i, d);
        }
        for (const i of suspects) {
          const ea = a[i];
          const sa = mapA.get(i);
          const sb = mapB.get(i);
          for (const pseudo of ['style', 'before', 'after']) {
            const pa = sa[pseudo];
            const pb = sb[pseudo];
            const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
            for (const k of keys) {
              if (pa[k] !== pb[k]) {
                diffs++;
                if (diffs <= 200) {
                  console.log(
                    `DIFF [${tag}] ${ea.path}${pseudo === 'style' ? '' : `::${pseudo}`} { ${k} }: A=${JSON.stringify(pa[k])} B=${JSON.stringify(sb[pseudo][k])}`,
                  );
                }
              }
            }
          }
          if (JSON.stringify(ea.rect) !== JSON.stringify(b[i].rect)) {
            diffs++;
            if (diffs <= 200)
              console.log(`DIFF [${tag}] ${ea.path} rect: A=${ea.rect} B=${b[i].rect}`);
          }
        }
      }
      console.log(`compared ${tag}: ${a.length} elements`);
    }
  }
}
await browser.close();
for (const s of servers) s.kill();

console.log(`\nviews: ${seenViews.length}, elements compared per view, total diffs: ${diffs}`);
if (diffs > 0) {
  console.log('FAILED — the builds do not render identically.');
  process.exit(1);
}
console.log('OK — every element, every computed property, every rect is identical.');
