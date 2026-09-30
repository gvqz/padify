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

    // The skeleton is gone — truly empty, not even Chrome's bare br — the
    // placeholder is back, and typing continues as plain text, not as
    // another heading.
    await expect.poll(() => innerHtml(editor)).toBe('');
    await expect
      .poll(() => editor.evaluate((node) => getComputedStyle(node, '::before').content !== 'none'))
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
    await expect.poll(() => innerHtml(editor)).toBe('');

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
    await expect.poll(() => innerHtml(editor)).toBe('');

    // One undo takes back the typed-after text; a second brings the
    // deleted content back — the normalization must not have orphaned
    // the native history.
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => innerHtml(editor)).toBe('');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor).toHaveText('survives undo');
  });

  test('after deleting everything the caret sits on the first line', async ({ page }) => {
    // The bare `<br>` Chrome leaves behind used to park the caret one line
    // BELOW the placeholder while the first typed character jumped back UP
    // to replace the br — the reported "cursor is on the line before".
    // A truly empty surface keeps caret, placeholder and first character
    // on one line (fresh notes are born this way).
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('xxx');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect.poll(() => innerHtml(editor)).toBe('');

    // The caret anchors at the very start of the surface — the only
    // position that renders on the same line the placeholder painted.
    const caret = await editor.evaluate((node) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      return {
        atStart: range.startContainer === node && range.startOffset === 0,
        collapsed: range.collapsed,
      };
    });
    expect(caret).toEqual({ atStart: true, collapsed: true });

    // Typing continues on that same line: the text replaces nothing —
    // no leftover br, no stray wrapper — and lands at the content edge.
    await page.keyboard.type('x');
    await expect.poll(() => innerHtml(editor)).toBe('x');
    const xTop = await editor.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().top;
    });
    const contentEdge = await editor.evaluate(
      (node) => node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).paddingTop),
    );
    expect(Math.abs(xTop - contentEdge)).toBeLessThan(5);
  });

  test('a stored note emptied to a bare br opens with a normalized surface', async ({ page }) => {
    // Pre-fix notes can store Chrome's bare `<br>` as their empty state.
    // Opening one must display the same normalized surface as a truly
    // empty note (visual only — opening never writes).
    await page.goto('/');
    await createRichNote(page);
    // Give the note content so it definitely persists, then rewrite its
    // stored html the way a pre-fix build would have stored a delete-all.
    await page.locator('#note').click();
    await page.keyboard.type('seed');
    await page.waitForTimeout(700);
    const noteId = await page.evaluate(async () => {
      // Rewrite the stored html of the active (only) rich note the way a
      // pre-fix build would have stored it after a delete-all.
      const request = indexedDB.open('padify', 1);
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = database.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const all: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
        const read = store.getAll();
        read.onsuccess = () => resolve(read.result as Array<Record<string, unknown>>);
        read.onerror = () => reject(read.error);
      });
      const rich = all.find((row) => row.noteType === 'rich') as Record<string, unknown>;
      rich.html = '<br>';
      store.put(rich);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
      return String(rich.id);
    });

    // Reopen — loadActiveIntoEditor normalizes the legacy empty state.
    await page.reload();
    await expect(page.locator('#richToolbar')).toBeVisible();

    const html = await page.locator('#note').evaluate((node) => node.innerHTML);
    expect(html).toBe('');
    const placeholder = await page
      .locator('#note')
      .evaluate((node) => getComputedStyle(node, '::before').content !== 'none');
    expect(placeholder).toBe(true);
    expect(noteId).toBeTruthy();
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
