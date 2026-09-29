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

  test('clicking a link floats its chip under the link and keeps typing', async ({
    page,
  }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('see the manual here plus padding');
    // Select exactly "the manual here".
    await editor.evaluate(() => {
      const note = document.querySelector('#note')!;
      const text = note.textContent ?? '';
      const start = text.indexOf('the manual here');
      const range = document.createRange();
      range.setStart(note.firstChild!, start);
      range.setEnd(note.firstChild!, start + 'the manual here'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await editor.press('Control+K');
    await page.locator('#richLinkInput').fill('https://example.com/manual');
    await page.locator('#richLinkApply').click();
    await expect(editor.locator('a')).toHaveText('the manual here');
    await expect(page.locator('#richLinkPopover')).toBeHidden();

    // Click the link itself: the chip floats under it, the editor keeps
    // focus (typing flows on), and the link text stays put.
    await editor.locator('a').click();
    const chip = page.locator('#richLinkPopover');
    await expect(chip).toBeVisible();
    await expect(chip.locator('#richLinkView')).toHaveText('https://example.com/manual');
    await expect(chip).toHaveCSS('position', 'fixed');
    await expect(page.locator('#note')).toBeFocused();

    const linkBox = await editor.locator('a').boundingBox();
    const chipBox = await chip.boundingBox();
    expect(linkBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Under the link, horizontally near it, inside the viewport.
    expect(chipBox!.y).toBeGreaterThanOrEqual(linkBox!.y + linkBox!.height - 2);
    expect(chipBox!.x).toBeGreaterThanOrEqual(linkBox!.x - 80);
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(1280);

    // Clicking elsewhere closes it.
    await editor.click({ position: { x: 300, y: 10 } });
    await expect(chip).toBeHidden();
  });

  test('Ctrl+click on a link opens the URL in a new tab', async ({ page }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('opened elsewhere');
    await editor.press('Shift+Home');
    await editor.press('Control+K');
    await page.locator('#richLinkInput').fill('https://example.com/target');
    await page.locator('#richLinkApply').click();
    await expect(editor.locator('a')).toHaveCount(1);

    const popupPromise = page.waitForEvent('popup');
    await editor.locator('a').click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    expect(popup.url()).toContain('https://example.com/target');
    await popup.close();
  });
});
