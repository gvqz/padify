import { expect, test, type Page } from '@playwright/test';

/**
 * The Tab key, end to end — the tab-gesture bug family the owner called
 * "MANY tab bugs" (the report's file retired into git history; this suite
 * is the pin).
 *
 * The regression this suite exists for: a bare text stream (plain words
 * typed into a classic note that never grows element blocks) is ONE
 * model block, so a block-indent Tab used to step the margin of the
 * whole document from a single press. The bare stream now takes the
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

/** The caret's stream offset on the note surface (visible chars before it). */
async function caretOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.getElementById('note');
    const selection = window.getSelection();
    if (!host || !selection || selection.rangeCount === 0) {
      return -1;
    }
    const range = document.createRange();
    range.selectNodeContents(host);
    range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    return range.toString().replace(/\u200B/g, '').length;
  });
}

test.describe('the Tab key', () => {
  test('the bare boot note takes a literal tab, never a document-wide margin', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await expect(editor).toBeVisible();

    // The boot note is a blank classic note — a bare stream waiting for
    // words. Give it some, then indent from the very start.
    await editor.click();
    await page.keyboard.type('Welcome! Padify takes a literal tab');
    await expect(editor).toContainText('Welcome! Padify takes');

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

  // The reported typing bug, end to end on the real keyboard: type → Tab
  // → Ctrl+Z → Ctrl+Y. Undo and redo restore the state AND the caret
  // that state was left with — the live-offset restore used to drop the
  // caret INSIDE the line on redo, and the next keystroke typed between
  // the word and its tab.
  test('undo and redo walk the caret with the tab (Ctrl+Z / Ctrl+Y)', async ({ page }) => {
    await page.goto('/');
    await createNoteOfType(page, 'standard');

    await page.keyboard.type('hello');
    await page.keyboard.press('Tab'); // "\thello", caret after the tab
    expect(await caretOffset(page)).toBe(6);

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');

    expect(await caretOffset(page)).toBe(6); // the drift left it at 5
    await page.keyboard.type('X');
    const text = ((await page.locator('#note').textContent()) ?? '').replace(/\u200B/g, '');
    expect(text.endsWith('hello\tX')).toBe(true); // the drift typed "helloX\t"
  });

  test('undo of a line-start tab returns the caret to the line start', async ({ page }) => {
    await page.goto('/');
    await createNoteOfType(page, 'standard');

    await page.keyboard.type('hello');
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab'); // "\thello", caret 1
    expect(await caretOffset(page)).toBe(1);

    await page.keyboard.press('Control+z');
    expect(await caretOffset(page)).toBe(0); // the drift left it at 1, after the 'h'

    await page.keyboard.press('Control+y');
    expect(await caretOffset(page)).toBe(1);
  });
});
