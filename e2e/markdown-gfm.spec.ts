/**
 * Markdown — the GFM act, end-to-end: the preview pane renders the FULL
 * GitHub Flavored Markdown grammar (the owned renderer's spec-faithful
 * surface), autolinks become real anchors, and the rendered task
 * checkboxes are LIVE — clicking one writes the toggle back into the
 * note's source and the pane re-renders to the same truth.
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

/** Boots a markdown note and types SOURCE text through the source pane. */
async function bootSource(page: Page, source: string): Promise<void> {
  await page.goto('/');
  await newMarkdownNote(page);
  await page.locator('[data-md-view="source"]').click();
  const textarea = page.locator('#note .markdown-source');
  await textarea.click();
  await textarea.fill(source);
  // The pane announces on input; the debounced preview re-render follows.
  await page.waitForTimeout(400);
}

test.describe('markdown notes — GFM rendering in the preview', () => {
  test('reference links, entities, indented code and tables render like github', async ({
    page,
  }) => {
    await bootSource(
      page,
      [
        'See the [padify repo][repo] or [the docs](https://example.com "Docs").',
        '',
        'Copyright &copy; 2026 &mdash; AT&T',
        '',
        '    indented code &amp; stays literal',
        '',
        '| a | b |',
        '| --- | ---: |',
        '| 1 | 2 |',
        '',
        '[repo]: https://github.com/gvqz/padify',
      ].join('\n'),
    );
    await page.locator('[data-md-view="preview"]').click();

    const preview = page.locator('#note .markdown-preview');
    // Reference link: the definition resolved, wherever it stood.
    await expect(preview.getByRole('link', { name: 'padify repo' })).toHaveAttribute(
      'href',
      'https://github.com/gvqz/padify',
    );
    // Inline link with its title.
    await expect(preview.getByRole('link', { name: 'the docs' })).toHaveAttribute('title', 'Docs');
    // Entities decode; a bare ampersand escapes.
    await expect(preview).toContainText('Copyright © 2026 — AT&T');
    // Indented code: the entity stays literal text.
    await expect(preview.locator('pre code')).toContainText('indented code &amp; stays literal');
    // The table with its right-aligned column.
    await expect(preview.locator('table td[style*="text-align:right"]')).toHaveText('2');
  });

  test('literal autolinks become anchors — www, https and email', async ({ page }) => {
    await bootSource(
      page,
      'Visit https://example.com/x or www.example.com or mail a.b@example.co.uk now.',
    );
    await page.locator('[data-md-view="preview"]').click();

    const preview = page.locator('#note .markdown-preview');
    await expect(preview.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute(
      'href',
      'https://example.com/x',
    );
    await expect(preview.getByRole('link', { name: 'www.example.com' })).toHaveAttribute(
      'href',
      'http://www.example.com',
    );
    await expect(preview.getByRole('link', { name: 'a.b@example.co.uk' })).toHaveAttribute(
      'href',
      'mailto:a.b@example.co.uk',
    );
  });

  test('clicking a rendered checkbox rewrites the source (preview mode)', async ({ page }) => {
    await bootSource(page, '- [ ] pack the bag\n- [x] charge the phone');
    await page.locator('[data-md-view="preview"]').click();

    const textarea = page.locator('#note .markdown-source');
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(textarea).toHaveValue(/- \[ \] pack the bag/);

    // Click the open task's row — the source flips to [x].
    await preview.locator('li', { hasText: 'pack the bag' }).click();
    await expect(textarea).toHaveValue(/- \[x\] pack the bag/);
    await expect(preview.locator('li', { hasText: 'pack the bag' }).locator('input')).toBeChecked();

    // Click again — back to open.
    await preview.locator('li', { hasText: 'pack the bag' }).click();
    await expect(textarea).toHaveValue(/- \[ \] pack the bag/);
    // The already-checked one was never touched.
    await expect(textarea).toHaveValue(/- \[x\] charge the phone/);
  });

  test('a checked task renders muted, not deleted', async ({ page }) => {
    await bootSource(page, '- [x] done deed');
    await page.locator('[data-md-view="preview"]').click();
    await expect(page.locator('#note .markdown-preview input[type="checkbox"]')).toBeChecked();
  });
});
