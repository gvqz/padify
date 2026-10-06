/**
 * The document title's PWA contract.
 *
 * The manifest declares `display_override: ["minimal-ui"]`, and override
 * beats `display` — an installed Edge/Chromium window therefore reports
 * minimal-ui, NOT standalone. Matching standalone alone answered
 * "browser" for an installed app, so the title grew a " - Padify" tail
 * the installed window's own chrome doubled (Edge already carries the
 * app name in front): the user saw "Padify - What the - Padify". An
 * installed app gets the BARE note name; a browser tab keeps the suffix.
 *
 * The stub patches window.matchMedia before boot so the page's own
 * detection reads minimal-ui, exactly as Edge reports it.
 */
import { expect, test } from '@playwright/test';

test.describe('the document title', () => {
  test('a browser tab carries the " - Padify" suffix', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tabStripTabs .tab-strip-tab').first().waitFor();
    await expect.poll(() => page.title()).toMatch(/ - Padify$/);
  });

  test('an installed app (minimal-ui) gets the bare note name', async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) => {
        const mql = original(query);
        if (query.includes('display-mode') && query.includes('minimal-ui')) {
          Object.defineProperty(mql, 'matches', { value: true });
        }
        return mql;
      }) as typeof window.matchMedia;
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#tabStripTabs .tab-strip-tab').first().waitFor();
    await expect.poll(() => page.title()).not.toMatch(/ - Padify$/);
    await context.close();
  });
});
