#!/usr/bin/env node
/**
 * css-cascade-audit.mjs — which rules actually MATCH live DOM, per sheet.
 *
 * Static audits answer "could this selector ever match something the app
 * emits?" from source text. This tool answers the ground-truth version:
 * load the built app in a real browser across a set of interactive views,
 * and record every stylesheet rule whose selector matches at least one
 * live element. Its Phase-1 job is the bootstrap decision: 89% of
 * bootstrap.min.css matches nothing; the matched set is what must survive
 * the un-shipping (folded into the design system), and the rest is
 * provably dead in every exercised state.
 *
 * Views intentionally mirror scripts/css-shot.mjs (same actions, same
 * viewport/scheme matrix) so results stay comparable across tools.
 *
 * Output: JSON on stdout —
 *   { sheets: { href: { matched: [ {line, selector} ... ],
 *                        unmatched: [ {line, selector} ... ] } } }
 * Selectors are comma-exploded: a rule group counts as matched only if
 * EVERY complex selector in it matched (a partial group would change
 * meaning if folded; the report shows per-complex granularity too).
 *
 * Usage: node scripts/css-cascade-audit.mjs [distDir]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.argv[2] ?? join(repo, 'dist');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const PORT = 4183;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', distDir], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

// Same action list as css-shot.mjs (kept in sync deliberately — the views
// define what "the app looks like" for every CSS tool in this repo).
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
  {
    name: 'shortcuts',
    action: async (page) => {
      await page.keyboard.press('Control+Shift+k');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'hover-navbar',
    action: async (page) => {
      // Tooltip + icon hover states: the app's own .tooltip markup is
      // focus/hover-triggered and otherwise never in the DOM.
      await page.hover('#preferences');
      await page.waitForTimeout(500);
      await page.hover('#wordCount');
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'timer',
    action: async (page) => {
      // The writing-session modal (its own .timer-* vocabulary).
      await page.keyboard.press('Control+Shift+t');
      await page.waitForTimeout(700);
    },
  },
];

/** In-page: every stylesheet rule, comma-exploded, with per-complex matches.
 *  Returns a serializable list; match resolution happens per element below. */
async function auditPage(page) {
  return page.evaluate(() => {
    /** CSS specificity as a comparable array [id, class, element]. */
    function specificity(sel) {
      const s = [0, 0, 0];
      const ids = sel.match(/#[\w-]+/g) ?? [];
      s[0] += ids.length;
      const noIds = sel.replace(/#[\w-]+/g, '');
      const classes = noIds.match(/\.[\w-]+/g) ?? [];
      s[1] += classes.length;
      const noClasses = noIds.replace(/\.[\w-]+/g, '');
      const elements = noClasses.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? [];
      s[2] += elements.filter((e) => !/^\s*$/.test(e)).length;
      s[1] += (sel.match(/\[[^\]]*\]/g) ?? []).length;
      s[1] += (sel.match(/:[a-zA-Z-]+(?![^(]*\))/g) ?? []).filter(
        (p) =>
          !/^::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop)/.test(
            p,
          ),
      ).length;
      return s.join(',');
    }

    const rules = [];
    const walkRules = (ruleList, mediaActive, sheetIndex, sheetHref) => {
      for (const rule of ruleList) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          const active = window.matchMedia(rule.conditionText ?? '').matches;
          walkRules(rule.cssRules, mediaActive && active, sheetIndex, sheetHref);
        } else if (rule.type === CSSRule.SUPPORTS_RULE) {
          walkRules(rule.cssRules, mediaActive, sheetIndex, sheetHref);
        } else if (rule.type === CSSRule.STYLE_RULE) {
          const parts = rule.selectorText.split(',').map((s) => s.trim());
          const matchedParts = new Array(parts.length).fill(false);
          const spec = parts.map((p) => specificity(p));
          rules.push({
            sheetHref,
            sheetIndex,
            ruleIndex: rules.length,
            parts,
            spec,
            matchedParts,
            mediaActive,
          });
        }
      }
    };
    for (let i = 0; i < document.styleSheets.length; i++) {
      const sheet = document.styleSheets[i];
      let rulesList;
      try {
        rulesList = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet without CORS — none here
      }
      walkRules(rulesList, true, i, sheet.href ?? '(inline)');
    }
    return rules;
  });
}

const browser = await chromium.launch();
const allRules = new Map(); // href -> Map(ruleKey -> {parts, matchedParts, ...})
for (const scheme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    for (const view of views) {
      if (mobile && !['boot', 'statistics', 'snapshots', 'preferences'].includes(view.name))
        continue;
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
      try {
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await view.action(page);
      } catch (e) {
        console.error(`(view ${scheme}-${mobile ? 'm-' : ''}${view.name} skipped: ${e.message})`);
      }
      const rules = await auditPage(page);
      // Mark matches against the CURRENT DOM.
      const matched = await page.evaluate((ruleData) => {
        const els = document.querySelectorAll('*');
        // Pseudo-element tokens Chrome won't accept in el.matches(): the
        // legacy single-colon spellings AND the double-colon ones.
        const stripPseudoElements = (sel) =>
          sel
            .replace(/::[a-zA-Z-]+(\([^)]*\))?/g, '')
            .replace(
              /(^|[\s,+>*]):(before|after|first-line|first-letter|selection|placeholder|marker|backdrop)/g,
              '$1',
            )
            .trim();
        for (const r of ruleData) {
          for (let p = 0; p < r.parts.length; p++) {
            if (r.matchedParts[p]) continue;
            const part = r.parts[p];
            const bare = stripPseudoElements(part);
            if (bare === '' || bare === '*') {
              // A pseudo-element with a universal (or empty) origin — e.g.
              // bootstrap's `:after,:before{box-sizing:border-box}` — applies
              // to EVERY element's pseudo. matches() cannot express it, and
              // treating it as "never matches" silently dropped it in the
              // first fold (every ::before flipped to content-box).
              r.matchedParts[p] = true;
              continue;
            }
            for (const el of els) {
              try {
                if (el.matches(bare)) {
                  r.matchedParts[p] = true;
                  break;
                }
              } catch {
                break; // invalid selector fragment — never matches
              }
            }
          }
        }
        return ruleData;
      }, rules);
      for (const r of matched) {
        if (!r.mediaActive) continue;
        if (!allRules.has(r.sheetHref)) allRules.set(r.sheetHref, new Map());
        const key = r.parts.join(' | ');
        const prev = allRules.get(r.sheetHref).get(key) ?? {
          matchedParts: new Array(r.parts.length).fill(false),
        };
        for (let p = 0; p < r.parts.length; p++) {
          if (r.matchedParts[p]) prev.matchedParts[p] = true;
        }
        allRules.get(r.sheetHref).set(key, prev);
      }
      await context.close();
    }
  }
}
await browser.close();
server.kill();

const out = { sheets: {} };
for (const [href, rules] of [...allRules.entries()].sort()) {
  const short = href.replace(/^.*:\/\/[^/]+/, '').replace(/^\/css\//, '');
  const fully = [];
  const partially = [];
  const never = [];
  for (const [key, { matchedParts }] of rules) {
    const parts = key.split(' | ');
    const entry = { selector: key };
    if (matchedParts.every(Boolean)) fully.push(entry);
    else if (matchedParts.some(Boolean)) partially.push(entry);
    else never.push(entry);
  }
  out.sheets[short] = { fully, partially, never };
  console.log(
    `${short.padEnd(34)} fully ${String(fully.length).padStart(4)}  partial ${String(partially.length).padStart(3)}  never ${String(never.length).padStart(4)}`,
  );
}

const outPath = join(mkdtempSync(join(tmpdir(), 'cascade-')), 'audit.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nfull report: ${outPath}`);
