import { expect, test, type Page } from '@playwright/test';

/**
 * The floating window (Document Picture-in-Picture).
 *
 * Headless Chromium has no Document PiP, so every test stubs the API
 * with a same-origin popup window: requestWindow() -> window.open('').
 * The real module then runs verbatim — stylesheets copied, editor
 * moved, host class applied — which is exactly the surface these
 * tests need. The stub also mirrors the API's 'enter' event.
 *
 * What these tests pin down (all were broken at once, which is why
 * this spec exists):
 *  - the main window stays usable while a note floats (the old
 *    .overlay blocked the navbar — including the close toggle itself);
 *  - typing in the floating window still saves and updates the count;
 *  - Escape (or the toggle) returns the editor to its exact slot;
 *  - the theme follows (dark mode + paper textures).
 */

/** Installs the Document-PiP stub (must run before the app boots). */
async function stubDocumentPip(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let enterListener: (() => void) | null = null;
    let openWindow: Window | null = null;
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        // The real API exposes the open window (consumers like the
        // word-count pill use it to reach elements that floated).
        get window(): Window | null {
          return openWindow && !openWindow.closed ? openWindow : null;
        },
        addEventListener: (_type: string, fn: () => void) => {
          enterListener = fn;
        },
        requestWindow: async (opts: { width?: number; height?: number }) => {
          const win = window.open(
            '',
            'padify-pip-stub',
            `popup=yes,width=${opts?.width ?? 350},height=${opts?.height ?? 500}`,
          );
          if (!win) throw new Error('popup blocked');
          openWindow = win;
          if (enterListener) setTimeout(() => enterListener(), 0);
          return win;
        },
      },
    });
  });
}

/** Opens the floating window and returns the stub's popup page. */
async function openFloatingWindow(page: Page): Promise<Page> {
  const popupPromise = page.context().waitForEvent('page', { timeout: 10_000 });
  await page.locator('#pip').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await popup.setViewportSize({ width: 350, height: 500 });
  await popup.waitForTimeout(400);
  return popup;
}

test.beforeEach(async ({ page }) => {
  await stubDocumentPip(page);
});

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
  // TEMPORARY DEBUG — Node-side only (no page impact): catch mid-test navigations.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log(`[NAV DEBUG ${Date.now() % 100000}] main frame → ${frame.url()}`);
    }
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

test.describe('floating window', () => {
  test('moves the editor in, shows the dock placeholder, keeps the main window alive', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#pipContainer')).toBeVisible();

    const popup = await openFloatingWindow(page);

    // The editor (and its status line) now live in the floating window.
    await expect(popup.locator('#textareaContainer')).toHaveCount(1);
    await expect(popup.locator('#note')).toBeVisible();
    await expect(popup.locator('.bottom-line')).toBeVisible();
    expect(await popup.evaluate(() => document.body.classList.contains('pip-host'))).toBe(true);

    // The floating window has its compact header with the note's title
    // and the note browser — and no dock button (the window's own close
    // affordances already bring the note home).
    await expect(popup.locator('#pipHeaderTitle')).toHaveText(/Padify/i);
    await expect(popup.locator('.pip-notes-btn')).toBeVisible();
    await expect(popup.locator('.pip-header-dock')).toHaveCount(0);
    // The statistics anchor is dead in a popup — it must not paint.
    await expect(popup.locator('.word-count-container a')).toBeHidden();

    // The main window's editor slot shows the dock placeholder instead.
    await expect(page.locator('.pip-dock')).toBeVisible();
    await expect(page.locator('#mainContainer')).toHaveClass(/pip/);

    // THE old breakage: the navbar (and the toggle that closes the
    // floating window) must stay clickable — no overlay may intercept.
    await expect(page.locator('#pip')).toBeEnabled();
    await page.locator('#pip').click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('.pip-dock')).toHaveCount(0);
    await expect(page.locator('#note')).toBeVisible();
  });

  test('typing in the floating window saves and updates the word count', async ({ page }) => {
    await page.goto('/');
    // A fresh note side-steps the welcome note's async storage restore
    // entirely — the count starts at a known zero.
    await page.locator('#addTab').click();
    await expect(page.locator('#wordCount')).toHaveText('0 characters • 0 words', {
      timeout: 10_000,
    });

    const popup = await openFloatingWindow(page);

    await popup.locator('#note').click();
    await popup.keyboard.type('Typed in the floating window.');
    // The app's input wiring debounces 500ms; the pill follows.
    await expect(popup.locator('#wordCount')).toHaveText('29 characters • 5 words', {
      timeout: 5_000,
    });

    // Escape closes the window and returns the editor to the main shell.
    // The settle mirrors the other close-path tests: the module's pagehide
    // moves the editor back synchronously, but the app's own follow-up work
    // (debounced saves, focus handoff) deserves a beat before assertions.
    await popup.keyboard.press('Escape').catch(() => {
      /* the page dies mid-press when the window closes */
    });
    await page.waitForTimeout(500);
    await expect(page.locator('#note')).toBeVisible();
    await expect(page.locator('#textareaContainer')).toHaveCount(1);
    await expect(page.locator('#note')).toHaveText('Typed in the floating window.');

    // …and the content survives a reload (the storage round trip).
    await page.reload();
    await expect(page.locator('#note')).toHaveText('Typed in the floating window.');
  });

  test('the dock placeholder button brings the note back', async ({ page }) => {
    await page.goto('/');
    const popup = await openFloatingWindow(page);
    await expect(page.locator('.pip-dock')).toBeVisible();

    await page.locator('.pip-dock-btn').click();
    await page.waitForTimeout(500);

    await expect(page.locator('.pip-dock')).toHaveCount(0);
    await expect(page.locator('#note')).toBeVisible();
    // The floating editor went back into the main window's shell.
    expect(await page.evaluate(() => !!document.querySelector('#editorShell #note'))).toBe(true);
    // The toggle's title is back to "activate".
    await expect(page.locator('#pip')).toHaveAttribute('title', 'Activate Floating Window');
    void popup;
  });

  test('dark mode and paper textures follow into the floating window', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.body.classList.add('dark', 'grain-paper'));

    const popup = await openFloatingWindow(page);

    const theme = await popup.evaluate(() => ({
      dark: document.body.classList.contains('dark'),
      paper: document.body.classList.contains('grain-paper'),
      bg: getComputedStyle(document.body).backgroundColor,
      image: getComputedStyle(document.body).backgroundImage,
    }));
    expect(theme.dark).toBe(true);
    expect(theme.paper).toBe(true);
    expect(theme.bg).toBe('rgb(0, 0, 0)');
    // The paper IMAGERY must paint in the floating window, not just its
    // class ride along — the host body once reset background-image with
    // a background shorthand, and every texture but starfield died.
    expect(theme.image).not.toBe('none');
    expect(theme.image).toContain('data:image/svg+xml');

    // The theme observer propagates changes made while floating — a
    // texture switch repaints the floating paper too.
    await page.evaluate(() => {
      document.body.classList.remove('grain-paper');
      document.body.classList.add('dotted-paper');
    });
    await popup.waitForTimeout(300);
    const dotted = await popup.evaluate(() => ({
      paper: document.body.classList.contains('dotted-paper'),
      image: getComputedStyle(document.body).backgroundImage,
    }));
    expect(dotted.paper).toBe(true);
    expect(dotted.image).toContain('radial-gradient');

    // Closing does not leave the theme classes stranded on the host.
    await popup.keyboard.press('Escape').catch(() => {
      /* window closed mid-press */
    });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => document.getElementById('mainContainer')?.className ?? ''),
    ).toBe('');
  });

  test('the note browser switches and creates notes without leaving the floating window', async ({
    page,
  }) => {
    await page.goto('/');

    // Two plain notes with known content: the welcome note + this one.
    await page.locator('#addTab').click();
    await page.locator('#note').click();
    await page.keyboard.type('Grocery list');
    await expect(page.locator('#wordCount')).toHaveText('12 characters • 2 words', {
      timeout: 10_000,
    });

    const popup = await openFloatingWindow(page);
    await expect(popup.locator('#pipHeaderTitle')).toHaveText('Grocery list');

    // Open the browser: both notes as rows, the active one highlighted,
    // the new-note action below them.
    await popup.locator('.pip-notes-btn').click();
    await expect(popup.locator('.pip-notes')).toBeVisible();
    const noteRows = popup.locator('.pip-note-row:not(.pip-note-new)');
    await expect(noteRows).toHaveCount(2);
    const groceryRow = popup.locator('.pip-note-row', { hasText: 'Grocery list' });
    await expect(groceryRow).toHaveClass(/active/);
    await expect(groceryRow.locator('.pip-note-preview')).toHaveText('Grocery list');

    // Switch to the welcome note from INSIDE the popup: the panel
    // closes, the title follows, the editor swaps content in place.
    await popup.locator('.pip-note-row', { hasText: 'Welcome' }).click();
    await expect(popup.locator('.pip-notes')).toBeHidden();
    await expect(popup.locator('#pipHeaderTitle')).toHaveText(/Welcome.*Padify/);
    await expect(popup.locator('#note')).toContainText('offline-capable notepad');
    await expect(popup.locator('#wordCount')).not.toHaveText('12 characters • 2 words');

    // A new note started from the browser is a plain, empty one.
    await popup.locator('.pip-notes-btn').click();
    await popup.locator('.pip-note-new').click();
    await expect(popup.locator('#pipHeaderTitle')).toHaveText('Untitled');
    await expect(popup.locator('#wordCount')).toHaveText('0 characters • 0 words');
    await popup.locator('#note').click();
    await popup.keyboard.type('From the floating window');
    await expect(popup.locator('#wordCount')).not.toHaveText('0 characters • 0 words');

    // Escape peels the browser back before it ever reaches the window.
    await popup.locator('.pip-notes-btn').click();
    await expect(popup.locator('.pip-notes')).toBeVisible();
    await popup.keyboard.press('Escape');
    await expect(popup.locator('.pip-notes')).toBeHidden();
    await expect(popup.locator('#note')).toBeVisible();
    await popup.keyboard.press('Escape').catch(() => {
      /* window closed mid-press */
    });
    await expect(page.locator('#note')).toBeVisible();
    await expect(page.locator('#note')).toContainText('From the floating window');
  });

  test('rich notes browse in the floating window but open from the main window', async ({
    page,
  }) => {
    await page.goto('/');

    // A rich note exists, but a plain note is active when the window opens.
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();
    await page.locator('.tab-strip-tab').first().click();
    await expect(page.locator('#pipContainer')).toBeVisible();

    const popup = await openFloatingWindow(page);
    await popup.locator('.pip-notes-btn').click();

    // The rich note browses (with its type mark and a hint) but is
    // inert: the floating window is a plain-typing surface.
    const richRow = popup.locator('.pip-note-row[disabled]');
    await expect(richRow).toHaveCount(1);
    await expect(richRow).toBeDisabled();
    await expect(richRow.locator('.pip-note-icon')).toBeVisible();

    // The window stays open, the plain note stays put.
    await expect(popup.locator('#note')).toBeVisible();
    await expect(popup.locator('#pipHeaderTitle')).toHaveText(/Padify/i);
  });

  test('a rich note active closes the floating window and hides the entry point', async ({
    page,
  }) => {
    await page.goto('/');
    const popup = await openFloatingWindow(page);
    await expect(popup.locator('#note')).toBeVisible();

    // Create a rich note from the (still fully usable) main window.
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();

    // The floating window closed itself and the editor came home.
    await expect(page.locator('#note')).toBeVisible();
    await expect(page.locator('#pipContainer')).toBeHidden();
    await expect(page.locator('.pip-dock')).toHaveCount(0);
  });
});
