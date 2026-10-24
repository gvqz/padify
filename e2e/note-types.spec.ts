import { expect, test, type Page } from '@playwright/test';

/**
 * Note types — the creation flow and the rich text toolbar.
 *
 * The default path must not move: "New note" (one click) still creates a
 * standard note with no toolbar. Rich notes opt in through the chevron
 * menu, show the formatting toolbar, and their markup must survive the
 * storage round trip (sanitize-on-load included).
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

async function openTypeMenu(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await expect(page.locator('#addTabTypeMenuPopover')).toBeVisible();
}

test.describe('note types', () => {
  test('plain "New note" keeps creating standard notes with no toolbar', async ({ page }) => {
    await page.goto('/');

    await page.locator('#addTab').click();
    await expect(page.locator('#note')).toHaveText('');

    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-type')).toHaveCount(0);
    await expect(page.locator('#richToolbar')).toBeHidden();
  });

  test('the chevron menu lists the note types from the registry', async ({ page }) => {
    await page.goto('/');
    await openTypeMenu(page);

    const popover = page.locator('#addTabTypeMenuPopover');
    await expect(popover.locator('.tab-type-menu-item', { hasText: 'Plain note' })).toBeVisible();
    await expect(
      popover.locator('.tab-type-menu-item', { hasText: 'Rich text note' }),
    ).toBeVisible();
    await expect(
      popover.locator('.tab-type-menu-item', { hasText: 'Markdown note' }),
    ).toBeVisible();
    await expect(popover.locator('.tab-type-menu-item', { hasText: 'Task list' })).toBeVisible();
    await expect(popover.locator('.tab-type-menu-item', { hasText: 'Drawing' })).toBeVisible();

    // Escape closes and returns focus to the trigger.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.locator('#addTabTypeMenu')).toBeFocused();
  });

  test('the type menu navigates with menu keys and activates with Enter', async ({ page }) => {
    await page.goto('/');
    const popover = page.locator('#addTabTypeMenuPopover');

    await page.locator('#addTabTypeMenu').click();
    await expect(popover).toBeVisible();

    // Arrows rove focus (from the trigger into the list, wrapping), Home/End jump.
    await page.keyboard.press('ArrowDown');
    await expect(popover.locator('.tab-type-menu-item').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(popover.locator('.tab-type-menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // five types now — four downs reach the last
    await expect(popover.locator('.tab-type-menu-item').last()).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps to the first item
    await expect(popover.locator('.tab-type-menu-item').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(popover.locator('.tab-type-menu-item').last()).toBeFocused();

    // Enter activates the focused item — the rich note is created.
    await page.keyboard.press('ArrowDown'); // last wraps forward to the first
    await expect(popover.locator('.tab-type-menu-item').first()).toBeFocused();
    await page.keyboard.press('ArrowDown'); // onto "Rich text note"
    await page.keyboard.press('Enter');
    await expect(popover).toBeHidden();
    await expect(page.locator('#richToolbar')).toBeVisible();
  });

  test('a rich note gets the toolbar, formats through it, and survives a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await openTypeMenu(page);
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();

    // The new note is active, badged, and shows the toolbar.
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-type')).toHaveCount(1);
    const toolbar = page.locator('#richToolbar');
    await expect(toolbar).toBeVisible();

    // Type a line and turn it into a heading via the toolbar.
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('Quarterly roadmap');
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-menu="block"]').click();
    await toolbar.locator('[data-rich-block="h1"]').click();
    await expect(editor.locator('h1')).toHaveCount(1);

    // Bold a word through the toolbar (keyboard word-selection — a dblclick
    // on text= resolves to the editor element itself, not the word).
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ship today');
    await page.keyboard.press('Control+Shift+ArrowLeft'); // selects "today"
    await toolbar.locator('[data-rich-cmd="bold"]').click();
    await expect(editor.locator('b')).toHaveCount(1);
    await expect(editor.locator('b')).toHaveText('today');

    // Persist (400ms debounce), reload, everything must come back.
    await page.waitForTimeout(900);
    await page.reload();
    const reloaded = page.locator('#note');
    await expect(reloaded.locator('h1')).toContainText('Quarterly roadmap');
    await expect(reloaded.locator('b')).toHaveCount(1);
    // The active note is still rich: the toolbar is visible after boot.
    await expect(page.locator('#richToolbar')).toBeVisible();
  });

  test('a drawing note opens the canvas and badges the strip', async ({ page }) => {
    // The canvas phase (docs/DRAWINGPAD_PLAN.md): the type is real end to
    // end — creatable, badged, titled — and opening it mounts the
    // Excalidraw island (a lazy chunk on first drawing note). The note
    // must present as a drawing everywhere the type is visible, and never
    // as an editable text surface.
    await page.goto('/');
    await openTypeMenu(page);
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' })
      .click();

    // The new note is active, carries the pencil badge, and derives its
    // strip title from the registry label (no name, empty content).
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-type')).toHaveCount(1);
    await expect(activeTab.locator('.tab-strip-title')).toHaveText('Drawing');

    // The host is not editable text: the canvas wrapper mounts and the
    // Excalidraw island lands in it (the chunk rides the first drawing).
    await expect(page.locator('#note [data-drawing-canvas]')).toBeVisible();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#richToolbar')).toBeHidden();
  });

  test('switching between notes shows and hides the toolbar', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');

    // Rich note.
    await openTypeMenu(page);
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();

    // The first (welcome/standard) note — toolbar hides again.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#richToolbar')).toBeHidden();

    // And back to the rich note — toolbar returns.
    await page.locator('#tabStripTabs .tab-strip-tab').last().click();
    await expect(page.locator('#richToolbar')).toBeVisible();
    await expect(editor).toBeVisible();
  });

  test('pressed states clear while the selection is outside the note', async ({ page }) => {
    await page.goto('/');
    await openTypeMenu(page);
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('code line');
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-menu="block"]').click();
    await toolbar.locator('[data-rich-block="pre"]').click();
    await expect(editor.locator('pre')).toHaveCount(1);
    // The styles button echoes the caret's block format, Docs-style.
    await expect(toolbar.locator('[data-rich-label="block"]')).toHaveText('Code block');

    // A selection that no longer lives in the note (document replaced, user
    // clicked elsewhere) must not keep the caret's pressed states lit.
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.word-count-container p')!);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await expect(toolbar.locator('[aria-pressed="true"]')).toHaveCount(0);

    // Caret back inside the note (a real click — Chrome clamps below-content
    // clicks into the last block, the code block) — the states re-sync.
    await editor.click();
    await expect(toolbar.locator('[data-rich-label="block"]')).toHaveText('Code block');
  });

  test('the link toolbar flow wraps the selected text', async ({ page }) => {
    await page.goto('/');
    await openTypeMenu(page);
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('read the docs');
    // Select the last word ("docs") — keyboard only, a dblclick on text=
    // resolves to the editor element instead of the word.
    await page.keyboard.press('Control+Shift+ArrowLeft');
    await page.locator('#richLinkButton').click();
    await page.locator('#richLinkInput').fill('https://example.com/docs');
    await page.locator('#richLinkApply').click();

    // The word is wrapped — not replaced with the href.
    await expect(editor.locator('a[href="https://example.com/docs"]')).toHaveCount(1);
    await expect(editor.locator('a')).toHaveText('docs');
    await expect(page.locator('#richLinkPopover')).toBeHidden();

    // A collapsed caret now pastes the URL itself as linked text (Docs'
    // paste-a-link gesture) instead of the old dead-end guidance.
    // Home parks the caret at the note start, outside any anchor (the anchor
    // is the note's last block, so End would clamp back INSIDE it).
    await page.keyboard.press('Home');
    await page.locator('#richLinkButton').click();
    await page.locator('#richLinkInput').fill('https://example.com/stray');
    await page.locator('#richLinkApply').click();
    await expect(editor.locator('a[href="https://example.com/stray"]')).toHaveText(
      'https://example.com/stray',
    );

    // Clicking the link floats its chip right under it (links.spec pins the
    // full gesture); Edit reveals the prefilled input and applying
    // retargets the existing anchor in place.
    await editor.locator('a').first().click();
    await expect(page.locator('#richLinkPopover')).toBeVisible();
    await expect(page.locator('#richLinkView')).toHaveText('https://example.com/stray');
    await page.locator('#richLinkEdit').click();
    await expect(page.locator('#richLinkInput')).toHaveValue('https://example.com/stray');
    await page.locator('#richLinkInput').fill('https://example.com/docs/v2');
    await page.locator('#richLinkApply').click();

    await expect(editor.locator('a[href="https://example.com/docs/v2"]')).toHaveCount(1);
    await expect(editor.locator('a[href="https://example.com/docs/v2"]')).toHaveText(
      'https://example.com/stray',
    );
  });
});
