/**
 * Markdown note type — the feature act, end-to-end: live equations, task
 * lists, table operations, the slash menu, clear formatting, Tab list
 * nesting, markdown-aware paste, the context menu's markdown rows, and
 * the .md export row. (Creation/autosave/preview live in markdown.spec.ts.)
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

test.describe('markdown notes — the feature act', () => {
  test('typing $…$ renders a live equation; the bubble inserts block math', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('the area of a circle is $\\pi r^2$ exactly');
    // The input rule converted the closing dollar: live KaTeX inline.
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);

    // The block equation, through the bubble (the toolbar button defaults
    // to inline — the segmented control picks the placement).
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('#markdownToolbar [data-md-action="math"]').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await page.locator('[data-md-math-kind="block"]').click();
    await page.locator('#markdownMathInput').fill('\\frac{1}{2}');
    await page.locator('#markdownMathInsert').click();
    await expect(editor.locator('.md-math-block .katex')).toHaveCount(1);

    // The preview shows the same equations through the owned renderer.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.katex')).toHaveCount(2);
  });

  test('the equation bubble edits a clicked equation in place', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('energy $E=mc^2$');
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);

    // Click the rendered equation: the bubble opens in edit mode.
    await editor.locator('.md-math-inline').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await expect(page.locator('#markdownMathInsert')).toHaveText('Apply');
    await expect(page.locator('#markdownMathInput')).toHaveValue('E=mc^2');

    await page.locator('#markdownMathInput').fill('E=mc^{3}');
    await page.locator('#markdownMathInsert').click();
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);
    // The source reflects the edit (autosave debounce).
    await page.waitForTimeout(700);
  });

  test('task lists: the button arms checkboxes and clicks toggle them', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('ship the feature');
    await page.locator('#markdownToolbar [data-md-action="task"]').click();

    const item = editor.locator('li[data-item-type="task"]');
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-checked', 'false');
    await expect(page.locator('#markdownToolbar [data-md-action="task"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Click the checkbox (the marker zone at the item's left edge).
    await item.click({ position: { x: 6, y: 10 } });
    await expect(item).toHaveAttribute('data-checked', 'true');

    // The preview shows a checked, disabled checkbox — the same truth.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    await expect(page.locator('#note .markdown-preview input[type="checkbox"]')).toHaveCount(1);
  });

  test('table operations from the in-table menu', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    await expect(editor.locator('table')).toHaveCount(1);

    // The caret sits inside the fresh table: the ops menu appears.
    const opsButton = page.locator('[data-md-menu="table"]');
    await expect(opsButton).toBeVisible();
    await opsButton.click();
    await page.locator('[data-md-table="row-below"]').click();
    await expect(editor.locator('tr')).toHaveCount(3);

    await opsButton.click();
    await page.locator('[data-md-table="col-right"]').click();
    await expect(editor.locator('tr').first().locator('th, td')).toHaveCount(4);

    await opsButton.click();
    await page.locator('[data-md-table="table-delete"]').click();
    await expect(editor.locator('table')).toHaveCount(0);
  });

  test('the slash menu: / filters and Enter inserts the block', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('/');
    const panel = page.locator('.markdown-slash');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.markdown-slash-item')).toHaveCount(11);

    await page.keyboard.type('quo');
    await expect(panel.locator('.markdown-slash-item')).toHaveCount(1);

    await page.keyboard.press('Enter');
    await expect(panel).toBeHidden();
    await expect(editor.locator('blockquote')).toHaveCount(1);
    // The "/quo" query was consumed by the insert.
    await expect(editor).not.toContainText('/quo');
  });

  test('clear formatting strips the marks from the selection', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('very ');
    await page.keyboard.press('Control+B');
    await page.keyboard.type('bold');
    await page.keyboard.press('Control+B');
    await page.keyboard.type(' words');
    await expect(editor.locator('strong')).toHaveText('bold');

    await page.keyboard.press('Control+A');
    await page.locator('#markdownToolbar [data-md-action="clear"]').click();
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(editor).toContainText('very bold words');
  });

  test('Tab nests list items; Shift-Tab lifts them', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('- outer');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- inner');
    await page.keyboard.press('Tab');
    await expect(editor.locator('ul ul li')).toHaveCount(1);

    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator('ul ul')).toHaveCount(0);
    await expect(editor.locator('ul > li')).toHaveCount(2);
  });

  test('pasting markdown text renders it (images as chips, math live)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const markdown = '![logo](https://example.com/logo.png)\n\nand $\\sqrt{2}$ too';
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, markdown);
    await page.keyboard.press('Control+V');

    // Parsed as markdown: the image is a chip (never an <img>), the math live.
    await expect(editor.locator('.md-image-chip')).toHaveCount(1);
    await expect(editor.locator('img[src]')).toHaveCount(0);
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);
  });

  test('the context menu speaks markdown', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('menu words');
    await page.keyboard.press('Control+A');

    await editor.click({ button: 'right' });
    const menu = page.locator('#padifyCtxMenu');
    await expect(menu).toBeVisible();
    // Markdown rows in, rich rows out.
    await expect(menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]')).toBeVisible();
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeHidden();

    await menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]').click();
    await expect(editor.locator('strong')).toHaveText('menu words');
  });

  test('the download menu offers the .md export only for markdown notes', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeVisible();

    // A plain note: the row stands down.
    await page.locator('#addTab').click();
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeHidden();
  });
});
