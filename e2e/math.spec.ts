import { expect, test, type Page } from '@playwright/test';

/**
 * Math equations: the toolbar bubble takes LaTeX, renders it live, and
 * Insert drops a rendered KaTeX chip into the note. The stored note keeps
 * only the LaTeX source (storage round trip re-renders), one undo removes
 * the whole equation, and clicking an equation reopens it for editing.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

async function newRichNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
  await page.locator('#note').focus();
}

test.describe('math equations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('insert an equation, reload, it re-renders from the stored source', async ({
    page,
  }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('Euler said ');

    await page.locator('[data-rich-action="math"]').click();
    const bubble = page.locator('#richMathPopover');
    await expect(bubble).toBeVisible();

    // The preview renders while typing (before any insert).
    await page.locator('#richMathInput').fill('e^{i\\pi} + 1 = 0');
    await expect(bubble.locator('.katex')).toBeVisible();

    await page.locator('#richMathInsert').click();
    await expect(bubble).toBeHidden();

    // The note shows a rendered, non-editable equation chip.
    const chip = editor.locator('.padify-math');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.katex')).toHaveCount(1);
    await expect(editor).toContainText('Euler said');

    // Storage keeps only the shell: reload and the equation re-renders.
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.locator('#note .padify-math .katex')).toHaveCount(1);
    const storedLatex = await page.evaluate(() => {
      return (
        document.querySelector('#note .padify-math') as HTMLElement | null
      )?.getAttribute('data-latex');
    });
    expect(storedLatex).toBe('e^{i\\pi} + 1 = 0');
  });

  test('one undo removes the whole equation, clicking reopens it for edit', async ({
    page,
  }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('before');

    await page.locator('[data-rich-action="math"]').click();
    await page.locator('#richMathInput').fill('x^2');
    await page.locator('#richMathInsert').click();

    await expect(editor.locator('.padify-math .katex')).toHaveCount(1);

    // One undo: the equation is gone entirely (render is undo-invisible).
    await editor.press('Control+Z');
    await expect(editor.locator('.padify-math')).toHaveCount(0);
    await expect(editor).toContainText('before');

    // Re-insert and click it: the bubble opens in edit mode, prefilled.
    await page.locator('[data-rich-action="math"]').click();
    await page.locator('#richMathInput').fill('y^3');
    await page.locator('#richMathInsert').click();
    await expect(editor.locator('.padify-math .katex')).toHaveCount(1);

    await editor.locator('.padify-math').click();
    const bubble = page.locator('#richMathPopover');
    await expect(bubble).toBeVisible();
    await expect(page.locator('#richMathInput')).toHaveValue('y^3');

    // Applying a new latex updates the same chip in place.
    await page.locator('#richMathInput').fill('z^4');
    await page.locator('#richMathInsert').click();
    await expect(bubble).toBeHidden();
    const latex = await editor.evaluate(() => {
      const chip = document.querySelector('#note .padify-math') as HTMLElement | null;
      return chip?.getAttribute('data-latex') ?? '';
    });
    expect(latex).toBe('z^4');
    await expect(editor.locator('.padify-math')).toHaveCount(1);
  });

  test('the context menu offers Insert equation', async ({ page }) => {
    await newRichNote(page);
    const editor = page.locator('#note');
    await editor.pressSequentially('math via menu');

    await editor.click({ button: 'right' });
    const item = page.locator('.padify-ctx-item[data-action="insert-equation"]');
    await expect(item).toBeVisible();
    await item.click();

    const bubble = page.locator('#richMathPopover');
    await expect(bubble).toBeVisible();
    await page.locator('#richMathInput').fill('a_1 + a_2');
    await page.locator('#richMathInsert').click();
    await expect(editor.locator('.padify-math .katex')).toHaveCount(1);
  });
});
