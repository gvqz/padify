import { expect, test, type Page } from '@playwright/test';

/**
 * Platform-aware shortcut labels — the app must show the modifier key the
 * USER's device actually has (Ctrl vs ⌘), never the "Ctrl/Cmd" hedge.
 *
 * The suite runs twice conceptually: as the runner's native platform
 * (Linux CI = Ctrl) and as an emulated Apple device, flipped by a Mac user
 * agent — the detection reads platform + UA (see src/lib/platform.ts).
 */

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

async function openShortcutsModal(page: Page): Promise<void> {
  await page.locator('#brandMenuButton').click();
  await page.locator('#brandMenu .brand-menu-item', { hasText: 'Keyboard shortcuts' }).click();
  await expect(page.locator('#keyboardShortcutsModal')).toHaveClass(/in/);
}

test.describe('on the native (non-Apple) platform', () => {
  test('the shortcuts reference shows Ctrl, never the Cmd hedge', async ({ page }) => {
    await page.goto('/');
    await openShortcutsModal(page);

    const modal = page.locator('#keyboardShortcutsModal');
    // The save row renders the single platform key…
    await expect(modal.locator('.shortcut-row', { hasText: 'Save as plain text' })).toContainText(
      'Ctrl + S',
    );
    // …and no hedge glyph appears anywhere in the reference.
    await expect(modal.locator('.shortcut-keys', { hasText: '⌘' })).toHaveCount(0);
    await expect(modal.locator('.shortcut-keys', { hasText: 'Ctrl /' })).toHaveCount(0);
  });

  test('the brand menu hint and toolbar tooltips spell Ctrl', async ({ page }) => {
    await page.goto('/');

    await page.locator('#brandMenuButton').click();
    const menu = page.locator('#brandMenu');
    await expect(menu).toHaveClass(/show/);
    await expect(menu.locator('.brand-menu-kbd')).toHaveText('Ctrl + K');

    // The unicode picker tooltip (data-shortcut-title hydration).
    const unicodeTitle = await page.locator('li.unicode-icon').getAttribute('title');
    expect(unicodeTitle).toBe('Insert Unicode Symbol [Ctrl + Shift + O]');
  });
});

test.describe('on an emulated Apple device', () => {
  test.use({ userAgent: MAC_UA });

  test('the shortcuts reference shows ⌘ instead of Ctrl', async ({ page }) => {
    await page.goto('/');
    await openShortcutsModal(page);

    const modal = page.locator('#keyboardShortcutsModal');
    await expect(modal.locator('.shortcut-row', { hasText: 'Save as plain text' })).toContainText(
      '⌘ + S',
    );
    // The word form must be gone — the hedge was the whole complaint. (The
    // no-results hint below the grid also says "Ctrl", so scope to rows.)
    await expect(modal.locator('.shortcut-keys', { hasText: 'Ctrl' })).toHaveCount(0);
    // Alt pairs flip too.
    await expect(
      modal.locator('.shortcut-row', { hasText: 'Voice typing' }).locator('.shortcut-keys'),
    ).toHaveText('⌥ + V');
  });

  test('the brand menu hint and toolbar tooltips spell ⌘', async ({ page }) => {
    await page.goto('/');

    await page.locator('#brandMenuButton').click();
    const menu = page.locator('#brandMenu');
    await expect(menu).toHaveClass(/show/);
    await expect(menu.locator('.brand-menu-kbd')).toHaveText('⌘ + K');

    const unicodeTitle = await page.locator('li.unicode-icon').getAttribute('title');
    expect(unicodeTitle).toBe('Insert Unicode Symbol [⌘ + ⇧ + O]');
  });
});
