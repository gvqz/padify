import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Padify e2e suite.
 *
 * Runs the app in a real Chromium against the Vite dev server and asserts
 * the flows a human would check by hand: editor + autosave, tabs, modals,
 * theming, the typed content model, and the cloud round trip.
 *
 * TWO servers run for every suite:
 *
 *  • the Vite dev server on :5199 (the app), whose /api proxy points at
 *    the API on :3041 exactly like production's same-origin routing;
 *  • the real API (server/) on :3041, against a throwaway SQLite file in
 *    a per-run temp directory, wiped when the run ends. The API used to
 *    be "deliberately out of scope" for e2e — which meant every /api path
 *    in every spec exercised the offline-degradation branch and nothing
 *    ever tested the server the way a browser actually drives it. The
 *    cloud-api spec signs up, pushes, and pulls through it; the other
 *    specs keep passing unchanged because the app is local-first and
 *    never asks the network for anything until a user signs in.
 */

/** Per-run scratch dir: the API's database lives (and dies) here. */
const runDir = mkdtempSync(join(tmpdir(), 'padify-e2e-'));
export const apiDbPath = join(runDir, 'api.db');

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx vite --port 5199 --strictPort',
      url: 'http://localhost:5199',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // The health endpoint answers 200 — readiness probes only accept
      // success statuses, and the router 404s unknown paths by design.
      command: 'bun server/index.ts',
      url: 'http://localhost:3041/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        // A throwaway local database for this run only — never the
        // developer's server/local.db, never Turso.
        TURSO_DATABASE_URL: `file:${apiDbPath}`,
        PORT: '3041',
        // The suite drives the whole app through one localhost address with
        // many parallel workers — the production per-address buckets
        // (30 sign-ins/min, 300 api/min) 429'd whichever spec crossed the
        // line that minute, flaking the run. Scaled up for tests only;
        // production keeps the reviewed limits (env unset → scale 1).
        RATE_LIMIT_SCALE: '1000',
      },
    },
  ],
});

/** Playwright calls this when the run ends (config export above is how it finds us). */
export async function globalTeardown(): Promise<void> {
  rmSync(runDir, { recursive: true, force: true });
}
