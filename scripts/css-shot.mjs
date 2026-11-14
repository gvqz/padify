#!/usr/bin/env node
/**
 * css-shot.mjs — deterministic view screenshots for pixel-diffing CSS changes.
 * Usage: node css-shot.mjs <outDir>
 * Serves dist/ on :4173 and captures 7 views x light/dark with reduced motion.
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
)('@playwright/test');
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? '/tmp/css-shots/run';
mkdirSync(outDir, { recursive: true });

// Serve dist/ on a fixed port — after proving no zombie holds it (a stale
// server would shoot the OLD build and "prove" nothing).
try {
  await fetch('http://localhost:4173/');
  console.error('REFUSED: port 4173 already answers — kill the stale server first.');
  process.exit(2);
} catch {
  /* port free */
}
const server = spawn('python3', ['-m', 'http.server', '4173', '--directory', join(repo, 'dist')], {
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
];

const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  for (const view of views) {
    // Fresh page per view so state never leaks between captures.
    await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await view.action(page);
    await page.screenshot({ path: join(outDir, `${scheme}-${view.name}.png`) });
    console.log(`shot ${scheme}-${view.name}`);
  }
  await context.close();
}

// Mobile pass — the @media-nested rules desktop shots cannot see.
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    colorScheme: scheme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  for (const view of views.filter((v) =>
    ['boot', 'statistics', 'snapshots', 'preferences'].includes(v.name),
  )) {
    await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    try {
      await view.action(page);
    } catch (e) {
      console.log(
        `(m-${scheme}-${view.name}: action not available on mobile — boot view captured)`,
      );
    }
    await page.screenshot({ path: join(outDir, `m-${scheme}-${view.name}.png`) });
    console.log(`shot m-${scheme}-${view.name}`);
  }
  await context.close();
}
await browser.close();
server.kill();
