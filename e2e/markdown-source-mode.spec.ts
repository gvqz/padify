/**
 * Markdown notes — the SOURCE mode, end-to-end: the raw-markdown textarea
 * (the note's editor and boot mode), the mode machine (source ↔ preview),
 * the source-mode toolbar grammar, keyboard behavior (list continuation,
 * Tab indent, Ctrl+B wrap) and the autosave round trip.
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
  test('the segmented control flips both modes; every button agrees', async ({ page }) => {
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Modes');

    // Source is the boot mode.
    await expect(page.locator('[data-md-view="source"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(source).toBeVisible();

    // Preview: the renderer alone, full width; the command chrome parks.
    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview).toBeVisible();
    await expect(source).toBeHidden();
    await expect(preview.locator('h1')).toHaveText('Modes');
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeDisabled();

    // Back to source: the textarea returns with the same content.
    await page.locator('[data-md-view="source"]').click();
    await expect(source).toBeVisible();
    await expect(preview).toBeHidden();
    await expect(source).toHaveValue('# Modes');
  });

  test('Ctrl+K opens the link popover, not the shortcuts modal (issue #59)', async ({ page }) => {
    await newMarkdownNote(page);
    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('docs link');

    await page.keyboard.press('Control+k');
    await expect(page.locator('#markdownLinkPopover')).toBeVisible();
    await expect(page.locator('#keyboardShortcutsModal')).not.toHaveClass(/in/);
  });

  test('the toolbar Undo button works in source mode (issue #56)', async ({ page }) => {
    await newMarkdownNote(page);
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

  test('raw markdown typed in source renders in the preview', async ({ page }) => {
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Typed raw\n\nSome **bold** and a `code` span.');

    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Typed raw');
    await expect(preview.locator('b')).toHaveText('bold');
    await expect(preview.locator('code')).toHaveText('code');
  });

  test('Enter continues lists, Tab indents, and Ctrl+B wraps — GitHub grammar', async ({
    page,
  }) => {
    await newMarkdownNote(page);

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
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('wrap me');

    // Bold wraps the selection with markers.
    await page.keyboard.press('Control+A');
    await page.locator('#markdownToolbar [data-md-action="bold"]').click();
    await expect(source).toHaveValue('**wrap me**');
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
    // The blank line is load-bearing: a table after a paragraph over a
    // single newline is a lazy paragraph continuation and never parses.
    await expect(source).toHaveValue(
      /\*\*wrap me\*\*\n\n\| Column 1 \| Column 2 \| Column 3 \|\n\| --- \| --- | --- \|\n\| \| \| \|/,
    );
  });

  test('the source pane autosaves and reloads (the storage round trip)', async ({ page }) => {
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Persisted from source\n\n- typed raw');
    await page.waitForTimeout(1200);

    await page.reload();
    await page.waitForTimeout(1500);
    // The note reopens in the source (the boot mode) with the persisted
    // words.
    const reloaded = page.locator('#note .markdown-source');
    await expect(reloaded).toHaveValue(/# Persisted from source\n\n- typed raw/);
  });

  test('double-Enter paragraph breaks stay clean in the preview (no <br /> leak)', async ({
    page,
  }) => {
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.type('# Title\n\nBody text');

    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Title');
    await expect(preview.locator('p')).toHaveText('Body text');
    // The owned renderer escapes raw HTML by design — the empty
    // paragraph must serialize AWAY (blank line), not as a `<br />`
    // placeholder that would paint as literal text here.
    await expect(preview).not.toContainText('<br');
  });

  test('the scroll carries across a source → preview → source round trip', async ({ page }) => {
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.insertText(
      '# Top\n\n' + Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n\n'),
    );

    // Scroll the source near the bottom.
    await source.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Top');
    // The preview opened near ITS bottom (the fraction carried over).
    const fraction = await preview.evaluate((el) =>
      el.scrollHeight - el.clientHeight > 0 ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 1,
    );
    expect(fraction).toBeGreaterThan(0.5);

    // And back: the source restores its own position.
    await page.locator('[data-md-view="source"]').click();
    const sourceFraction = await source.evaluate(
      (el) => (el.scrollTop ?? 0) / Math.max(1, el.scrollHeight - el.clientHeight),
    );
    expect(sourceFraction).toBeGreaterThan(0.5);
  });
});
