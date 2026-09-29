import { expect, test } from '@playwright/test';

/**
 * Theme-aware ink: the palette a rich note's colors were picked under is
 * re-mapped when the app flips between light and dark — near-black ink
 * written on paper becomes near-white ink on the dark surface, and flips
 * back. Storage only catches up on the next edit (opening a note never
 * writes on its own).
 */

async function newRichNote(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
  await page.locator('#note').focus();
}

async function inkColorOf(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const span = document.querySelector('#note span[style*="color"]') as HTMLElement | null;
    return span ? getComputedStyle(span).color : '';
  });
}

test.describe('theme ink', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('picked ink flips with the theme, both ways', async ({ page }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('colored words');
    await editor.press('Shift+Home');

    // Pick "ink" from the palette.
    await page.locator('#richToolbar [data-rich-menu="color"]').click();
    await page.locator('[data-rich-color="ink"]').click();

    // Light mode: near-black.
    await expect.poll(() => inkColorOf(page)).toBe('rgb(26, 26, 26)');

    // Flip to dark through the real preferences UI, and back in the same
    // modal session (the fade lags a close/reopen cycle).
    await page.keyboard.press('Control+,');
    const modal = page.locator('#preferencesModal');
    await expect(modal).toHaveClass(/in/);
    await modal.locator('label', { hasText: 'Dark' }).first().click();
    await expect(page.locator('body')).toHaveClass(/dark/);

    // The same run now answers near-white — no dead ink on the dark surface.
    await expect.poll(() => inkColorOf(page)).toBe('rgb(241, 243, 244)');

    // And back.
    await modal.locator('label', { hasText: 'Light' }).first().click();
    await expect(page.locator('body')).not.toHaveClass(/dark/);
    await page.keyboard.press('Escape');
    await expect.poll(() => inkColorOf(page)).toBe('rgb(26, 26, 26)');
  });

  test('a note saved in dark ink re-inks when reopened in light mode', async ({
    page,
  }) => {
    test.info().annotations.push({ type: 'note', description: 'storage round trip' });
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('dark ink note');
    await editor.press('Shift+Home');
    await page.locator('#richToolbar [data-rich-menu="color"]').click();
    await page.locator('[data-rich-color="ink"]').click();

    // Dark theme + a real edit so the save stamps dark ink.
    await page.keyboard.press('Control+,');
    const modal = page.locator('#preferencesModal');
    await expect(modal).toHaveClass(/in/);
    await modal.locator('label', { hasText: 'Dark' }).first().click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await editor.pressSequentially(' more');
    await page.waitForTimeout(400);

    // Reload — still dark ink on the dark surface.
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/dark/);
    await expect.poll(() => inkColorOf(page)).toBe('rgb(241, 243, 244)');

    // Flip the device to light through preferences: the stored dark ink
    // re-maps for display.
    await page.keyboard.press('Control+,');
    await page
      .locator('#preferencesModal')
      .locator('label', { hasText: 'Light' })
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expect.poll(() => inkColorOf(page)).toBe('rgb(26, 26, 26)');

    // Reload in light mode — the stamp was persisted with the edit, so the
    // note loads in light ink without a visible flash of dark-only colors.
    await page.reload();
    await expect.poll(() => inkColorOf(page)).toBe('rgb(26, 26, 26)');
  });
});
