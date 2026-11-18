import { expect, test, type Page } from '@playwright/test';

/**
 * Typing substitutions — the family (the em-dash pair, the ellipsis, the
 * ASCII arrows, Word's symbol shorthand), driven through the REAL input
 * path on every note kind:
 *
 *  - plain and rich notes convert through the model engine, with Word's
 *    autocorrect undo manners (undo #1 hands the raw pair back) and no
 *    re-fire after the undo;
 *  - the markdown source textarea converts through the field splice;
 *  - the task composer's input converts the same way;
 *  - the markdown structures the veto protects (`---`, the table
 *    separator) never convert, and neither does fenced code;
 *  - the settings ship OFF, persist across reloads, and "Reset to
 *    defaults" clears them — through the real preferences checkboxes,
 *    never a back door.
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

async function createNote(page: Page, label: string): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: label }).click();
}

/** Flips one substitution setting through the real preferences checkbox.
 *
 * The boot wiring is async (initApp gates on storageReady()), so on a
 * cold page the change event can outrun the handler that persists the
 * choice and arms the substitution listener — this poll re-dispatches
 * until the handler is live. The localStorage mirror is written by the
 * SAME synchronous pass that fires the change notification, so the
 * mirror carrying the value is the receipt that the wiring took. */
async function setSubstitution(
  page: Page,
  inputId: string,
  storageKey: string,
  enabled: boolean,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ inputId, storageKey, enabled }) => {
          const checkbox = document.getElementById(inputId) as HTMLInputElement;
          checkbox.checked = enabled;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          return localStorage.getItem(storageKey) === (enabled ? 'Yes' : 'No');
        },
        { inputId, storageKey, enabled },
      ),
    )
    .toBe(true);
}

function setEmDash(page: Page, enabled: boolean): Promise<void> {
  return setSubstitution(page, 'emDashSubstitution', 'userChosenEmDashSubstitution', enabled);
}

function setEllipsis(page: Page, enabled: boolean): Promise<void> {
  return setSubstitution(page, 'ellipsisSubstitution', 'userChosenEllipsisSubstitution', enabled);
}

function setArrows(page: Page, enabled: boolean): Promise<void> {
  return setSubstitution(page, 'arrowSubstitution', 'userChosenArrowSubstitution', enabled);
}

function setSymbols(page: Page, enabled: boolean): Promise<void> {
  return setSubstitution(page, 'symbolSubstitution', 'userChosenSymbolSubstitution', enabled);
}

test.describe('em-dash substitution', () => {
  test('plain note: the pair converts as you type, undo hands the raw pair back', async ({
    page,
  }) => {
    await page.goto('/');
    await setEmDash(page, true);
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('wait -- what');
    await expect(editor).toHaveText('wait \u2014 what');

    // Chronological undo: the words typed after the pair go first…
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('wait \u2014');

    // …then the substitution reverts and the raw pair is back.
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('wait --');

    // Redo walks the dash back in.
    await page.keyboard.press('Control+Shift+z');
    await expect(editor).toHaveText('wait \u2014');

    // Typing continues from there with no re-trigger — you can always
    // get your "--" back.
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('wait --');
    await page.keyboard.type(' today');
    await expect(editor).toHaveText('wait -- today');
  });

  test('rich note: the pair converts through the engine too', async ({ page }) => {
    await page.goto('/');
    await setEmDash(page, true);
    await createNote(page, 'Rich text note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('said -- out loud');
    await expect(editor).toHaveText('said \u2014 out loud');

    // The words after the pair undo first, then the raw pair is back.
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('said \u2014');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('said --');
  });

  test('the markdown structures stay raw: "---", the table separator', async ({ page }) => {
    await page.goto('/');
    await setEmDash(page, true);
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    // A `---` run: the pair opens the line, the third hyphen trails the
    // dash — nothing converts.
    await page.keyboard.type('---');
    await expect(editor).toHaveText('---');

    // A word, then the pair: that one converts (sanity against overkill).
    await page.keyboard.press('Enter');
    await page.keyboard.type('well--known');
    await expect(editor).toContainText('well\u2014known');
  });

  test('markdown note: the source textarea converts, the fences stay', async ({ page }) => {
    await page.goto('/');
    await setEmDash(page, true);
    await createNote(page, 'Markdown note');
    const source = page.locator('textarea.markdown-source');
    await source.click();

    await page.keyboard.type('wait -- what');
    await expect(source).toHaveValue('wait \u2014 what');

    // The horizontal rule is never touched.
    await page.keyboard.press('Enter');
    await page.keyboard.type('---');
    await expect(source).toHaveValue('wait \u2014 what\n---');

    // Neither is a table separator mid-row.
    await page.keyboard.press('Enter');
    await page.keyboard.type('|--');
    await expect(source).toHaveValue('wait \u2014 what\n---\n|--');
  });

  test('task note: the composer converts', async ({ page }) => {
    await page.goto('/');
    await setEmDash(page, true);
    await createNote(page, 'Task list');
    const composer = page.locator('#note [data-composer-input]');
    await composer.click();

    await page.keyboard.type('blocked -- waiting on review');
    await expect(composer).toHaveValue('blocked \u2014 waiting on review');
  });

  test('the shipped default is OFF, the checkbox turns it on live', async ({ page }) => {
    await page.goto('/');
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    // Off by default: the pair stands.
    await page.keyboard.type('wait -- what');
    await expect(editor).toHaveText('wait -- what');

    await page.locator('[data-target="#preferencesModal"]').first().click();
    await expect(page.locator('#preferencesModal')).toBeVisible();
    await setEmDash(page, true);
    await page.locator('#preferencesModal .pref-done-btn').click();
    await expect(page.locator('#preferencesModal')).toBeHidden();

    // Live: no reload needed.
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('again -- here');
    await expect(editor).toHaveText('again \u2014 here');
  });

  test('the setting persists across a reload', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-target="#preferencesModal"]').first().click();
    await setEmDash(page, true);
    await page.locator('#preferencesModal .pref-done-btn').click();

    await page.reload();
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('reloaded -- still on');
    await expect(editor).toHaveText('reloaded \u2014 still on');
  });

  test('reset to defaults clears the substitution', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-target="#preferencesModal"]').first().click();
    await setEmDash(page, true);
    await page.locator('#resetPreferences').click();
    await expect(page.locator('#emDashSubstitution')).not.toBeChecked();
    await page.locator('#preferencesModal .pref-done-btn').click();

    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('wait -- what');
    await expect(editor).toHaveText('wait -- what');
  });
});

test.describe('ellipsis substitution', () => {
  test('plain note: three dots become an ellipsis, undo hands the dots back', async ({ page }) => {
    await page.goto('/');
    await setEllipsis(page, true);
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('wait ... what');
    await expect(editor).toHaveText('wait \u2026 what');

    // The words after the dots undo first, then the raw trio is back.
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('wait \u2026');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('wait ...');

    // Typing continues with no re-trigger — the raw dots stay yours.
    await page.keyboard.type(' today');
    await expect(editor).toHaveText('wait ... today');
  });

  test('markdown note: fenced code keeps its dots, prose converts after the fence', async ({
    page,
  }) => {
    await page.goto('/');
    await setEllipsis(page, true);
    await createNote(page, 'Markdown note');
    const source = page.locator('textarea.markdown-source');
    await source.click();

    // Inside the fence: the dots stand.
    await page.keyboard.type('```js');
    await page.keyboard.press('Enter');
    await page.keyboard.type('wait ...');
    await expect(source).toHaveValue('```js\nwait ...');

    // After the fence closes: the same dots convert.
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and then ...');
    await expect(source).toHaveValue('```js\nwait ...\n```\nand then \u2026');
  });
});

test.describe('arrow substitution', () => {
  test('plain note: ->, => and <-> convert; `<-` and `-->` stand', async ({ page }) => {
    await page.goto('/');
    await setArrows(page, true);
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('a -> b');
    await expect(editor).toHaveText('a \u2192 b');

    await page.keyboard.press('Enter');
    await page.keyboard.type('c => d');
    await page.keyboard.press('Enter');
    await page.keyboard.type('e <-> f');
    // The R assignment never converts — no rule, no rewrite.
    await page.keyboard.press('Enter');
    await page.keyboard.type('x <- y');
    // A hyphen run is syntax, not an arrow — the comment closer stands.
    await page.keyboard.press('Enter');
    await page.keyboard.type('-->');
    // The plain note paints bare text until Enter plants the blocks —
    // innerText is the honest line view.
    const lines = await editor.evaluate((el) => (el as HTMLElement).innerText);
    expect(lines).toBe('a \u2192 b\nc \u21d2 d\ne \u2194 f\nx <- y\n-->');
  });

  test('rich note: the arrows convert through the engine too', async ({ page }) => {
    await page.goto('/');
    await setArrows(page, true);
    await createNote(page, 'Rich text note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('flow -> gate');
    await expect(editor).toHaveText('flow \u2192 gate');

    // The words after the arrow undo first, then the raw pair is back.
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('flow \u2192');
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('flow ->');
  });
});

test.describe('symbol substitution', () => {
  test('plain note: (c) becomes © after a space, foo(c) stays a call', async ({ page }) => {
    await page.goto('/');
    await setSymbols(page, true);
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.type('see (c) here');
    await expect(editor).toHaveText('see \u00a9 here');

    await page.keyboard.press('Enter');
    await page.keyboard.type('(tm) pending');
    await page.keyboard.press('Enter');
    await page.keyboard.type('foo(c)');
    const lines = await editor.evaluate((el) => (el as HTMLElement).innerText);
    expect(lines).toBe('see \u00a9 here\n\u2122 pending\nfoo(c)');
  });
});

test.describe('the family ships OFF', () => {
  test('nothing converts until its row flips on, live in the same session', async ({ page }) => {
    await page.goto('/');
    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();

    // Every rule ships OFF: everything stands raw.
    await page.keyboard.type('wait -- ... (c) x ->');
    await expect(editor).toHaveText('wait -- ... (c) x ->');

    await page.locator('[data-target="#preferencesModal"]').first().click();
    await expect(page.locator('#preferencesModal')).toBeVisible();
    await setEmDash(page, true);
    await setEllipsis(page, true);
    await setArrows(page, true);
    await setSymbols(page, true);
    await page.locator('#preferencesModal .pref-done-btn').click();
    await expect(page.locator('#preferencesModal')).toBeHidden();

    // Live, no reload: the whole family converts.
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('a -- b ... c (c) d ->');
    await expect(editor).toHaveText('a \u2014 b \u2026 c \u00a9 d \u2192');
  });

  test('reset to defaults clears the whole family', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-target="#preferencesModal"]').first().click();
    await setEmDash(page, true);
    await setEllipsis(page, true);
    await setArrows(page, true);
    await setSymbols(page, true);
    await page.locator('#resetPreferences').click();
    await expect(page.locator('#emDashSubstitution')).not.toBeChecked();
    await expect(page.locator('#ellipsisSubstitution')).not.toBeChecked();
    await expect(page.locator('#arrowSubstitution')).not.toBeChecked();
    await expect(page.locator('#symbolSubstitution')).not.toBeChecked();
    await page.locator('#preferencesModal .pref-done-btn').click();

    await createNote(page, 'Plain note');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('x ... ->');
    await expect(editor).toHaveText('x ... ->');
  });
});
