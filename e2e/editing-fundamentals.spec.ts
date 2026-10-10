import { expect, test, type Page } from '@playwright/test';

/**
 * Editing fundamentals — the gestures every note leans on, pinned against
 * the regressions that made the rich editor feel broken:
 *
 *  - typing after an undo (or a note switch) stays on the undo stack;
 *  - Backspace at the start of a list item leaves the list;
 *  - Enter on an empty quote line / a code block's trailing empty line
 *    leaves the style (the double-Enter exit);
 *  - the block-style buttons work on a fresh, empty note.
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

async function applyBlockStyle(page: Page, block: string): Promise<void> {
  await page.locator('[data-rich-menu="block"]').click();
  await page.locator(`[data-rich-block="${block}"]`).click();
}

async function noteHtml(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('#note')!.innerHTML);
}

test.describe('editing fundamentals', () => {
  test('typing after an undo stays on the undo stack', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('first burst');
    await expect(editor).toHaveText('first burst');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('');

    // THE regression: the burst flag once stayed armed after the undo, so
    // everything typed afterwards opened NO history group — the undo
    // button never lit and Ctrl+Z did nothing.
    await page.keyboard.type('second burst');
    const undoButton = page.locator('[data-rich-action="undo"]');
    await expect(undoButton).toHaveAttribute('aria-disabled', 'false');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('');
  });

  test('typing on a second note is undoable (the burst survives the switch)', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('note one words');

    // Switch to the first note and back — renderHtml resets the history,
    // and the burst flag must go with it.
    await createRichNote(page);
    await page.keyboard.type('note two words');
    await expect(editor).toHaveText('note two words');
    const undoButton = page.locator('[data-rich-action="undo"]');
    await expect(undoButton).toHaveAttribute('aria-disabled', 'false');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('');
  });

  test('Backspace at the start of a list item leaves the list (and undoes back)', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();

    await page.keyboard.type('lone item');
    await toolbar.locator('[data-rich-list="ul"]').click();
    await expect(editor.locator('ul > li')).toHaveText('lone item');

    // Home puts the caret at the item's start — native Chromium NO-OPs a
    // Backspace there; the engine must lift the item out instead.
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('ul')).toHaveCount(0);
    await expect(editor.locator('div')).toHaveText('lone item');

    // The lift is one command — one undo brings the list back.
    await page.keyboard.press('Control+z');
    await expect(editor.locator('ul > li')).toHaveText('lone item');
  });

  test('Enter on an empty quote line leaves the quote', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('quoted words');
    await page.keyboard.press('Control+a');
    await applyBlockStyle(page, 'blockquote');
    await expect(editor.locator('blockquote')).toHaveText('quoted words');

    // Enter continues the quote (Docs), Enter on the EMPTY line it made
    // leaves it — the user could not escape before.
    await editor.press('End');
    await page.keyboard.press('Enter');
    await expect(editor.locator('blockquote')).toHaveCount(2);
    await page.keyboard.press('Enter');
    await expect((await noteHtml(page)).startsWith('<blockquote>quoted words</blockquote><p')).toBe(
      true,
    );
    await page.keyboard.type('out of the quote');
    await expect(editor.locator('p')).toHaveText('out of the quote');
    await expect(editor.locator('blockquote')).toHaveCount(1);
  });

  test('Enter on the code block\u2019s trailing empty line leaves the code', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('const x = 1;');
    await page.keyboard.press('Control+a');
    await applyBlockStyle(page, 'pre');
    await expect(editor.locator('pre')).toHaveText('const x = 1;');

    // Enter at the code's end adds a code line (native); Enter on the
    // empty line it made leaves the block — the code keeps its text.
    await editor.press('End');
    await page.keyboard.press('Enter');
    const afterFirstEnter = await editor.locator('pre').innerHTML();
    await expect(afterFirstEnter).toContain('const x = 1;<br>');
    await page.keyboard.press('Enter');
    await page.keyboard.type('back to plain');
    await expect(editor.locator('pre')).toHaveText('const x = 1;');
    await expect(editor.locator('p')).toHaveText('back to plain');
  });

  test('the block-style buttons work on an empty note', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();

    // A fresh note takes a heading: the block materializes empty, and
    // the typing lands inside it (these were silent no-ops before).
    await applyBlockStyle(page, 'h1');
    await page.keyboard.type('Fresh title');
    await expect(editor.locator('h1')).toHaveText('Fresh title');

    // Same for the code block on a fresh note.
    await createRichNote(page);
    await editor.click();
    await applyBlockStyle(page, 'pre');
    await page.keyboard.type('git status');
    await expect(editor.locator('pre')).toHaveText('git status');
  });
});
