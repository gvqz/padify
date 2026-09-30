import { expect, test, type Page } from '@playwright/test';

/**
 * The context menu speaks the active note's vocabulary: the rich-only rows
 * (format row, clear formatting, insert link, insert equation) belong to
 * rich text notes alone. On a plain note they would either be stripped at
 * save or produce content the note cannot hold — the menu shrinks to what
 * a plain note can honestly do. This pins the split both ways.
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

async function openContextMenu(page: Page): Promise<void> {
  await page.locator('#note').click({ button: 'right' });
  await expect(page.locator('#padifyCtxMenu')).toBeVisible();
}

test.describe('context menu follows the note type', () => {
  test('a plain note hides the rich-only rows entirely', async ({ page }) => {
    await page.goto('/');
    // The fresh boot opens a standard note.
    await openContextMenu(page);

    const menu = page.locator('#padifyCtxMenu');
    // Rich-only rows: gone.
    await expect(menu.locator('[data-action="insert-equation"]')).toBeHidden();
    await expect(menu.locator('[data-action="clear-formatting"]')).toBeHidden();
    await expect(menu.locator('[data-action="insert-link"]')).toBeHidden();
    await expect(menu.locator('[data-action="remove-link"]')).toBeHidden();
    await expect(menu.locator('.padify-ctx-formats')).toBeHidden();
    // The separator leading the rich group hides with it — no doubled rule.
    await expect(menu.locator('.padify-ctx-sep.padify-ctx-rich')).toBeHidden();
    // What a plain note can honestly do: still there.
    await expect(menu.locator('[data-action="select-all"]')).toBeVisible();
    await expect(menu.locator('[data-action="undo"]')).toBeVisible();
    await expect(menu.locator('.padify-ctx-parent')).toBeVisible(); // case converter
  });

  test('a rich note keeps the full menu, equations included', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();

    await openContextMenu(page);
    const menu = page.locator('#padifyCtxMenu');
    await expect(menu.locator('[data-action="insert-equation"]')).toBeVisible();
    await expect(menu.locator('[data-action="clear-formatting"]')).toBeVisible();
    await expect(menu.locator('[data-action="insert-link"]')).toBeVisible();
    await expect(menu.locator('.padify-ctx-formats')).toBeVisible();
    await expect(menu.locator('.padify-ctx-sep.padify-ctx-rich')).toBeVisible();
  });

  test('switching to a plain note after a rich one shrinks the menu again', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();

    // Back to the boot note (standard).
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await openContextMenu(page);

    const menu = page.locator('#padifyCtxMenu');
    await expect(menu.locator('[data-action="insert-equation"]')).toBeHidden();
    await expect(menu.locator('[data-action="select-all"]')).toBeVisible();
  });

  test('keyboard navigation skips the hidden rows on a plain note', async ({ page }) => {
    await page.goto('/');
    await openContextMenu(page);
    // Opening focuses the first visible row; walking down must never land
    // inside the hidden format row or on the hidden rich-only actions.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('ArrowDown');
      const focusedIsVisible = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return !!active && active.closest('[hidden]') === null && active.offsetParent !== null;
      });
      expect(focusedIsVisible, 'focus stays on visible rows').toBe(true);
    }
  });
});
