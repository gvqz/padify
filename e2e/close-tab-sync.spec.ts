import { expect, test, type Page } from '@playwright/test';

/**
 * A closed tab stays closed, end to end against the real API.
 *
 * The story the user told: "I'm closing a tab that's empty but it keeps on
 * reopening." Two windows of the same account and one closed note — the
 * loop needs every layer to hold:
 *
 *   • the closing window's tombstone must reach the OTHER window (its pull
 *     cursor is its own — a shared cursor let one window's pull starve the
 *     other's, and the blind window re-published the closed note live on
 *     every cycle, un-deleting it in the cloud);
 *   • the merge must not take a live row back for a note this device
 *     closed (a pending tombstone outranks a stale re-publish);
 *   • the server must refuse a live write that would un-delete a tombstone
 *     it isn't strictly newer than.
 *
 * The race is staged in the localStorage fallback backend (private-mode
 * shape — IndexedDB unavailable), where two same-origin windows share the
 * notes store and every setting LIVE. That is the environment where the
 * shared pull cursor used to starve the second window deterministically;
 * in the IndexedDB backend the same starvation hid inside a boot-time race
 * between the two stores. The fix — a per-window cursor — holds in both.
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

function freshAccount(): { email: string; password: string } {
  const stem = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { email: `${stem}@example.test`, password: 'a long enough password' };
}

async function signUp(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/');
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
  await page.locator('#cloudAuthSwitch').click();
  await expect(page.locator('#cloudAuthSubmit')).toContainText(/create/i);
  await page.locator('#cloudAuthEmail').fill(account.email);
  await page.locator('#cloudAuthPassword').fill(account.password);
  await page.locator('#cloudAuthSubmit').click();
  await expect(page.locator('#cloudSignedInPane')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** Forces a full sync cycle through the modal's manual button. */
async function forceSync(page: Page): Promise<void> {
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
  await page.locator('#cloudSyncNow').click();
  await expect
    .poll(async () => page.locator('#cloudNavContainer').getAttribute('title'), {
      timeout: 20_000,
      message: 'the manual sync cycle to land',
    })
    .toContain('up to date');
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** The tab whose title is EXACTLY the given text. */
function tabWithTitle(page: Page, title: string) {
  return page.locator('#tabStripTabs .tab-strip-tab').filter({
    has: page.locator('.tab-strip-title', { hasText: new RegExp(`^${title}$`) }),
  });
}

/** Every strip title on the page, for absence assertions. */
async function stripTitles(page: Page): Promise<string[]> {
  return page.locator('#tabStripTabs .tab-strip-title').allTextContents();
}

test.describe('closing a tab (real API)', () => {
  test('an empty tab closed in one window stays closed everywhere', async ({ browser }) => {
    test.setTimeout(150_000);

    // The localStorage fallback backend: two same-origin windows share
    // everything LIVE — the environment where a shared pull cursor used
    // to starve the second window deterministically.
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });

    try {
      const pageA = await context.newPage();
      const errorsA: string[] = [];
      pageA.on('pageerror', (error) => errorsA.push(String(error)));
      pageErrors.set(pageA, errorsA);

      const account = freshAccount();
      await signUp(pageA, account);

      // The empty note, named so the strip can assert it. Content stays
      // empty — the close must need no confirmation dialog.
      await pageA.locator('#addTab').click();
      await pageA.locator('#tabStripTabs .tab-strip-tab').last().dblclick();
      await pageA.keyboard.press('Control+a');
      await pageA.keyboard.type('Scratch');
      await pageA.keyboard.press('Enter');
      await expect(tabWithTitle(pageA, 'Scratch')).toBeVisible();
      await forceSync(pageA);

      // The second window of the SAME account: same origin, same stores,
      // its own document and its own pull cursor. It must see the note.
      const pageB = await context.newPage();
      const errorsB: string[] = [];
      pageB.on('pageerror', (error) => errorsB.push(String(error)));
      pageErrors.set(pageB, errorsB);

      await pageB.goto('/');
      await expect
        .poll(async () => stripTitles(pageB), {
          timeout: 60_000,
          message: 'the note to arrive in the second window',
        })
        .toContain('Scratch');

      // The close: an empty tab closes with no dialog. The tombstone
      // rides the manual cycle and lands in the cloud.
      await tabWithTitle(pageA, 'Scratch').locator('.tab-strip-close').click();
      await expect(tabWithTitle(pageA, 'Scratch')).toHaveCount(0);
      await forceSync(pageA);

      // The second window syncs. Its own cursor is still behind the
      // tombstone, so its pull must deliver it: the note leaves this
      // window too, and nothing re-publishes it to the cloud.
      await forceSync(pageB);
      await expect
        .poll(async () => stripTitles(pageB), {
          timeout: 30_000,
          message: 'the closed note to leave the second window',
        })
        .not.toContain('Scratch');

      // The closer syncs again — the moment the reopen used to happen:
      // the blind window's live re-publish arrived and the closed note
      // rejoined the strip. It must stay closed.
      await forceSync(pageA);
      await pageA.waitForTimeout(2_000); // any late cycle lands here
      expect(await stripTitles(pageA), 'the closed tab must not reopen').not.toContain('Scratch');
      expect(await stripTitles(pageB), 'the closed tab must not reopen (window B)').not.toContain(
        'Scratch',
      );

      expect(errorsA, 'uncaught page errors (window A)').toEqual([]);
      expect(errorsB, 'uncaught page errors (window B)').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
