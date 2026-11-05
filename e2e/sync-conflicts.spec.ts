import { expect, test, type Page } from '@playwright/test';

/**
 * Version conflicts, end to end against the real API — the parked record
 * and the review sheet under their harshest light.
 *
 * The story the user told: a note edited from two open devices accumulated
 * a "X — conflicted copy" tab per sync cycle until the strip filled with
 * near-identical notes. The words now park on the note itself
 * (NoteTab.conflict): the strip badges it, the review sheet resolves it,
 * and a repeated race refreshes the record instead of minting anything.
 *
 * The race is staged with real offline windows (context.setOffline), not
 * timing luck:
 *
 *   1. both devices share a base version;
 *   2. A goes offline and types; B types and pushes;
 *   3. A reconnects — the pull beats A's push, A's dirty words lose, and
 *      the record parks them on the note;
 *   4. the SAME race runs a second time — the record must keep the
 *      ORIGINAL lost words and refresh theirs, never mint a twin.
 *
 * Complementary edits (the common case) never park at all: the three-way
 * merge splices them into the canonical note.
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
  // The auth POST is a network round trip — on a loaded CI box five
  // seconds of default headroom lost the race twice.
  await expect(page.locator('#cloudSignedInPane')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** Starts a sync cycle INSTANTLY — the same 'online' listener production
 *  uses, dispatched microseconds after the keystrokes: deep inside the
 *  500ms editor-capture window, so the cycle pushes the STALE model and
 *  the merge-time capture is what makes the local dirty. That is the
 *  production shape of a two-device race (the 30s tick landing mid-typing),
 *  staged without the modal's click-to-click timing luck. */
async function raceSync(page: Page): Promise<void> {
  // The user looked away from the editor (the original staging bought
  // this blur with the cloud modal's dance): an unfocused editor is what
  // lets a merge repaint the note instead of deferring to the typist.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => page.locator('#cloudNavContainer').getAttribute('title'), {
      timeout: 20_000,
      message: 'the raced sync cycle to land',
    })
    .toContain('up to date');
}

/** Forces a full sync cycle through the modal's manual button. */
async function forceSync(page: Page): Promise<void> {
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
  await page.locator('#cloudSyncNow').click();
  // The cycle must actually LAND — a fixed sleep raced under CI load and
  // the next device pulled the pre-sync state. The navbar title carries
  // the live phase; "up to date" is the idle-after-sync signature.
  await expect
    .poll(async () => page.locator('#cloudNavContainer').getAttribute('title'), {
      timeout: 20_000,
      message: 'the manual sync cycle to land',
    })
    .toContain('up to date');
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudModal')).toBeHidden();
}

/** The tab whose title is EXACTLY the given text (a substring locator
 *  would also match restored copies — "X" matches "X (other version)"). */
function tabWithTitle(page: Page, title: string) {
  return page.locator('#tabStripTabs .tab-strip-tab').filter({
    has: page.locator('.tab-strip-title', { hasText: new RegExp(`^${title}$`) }),
  });
}

test.describe('version conflicts (real API)', () => {
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

  test("complementary edits merge — no badge, no twin, everyone's words live", async ({
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
    await page.keyboard.type('MergeNote base start');
    await page.keyboard.type(' middle words');
    await page.keyboard.type(' base end');
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
      await expect(pageB.locator('#cloudSignedInPane')).toBeVisible({ timeout: 15_000 });
      await pageB.keyboard.press('Escape');

      await expect
        .poll(async () => pageB.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 60_000,
          message: 'the note to arrive on device B',
        })
        .toContain('MergeNote base start middle words base end');

      // B edits the END (waits out its capture+persist+push debounces so
      // it arrives at the push CLEAN); A then edits the START. B must
      // SWITCH to the pulled note first — its welcome tab is what was
      // active, and typing into it would push the wrong note entirely.
      await pageB.locator('#tabStripTabs .tab-strip-tab', { hasText: 'MergeNote' }).click();
      await pageB.locator('#note').click();
      await pageB.keyboard.press('Control+End');
      await pageB.keyboard.type(' tailB');
      await pageB.waitForTimeout(2_600);
      await forceSync(pageB);

      await editor.click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('headA ');
      await raceSync(page);

      // The merge spliced both ends into one note. No badge, no twin —
      // ONE note carrying both devices' words.
      await expect(page.locator('#note')).toContainText('headA');
      await expect(page.locator('#note')).toContainText('tailB');
      await expect(page.locator('.tab-strip-conflict')).toHaveCount(0);
      const titles = await page.locator('#tabStripTabs .tab-strip-title').allTextContents();
      expect(titles.filter((t) => t.includes('MergeNote'))).toHaveLength(1);

      expect(bErrors, 'uncaught page errors (device B)').toEqual([]);
    } finally {
      await contextB.close();
    }
  });

  test("a change that lands while you're away peeks on the next open — once, marked, no badge", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const account = freshAccount();

    // ---- the shared base: A writes PeekNote, then looks elsewhere -------
    await signUp(page, account);
    await page.locator('#addTab').click();
    await page.locator('#note').click();
    await page.keyboard.type('PeekNote origin words');
    await forceSync(page);
    // A opens a FRESH note — PeekNote sits in the strip, unwatched.
    await page.locator('#addTab').click();
    await expect(
      page.locator('#tabStripTabs .tab-strip-title', { hasText: 'PeekNote origin words' }),
    ).toBeVisible();

    // ---- device B: the same account, edits PeekNote --------------------
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
      await expect(pageB.locator('#cloudSignedInPane')).toBeVisible({ timeout: 15_000 });
      await pageB.keyboard.press('Escape');

      await expect
        .poll(async () => pageB.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 60_000,
          message: 'the note to arrive on device B',
        })
        .toContain('PeekNote origin words');

      // B appends (waits out capture+persist+push so it arrives CLEAN).
      await pageB.locator('#tabStripTabs .tab-strip-tab', { hasText: 'PeekNote' }).click();
      await pageB.locator('#note').click();
      await pageB.keyboard.press('Control+End');
      await pageB.keyboard.type(' tailFromB');
      await pageB.waitForTimeout(2_600);
      await forceSync(pageB);

      // ---- A pulls — PeekNote is NOT the active note, so the change -----
      // ---- arrives unseen ----------------------------------------------
      await raceSync(page);
      // A clean adoption: no badge anywhere (this is not a conflict).
      await expect(page.locator('.tab-strip-conflict')).toHaveCount(0);

      // Opening the note answers "what changed since I last looked?":
      // the peek opens over the freshly painted words, B's tail marked.
      await page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'PeekNote' }).click();
      await expect(page.locator('#unseenModal')).toHaveClass(/in/);
      await expect(page.locator('#unseenDiff')).toContainText('PeekNote origin words');
      await expect(page.locator('#unseenDiff .conflict-ins')).toContainText('tailFromB');
      // Nothing was lost — nothing is struck through.
      await expect(page.locator('#unseenDiff .conflict-del')).toHaveCount(0);

      // Close it; the note underneath already carries everyone's words.
      await page.locator('#unseenModal .snap-foot [data-dismiss="modal"]').click();
      await expect(page.locator('#unseenModal')).not.toHaveClass(/in/);
      await expect(page.locator('#note')).toContainText('PeekNote origin words');
      await expect(page.locator('#note')).toContainText('tailFromB');

      // The peek is once per change: away and back, nothing re-opens.
      await page.locator('#addTab').click();
      await page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'PeekNote' }).click();
      await expect(page.locator('#note')).toContainText('tailFromB');
      await expect(page.locator('#unseenModal')).not.toHaveClass(/in/);

      expect(bErrors, 'uncaught page errors (device B)').toEqual([]);
    } finally {
      await contextB.close();
    }
  });

  test('a true race parks ONE record — the second race refreshes it, never mints', async ({
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

    // Rename the note so the strip can assert it exactly.
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
      await expect(pageB.locator('#cloudSignedInPane')).toBeVisible({ timeout: 15_000 });
      await pageB.keyboard.press('Escape');

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
      // debounces first, so B arrives at the race CLEAN.
      await tabWithTitle(pageB, 'RaceNote').click();
      await pageB.locator('#note').click();
      await pageB.keyboard.press('Control+End');
      await pageB.keyboard.type(' B first words');
      await pageB.waitForTimeout(2_600); // capture 500ms + persist 400ms + push 1.2s
      await forceSync(pageB);

      await tabWithTitle(page, 'RaceNote').click();
      await editor.click();
      // Control+End on BOTH devices with a leading space: two insertions
      // at the SAME anchor are the true overlap — anything less (adjacent
      // anchors, glued words) the merge legitimately splices as
      // complementary, and no badge is the CORRECT answer there.
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' raceA');
      await raceSync(page);

      // ONE note, wearing the review badge — no twin anywhere.
      await expect
        .poll(async () => page.locator('#tabStripTabs .tab-strip-title').allTextContents(), {
          timeout: 30_000,
          message: 'device A to hold exactly the one note, badged',
        })
        .toContain('RaceNote');
      const raceTitles = await page.locator('#tabStripTabs .tab-strip-title').allTextContents();
      expect(raceTitles.filter((t) => t.includes('RaceNote'))).toHaveLength(1);
      const badged = tabWithTitle(page, 'RaceNote').locator('.tab-strip-conflict');
      await expect(badged).toBeVisible();

      // The canonical took B's words; the review sheet holds A's.
      await expect(page.locator('#note')).toContainText('B first words');

      // ---- the review: restore MY version --------------------------------
      await badged.click();
      await expect(page.locator('#conflictModal')).toHaveClass(/in/);
      // The tracked body marks A's lost words struck, B's words live.
      await expect(page.locator('#conflictDiff')).toContainText('raceA');
      await page.locator('[data-conflict-resolution="mine"]').click();
      await expect(page.locator('#conflictModal')).toBeHidden();
      await expect(page.locator('#note')).toContainText('raceA');
      // The badge retired with the record.
      await expect(page.locator('.tab-strip-conflict')).toHaveCount(0);

      // The restored version must reach BOTH devices before the second
      // race — a shared ancestor is what makes the second overlap a
      // conflict instead of two disjoint edits on diverged lineages.
      await forceSync(page);
      await forceSync(pageB);
      await expect(pageB.locator('#note')).toContainText('raceA');

      // ---- race 2: the same shape again --------------------------------
      await pageB.locator('#note').click();
      await pageB.keyboard.press('Control+End');
      await pageB.keyboard.type(' B second words');
      await pageB.waitForTimeout(2_600); // B's push lands before the race
      await forceSync(pageB);

      await tabWithTitle(page, 'RaceNote').click();
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' raceA2');
      await raceSync(page);

      // Still ONE note, still ONE badge — the record refreshed, nothing
      // minted. The strip never fills with near-duplicates again.
      await expect(tabWithTitle(page, 'RaceNote').locator('.tab-strip-conflict')).toBeVisible({
        timeout: 30_000,
      });
      const raceTitles2 = await page.locator('#tabStripTabs .tab-strip-title').allTextContents();
      expect(raceTitles2.filter((t) => t.includes('RaceNote'))).toHaveLength(1);
      expect(
        await page.locator('.tab-strip-conflict').count(),
        'exactly one review badge after the second race',
      ).toBe(1);

      // The second review offers the SECOND race's losing words.
      await tabWithTitle(page, 'RaceNote').locator('.tab-strip-conflict').click();
      await expect(page.locator('#conflictDiff')).toContainText('raceA2');
      await page.locator('[data-conflict-resolution="both"]').click();
      await expect(page.locator('#conflictModal')).toBeHidden();
      // "Keep both": the note keeps my words AND their version lands as
      // an explicit copy — the old twin behavior, as a decision.
      await expect(page.locator('#note')).toContainText('raceA2');
      await expect(
        page.locator('#tabStripTabs .tab-strip-title', { hasText: '(other version)' }),
      ).toBeVisible();

      expect(bErrors, 'uncaught page errors (device B)').toEqual([]);
    } finally {
      await contextB.close();
    }
  });
});
