/**
 * Markdown note type — the feature act, end-to-end: the equation bubble,
 * task lists, the table template, clear formatting, Tab list nesting,
 * paste parity, the context menu's markdown rows, the .md export row, and
 * the Source/Preview act (the top bar eye and the segmented control).
 * (Creation/autosave live in markdown.spec.ts.)
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

/** Boots a markdown note and fills its source pane in one shot. */
async function bootSource(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await newMarkdownNote(page);
  const source = page.locator('#note .markdown-source');
  await expect(source).toBeVisible();
  await source.fill(content);
}

test.describe('markdown notes — the feature act', () => {
  test('the equation bubble inserts inline math; the preview renders it live', async ({ page }) => {
    await bootSource(page, 'the area of a circle is ');

    await page.locator('#markdownToolbar [data-md-action="math"]').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await page.locator('#markdownMathInput').fill('\\pi r^2');
    await page.locator('#markdownMathInsert').click();

    // The source carries the wrapped equation; the caret sits between
    // the dollars for overtyping.
    const source = page.locator('#note .markdown-source');
    expect(await source.inputValue()).toBe('the area of a circle is $\\pi r^2$');

    // The preview renders it through the owned renderer + KaTeX.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.katex')).toHaveCount(1);
  });

  test('the equation bubble inserts block math on its own lines', async ({ page }) => {
    await bootSource(page, 'Intro.');

    await page.locator('#markdownToolbar [data-md-action="math"]').click();
    await page.locator('[data-md-math-kind="block"]').click();
    await page.locator('#markdownMathInput').fill('\\frac{1}{2}');
    await page.locator('#markdownMathInsert').click();

    const source = page.locator('#note .markdown-source');
    expect(await source.inputValue()).toContain('$$\n\\frac{1}{2}\n$$');

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.md-math-block .katex')).toHaveCount(1);
  });

  test('clicking a rendered equation in the preview opens the bubble with its source', async ({
    page,
  }) => {
    await bootSource(page, 'energy $E=mc^2$');
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.katex')).toHaveCount(1);

    await preview.locator('.padify-math').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await expect(page.locator('#markdownMathInsert')).toHaveText('Apply');
    await expect(page.locator('#markdownMathInput')).toHaveValue('E=mc^2');

    await page.locator('#markdownMathInput').fill('E=mc^{3}');
    await page.locator('#markdownMathInsert').click();
    expect(await page.locator('#note .markdown-source').inputValue()).toContain('E=mc^{3}');
  });

  test('footnotes: the reference and definition survive, and the preview renders them', async ({
    page,
  }) => {
    await bootSource(
      page,
      'A note with a footnote[^1] inside.\n\n[^1]: The definition, **bold** included.',
    );

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.md-footnote-ref')).toHaveCount(1);
    await expect(preview.locator('.md-footnote-ref a')).toHaveAttribute('href', '#md-fn-1');
    await expect(preview.locator('section.md-footnotes')).toHaveCount(1);
    await expect(preview.locator('.md-footnote-item')).toHaveCount(1);
    // The definition's markup resolves through the inline pass.
    await expect(preview.locator('.md-footnote-item b')).toHaveText('bold');

    // Back in source: both halves are still markdown.
    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    const roundTrip = await page.locator('#note .markdown-source').inputValue();
    expect(roundTrip).toContain('[^1]');
    expect(roundTrip).toContain('[^1]:');
  });

  test('a single-line $$…$$ paragraph is display math in the preview (no silent inline downgrade)', async ({
    page,
  }) => {
    await bootSource(page, 'Intro text.\n\n$$\\frac{1}{2}$$\n\nOutro text.');

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.md-math-block .padify-math')).toHaveCount(1);

    // And the round-trip keeps the compact form the user typed.
    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    expect(await page.locator('#note .markdown-source').inputValue()).toContain('$$\\frac{1}{2}$$');
  });

  test('task lists: the button arms items and the PREVIEW checkboxes toggle the source', async ({
    page,
  }) => {
    await bootSource(page, 'ship the feature');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.press('Control+A');
    await page.locator('#markdownToolbar [data-md-action="task"]').click();
    expect(await source.inputValue()).toBe('- [ ] ship the feature');
    await expect(page.locator('#markdownToolbar [data-md-action="task"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The preview renders the checkbox; clicking it writes the toggle
    // back into the source (the one live gesture the preview owns).
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const box = page.locator('#note .markdown-preview input[type="checkbox"]');
    await expect(box).toHaveCount(1);
    await page.locator('#note .markdown-preview li').click();
    await expect(box).toHaveAttribute('checked', /.*/);
    expect(await source.inputValue()).toBe('- [x] ship the feature');
  });

  test('the table button writes the GFM template; the caret lands in the first header', async ({
    page,
  }) => {
    await bootSource(page, '');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    const value = await source.inputValue();
    expect(value).toContain('| Column 1 | Column 2 | Column 3 |');
    expect(value).toContain('| --- | --- | --- |');

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    await expect(page.locator('#note .markdown-preview table')).toHaveCount(1);
  });

  test('clear formatting strips the markers from the selection', async ({ page }) => {
    await bootSource(page, 'very **bold** words');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await source.evaluate((el, [start, end]) => el.setSelectionRange(start, end), [0, 16]);
    await page.locator('#markdownToolbar [data-md-action="clear"]').click();
    expect(await source.inputValue()).toBe('very bold words');
  });

  test('Tab indents the selected lines; Shift-Tab lifts them', async ({ page }) => {
    await bootSource(page, '- outer\n- inner');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Tab');
    expect(await source.inputValue()).toBe('  - outer\n  - inner');

    await page.keyboard.press('Shift+Tab');
    expect(await source.inputValue()).toBe('- outer\n- inner');
  });

  test('pasting keeps text LITERAL — every clip is content, never restructured', async ({
    page,
  }) => {
    await bootSource(page, '');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      const markdown = '![logo](https://example.com/logo.png)\n\nand $\\sqrt{2}$ too';
      await navigator.clipboard.writeText(markdown);
    });
    await page.keyboard.press('Control+V');

    // The textarea's paste is the plain-text contract: the bytes ride in
    // as typed, never reinterpreted as chips, blocks or equations.
    const pasted = await source.inputValue();
    expect(pasted).toContain('![logo](https://example.com/logo.png)');
    expect(pasted).toContain('and $\\sqrt{2}$ too');
  });

  test('the context menu speaks markdown', async ({ page }) => {
    await bootSource(page, 'menu words');

    const source = page.locator('#note .markdown-source');
    await source.click();
    await page.keyboard.press('Control+A');

    await source.click({ button: 'right' });
    const menu = page.locator('#padifyCtxMenu');
    await expect(menu).toBeVisible();
    // Markdown rows in, rich rows out.
    await expect(menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]')).toBeVisible();
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeHidden();

    await menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]').click();
    expect(await source.inputValue()).toBe('**menu words**');
  });

  test('the download menu offers the .md export only for markdown notes', async ({ page }) => {
    await bootSource(page, 'x');

    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeVisible();

    // A plain note: the row stands down.
    await page.locator('#addTab').click();
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeHidden();
  });
});

test.describe('markdown notes — the Source/Preview act', () => {
  test('the top bar eye and the segmented control agree', async ({ page }) => {
    await bootSource(page, '# Agreement');

    // Source is the default; both controls read it.
    await expect(page.locator('[data-md-view="source"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#previewToggleButton')).toHaveAttribute('aria-pressed', 'false');

    // The eye flips to the preview; the segmented control follows.
    await page.locator('#previewToggleButton').click();
    await expect(page.locator('[data-md-view="preview"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#previewToggleButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#note .markdown-preview')).toBeVisible();
    await expect(page.locator('#note .markdown-source')).toBeHidden();

    // The segmented control flips back; the eye follows.
    await page.locator('[data-md-view="source"]').click();
    await expect(page.locator('#previewToggleButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#note .markdown-source')).toBeVisible();
  });

  test('the eye stands down for plain notes; preview parks the command chrome', async ({
    page,
  }) => {
    await bootSource(page, 'words');

    await page.locator('#previewToggleButton').click();
    // Formatting an invisible document is a no-op — the buttons park.
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeDisabled();

    await page.locator('[data-md-view="source"]').click();
    await expect(page.locator('#markdownToolbar [data-md-action="bold"]')).toBeEnabled();

    // A plain note: no toggle at all.
    await page.locator('#addTab').click();
    await expect(page.locator('#previewToggleContainer')).toBeHidden();
  });

  test('the preview follows the edits that land while it is showing', async ({ page }) => {
    await bootSource(page, '- [ ] one');

    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const box = page.locator('#note .markdown-preview input[type="checkbox"]');
    await expect(box).toHaveCount(1);

    // A task toggle (the preview's own live gesture) re-renders it.
    await page.locator('#note .markdown-preview li').click();
    await expect(page.locator('#note .markdown-source')).toHaveValue('- [x] one');
  });
});
