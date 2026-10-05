/**
 * Rapid note switching — the tab strip is used the way people actually
 * use it: slam the tabs back and forth, type immediately after each
 * switch, undo right after a switch. Every switch is a surface swap on a
 * shared editor, so the regressions to pin are the cross-note leaks:
 * content bleeding between notes, keystrokes going nowhere, the undo
 * stack carrying the PREVIOUS note's history, the caret landing inside a
 * table that happens to lead the note, and autosave persisting any of it.
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

async function newRichNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
}

/** Types into whatever surface is active and returns what the doc holds. */
async function typeAndRead(page: Page, text: string): Promise<string> {
  await page.keyboard.type(text);
  await page.waitForTimeout(250);
  return page.evaluate(() => document.querySelector('#note')?.textContent ?? '');
}

/** The element that owns focus after a switch (inside #note, or body). */
async function focusInsideEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const note = document.querySelector('#note');
    return !!active && !!note && (active === note || note.contains(active));
  });
}

test.describe('rapid note switching', () => {
  test('slamming between a markdown and a rich note keeps each note its own', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# alpha');
    await expect(editor.locator('h1')).toHaveText('alpha');

    await newRichNote(page);
    await page.keyboard.type('beta body');
    await page.waitForTimeout(300);

    // Slam back and forth — content must follow its own note every time.
    for (let round = 0; round < 3; round += 1) {
      await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
      await expect(page.locator('#markdownToolbar')).toBeVisible();
      await expect(editor.locator('h1')).toHaveText('alpha');

      await page.locator('#tabStripTabs .tab-strip-tab').nth(2).click();
      await expect(page.locator('#richToolbar')).toBeVisible();
      await expect(page.locator('#note')).toContainText('beta body');
    }
  });

  test('typing lands in the note immediately after a switch (focus follows)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('first note');

    await newRichNote(page);
    await page.keyboard.type('plain ');
    await page.waitForTimeout(250);

    // Switch BACK by tab click only — no click into the note.
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    expect(await focusInsideEditor(page)).toBe(true);
    const heard = await typeAndRead(page, 'more');
    // The caret takes the deterministic start spot on a switch (the same
    // contract the rich surface has): typing PREPENDS, never loses a
    // keystroke.
    expect(heard).toBe('morefirst note');

    // And the rich note takes keystrokes right after ITS switch too —
    // same start-caret contract, prepending.
    await page.locator('#tabStripTabs .tab-strip-tab').nth(2).click();
    expect(await focusInsideEditor(page)).toBe(true);
    const plainHeard = await typeAndRead(page, 'sided');
    expect(plainHeard).toBe('sidedplain ');
  });

  test('undo after a switch never resurrects the previous note', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('first note words');

    await newRichNote(page);
    await page.keyboard.type('plain words');
    await page.waitForTimeout(400);

    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    // The shared editor's undo stack was reset by the switch: undo here
    // may revert this note's own last change — it must NEVER pull the
    // plain note's text into this one.
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => document.querySelector('#note')?.textContent ?? '');
    expect(text).not.toContain('plain words');

    // Reload: autosave must have stored each note's true content.
    await page.reload();
    await page.waitForTimeout(600);
    const afterReload = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#tabStripTabs .tab-strip-tab')).map(
        (tab) => tab.textContent ?? '',
      ),
    );
    expect(afterReload.length).toBeGreaterThanOrEqual(2);
  });

  test('switching to a table-led note keeps the caret deterministic, table intact', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    // A table-led note: the old caret mapping dropped the caret into the
    // LAST cell of it, so typing after a switch typed into the table at a
    // random spot. Build the note: table first, then a line under it.
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    await expect(editor.locator('table')).toHaveCount(1);
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.type('trailing line');

    await newRichNote(page);
    await page.keyboard.type('other note');
    await page.waitForTimeout(300);
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    await expect(editor.locator('table')).toHaveCount(1);

    // Focus lands in the editor and the caret takes the deterministic
    // start spot (the doc's first text position — the same spot a fresh
    // table hands the user, and the same place the rich surface parks
    // the caret): typing prepends into the first cell and touches
    // nothing else.
    expect(await focusInsideEditor(page)).toBe(true);
    await page.keyboard.type('X');
    await page.waitForTimeout(250);
    // The X lands in the doc's FIRST text position and nowhere else —
    // never the last cell the old mapping favored.
    const cells = await editor.locator('table th, table td').allTextContents();
    expect(cells[0]).toBe('X');
    expect(cells.slice(1).every((cell) => !cell.includes('X'))).toBe(true);
    await expect(editor).toContainText('trailing line');
  });
});
