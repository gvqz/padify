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

    // The floating window has its compact header with the note's title.
    await expect(popup.locator('#pipHeaderTitle')).toHaveText(/Padify/i);

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
    await popup.keyboard.press('Escape').catch(() => {
      /* the page dies mid-press when the window closes */
    });
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

    expect(
      await popup.evaluate(() => ({
        dark: document.body.classList.contains('dark'),
        paper: document.body.classList.contains('grain-paper'),
        bg: getComputedStyle(document.body).backgroundColor,
      })),
    ).toEqual({ dark: true, paper: true, bg: 'rgb(0, 0, 0)' });

    // The theme observer propagates a change made while floating.
    await page.evaluate(() => document.body.classList.remove('grain-paper'));
    await page.waitForTimeout(300);
    expect(await popup.evaluate(() => document.body.classList.contains('grain-paper'))).toBe(false);

    // Closing does not leave the theme classes stranded on the host.
    await popup.keyboard.press('Escape').catch(() => {
      /* window closed mid-press */
    });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => document.getElementById('mainContainer')?.className ?? ''),
    ).toBe('');
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
