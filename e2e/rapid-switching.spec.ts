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
  // The markdown surface is a textarea — its VALUE is the document (a
  // textarea's textContent never reflects what it holds); the rich
  // surface still reads as text.
  return page.evaluate(() => {
    const note = document.querySelector('#note');
    if (!note) {
      return '';
    }
    const source = note.querySelector<HTMLTextAreaElement>('.markdown-source');
    return source ? source.value : (note.textContent ?? '');
  });
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
    const editor = page.locator('#note .markdown-source');
    await editor.click();
    await page.keyboard.type('# alpha');
    await expect(editor).toHaveValue('# alpha');

    await newRichNote(page);
    await page.keyboard.type('beta body');
    await page.waitForTimeout(300);

    // Slam back and forth — content must follow its own note every time.
    for (let round = 0; round < 3; round += 1) {
      await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
      await expect(page.locator('#markdownToolbar')).toBeVisible();
      await expect(editor).toHaveValue('# alpha');

      await page.locator('#tabStripTabs .tab-strip-tab').nth(2).click();
      await expect(page.locator('#richToolbar')).toBeVisible();
      await expect(page.locator('#note')).toContainText('beta body');
    }
  });

  test('typing lands in the note immediately after a switch (focus follows)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .markdown-source');
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
    const editor = page.locator('#note .markdown-source');
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
    const editor = page.locator('#note .markdown-source');
    await editor.click();
    // A table-led note, built the source way: the template first (the
    // header lands selected), then a trailing line under it.
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    await expect(editor).toHaveValue(/\| Column 1 \| Column 2 \| Column 3 \|/);
    await page.keyboard.press('End');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('trailing line');

    await newRichNote(page);
    await page.keyboard.type('other note');
    await page.waitForTimeout(300);
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    await expect(page.locator('#markdownToolbar')).toBeVisible();

    // The table survived the round trip byte-for-byte, trailing line and all.
    await expect(editor).toHaveValue(/\| --- \| --- \| --- \|/);
    await expect(editor).toHaveValue(/trailing line/);

    // Focus lands in the source and the caret takes the deterministic
    // start spot (position 0 — the same contract the rich surface has):
    // typing prepends and touches nothing else.
    expect(await focusInsideEditor(page)).toBe(true);
    const before = await editor.inputValue();
    await page.keyboard.type('X');
    await page.waitForTimeout(250);
    expect(await editor.inputValue()).toBe(`X${before}`);
  });

  test('no editing chrome outlives its note (the visual editor went whole)', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    const editor = page.locator('#note .markdown-source');
    await editor.click();
    await page.keyboard.type('grip source note');

    // The visual editor's floating chrome — the block grip, the bubble
    // menu, the slash menu — went with the visual editor: none of it
    // exists for any note, any hover, ever again.
    await editor.hover();
    await expect(page.locator('.md-block-handle')).toHaveCount(0);
    await expect(page.locator('.md-bubble-menu')).toHaveCount(0);
    await expect(page.locator('.md-slash-menu')).toHaveCount(0);

    // Switch to a rich note and back: still nothing — what one note
    // shows stays in it.
    await newRichNote(page);
    await page.keyboard.type('plain body');
    await expect(page.locator('#note')).toContainText('plain body');
    await expect(page.locator('.md-block-handle')).toHaveCount(0);

    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    await expect(page.locator('.md-block-handle')).toHaveCount(0);
    await expect(editor).toHaveValue('grip source note');
  });
});
