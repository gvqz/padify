import { expect, test, type Page } from '@playwright/test';

/**
 * Tables: the grid picker insert, Tab cell navigation, the caret-aware
 * structure menu, and the storage round trip. The stored subset is
 * table > tbody > tr > td — borders live in the chrome, so the assertions
 * watch markup and the chrome renders it.
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

test.describe('tables', () => {
  test('grid insert, Tab navigation and reload persistence', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.locator('[data-rich-menu="table"]').click();
    // Cell (1,2) means a 2x3 table.
    await page.locator('[data-rich-grid="1,2"]').click();
    await expect(editor.locator('table td')).toHaveCount(6);

    // The caret starts in the first cell; Tab walks cells and wraps rows.
    await page.keyboard.type('a1');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b1');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('a2');
    const cells = editor.locator('table tr:nth-child(1) td');
    await expect(cells).toHaveText(['a1', 'b1', '']);
    await expect(editor.locator('table tr:nth-child(2) td').first()).toHaveText('a2');

    await page.waitForTimeout(900); // autosave debounce (400ms) settles
    await page.reload();
    await expect(page.locator('#note table td')).toHaveCount(6);
    await expect(page.locator('#note table tr').first().locator('td')).toHaveText(['a1', 'b1', '']);
  });

  test('the structure menu inserts and deletes rows and columns', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const table = editor.locator('table');
    const opsButton = page.locator('#richTableMenuHost [data-rich-menu="table-ops"]');

    await editor.click();
    await page.locator('[data-rich-menu="table"]').click();
    await page.locator('[data-rich-grid="1,1"]').click(); // 2x2
    await expect(table.locator('td')).toHaveCount(4);

    // The ops menu appears only while the caret is inside a table.
    await expect(opsButton).toBeVisible();

    await table.locator('tr').first().locator('td').first().click();
    await page.locator('[data-rich-menu="table-ops"]').click();
    await page.locator('[data-rich-table="col-right"]').click();
    await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
    await expect(table.locator('tr').nth(1).locator('td')).toHaveCount(3);

    await page.locator('[data-rich-menu="table-ops"]').click();
    await page.locator('[data-rich-table="row-below"]').click();
    await expect(table.locator('tr')).toHaveCount(3);

    await page.locator('[data-rich-menu="table-ops"]').click();
    await page.locator('[data-rich-table="table-delete"]').click();
    await expect(table).toHaveCount(0);
    await expect(opsButton).toBeHidden();
  });
});
