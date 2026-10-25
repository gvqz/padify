import { expect, test, type Page } from '@playwright/test';

/**
 * The share flow, end to end against the real API.
 *
 * The share sheet's contracts live here:
 *
 *  1. The signed-out gate — sharing is a cloud-account feature; the
 *     gate points at the cloud modal, and the sheet's footer stays
 *     quiet (it speaks for the links list, not the gate).
 *
 *  2. The empty-note refusal — a blank note never becomes a link. The
 *     note card goes dashed and says why, the create button stays dark,
 *     and the server would refuse the row even if the button were forced.
 *
 *  3. The happy path — a note with words shares: the link lands in the
 *     list as Active, newest first, and the foot counts it.
 *
 *  4. The two-step cancel — the confirm state IS the button: the first
 *     click arms it ("Really cancel?"), a click anywhere else disarms
 *     it, and the second click revokes the link. No second dialog ever
 *     stacks over the sheet.
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

async function openShareModal(page: Page): Promise<void> {
  await page.locator('#shareNotes').click();
  await expect(page.locator('#shareModal')).toBeVisible();
}

async function typeIntoFreshNote(page: Page, text: string): Promise<void> {
  await page.locator('#addTab').click();
  const editor = page.locator('#note');
  await expect(editor).toHaveText('');
  await editor.click();
  await page.keyboard.type(text);
}

test.describe('share links (real API)', () => {
  test('the panel hangs from the share icon and the gate points at the cloud panel', async ({
    page,
  }) => {
    await page.goto('/');
    await openShareModal(page);

    // The panel frame: anchored topbar panel, gate pane, no footer bar —
    // the count chip speaks for the list inside the section head.
    await expect(page.locator('#shareModal.topbar-panel.share-panel')).toBeVisible();
    await expect(page.locator('#shareSignedOutPane')).toBeVisible();
    await expect(page.locator('#shareLinkCount')).toBeHidden();

    // Anchored, not a docked sheet: the panel hangs below the topbar's
    // share icon, inside the viewport, and the page keeps its width.
    const box = await page.locator('#shareModal').boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.width).toBeLessThan(viewport.width);

    // The gate hands off to the cloud panel — the sign-in surface.
    await page.locator('#shareSignInCta').click();
    await expect(page.locator('#cloudModal.topbar-panel.cloud-panel')).toBeVisible();
    await expect(page.locator('#shareModal')).toBeHidden();
  });

  test('an empty note cannot be shared — the card says why, the button stays dark', async ({
    page,
  }) => {
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'temporary words that will be deleted');
    await openShareModal(page);

    // A note with words: the create button is alive.
    await expect(page.locator('#shareCreateBtn')).toBeEnabled();
    await expect(page.locator('#shareNoteCard')).not.toHaveClass(/is-empty/);
    await page.keyboard.press('Escape');

    // Delete the words — the note goes empty, and the refusal appears.
    await page.locator('#note').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(700); // let the capture land in the model
    await openShareModal(page);

    await expect(page.locator('#shareNoteCard')).toHaveClass(/is-empty/);
    await expect(page.locator('#shareNoteMeta')).toContainText(/empty/i);
    await expect(page.locator('#shareCreateBtn')).toBeDisabled();
  });

  test('a note with words shares: the link lists as Active and the count chip says it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'the shareable line');
    await openShareModal(page);

    // The create button fires; the new link lands in the list as Active.
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);
    await expect(page.locator('.share-link-row .share-badge.active')).toBeVisible();
    await expect(page.locator('#shareLinkCount')).toHaveText('1');

    // The link's URL is on the clipboard-ready row: a real share URL shape.
    await expect(page.locator('.share-link-url')).toContainText('/share/?t=');
  });

  test('cancelling is a two-step arm on the button — no second dialog', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'the cancellable line');
    await openShareModal(page);

    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);

    // First press: the button arms — filled, asking the question. No
    // Swal, no stacked dialog: the sheet's own DOM is all there is.
    await page.locator('.share-link-row .share-chip-btn.danger').click();
    await expect(page.locator('.share-link-row .share-chip-btn.danger.is-armed')).toHaveText(
      'Really cancel?',
    );
    await expect(page.locator('.swal2-container')).toHaveCount(0);
    await expect(page.locator('.share-link-row .share-badge.active')).toBeVisible();

    // A click anywhere else disarms — the confirm is a gesture on the
    // button, not a state to wander away from.
    await page.locator('.share-links-title').click();
    await expect(page.locator('.share-chip-btn.danger.is-armed')).toHaveCount(0);
    await expect(page.locator('.share-link-row .share-chip-btn.danger')).toHaveText('Cancel link');

    // Arm again; the second press commits and the badge flips.
    await page.locator('.share-link-row .share-chip-btn.danger').click();
    await page.locator('.share-link-row .share-chip-btn.danger.is-armed').click();
    await expect(page.locator('.share-link-row .share-badge.revoked')).toBeVisible();
    await expect(page.locator('.share-link-row')).toHaveClass(/dim/);
    // A cancelled link offers no cancel button anymore.
    await expect(page.locator('.share-chip-btn.danger')).toHaveCount(0);
  });

  test('the scope switch lists other notes\u2019 links, newest first', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());

    // Two notes, each with its own link.
    await typeIntoFreshNote(page, 'first shared note');
    await openShareModal(page);
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);
    await page.keyboard.press('Escape');

    await typeIntoFreshNote(page, 'second shared note');
    await openShareModal(page);
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);
    await expect(page.locator('#shareLinkCount')).toHaveText('1');

    // "This note" shows only the current note's link; "All notes" shows both,
    // newest first — the link you just made leads. The segmented control
    // hides its radios (labels take the clicks).
    await page.locator('label[for="shareScopeAll"]').click();
    await expect(page.locator('.share-link-row')).toHaveCount(2);
    await expect(page.locator('#shareLinkCount')).toHaveText('2');
    await expect(page.locator('.share-link-row .share-link-meta').first()).toContainText(
      'second shared note',
    );

    await page.locator('label[for="shareScopeNote"]').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);
  });

  test('the panel is a tool, not a room: outside click and Escape both close it', async ({
    page,
  }) => {
    await page.goto('/');
    await openShareModal(page);

    // The trigger toggles: a second click on the share icon closes.
    await page.locator('#shareNotes').click();
    await expect(page.locator('#shareModal')).toBeHidden();

    await openShareModal(page);
    // A click on the page (not the panel, not the trigger) dismisses —
    // no backdrop exists; the page itself is the dismiss gesture.
    await page
      .locator('.editor-shell, #note')
      .first()
      .click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#shareModal')).toBeHidden();
  });

  test('a modal takes the screen from any standing panel', async ({ page }) => {
    await page.goto('/');
    await openShareModal(page);

    // The × is data-dismiss="panel" — the panel's own close.
    await page.locator('#shareModal .share-close').click();
    await expect(page.locator('#shareModal')).toBeHidden();

    // A modal owns the screen: standing panels go down when one opens.
    await page.locator('#cloudNavContainer').click();
    await expect(page.locator('#cloudModal')).toBeVisible();
    await page.locator('[data-target="#preferencesModal"]').first().click();
    await expect(page.locator('#preferencesModal')).toBeVisible();
    await expect(page.locator('#cloudModal')).toBeHidden();
  });
});
