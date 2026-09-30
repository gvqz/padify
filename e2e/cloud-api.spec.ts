import { expect, test, type Page } from '@playwright/test';

/**
 * The cloud round trip, driven through the real API.
 *
 * This is the spec the suite could never have: until the config learned to
 * boot server/, every /api path in e2e exercised the offline-degradation
 * branch and the server was tested only by its unit contracts. Here two
 * independent browser contexts — two devices, neither sharing storage —
 * agree on a note through the server and nothing else:
 *
 *   device A signs up, writes a note, pushes;
 *   device B signs in on a clean profile and the note arrives by pull.
 *
 * If the push is bricked, the pull is bricked, the wire keys disagree, the
 * merge drops the row, or the storage round trip mangles the content —
 * this fails at the step that broke, with the page open.
 *
 * The e2e config boots the API against a throwaway SQLite file (see
 * playwright.config.ts); nothing here touches a real database.
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

/** Random account per run — the API's database is throwaway, but a fixed
 *  address would collide across reuseExistingServer dev runs. */
function freshAccount(): { email: string; password: string } {
  const stem = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { email: `${stem}@example.test`, password: 'a long enough password' };
}

async function openCloudModal(page: Page): Promise<void> {
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
}

async function submitAuth(
  page: Page,
  mode: 'sign-in' | 'sign-up',
  { email, password }: { email: string; password: string },
): Promise<void> {
  if (mode === 'sign-up') {
    // The form starts in sign-in mode; the switch link flips it.
    await page.locator('#cloudAuthSwitch').click();
    await expect(page.locator('#cloudAuthTitle')).toContainText(/create/i);
  }
  await page.locator('#cloudAuthEmail').fill(email);
  await page.locator('#cloudAuthPassword').fill(password);
  await page.locator('#cloudAuthSubmit').click();

  // Signed in: the auth pane swaps for the account pane, and the app
  // toasts. The sign-in itself fires an immediate sync cycle.
  await expect(page.locator('#cloudSignedInPane')).toBeVisible();
  await expect(page.locator('#cloudAccountEmail')).toHaveText(email);
}

test.describe('cloud round trip (real API)', () => {
  test('device A signs up and pushes; device B signs in and pulls', async ({ page, browser }) => {
    test.setTimeout(120_000); // two devices, two boots, one server round trip
    const account = freshAccount();
    const marker = 'the server carried this line';

    // ---- device A: sign up, write, push --------------------------------
    await page.goto('/');
    await openCloudModal(page);
    await submitAuth(page, 'sign-up', account);

    // Close the modal (the account view deliberately stays open after
    // signing in), create a note, and type the marker line.
    await page.keyboard.press('Escape');
    await expect(page.locator('#cloudModal')).toBeHidden();

    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await expect(editor).toHaveText('');
    await editor.click();
    await page.keyboard.type(marker);

    // Force the push now instead of waiting out the push debounce, then
    // wait one round trip for the cycle to land it on the server.
    await openCloudModal(page);
    await page.locator('#cloudSyncNow').click();
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Escape');

    // ---- device B: clean context, sign in, pull ------------------------
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const bErrors: string[] = [];
      pageB.on('pageerror', (error) => bErrors.push(String(error)));
      pageErrors.set(pageB, bErrors);

      await pageB.goto('/');
      await openCloudModal(pageB);
      await submitAuth(pageB, 'sign-in', account);

      // The account pane deliberately stays open after signing in —
      // close the modal so the strip behind it is clickable.
      await pageB.keyboard.press('Escape');
      await expect(pageB.locator('#cloudModal')).toBeHidden();

      // The note arrives from the server — the only place it can come
      // from: this context has no local storage, and the only thing it
      // shares with device A is the account.
      await expect
        .poll(async () => pageB.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 90_000,
          message: 'the pushed note to arrive on device B',
        })
        .toContain(marker);

      // Opening it shows the content the server stored, and the account
      // email is the one both devices signed in under.
      await pageB.locator('#tabStripTabs .tab-strip-tab', { hasText: marker }).first().click();
      await expect(pageB.locator('#note')).toContainText(marker);
      expect(bErrors, 'uncaught page errors (device B)').toEqual([]);
    } finally {
      await contextB.close();
    }
  });

  test('a duplicate signup answers the signin message — no enumeration', async ({ page }) => {
    const account = freshAccount();

    // Create the account once (device A above proved the happy path; here
    // just take the shortest route to a stored user).
    await page.goto('/');
    await openCloudModal(page);
    await submitAuth(page, 'sign-up', account);
    await page.keyboard.press('Escape');

    // A second signup on the same address must answer exactly what signin
    // answers for a wrong password — same status, same words — so neither
    // response distinguishes a taken address from a bad password.
    await openCloudModal(page);
    await page.locator('#cloudSignOut').click();
    await expect(page.locator('#cloudAuthPane')).toBeVisible();

    await page.locator('#cloudAuthSwitch').click();
    await page.locator('#cloudAuthEmail').fill(account.email);
    await page.locator('#cloudAuthPassword').fill(account.password);
    await page.locator('#cloudAuthSubmit').click();

    await expect(page.locator('#cloudAuthError')).toBeVisible();
    await expect(page.locator('#cloudAuthError')).toHaveText('Wrong email or password.');
  });
});
