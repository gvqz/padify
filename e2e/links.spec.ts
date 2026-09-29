import { expect, test } from '@playwright/test';

/**
 * The remade link surface: Ctrl+K opens the bubble, bare domains complete
 * to https://, an existing link answers with the chip (open / edit / copy /
 * remove), and Copy really puts the href on the clipboard.
 */

async function newRichNote(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
  await page.locator('#note').focus();
}

test.describe('links', () => {
  // The Copy action reads the real clipboard back in this spec.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Ctrl+K opens the bubble and a bare domain completes to https://', async ({
    page,
  }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('read this');
    await editor.press('Shift+Home'); // select the words

    await editor.press('Control+K');
    await expect(page.locator('#richLinkPopover')).toBeVisible();

    // No scheme typed — the completion adds it.
    await page.locator('#richLinkInput').fill('example.com/guide');
    await page.locator('#richLinkApply').click();

    await expect(editor.locator('a[href="https://example.com/guide"]')).toHaveText(
      'read this',
    );
    await expect(page.locator('#richLinkPopover')).toBeHidden();
    // The link button answers pressed while the caret sits in the link.
    await expect(page.locator('#richLinkButton')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the chip copies the href and removes the link', async ({ page }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('docs or it did not happen');
    await editor.press('Control+Shift+Home'); // select all the words
    await editor.press('Control+K');
    await page.locator('#richLinkInput').fill('https://docs.example.dev/start');
    await page.locator('#richLinkApply').click();
    await expect(editor.locator('a')).toHaveCount(1);

    // Caret sits in the link after the wrap — Ctrl+K answers with the chip.
    await editor.press('Control+K');
    await expect(page.locator('#richLinkView')).toHaveText(
      'https://docs.example.dev/start',
    );

    await page.locator('#richLinkCopy').click();
    await expect(page.locator('#toast')).toContainText('Link copied');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe('https://docs.example.dev/start');

    await page.locator('#richLinkChipRemove').click();
    await expect(editor.locator('a')).toHaveCount(0);
    await expect(editor).toHaveText('docs or it did not happen');
  });
});
