import { defineConfig, devices } from '@playwright/test';

/**
 * Padify smoke suite.
 *
 * Runs the app in a real Chromium against the Vite dev server and asserts
 * the flows a human would check by hand: editor + autosave, tabs, modals,
 * theming, and the fixed-navbar layout. These are the guardrails the editor
 * revamp will run against — if one of these fails, stop and investigate.
 *
 * Kept deliberately small and deterministic: no network-dependent features
 * (music search, cloud sync), no sound assertions.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
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
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
