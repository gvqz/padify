import { expect, test, type Page } from '@playwright/test';

/**
 * The context menu speaks the active note's vocabulary: the format row
 * (Bold/Italic/Underline/Strikethrough) and clear formatting serve EVERY
 * html note — the classic/plain note is the same contenteditable surface
 * the rich note is. The toolbar-bubble rows (insert link, insert
 * equation) belong to the kinds that own those bubbles — rich and
 * markdown notes. This pins the split both ways.
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
  test('a plain note keeps the format row, hides the bubble rows', async ({ page }) => {
    await page.goto('/');
    // The fresh boot opens a standard note.
    await openContextMenu(page);

    const menu = page.locator('#padifyCtxMenu');
    // The toolbar-bubble rows: gone (no Docs toolbar on a plain note,
    // no equation/link popover to open).
    await expect(menu.locator('[data-action="insert-equation"]')).toBeHidden();
    await expect(menu.locator('[data-action="insert-link"]')).toBeHidden();
    await expect(menu.locator('[data-action="remove-link"]')).toBeHidden();
    // The markdown format group has no business on a plain note.
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-md')).toBeHidden();
    // The B/I/U/S row is the classic note's formatting affordance: the
    // same contenteditable surface, the same EditorPort commands.
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeVisible();
    await expect(menu.locator('.padify-ctx-sep.padify-ctx-rich')).toBeVisible();
    await expect(menu.locator('[data-action="clear-formatting"]')).toBeVisible();
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
    // The rich format row specifically — the markdown one rides the same
    // class with its own modifier (hidden on rich notes).
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeVisible();
    await expect(menu.locator('.padify-ctx-sep.padify-ctx-rich')).toBeVisible();
  });

  test('switching to a plain note after a rich one swaps back the bubble rows', async ({
    page,
  }) => {
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
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeVisible();
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

test.describe('the plain note format row actually formats', () => {
  test('Bold from the format row bolds the selection in a standard note', async ({ page }) => {
    await page.goto('/');
    // A FRESH plain note (the boot note carries the welcome text).
    await page.locator('#addTab').click();

    const note = page.locator('#note');
    await note.click();
    await page.keyboard.type('classic note text');

    // The caret sits at the line's end — Shift+Home takes the whole line.
    await page.keyboard.press('Shift+Home');
    await openContextMenu(page);
    await page
      .locator('#padifyCtxMenu .padify-ctx-rich .padify-ctx-fmt[data-format="bold"]')
      .click();

    // The port's canonical bold spelling is <b> (its format family admits
    // b and strong both — see ModelPort.FORMAT_MARKS).
    await expect(note.locator('b')).toHaveText('classic note text');
    await expect(page.locator('#toast')).toContainText('Bold on.');
  });
});
