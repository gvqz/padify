import { expect, test, type Page } from '@playwright/test';

/**
 * The Tab key, end to end — the gestures tasks.txt called "MANY tab bugs".
 *
 * The regression this suite exists for: a bare text stream (the welcome
 * note — a classic note that never grew element blocks) is ONE model
 * block, so a block-indent Tab used to step the margin of the whole
 * document from a single press. The bare stream now takes the
 * line-oriented literal tab, element blocks keep the Docs margin step,
 * and the markdown surface keeps the caret instead of handing focus to
 * the topbar.
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

async function createNoteOfType(page: Page, typeId: string): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page.locator(`#addTabTypeMenuPopover [data-note-type="${typeId}"]`).click();
  await page.locator('#note').focus();
}

test.describe('the Tab key', () => {
  test('the welcome note takes a literal tab, never a document-wide margin', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await expect(editor).toContainText('Welcome! Padify is an offline-capable notepad');

    await editor.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Tab');

    // The stream stays a stream: no margin block materialized anywhere,
    // and the tab landed in the text.
    await expect(editor.locator('[style*="margin-left"]')).toHaveCount(0);
    const text = (await editor.textContent()) ?? '';
    expect(text.startsWith('\tWelcome!')).toBe(true);
  });

  test('rich notes step only the caret block', async ({ page }) => {
    await page.goto('/');
    await createNoteOfType(page, 'rich');

    const editor = page.locator('#note');
    await page.keyboard.type('first block');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second block');
    await page.keyboard.press('Tab');

    const indented = editor.locator('div[style*="margin-left"]');
    await expect(indented).toHaveCount(1);
    await expect(indented).toHaveText('second block');
    // The first block kept its position — only the caret block moved.
    await expect(editor).toContainText('first block');

    // Docs parity on Backspace (the selecting/backspacing-tabs task): the
    // first press at the indented block's start unwinds the indent ONLY —
    // the native delete merged the block into the line above in one press
    // and littered the merge with span wrappers. The caret also stays on
    // the (formerly indented) block: a numeric restore of the boundary
    // offset resolved to the previous line's end, and the second press
    // ate ITS last character.
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('div[style*="margin-left"]')).toHaveCount(0);
    // 'first block' stayed root text; 'second block' keeps its own block.
    await expect(editor.locator('div')).toHaveText(['second block']);
    await expect(editor.locator('span[style*="background-color"]')).toHaveCount(0);

    // The next press merges — the line above loses nothing.
    await page.keyboard.press('Backspace');
    await expect(editor.locator('div')).toHaveCount(0);
    await expect(editor).toHaveText('first blocksecond block');

    // ... and a third press deletes the character BEFORE the seam — the
    // 'k' of 'first block' (the caret survived the unindent + merge).
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveText('first blocsecond block');
  });

  test('list items nest and lift with Tab / Shift+Tab', async ({ page }) => {
    await page.goto('/');
    await createNoteOfType(page, 'rich');

    await page.keyboard.type('parent item');
    await page.keyboard.press('Control+Shift+7');
    await page.keyboard.press('Enter');
    await page.keyboard.type('child item');
    await page.keyboard.press('Tab');

    const editor = page.locator('#note');
    const nested = editor.locator('li ul li');
    await expect(nested).toHaveCount(1);
    await expect(nested).toHaveText('child item');

    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator('li ul li')).toHaveCount(0);
    await expect(editor.locator('ul > li')).toHaveCount(2);
  });

  test('markdown source keeps the caret and indents the line', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addTabTypeMenu').click();
    await page.locator('#addTabTypeMenuPopover [data-note-type="markdown"]').click();

    const surface = page.locator('#note .markdown-source');
    await expect(surface).toBeVisible();
    await surface.click();
    await page.keyboard.type('prose line');
    await page.keyboard.press('Tab');

    // The line indented two spaces (the source grammar's marker width).
    expect(await surface.inputValue()).toBe('  prose line');
    // The gesture must not hand focus to the topbar (the old behavior
    // ejected the author from the note mid-sentence).
    const focusInEditor = () =>
      page.evaluate(() => document.activeElement?.classList.contains('markdown-source'));
    expect(await focusInEditor()).toBe(true);

    await page.keyboard.press('Shift+Tab');
    expect(await surface.inputValue()).toBe('prose line');
    expect(await focusInEditor()).toBe(true);
  });
});
