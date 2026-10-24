import { expect, test, type Page } from '@playwright/test';

/**
 * Padify smoke suite — the flows a human checks by hand after touching
 * anything. Runs against the Vite dev server (see playwright.config.ts).
 *
 * The app has had a zero-console-error bar all along; every test below
 * collects uncaught page errors and fails if any were thrown, so refactors
 * (editor revamp included) can't silently regress that.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

test.describe('editor core', () => {
  test('boots with the welcome note — no counter pill, the stats entry stays', async ({ page }) => {
    await page.goto('/');

    const editor = page.locator('#note');
    await expect(editor).toContainText('Welcome! Padify is an offline-capable notepad');

    // The character/word counter pill is retired: no #wordCount text, and
    // the bottom line's capsule is only the statistics icon (no counter).
    await expect(page.locator('#wordCount')).toHaveCount(0);
    await expect(page.locator('.bottom-line .word-count-container')).toBeVisible();
    await expect(page.locator('.bottom-line .word-count-container')).not.toContainText(
      /characters? •/,
    );
  });

  test('typing survives a reload (IndexedDB autosave)', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await expect(editor).toBeVisible();

    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' persistence probe');

    // Debounced autosave is 400ms — give it room, then reload.
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.locator('#note')).toContainText('persistence probe');
  });

  test('add tab empties the editor; switching back restores the first note', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await expect(editor).toContainText('Welcome!');

    await page.locator('#addTab').click();
    await expect(editor).toHaveText('');

    // Back to the first tab through the strip.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(editor).toContainText('Welcome!');
  });
});

test.describe('navbar & chrome', () => {
  test('the fixed navbar stays a single row on desktop', async ({ page }) => {
    await page.goto('/');
    const box = await page.locator('nav.navbar').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, 'navbar height at 1280px').toBeLessThanOrEqual(60);
  });

  test('the fixed navbar stays a single row on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const box = await page.locator('nav.navbar').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, 'navbar height at 390px').toBeLessThanOrEqual(60);
  });

  test('brand menu opens and its items launch the shortcuts modal', async ({ page }) => {
    await page.goto('/');
    await page.locator('#brandMenuButton').click();
    await expect(page.locator('#brandMenu')).toHaveClass(/show/);

    await page.locator('#brandMenu .brand-menu-item', { hasText: 'Keyboard shortcuts' }).click();
    await expect(page.locator('#keyboardShortcutsModal')).toHaveClass(/in/);
  });
});

test.describe('modals', () => {
  test('statistics modal opens with real numbers', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[data-target="#statisticsModal"]').click();
    const modal = page.locator('#statisticsModal');
    await expect(modal).toHaveClass(/in/);
    await expect(modal).toContainText(/word/i);
  });

  test('preferences dark toggle flips the theme and sticks across reload', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+,');
    const modal = page.locator('#preferencesModal');
    await expect(modal).toHaveClass(/in/);

    await modal.locator('label', { hasText: 'Dark' }).first().click();
    await expect(page.locator('body')).toHaveClass(/dark/);

    // The kv layer mirrors to localStorage synchronously but coalesces the
    // IndexedDB write on a 150ms timer; give it room so the reload can't
    // abort the flush mid-transaction.
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/dark/);
  });
});
