/**
 * Markdown note type — end-to-end: creation, WYSIWYG editing through the
 * Milkdown surface, the toolbar, autosave round-trips, the preview
 * toggle, and the chrome that follows the active note kind.
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

test.describe('markdown notes', () => {
  test('creating one swaps the chrome: markdown toolbar, no rich toolbar', async ({ page }) => {
    await page.goto('/');

    await newMarkdownNote(page);
    await expect(page.locator('#richToolbar')).toBeHidden();
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    // The surface took the host: the wrapper is in, the host stands down.
    await expect(page.locator('#note .markdown-surface')).toBeVisible();
    await expect(page.locator('#note')).toHaveAttribute('contenteditable', 'false');
    // The active tab carries the type badge.
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-type')).toHaveCount(1);
  });

  test('input rules format while typing, and the pill counts words not syntax', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Trip plan');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- pack the ');
    await page.keyboard.press('Control+B');
    await page.keyboard.type('good bag');
    await page.keyboard.press('Control+B');
    await page.waitForTimeout(700);

    // WYSIWYG: a real heading, a real list, real bold.
    await expect(editor.locator('h1')).toHaveText('Trip plan');
    await expect(editor.locator('li')).toHaveCount(1);
    await expect(editor.locator('strong')).toHaveText('good bag');

    // The pill reads the rendered projection — no asterisks, no dash.
    const pill = await page.locator('#wordCount').textContent();
    expect(pill).not.toContain('#');
    expect(pill).not.toContain('-');
  });

  test('the toolbar formats the selection and pressed states follow', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('some plain words');
    await page.keyboard.press('Control+A');

    await page.locator('#markdownToolbar [data-md-action="bold"]').click();
    await expect(editor.locator('strong')).toHaveText('some plain words');
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Toggling again unwraps.
    await page.locator('#markdownToolbar [data-md-action="bold"]').click();
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('the text-style dropdown turns blocks into headings', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('a line to promote');
    await page.keyboard.press('Control+A');

    await page.locator('#markdownToolbar [data-md-menu="block"]').click();
    await page.locator('#markdownToolbar [data-md-block="h2"]').click();
    await expect(editor.locator('h2')).toHaveText('a line to promote');
    await expect(page.locator('[data-md-label="block"]')).toHaveText('Heading 2');
  });

  test('autosave survives a reload — the markdown source persists', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Persisted');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- item one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- item two');
    await page.waitForTimeout(1200);

    await page.reload();
    await page.waitForTimeout(1500);

    // Same note, same rendering, still editable.
    await expect(page.locator('#note .ProseMirror')).toBeVisible();
    await expect(page.locator('#note .ProseMirror h1')).toHaveText('Persisted');
    await expect(page.locator('#note .ProseMirror li')).toHaveCount(2);
    await expect(page.locator('#markdownToolbar')).toBeVisible();
  });

  test('the preview toggle shows the owned renderer, edit returns to the editor', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Read only view');
    await page.waitForTimeout(600);

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Read only view');
    // Command chrome parks while the preview owns the surface.
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeDisabled();

    await page.locator('#markdownToolbar [data-md-view="edit"]').click();
    await expect(preview).toBeHidden();
    await expect(page.locator('#note .ProseMirror')).toBeVisible();
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeEnabled();
  });

  test('switching kinds swaps the chrome back and forth', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    // Back to a plain note: markdown chrome gone, the host is editable
    // again, and the html engine answers (typing lands in the note).
    await page.locator('#addTab').click();
    await expect(page.locator('#markdownToolbar')).toBeHidden();
    await expect(page.locator('#note')).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('#note .markdown-surface')).toHaveCount(0);

    await page.locator('#note').focus();
    await page.keyboard.type('back on the html surface');
    await expect(page.locator('#note')).toContainText('back on the html surface');
  });

  test('the link popover applies a safe href and refuses javascript: ones', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('the docs page');
    await page.keyboard.press('Control+A');

    await page.locator('#markdownToolbar [data-md-action="link"]').click();
    const popover = page.locator('#markdownLinkPopover');
    await expect(popover).toBeVisible();
    await page.locator('#markdownLinkInput').fill('javascript:alert(1)');
    await page.locator('#markdownLinkApply').click();
    await expect(page.locator('#toast')).toContainText(/http/i);

    // A real URL applies: the selection becomes a link.
    await page.locator('#markdownLinkInput').fill('https://example.com/docs');
    await page.locator('#markdownLinkApply').click();
    await expect(editor.locator('a[href="https://example.com/docs"]')).toHaveText('the docs page');
  });
});
