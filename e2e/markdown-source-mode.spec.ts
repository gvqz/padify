/**
 * Markdown notes — the SOURCE mode, end-to-end: the raw-markdown textarea
 * (the "normal typing" pane), the mode machine (visual ↔ source ↔ split ↔
 * preview), the source-mode toolbar grammar, keyboard behavior (list
 * continuation, Tab indent, Ctrl+B wrap) and the autosave round trip.
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

test.describe('markdown source mode', () => {
  test('the segmented control flips all four modes; every button agrees', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Modes');

    // Visual is the boot mode.
    await expect(page.locator('[data-md-view="edit"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#note .markdown-source')).toBeHidden();

    // Source: the textarea owns the surface.
    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await expect(source).toBeVisible();
    await expect(editor).toBeHidden();
    await expect(page.locator('[data-md-view="source"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(source).toHaveValue(/# Modes/);

    // Back to visual: the WYSIWYG returns with the same content.
    await page.locator('[data-md-view="edit"]').click();
    await expect(source).toBeHidden();
    await expect(editor.locator('h1')).toHaveText('Modes');

    // Preview: the renderer alone, full width.
    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview).toBeVisible();
    await expect(source).toBeHidden();
    await expect(editor).toBeHidden();
    await expect(preview.locator('h1')).toHaveText('Modes');
    // Command chrome parks while the preview owns the surface.
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeDisabled();
  });

  test('Ctrl+K opens the link popover, not the shortcuts modal (issue #59)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('docs link');

    // Visual mode: the link popover, never the shortcuts modal.
    await page.keyboard.press('Control+k');
    await expect(page.locator('#markdownLinkPopover')).toBeVisible();
    await expect(page.locator('#keyboardShortcutsModal')).not.toHaveClass(/in/);
    await page.keyboard.press('Escape');

    // Source mode: the same shortcut, same popover.
    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#markdownLinkPopover')).toBeVisible();
    await expect(page.locator('#keyboardShortcutsModal')).not.toHaveClass(/in/);
  });

  test('the toolbar Undo button works in source mode (issue #56)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    // One insertText = one native undo transaction (per-key typing would
    // need one undo per character).
    await page.keyboard.insertText('undo me');

    // The button click moves focus to the toolbar — undo must still run
    // (it used to be a silent no-op: a text control's stack is only
    // reachable while the control is focused).
    await page.locator('#markdownToolbar [data-md-action="undo"]').click();
    await expect(source).toHaveValue('');
  });

  test('raw markdown typed in source renders after a mode round trip', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Typed raw\n\nSome **bold** and a `code` span.');

    // Back to visual: the WYSIWYG parses what was typed.
    await page.locator('[data-md-view="edit"]').click();
    const editor = page.locator('#note .ProseMirror');
    await expect(editor.locator('h1')).toHaveText('Typed raw');
    await expect(editor.locator('strong')).toHaveText('bold');
    await expect(editor.locator('code')).toHaveText('code');
  });

  test('Enter continues lists, Tab indents, and Ctrl+B wraps — GitHub grammar', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('- first item');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    // The continuation marker was already there — typing rode after it.
    await expect(source).toHaveValue(/- first item\n- second/);

    // Tab sinks the item; Shift+Tab lifts it back.
    await page.keyboard.press('Tab');
    await expect(source).toHaveValue(/- first item\n {2}- second/);
    await page.keyboard.press('Shift+Tab');
    await expect(source).toHaveValue(/- first item\n- second/);

    // Enter continues; a marker-only line then lifts OUT of the list.
    await page.keyboard.press('Enter');
    await expect(source).toHaveValue(/- first item\n- second\n- $/);
    await page.keyboard.press('Enter');
    await expect(source).toHaveValue(/- first item\n- second\n$/);

    // Ctrl+B wraps the fresh line's word.
    await page.keyboard.type('plain now');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Control+B');
    await expect(source).toHaveValue(/- first item\n- second\n\*\*plain now\*\*$/);
  });

  test('the toolbar speaks markdown in source mode', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('wrap me');

    // Bold wraps the selection with markers.
    await page.keyboard.press('Control+A');
    await page.locator('#markdownToolbar [data-md-action="bold"]').click();
    await expect(source).toHaveValue('**wrap me**');
    // The caret returned to the pane (not the toolbar button).
    // Heading 2 prefixes the line through the block dropdown.
    await page.locator('#markdownToolbar [data-md-menu="block"]').click();
    await page.locator('#markdownToolbar [data-md-block="h2"]').click();
    await expect(source).toHaveValue('## **wrap me**');
    // The dropdown's label follows the line.
    await expect(page.locator('[data-md-label="block"]')).toHaveText('Heading 2');
    // The quote REPLACES the heading — one block shape at a time (the
    // turn-into grammar the block menu itself carries).
    await page.locator('#markdownToolbar [data-md-action="quote"]').click();
    await expect(source).toHaveValue('> **wrap me**');
    // Back to a paragraph (Normal text strips the quote — the same
    // turn-into grammar), then a table template inserts on its own lines
    // (End first: the bold action left the content selected, and an insert
    // at a selection replaces it — the honest insert contract).
    await page.locator('#markdownToolbar [data-md-menu="block"]').click();
    await page.locator('#markdownToolbar [data-md-block="p"]').click();
    await page.keyboard.press('End');
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    await expect(source).toHaveValue(
      /\*\*wrap me\*\*\n\| Column 1 \| Column 2 \| Column 3 \|\n\| --- \| --- \| --- \|\n\| \| \| \|/,
    );
  });

  test('the source pane autosaves and reloads (the storage round trip)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Persisted from source\n\n- typed raw');
    await page.waitForTimeout(1200);

    await page.reload();
    await page.waitForTimeout(1500);
    // The note opens visual (the boot mode) with the persisted source.
    const editor = page.locator('#note .ProseMirror');
    await expect(editor.locator('h1')).toHaveText('Persisted from source');
    await expect(editor.locator('li')).toHaveCount(1);
  });

  test('double-Enter paragraph breaks stay clean in the preview (no <br /> leak)', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Title');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Body text');
    await page.waitForTimeout(600);

    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Title');
    await expect(preview.locator('p')).toHaveText('Body text');
    // The owned renderer escapes raw HTML by design — the empty
    // paragraph must serialize AWAY (blank line), not as a `<br />`
    // placeholder that would paint as literal text here.
    await expect(preview).not.toContainText('<br');
  });

  test('split keeps the source left and a live preview right', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('[data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Split shows both');

    await page.locator('[data-md-view="split"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(source).toBeVisible();
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Split shows both');

    // Typing in the source pane updates the preview a beat later.
    await source.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' — live');
    await expect(preview.locator('h1')).toHaveText('Split shows both — live', { timeout: 3000 });
  });
});
