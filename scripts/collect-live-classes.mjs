#!/usr/bin/env node
/**
 * collect-live-classes.mjs — every class token that appears on ANY element
 * across the css-cascade-audit view matrix (same views, same viewport/scheme
 * mix, same waits). Output: JSON array of class tokens, sorted, on stdout.
 *
 * Ground truth for the bootstrap-subset prune: a bootstrap class token that
 * is never emitted by app code AND never observed live cannot reach the DOM
 * (note content is sanitized to a class-free subset — only the fixed
 * padify-math shell survives — so app code is the only source).
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.argv[2] ?? join(repo, 'dist');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const PORT = 4199;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', distDir], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

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
      await page.hover('#preferences');
      await page.waitForTimeout(500);
      await page.hover('#wordCount');
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'timer',
    action: async (page) => {
      await page.keyboard.press('Control+Shift+t');
      await page.waitForTimeout(700);
    },
  },
];

const live = new Set();
const browser = await chromium.launch();
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
      const classes = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          if (el.className && typeof el.className === 'string')
            out.push(...el.className.split(/\s+/));
        }
        return out.filter(Boolean);
      });
      for (const c of classes) live.add(c);
      await context.close();
    }
  }
}
await browser.close();
server.kill();

console.error(`observed ${live.size} distinct live class tokens`);
console.log(JSON.stringify([...live].sort(), null, 2));
