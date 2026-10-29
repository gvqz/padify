import { expect, test, type Page } from '@playwright/test';

/**
 * The note rail's right-click menu, end to end.
 *
 * The contracts live here:
 *
 *  1. Right-clicking a note opens the custom menu (and not the
 *     browser's) with the full action set; Escape and outside clicks
 *     close it; right-clicking empty space opens nothing custom.
 *
 *  2. Rename walks the rail's own inline rename input.
 *
 *  3. Duplicate clones the note under a "Copy of …" name right after
 *     the source, opens the copy, and the copy is NOT a conflicted-copy
 *     badge case — it is a deliberate duplicate.
 *
 *  4. Change type flips the note's kind from the submenu and the editor
 *     chrome follows (the markdown toolbar arrives).
 *
 *  5. Copy note text lands the note's text on the clipboard.
 *
 *  6. Close tab goes through the same guarded flow as the rail's ×:
 *     a note with content asks first.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'no uncaught page errors').toEqual([]);
});

const MENU = '#noteCtxMenu';

async function openMenu(page: import('@playwright/test').Page, nth = 0): Promise<void> {
  await page.locator('.tab-strip-tab').nth(nth).click({ button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
}

test('right-click opens the note menu; Escape, outside click and empty space behave', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.tab-strip-tab')).toHaveCount(1);

  await openMenu(page);
  await expect(page.locator(MENU)).toBeVisible();
  await expect(page.locator(`${MENU} [data-action="open"]`)).toContainText('Open');
  await expect(page.locator(`${MENU} [data-action="rename"]`)).toContainText('Rename');
  await expect(page.locator(`${MENU} [data-action="duplicate"]`)).toContainText('Duplicate');
  await expect(page.locator(`${MENU} [data-action="type-menu"]`)).toContainText('Change type');
  await expect(page.locator(`${MENU} [data-action="snapshot"]`)).toContainText('Take snapshot');
  await expect(page.locator(`${MENU} [data-action="share"]`)).toContainText('Share note');
  await expect(page.locator(`${MENU} [data-action="copy-text"]`)).toContainText('Copy note text');
  await expect(page.locator(`${MENU} [data-action="stats"]`)).toContainText('Statistics');
  await expect(page.locator(`${MENU} [data-action="close"]`)).toContainText('Close tab');

  // Escape closes.
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toBeHidden();

  // A second right-click opens it again; a click elsewhere closes.
  await openMenu(page);
  await page.mouse.click(640, 500);
  await expect(page.locator(MENU)).toBeHidden();

  // Right-click on empty space: no custom menu (the browser's own shows,
  // which the test cannot see — but ours must stay shut).
  await page.mouse.click(900, 500, { button: 'right' });
  await expect(page.locator(MENU)).toBeHidden();
});

test("rename from the menu walks the rail's inline rename input", async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await openMenu(page);
  await page.locator(`${MENU} [data-action="rename"]`).click();
  await expect(page.locator(MENU)).toBeHidden();

  const input = page.locator('.tab-strip-rename');
  await expect(input).toBeVisible();
  await input.fill('Renamed from the menu');
  await input.press('Enter');

  await expect(page.locator('.tab-strip-title').first()).toHaveText('Renamed from the menu');
});

test('duplicate clones the note after the source and opens the copy', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Give the source a name and a word so the clone has something to carry.
  await page.locator('.tab-strip-tab').first().dblclick();
  await page.locator('.tab-strip-rename').fill('Field notes');
  await page.locator('.tab-strip-rename').press('Enter');
  await expect(page.locator('.tab-strip-title').first()).toHaveText('Field notes');
  await page.locator('#note').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Original words live here.');

  await openMenu(page);
  await page.locator(`${MENU} [data-action="duplicate"]`).click();
  await expect(page.locator(MENU)).toBeHidden();

  await expect(page.locator('.tab-strip-tab')).toHaveCount(2);
  await expect(page.locator('.tab-strip-title').nth(1)).toHaveText('Copy of Field notes');
  // The copy opened, and the copy is NOT a conflicted copy (no fork badge).
  await expect(page.locator('.tab-strip-tab').nth(1)).toHaveClass(/active/);
  await expect(page.locator('.tab-strip-tab .tab-strip-copy')).toHaveCount(0);
  // The clone carries the source's words.
  await expect(page.locator('#note')).toContainText('Original words live here.');
});

test('change type flips the kind from the submenu and the chrome follows', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await openMenu(page);
  await page.locator(`${MENU} [data-action="type-menu"] .padify-ctx-trigger`).hover();
  await expect(page.locator(`${MENU} .note-ctx-submenu`)).toBeVisible();

  // The current kind is checked before the choice.
  await expect(page.locator(`${MENU} [data-type-check="standard"]`)).toBeVisible();

  await page.locator(`${MENU} [data-action="set-type"][data-type="markdown"]`).click();
  await expect(page.locator(MENU)).toBeHidden();

  // The markdown toolbar arrives — the editor chrome followed the type.
  await expect(page.locator('#markdownToolbar')).toBeVisible();
  // And the move persists across a reload.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openMenu(page);
  await page.locator(`${MENU} [data-action="type-menu"] .padify-ctx-trigger`).hover();
  await expect(page.locator(`${MENU} [data-type-check="markdown"]`)).toBeVisible();
});

test("copy note text puts the note's text on the clipboard", async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.locator('#note').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Clipboard catch phrase.');

  await openMenu(page);
  await page.locator(`${MENU} [data-action="copy-text"]`).click();
  await expect(page.locator(MENU)).toBeHidden();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe('Clipboard catch phrase.');
});

test("close tab on a note with content asks first, like the rail's ×", async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await openMenu(page);
  await page.locator(`${MENU} [data-action="close"]`).click();
  await expect(page.locator(MENU)).toBeHidden();

  // The guarded close asks before it deletes.
  const ask = page.locator('dialog.vz-dialog');
  await expect(ask).toBeVisible();
  await expect(ask.locator('.vz-dialog-title')).toContainText('Close this tab?');
  await page.keyboard.press('Escape');
});
