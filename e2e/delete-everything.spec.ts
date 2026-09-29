import { expect, test, type Page } from '@playwright/test';

/**
 * Deleting everything after typing: Chrome leaves a skeleton behind (the
 * last heading/list survives as an empty block), hides the placeholder and
 * keeps the deleted run's character style as its typing style. The port
 * normalizes that on delete-type inputs — these tests pin the reset and,
 * just as important, what must NOT reset: a deliberately empty list, and
 * the native undo stack that has to restore the deleted text.
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

async function createRichNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
}

/** The editor's exact HTML (toHaveHTML is not available on this version). */
function innerHtml(editor: ReturnType<Page['locator']>): Promise<string> {
  return editor.evaluate((node) => node.innerHTML);
}

test.describe('delete everything after typing', () => {
  test('a heading emptied by Ctrl+A Backspace resets to a plain surface', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('big title');
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('[data-rich-block="h1"]').click();
    await expect(editor.locator('h1')).toHaveText('big title');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    // The skeleton is gone, the placeholder is back, and typing continues
    // as plain text — not as another heading.
    await expect.poll(() => innerHtml(editor)).toBe('<br>');
    await expect
      .poll(() =>
        editor.evaluate((node) => getComputedStyle(node, '::before').content !== 'none'),
      )
      .toBe(true);

    await page.keyboard.type('plain again');
    await expect(editor).toHaveText('plain again');
    await expect(editor.locator('h1')).toHaveCount(0);
  });

  test('an emptied list stops claiming the keystrokes that follow', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('list item');
    await page.locator('#richToolbar [data-rich-list="ul"]').click();
    await expect(editor.locator('ul > li')).toHaveText('list item');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect.poll(() => innerHtml(editor)).toBe('<br>');

    await page.keyboard.type('plain');
    await page.keyboard.press('Enter');
    // A plain paragraph break — not another list item.
    await expect(editor.locator('ul')).toHaveCount(0);
    await expect(editor.locator('div').last()).toBeVisible();
  });

  test('the deleted run does not ghost its bold onto the next typing', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('bold words');
    await page.keyboard.press('ControlOrMeta+a');
    await page.locator('#richToolbar [data-rich-cmd="bold"]').click();
    await expect(editor.locator('b')).toHaveText('bold words');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('clean');

    await expect(editor).toHaveText('clean');
    await expect(editor.locator('b')).toHaveCount(0);
    await expect(page.locator('#richToolbar [data-rich-cmd="bold"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('undo after the reset restores the deleted text', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('survives undo');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect.poll(() => innerHtml(editor)).toBe('<br>');

    // One undo takes back the typed-after text; a second brings the
    // deleted content back — the normalization must not have orphaned
    // the native history.
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => innerHtml(editor)).toBe('<br>');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor).toHaveText('survives undo');
  });

  test('a deliberately empty list survives — only deletes normalize', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    // Toggle a list on the empty caret: an intentional empty block.
    await page.locator('#richToolbar [data-rich-list="ul"]').click();
    await expect(editor.locator('ul > li')).toHaveCount(1);

    await page.keyboard.type('first item');
    await expect(editor.locator('ul > li')).toHaveText('first item');
  });
});
