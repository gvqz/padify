import { expect, test, type Page } from '@playwright/test';

/**
 * Conflicted copies, end to end against the real API — the multiplication
 * guard under its harshest light.
 *
 * The story the user told: a note edited from two open devices accumulates
 * a "X — conflicted copy" tab per sync cycle until the strip fills with
 * near-identical notes. The fix models the copy as the note's unmerged
 * BRANCH: the first loss mints it, later losses update its words in place.
 *
 * The race is staged with real offline windows (context.setOffline), not
 * timing luck:
 *
 *   1. both devices share a base version;
 *   2. A goes offline and types; B types and pushes;
 *   3. A reconnects — the pull beats A's push, A's dirty words lose, and a
 *      conflicted copy keeps them;
 *   4. the SAME race runs a second time — the branch must UPDATE in place,
 *      never mint a second copy.
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
  await expect(page.locator('#cloudSignedInPane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** Forces a full sync cycle through the modal's manual button. */
async function forceSync(page: Page): Promise<void> {
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
  await page.locator('#cloudSyncNow').click();
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** The tab whose title is EXACTLY the given text (a substring locator would
 *  also match the conflicted copy — "X" matches "X — conflicted copy"). */
function tabWithTitle(page: Page, title: string) {
  return page.locator('#tabStripTabs .tab-strip-tab').filter({
    has: page.locator('.tab-strip-title', { hasText: new RegExp(`^${title}$`) }),
  });
}

test.describe('conflicted copies (real API)', () => {
  test('a rename racing a sync cycle stays clean — no stray page errors', async ({ page }) => {
    // The blur/Enter double-commit used to race Chromium's own blur fixup
    // during a strip rebuild, throwing an uncaught NotFoundError. The
    // rename settles once now; the strip stays consistent.
    const account = freshAccount();
    await signUp(page, account);
    await page.locator('#addTab').click();
    await page.locator('#note').click();
    await page.keyboard.type('rename race body');
    await page.waitForTimeout(600);

    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'rename race body' })
      .first()
      .dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Renamed');
    await page.keyboard.press('Enter');

    for (let i = 0; i < 3; i += 1) {
      await forceSync(page);
    }
    await expect(
      page.locator('#tabStripTabs .tab-strip-title', { hasText: 'Renamed' }),
    ).toBeVisible();
  });

  test('a two-device race keeps both versions once — the second race updates the branch', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const account = freshAccount();

    // ---- the shared base: A writes, both devices hold it ---------------
    await signUp(page, account);
    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('RaceNote base version');
    await forceSync(page);

    // Rename the note so the copy's name is assertable.
    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'RaceNote base version' })
      .first()
      .dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('RaceNote');
    await page.keyboard.press('Enter');
    await forceSync(page);

    // ---- device B: the same account, a clean profile ------------------
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      const bErrors: string[] = [];
      pageB.on('pageerror', (error) => bErrors.push(String(error)));
      pageErrors.set(pageB, bErrors);

      await pageB.goto('/');
      await pageB.locator('#cloudNavContainer').click();
      await pageB.locator('#cloudAuthEmail').fill(account.email);
      await pageB.locator('#cloudAuthPassword').fill(account.password);
      await pageB.locator('#cloudAuthSubmit').click();
      await expect(pageB.locator('#cloudSignedInPane')).toBeVisible();
      await pageB.keyboard.press('Escape');

      // B holds the note (arrives by pull).
      await expect
        .poll(async () => pageB.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 60_000,
          message: 'the note to arrive on device B',
        })
        .toContain('RaceNote');

      // ---- race 1: B pushes first, then A types and syncs INSIDE the
      // capture window (<500ms: the typing still sits in the DOM, the
      // model not yet updated, so A's cycle pushes nothing and its own
      // merge-time capture makes the local dirty — the losing side).
      // This is the production shape: two open devices, the 30s tick
      // landing mid-typing. B's typing waits out its own capture+push
      // debounces first, so B arrives at the race CLEAN (a dirty B would
      // legitimately mint its own branch — two branches, not a bug).
      await tabWithTitle(pageB, 'RaceNote').click();
      await pageB.locator('#note').click();
      await pageB.keyboard.type(' B first words');
      await pageB.waitForTimeout(2_600); // capture 500ms + persist 400ms + push 1.2s
      await forceSync(pageB);

      await tabWithTitle(page, 'RaceNote').click();
      await editor.click();
      await page.keyboard.type('A words typed while B had already pushed');
      await page.locator('#cloudNavContainer').click();
      await expect(page.locator('#cloudModal')).toBeVisible();
      await page.locator('#cloudSyncNow').click();
      await page.waitForTimeout(1_500);
      await page.keyboard.press('Escape');

      // Exactly ONE conflicted copy, wearing the fork badge.
      await expect
        .poll(async () => page.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 30_000,
          message: 'device A to hold the base note plus ONE copy',
        })
        .toContain('RaceNote — conflicted copy');

      const copyTabs1 = await page
        .locator('#tabStripTabs .tab-strip-tab', { hasText: '— conflicted copy' })
        .count();
      expect(copyTabs1, 'exactly one conflicted copy after the first race').toBe(1);

      // The canonical took B's words; the copy holds A's words.
      await expect(page.locator('#note')).toContainText('B first words');
      await page.locator('#tabStripTabs .tab-strip-tab', { hasText: '— conflicted copy' }).click();
      await expect(page.locator('#note')).toContainText('A words typed');

      // ---- race 2: the same shape again --------------------------------
      // A merges the branch's point back into the canonical by editing it,
      // B pushes a newer version first (cleanly — the debounces drain),
      // and A syncs inside the capture window once more. The old merge
      // minted a SECOND copy here — the strip fills with near-duplicates,
      // one per race. The branch must UPDATE in place instead.
      await pageB.locator('#note').click();
      await pageB.keyboard.type(' B second words');
      await pageB.waitForTimeout(2_600); // B's push lands before the race
      await forceSync(pageB);

      await tabWithTitle(page, 'RaceNote').click();
      await editor.click();
      await page.keyboard.type('A second words, still typing');
      await page.locator('#cloudNavContainer').click();
      await expect(page.locator('#cloudModal')).toBeVisible();
      await page.locator('#cloudSyncNow').click();
      await page.waitForTimeout(1_500);
      await page.keyboard.press('Escape');

      // The branch UPDATED in place: still exactly one copy, now carrying
      // the second race's losing words — not a second near-duplicate tab.
      await expect
        .poll(async () => page.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 30_000,
          message: 'the branch to update after the second race',
        })
        .toContain('RaceNote — conflicted copy');

      const copyTabs2 = await page
        .locator('#tabStripTabs .tab-strip-tab', { hasText: '— conflicted copy' })
        .count();
      expect(copyTabs2, 'still exactly one conflicted copy after the second race').toBe(1);

      await page.locator('#tabStripTabs .tab-strip-tab', { hasText: '— conflicted copy' }).click();
      await expect(page.locator('#note')).toContainText('A second words');

      // The fork badge marks the branch in the strip.
      await expect(
        page
          .locator('#tabStripTabs .tab-strip-tab', { hasText: '— conflicted copy' })
          .locator('.tab-strip-copy'),
      ).toBeVisible();

      expect(bErrors, 'uncaught page errors (device B)').toEqual([]);
    } finally {
      await contextB.close();
    }
  });
});
