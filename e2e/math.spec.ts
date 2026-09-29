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
    await expect(page.locator('#richMathPreview .katex')).toBeVisible();

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

  test('the palette writes an equation without any LaTeX typing', async ({ page }) => {
    // The Docs gesture: every character below comes from the palette —
    // sin(α) built by picking sin, auto-sized parens, then the letter.
    await newRichNote(page);
    const editor = page.locator('#note');

    await page.locator('[data-rich-action="math"]').click();
    await expect(page.locator('#richMathPopover')).toBeVisible();

    // Greek letters render immediately; the other tabs lazy-render on first
    // use. Hidden categories stay out of the accessibility tree, so role
    // queries only ever see the active grid.
    await expect(page.locator('.rich-math-tab')).toHaveCount(5);
    await expect(page.locator('.rich-math-symbol:not([hidden])')).toHaveCount(39);

    await page.getByRole('tab', { name: 'Operations' }).click();
    // Rendered-level check: the Greek grid is display:none, not merely
    // attribute-hidden (display:flex defeats the UA rule without the CSS).
    const greekDisplay = await page.evaluate(() => {
      const greek = document.querySelector(
        '.rich-math-symbol[data-category="greek"]',
      ) as HTMLElement;
      return getComputedStyle(greek).display;
    });
    expect(greekDisplay).toBe('none');
    await page.getByRole('button', { name: /^sin \(/ }).click();
    await page.getByRole('button', { name: /auto-sized parentheses/ }).click();
    await page.getByRole('tab', { name: 'Greek letters' }).click();
    await page.getByRole('button', { name: /^alpha \(/ }).click();

    const input = page.locator('#richMathInput');
    await expect(input).toHaveValue('\\sin\\left(\\alpha\\right)');
    await expect(page.locator('#richMathPreview .katex')).toBeVisible();

    await page.locator('#richMathInsert').click();
    await expect(editor.locator('.padify-math .katex')).toHaveCount(1);
    const stored = await editor.evaluate(() => {
      const chip = document.querySelector('#note .padify-math') as HTMLElement | null;
      return chip?.getAttribute('data-latex') ?? '';
    });
    expect(stored).toBe('\\sin\\left(\\alpha\\right)');
  });

  test('the fraction template lands the caret in the numerator', async ({ page }) => {
    await newRichNote(page);
    await page.locator('[data-rich-action="math"]').click();
    await page.getByRole('tab', { name: 'Operations' }).click();
    await page.getByRole('button', { name: /^fraction \(/ }).click();

    const input = page.locator('#richMathInput');
    await expect(input).toHaveValue('\\frac{}{}');
    // The caret sits between the first braces — typing fills the numerator,
    // exactly the no-thought placement the template is for.
    await page.keyboard.type('7');
    await expect(input).toHaveValue('\\frac{7}{}');
    const caret = await input.evaluate((node) => (node as HTMLInputElement).selectionStart);
    expect(caret).toBe('\\frac{7'.length);
  });
});
