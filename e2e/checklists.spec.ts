import { expect, test, type Page } from '@playwright/test';

/**
 * Checklists: the toolbar button, the Docs shortcut, gutter-click toggles
 * and the storage round trip. The boxes are CSS paint over
 * data-rich-checklist/data-checked — the assertions watch the attributes,
 * because those are what storage, sync and the share page see.
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

async function createRichNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
}

/** Clicks the CSS-painted checkbox gutter of the given item (0-based). */
async function clickCheckbox(page: Page, index: number): Promise<void> {
  const box = page.locator('#note ul[data-rich-checklist] > li').nth(index);
  const rect = await box.boundingBox();
  await page.mouse.click(rect!.x + 8, rect!.y + rect!.height / 2);
}

test.describe('checklists', () => {
  test('toolbar toggle, gutter check, Enter behavior and reload persistence', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    const checklistButton = toolbar.locator('[data-rich-list="checklist"]');

    await editor.click();
    await page.keyboard.type('milk');
    await checklistButton.click();
    await expect(editor.locator('ul[data-rich-checklist]')).toHaveCount(1);
    await expect(checklistButton).toHaveAttribute('aria-pressed', 'true');

    // The caret survived the engine's rewrite (Chrome resets list carets to
    // the item start): typing must continue the item, not prepend to it.
    await page.keyboard.type(' and bread');
    await expect(editor.locator('li').first()).toHaveText('milk and bread');

    // Enter starts the next item, unchecked.
    await page.keyboard.press('Enter');
    await page.keyboard.type('eggs');
    await clickCheckbox(page, 1);
    await expect(editor.locator('li').nth(1)).toHaveAttribute('data-checked', 'true');
    await expect(editor.locator('li').first()).toHaveAttribute('data-checked', 'false');

    // The plain-text twin (titles/previews/exports) carries the state.
    await page.waitForTimeout(900); // autosave debounce (400ms) settles before reload
    await page.reload();
    await expect(editor.locator('ul[data-rich-checklist] > li')).toHaveCount(2);
    await expect(editor.locator('li').nth(1)).toHaveAttribute('data-checked', 'true');
    await expect(editor.locator('li').first()).toHaveAttribute('data-checked', 'false');
  });

  test('the Docs shortcut Ctrl+Shift+9 makes a checklist; bullet converts instead of erasing', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('step one');
    await page.keyboard.press('Control+Shift+Digit9');
    await expect(editor.locator('ul[data-rich-checklist]')).toHaveCount(1);

    // Ctrl+Shift+7 on a checklist converts to bullets — the list survives
    // (Docs semantics), only the boxes go.
    await page.keyboard.press('Control+Shift+Digit7');
    await expect(editor.locator('ul[data-rich-checklist]')).toHaveCount(0);
    await expect(editor.locator('ul > li')).toHaveCount(1);
    await expect(editor.locator('ul > li')).toHaveText('step one');

    // The numbered cluster answers too.
    await page.keyboard.press('Control+Shift+Digit8');
    await expect(editor.locator('ol > li')).toHaveCount(1);
  });

  test('a standard note never shows the checklist button (the gate holds)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addTab').click();
    await expect(page.locator('#richToolbar')).toBeHidden();
  });
});
