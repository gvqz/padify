import { expect, test, type Page } from '@playwright/test';

/**
 * The Docs-style toolbar vocabulary and the floating-window gating.
 *
 * Everything here runs the REAL UI paths (menus, palettes, buttons,
 * shortcuts) and then insists the markup survives the storage round trip
 * — the sanitizer must keep exactly what the controls produce.
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

test.describe('docs toolbar', () => {
  test('size, color, alignment, divider and superscript survive a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('Styled line');

    // Font size 24 through the dropdown.
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-menu="size"]').click();
    await toolbar.locator('[data-rich-size="24"]').click();
    await expect(editor.locator('span')).toHaveCSS('font-size', '24px');

    // Text color through the palette (re-select the line first — the size
    // command may leave the selection where the engine decided). Chrome
    // nests the color run INSIDE the size span, so both assertions read the
    // innermost span carrying the text (inheritance included).
    const runStyle = (prop: string): Promise<string> =>
      page.evaluate((p) => {
        const spans = Array.from(document.querySelectorAll('#note span'));
        const innermost = spans.reverse().find((span) => span.textContent === 'Styled line');
        return innermost ? getComputedStyle(innermost).getPropertyValue(p) : '';
      }, prop);

    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-menu="color"]').click();
    // The palette carries theme KEYS (auto dark/light re-inking); blue
    // resolves to #4285f4 in light mode.
    await toolbar.locator('[data-rich-color="blue"]').click();
    expect(await runStyle('color')).toBe('rgb(66, 133, 244)');

    // Alignment through the alignment group.
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-action="align-center"]').click();
    await expect(
      editor.locator('div', { hasText: 'Styled line' }).first(),
    ).toHaveCSS('text-align', 'center');

    // The caret label echoes the styled run, Docs-style.
    await editor.locator('span').first().click();
    await expect(toolbar.locator('[data-rich-label="size"]')).toHaveText('24');

    // A divider at a collapsed caret, then a superscript word.
    await editor.press('Control+End');
    await page.keyboard.press('Enter');
    await toolbar.locator('[data-rich-action="hr"]').click();
    await expect(editor.locator('hr')).toHaveCount(1);

    await page.keyboard.press('Enter');
    await page.keyboard.type('ten to the 4');
    await page.keyboard.press('Control+Shift+ArrowLeft'); // selects "4"
    await toolbar.locator('[data-rich-action="sup"]').click();
    await expect(editor.locator('sup')).toHaveText('4');

    // Persist, reload, everything comes back through the sanitizer.
    await page.waitForTimeout(900);
    await page.reload();
    const reloaded = page.locator('#note');
    expect(await runStyle('font-size')).toBe('24px');
    expect(await runStyle('color')).toBe('rgb(66, 133, 244)');
    await expect(
      reloaded.locator('div', { hasText: 'Styled line' }).first(),
    ).toHaveCSS('text-align', 'center');
    await expect(reloaded.locator('hr')).toHaveCount(1);
    await expect(reloaded.locator('sup')).toHaveText('4');
    await expect(page.locator('#richToolbar')).toBeVisible();
  });

  test('undo and redo buttons step the native history', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('hold this');
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-cmd="bold"]').click();
    await expect(editor.locator('b')).toHaveText('hold this');

    await toolbar.locator('[data-rich-action="undo"]').click();
    await expect(editor.locator('b')).toHaveCount(0);
    await expect(editor).toContainText('hold this');

    await toolbar.locator('[data-rich-action="redo"]').click();
    await expect(editor.locator('b')).toHaveText('hold this');
  });

  test('the font menu applies a family and the label follows the caret', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('serif moment');
    await editor.press('Control+End');
    await editor.press('Shift+Home');

    await toolbar.locator('[data-rich-menu="font"]').click();
    await toolbar.locator('[data-rich-font="Georgia"]').click();
    await expect(editor.locator('span')).toHaveCSS('font-family', 'Georgia');

    await editor.locator('span').first().click();
    await expect(toolbar.locator('[data-rich-label="font"]')).toHaveText('Georgia');
  });

  test('dropdown menus rove with arrows and Escape returns to the note', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const toolbar = page.locator('#richToolbar');
    const sizeButton = toolbar.locator('[data-rich-menu="size"]');
    const panel = toolbar.locator('.rich-menu-panel-sizes');

    await sizeButton.click();
    await expect(panel).toBeVisible();
    // Opening focuses the first item; the sizes grid is 2 columns —
    // Right/Left step one cell, Down/Up jump a row, Home/End the edges.
    await expect(panel.locator('[data-rich-size="8"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(panel.locator('[data-rich-size="9"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(panel.locator('[data-rich-size="11"]')).toBeFocused();
    await page.keyboard.press('End');
    await expect(panel.locator('[data-rich-size="96"]')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(sizeButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#note')).toBeFocused();
  });

  test('Tab and Shift+Tab indent and outdent inside lists', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('one\ntwo\nthree');
    await editor.press('Control+A');
    await toolbar.locator('[data-rich-list="ul"]').click();
    await expect(editor.locator('ul > li')).toHaveCount(3);

    // Caret into "two", Tab nests it under "one".
    await editor.locator('ul > li', { hasText: 'two' }).click();
    await page.keyboard.press('Tab');
    await expect(editor.locator('ul ul li')).toHaveText('two');

    // Shift+Tab unnests — and no literal tab character was typed anywhere.
    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator('ul ul')).toHaveCount(0);
    await expect(editor.locator('ul > li')).toHaveCount(3);
  });

  test('indent steps a plain block and survives the sanitizer', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('indented paragraph');
    await editor.press('Control+End');
    await editor.press('Shift+Home');

    await toolbar.locator('[data-rich-action="indent"]').click();
    await expect(editor.locator('div').first()).toHaveCSS('margin-left', '40px');

    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.locator('#note div').first()).toHaveCSS('margin-left', '40px');
  });

  test('a size picked at a collapsed caret styles what is typed next', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('before');

    // Chrome ignores fontSize at a collapsed caret outright; the port plants
    // a styled caret run so the Docs behavior holds: pick a size, then type.
    await toolbar.locator('[data-rich-menu="size"]').click();
    await toolbar.locator('[data-rich-size="24"]').click();
    await page.keyboard.type('AFTER24');
    await expect(editor.locator('span')).toHaveText('\u200BAFTER24');
    await expect(editor.locator('span')).toHaveCSS('font-size', '24px');

    // The styled run survives the storage round trip (span subset).
    await page.waitForTimeout(900);
    await page.reload();
    const runStyle = (prop: string): Promise<string> =>
      page.evaluate((p) => {
        const span = Array.from(document.querySelectorAll('#note span')).find((s) =>
          s.textContent?.includes('AFTER24'),
        );
        return span ? getComputedStyle(span).getPropertyValue(p) : '';
      }, prop);
    expect(await runStyle('font-size')).toBe('24px');
  });

  test('the size menu marks the value the caret sits in', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('plain text');

    // The bare caret answers the note's default size — read the live label
    // and assert its menu item is the one marked, Docs-style.
    await toolbar.locator('[data-rich-menu="size"]').click();
    const label = (await toolbar.locator('[data-rich-label="size"]').textContent())!.trim();
    await expect(toolbar.locator(`[data-rich-size="${label}"]`)).toHaveClass(/rich-menu-current/);
    await page.keyboard.press('Escape');

    // Style the line 36, reopen: the menu now ticks 36.
    await editor.press('Control+End');
    await editor.press('Shift+Home');
    await toolbar.locator('[data-rich-menu="size"]').click();
    await toolbar.locator('[data-rich-size="36"]').click();
    await toolbar.locator('[data-rich-menu="size"]').click();
    await expect(toolbar.locator('[data-rich-size="36"]')).toHaveClass(/rich-menu-current/);
    await expect(toolbar.locator('[data-rich-size="12"]')).not.toHaveClass(/rich-menu-current/);
  });

  test('a custom size between 1 and 400 applies and echoes back', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('custom size');

    // Type a non-preset size and apply it.
    await toolbar.locator('[data-rich-menu="size"]').click();
    const input = toolbar.locator('#richSizeInput');
    await input.fill('137');
    await input.press('Enter');

    // The caret label answers 137 and the typed text joins a 137px run.
    await expect(toolbar.locator('[data-rich-label="size"]')).toHaveText('137');
    await page.keyboard.type('BIG');
    const runSize = page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('#note span')).find((s) =>
        s.textContent?.includes('BIG'),
      );
      return span ? getComputedStyle(span).fontSize : '';
    });
    await expect(runSize).resolves.toBe('137px');

    // Out-of-range values are refused with guidance, not applied.
    await toolbar.locator('[data-rich-menu="size"]').click();
    await input.fill('500');
    await toolbar.locator('[data-rich-size-apply]').click();
    await expect(page.locator('#toast')).toContainText('1 and 400');
    await expect(input).toBeFocused();
  });

  test('the color picker applies a custom hex to the selection', async ({ page }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('custom ink here');

    // Select "custom ink" via the DOM (keyboard-only word selection is slow).
    await editor.evaluate(() => {
      const note = document.querySelector('#note')!;
      const range = document.createRange();
      range.setStart(note.firstChild!, 0);
      range.setEnd(note.firstChild!, 'custom ink'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await toolbar.locator('[data-rich-menu="color"]').click();
    const panel = toolbar.locator('[data-rich-panel-color]');
    await expect(panel).toBeVisible();

    // Palette keys render (theme-aware) and the custom picker is present.
    await expect(panel.locator('.rich-swatch')).toHaveCount(12);
    await expect(panel.locator('.rich-cp-hue')).toBeVisible();

    // Type a custom hex; Enter applies it to the parked selection.
    const hex = panel.locator('.rich-cp-hex');
    await hex.fill('#7c3aed');
    await hex.press('Enter');

    const styled = page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('#note span')).find((s) =>
        s.textContent?.includes('custom ink'),
      );
      return span ? getComputedStyle(span).color : '';
    });
    await expect(styled).resolves.toBe('rgb(124, 58, 237)');

    // The panel closed and the note kept focus.
    await expect(panel).toBeHidden();
    await expect(editor).toBeFocused();

    // The pick is remembered under Recents for the session.
    await toolbar.locator('[data-rich-menu="color"]').click();
    await expect(panel.locator('.rich-cp-grid-recent .rich-swatch')).toHaveCount(1);
  });

  test('the highlight picker offers pastels plus None and applies both ways', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    const toolbar = page.locator('#richToolbar');
    await editor.click();
    await page.keyboard.type('glow zone');

    await editor.press('Control+A');
    await toolbar.locator('[data-rich-menu="highlight"]').click();
    const panel = toolbar.locator('[data-rich-panel-hilite]');
    await expect(panel.locator('.rich-swatch')).toHaveCount(7); // 6 pastels + None

    await panel.locator('[data-rich-highlight="#d0ebff"]').click();
    await expect(editor.locator('span')).toHaveCSS(
      'background-color',
      'rgb(208, 235, 255)',
    );

    // None clears the highlight entirely.
    await editor.press('Control+A');
    await toolbar.locator('[data-rich-menu="highlight"]').click();
    await panel.locator('[data-rich-highlight="transparent"]').click();
    await expect(
      editor.evaluate(() =>
        Array.from(document.querySelectorAll('#note span')).some(
          (s) => (s as HTMLElement).style.backgroundColor !== '',
        ),
      ),
    ).resolves.toBe(false);
  });
});

test.describe('floating window gating', () => {
  test('the PiP entry point follows the active note type', async ({ page }) => {
    // Headless Chromium has no Document PiP — stub the feature marker so
    // the availability logic (not the API) is what runs. The module also
    // subscribes to the 'enter' event at boot.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'documentPictureInPicture', {
        value: { addEventListener: () => {} },
        configurable: true,
      });
    });

    await page.goto('/');
    const pip = page.locator('#pipContainer');

    // The welcome note is standard — the entry point shows.
    await expect(pip).toBeVisible();

    // A rich note active — the entry point hides.
    await createRichNote(page);
    await expect(pip).toBeHidden();

    // Back to the standard note — it returns.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(pip).toBeVisible();
  });
});
