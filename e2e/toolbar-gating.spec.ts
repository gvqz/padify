import { expect, test, type Page } from '@playwright/test';

/**
 * The toolbar's honesty pass (issue #165 + the caret-following color bars):
 *
 *  - the bars under the text-color and highlight buttons mirror the CARET
 *    (Docs' font-color button behavior), not the last color anyone picked —
 *    through picks, caret moves, reloads and theme flips;
 *  - gated commands speak instead of staying silent: clear formatting
 *    without a ranged selection, block formats inside list items / table
 *    cells, and block formats with no caret anywhere all raise the hint
 *    pill under the button that was clicked;
 *  - the caret-friendly quote still quotes, and the list toggles still
 *    apply at a bare caret — the gates only fire when the engine would
 *    refuse anyway.
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

async function noteHtml(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('#note')!.innerHTML);
}

/** The pad's STORED note bytes from IndexedDB — the persisted truth the
 *  reload will boot from. Waiting on this (not a timed sleep) makes the
 *  storage round trip below deterministic: the fixed 900 ms raced the
 *  400 ms input debounce + persist chain under load and the reload cut
 *  the write off. */
async function storedNoteHtml(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('padify');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('notes', 'readonly');
          const cursorRequest = tx.objectStore('notes').openCursor();
          const rows: string[] = [];
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              rows.push(String((cursor.value as { content?: unknown }).content ?? ''));
              cursor.continue();
            } else {
              resolve(rows.join('\n'));
              db.close();
            }
          };
        };
      }),
  );
}

/** Selects every occurrence-free text range `find`..+len inside the note. */
async function selectWord(page: Page, find: string): Promise<void> {
  await page.evaluate((needle) => {
    const note = document.getElementById('note')!;
    const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const index = (node.nodeValue ?? '').indexOf(needle);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      node = walker.nextNode() as Text | null;
    }
    throw new Error(`text not found: ${needle}`);
  }, find);
  await page.waitForTimeout(200);
}

/** Places a collapsed caret inside the element the selector matches. */
async function placeCaret(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate(
    ([sel, at]) => {
      const note = document.getElementById('note')!;
      const target = note.querySelector(sel as string) ?? note;
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node && (node.nodeValue ?? '').length < (at as number)) {
        node = walker.nextNode() as Text | null;
      }
      const range = document.createRange();
      if (node) {
        const raw = Math.min(at as number, (node as Text).nodeValue!.length);
        range.setStart(node, raw);
        range.setEnd(node, raw);
      } else {
        range.selectNodeContents(target);
        range.collapse(false);
      }
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [selector, offset],
  );
  await page.waitForTimeout(250); // the rAF-batched state refresh settles
}

async function inkBar(page: Page): Promise<string> {
  return page.evaluate(() =>
    document
      .querySelector<HTMLElement>('[data-rich-ink="color"]')!
      .style.getPropertyValue('--rich-ink'),
  );
}

async function hiliteBar(page: Page): Promise<string> {
  return page.evaluate(() =>
    document
      .querySelector<HTMLElement>('[data-rich-hilite]')!
      .style.getPropertyValue('--rich-hilite'),
  );
}

test.describe('caret-following color bars', () => {
  test('the bars mirror the caret through picks, moves and a reload', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('red here and plain here');

    // Ink "red her" red through the palette; the caret sits in the run.
    await selectWord(page, 'red her');
    await page.locator('#richToolbar [data-rich-menu="color"]').click();
    await page.locator('#richToolbar [data-rich-color="red"]').click();
    await expect.poll(() => noteHtml(page)).toContain('color: #ea4335');
    expect(await inkBar(page)).toBe('#ea4335');

    // The caret to the plain tail: the bar must give the color up (the old
    // glitch kept the last pick forever).
    await editor.press('Control+End');
    await expect.poll(() => inkBar(page)).toBe('');
    expect(await hiliteBar(page)).toBe('');

    // Highlight just the word "plain"; the swash bar paints; leaving the
    // word clears it again.
    await selectWord(page, 'plain');
    await page.locator('#richToolbar [data-rich-menu="highlight"]').click();
    await page.locator('#richToolbar [data-rich-highlight="#fff3bf"]').click();
    await expect.poll(() => noteHtml(page)).toContain('background-color: #fff3bf');
    expect(await hiliteBar(page)).toBe('#fff3bf');
    await editor.press('Control+End');
    await expect.poll(() => hiliteBar(page)).toBe('');
    expect(await inkBar(page)).toBe('');

    // Storage round trip: wait for the debounced persist to actually
    // land its bytes (the stored highlight run is the last pick), then
    // reload, park the caret in each run — both bars read the STORED
    // colors with no pick this session.
    await expect
      .poll(() => storedNoteHtml(page), { timeout: 10_000 })
      .toContain('background-color: #fff3bf');
    await page.reload();
    await placeCaret(page, 'span[style*="color"]', 3);
    // The bars follow the caret through an async selectionchange — poll,
    // don't read once (under load the read outran the engine).
    await expect.poll(() => inkBar(page)).toBe('#ea4335');
    await expect.poll(() => hiliteBar(page)).toBe('');
    await placeCaret(page, 'span[style*="background-color"]', 2);
    await expect.poll(() => inkBar(page)).toBe('');
    await expect.poll(() => hiliteBar(page)).toBe('#fff3bf');
  });

  test('a theme flip re-reads the caret ink (the engine re-inks the run)', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('colored words');
    await editor.press('Shift+Home');
    await page.locator('#richToolbar [data-rich-menu="color"]').click();
    await page.locator('#richToolbar [data-rich-color="red"]').click();
    await expect.poll(() => inkBar(page)).toBe('#ea4335');

    // Flip to dark through the real preferences UI. The modal takes the
    // caret with it — the bars reset while the caret is gone (there is no
    // "current value" outside the note).
    await page.keyboard.press('Control+,');
    const modal = page.locator('#preferencesModal');
    await expect(modal).toHaveClass(/in/);
    await modal.locator('label', { hasText: 'Dark' }).first().click();
    await expect(page.locator('body')).toHaveClass(/dark/);
    await page.keyboard.press('Escape');
    await expect.poll(() => inkBar(page)).toBe('');

    // Back in the note: the stored light red re-inked to the dark red, and
    // the bar reads the re-inked value.
    await page.locator('#note span').click();
    await expect.poll(() => inkBar(page)).toBe('#f28b82');

    // And back to light.
    await page.keyboard.press('Control+,');
    await expect(modal).toHaveClass(/in/);
    await modal.locator('label', { hasText: 'Light' }).first().click();
    await expect(page.locator('body')).not.toHaveClass(/dark/);
    await page.keyboard.press('Escape');
    await page.locator('#note span').click();
    await expect.poll(() => inkBar(page)).toBe('#ea4335');
  });

  test('the highlight menu marks the swatch the caret sits in', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('marked words');
    await editor.press('Shift+Home');
    await page.locator('#richToolbar [data-rich-menu="highlight"]').click();
    await page.locator('#richToolbar [data-rich-highlight="#d3f9d8"]').click();

    // Reopening marks the caret's highlight, Docs-style — the palette
    // swatch and its recents twin both carry the mark.
    await page.locator('#richToolbar [data-rich-menu="highlight"]').click();
    await expect(page.locator('[data-rich-highlight="#d3f9d8"]').first()).toHaveClass(
      /rich-menu-current/,
    );
    await page.keyboard.press('Escape');
  });
});

test.describe('the hint pill and the gates', () => {
  test('clear formatting without a selection raises the pill instead of silence', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('plain words');
    await editor.press('Control+End'); // a bare caret — no range

    await page.locator('#richToolbar [data-rich-cmd="removeFormat"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText('Select some text first');

    // Escape dismisses; with a real selection the command runs, no pill.
    await page.keyboard.press('Escape');
    await expect(page.locator('.rich-hint-pill')).toBeHidden();
    await editor.press('Shift+Home');
    await page.locator('#richToolbar [data-rich-cmd="removeFormat"]').click();
    await expect(page.locator('.rich-hint-pill')).toBeHidden();
  });

  test('block formats inside a list item speak instead of no-oping', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('an item');
    await page.locator('#richToolbar [data-rich-list="ul"]').click();
    await expect(editor.locator('ul > li')).toHaveText('an item');

    // Heading 1 inside the item: pill, note untouched.
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="h1"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText("Headings can't go inside list items");
    await expect.poll(() => noteHtml(page)).toBe('<ul><li>an item</li></ul>');

    // Normal text inside the item: the pill points at the list toggle.
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="p"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText(
      'To return a list item to plain text, toggle the list off.',
    );

    // Quote inside the item: its own word.
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="blockquote"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText("Quotes can't go inside list items");

    // Escape dismisses the pill.
    await page.keyboard.press('Escape');
    await expect(page.locator('.rich-hint-pill')).toBeHidden();
    await expect.poll(() => noteHtml(page)).toBe('<ul><li>an item</li></ul>');
  });

  test('a block format inside a table cell raises the cell hint', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('line one');
    await page.locator('#richToolbar [data-rich-menu="table"]').click();
    await page.locator('#richToolbar [data-rich-grid="0,0"]').click();
    await editor.pressSequentially('in cell');
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="h2"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText(
      "Headings can't go inside table cells",
    );
    // The note is untouched — no stray empty block appears after the table
    // (that wrong-block conversion was the old silence's uglier sibling).
    await expect.poll(() => noteHtml(page)).not.toContain('<h2>');
    await expect.poll(() => noteHtml(page)).not.toContain('<h1');
  });

  test('a block format with no caret anywhere raises the selection hint', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    // Throw the selection onto the tab strip — the note holds no caret.
    await page.evaluate(() => {
      const strip = document.getElementById('tabStripTabs')!;
      const range = document.createRange();
      range.selectNodeContents(strip);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(250);
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="h1"]').click();
    await expect(page.locator('.rich-hint-pill')).toHaveText('Select some text first');
    await expect.poll(() => noteHtml(page)).toBe('');
  });

  test('the caret-friendly quote still quotes at a bare caret', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('quoted line');
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="blockquote"]').click();
    await expect.poll(() => noteHtml(page)).toContain('<blockquote>quoted line</blockquote>');

    // The quote toggle OFF: the active block returns to plain.
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('#richToolbar [data-rich-block="blockquote"]').click();
    await expect.poll(() => noteHtml(page)).toContain('quoted line');
    await expect.poll(() => noteHtml(page)).not.toContain('<blockquote>');
  });

  test('the list toggles still apply at a bare caret', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);
    const editor = page.locator('#note');
    await editor.click();
    await editor.pressSequentially('listed');
    await page.locator('#richToolbar [data-rich-list="ol"]').click();
    await expect(editor.locator('ol > li')).toHaveText('listed');
  });
});
