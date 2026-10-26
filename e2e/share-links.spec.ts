import { expect, test, type Page } from '@playwright/test';

/**
 * The share flow, end to end against the real API.
 *
 * The share panel's contracts live here:
 *
 *  1. The signed-out gate — sharing is a cloud-account feature; the
 *     gate points at the cloud panel.
 *
 *  2. The empty-note refusal — a blank note never becomes a link: the
 *     button goes dark and one quiet line says why.
 *
 *  3. The happy path — a note with words shares: the note's ONE link
 *     shows as an Active card, the button turns into the update action,
 *     and no second link can ever be minted for the same note.
 *
 *  4. The dedupe — a note keeps ONE active link: updating refreshes the
 *     window it already has (same URL), it does not create a twin.
 *
 *  5. The links popup — the list lives in its own panel, opened from
 *     the share panel's "All links" row, and it lists ACTIVE links
 *     only: a cancelled link leaves the list instead of haunting it.
 *
 *  6. The two-step cancel — the confirm state IS the button: the first
 *     click arms it ("Really cancel?"), a click anywhere else disarms
 *     it, and the second click revokes the link. No second dialog ever
 *     stacks over a panel.
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

async function openSharePanel(page: Page): Promise<void> {
  await page.locator('#shareNotes').click();
  await expect(page.locator('#shareModal')).toBeVisible();
}

async function openLinksPanel(page: Page): Promise<void> {
  // The popup refreshes its list on open — wait for that fetch to land
  // so the rows the test clicks are the settled ones, not a render about
  // to be replaced.
  const listFetched = page.waitForResponse(
    (response) => response.url().includes('/api/shares') && response.request().method() === 'GET',
  );
  await page.locator('#shareAllLinks').click();
  await expect(page.locator('#shareLinksPanel')).toBeVisible();
  await listFetched;
  await expect(page.locator('#shareModal')).toBeHidden();
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
    await openSharePanel(page);

    // The panel frame: anchored topbar panel, gate pane, no note strip,
    // no subtitle — the panel is the act of sharing, nothing previews
    // the note anymore.
    await expect(page.locator('#shareModal.topbar-panel.share-panel')).toBeVisible();
    await expect(page.locator('#shareSignedOutPane')).toBeVisible();
    await expect(page.locator('.share-note-strip')).toHaveCount(0);
    await expect(page.locator('.share-subtitle')).toHaveCount(0);

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

  test('an empty note cannot be shared — the line says why, the button stays dark', async ({
    page,
  }) => {
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'temporary words that will be deleted');
    await openSharePanel(page);

    // A note with words: the create button is alive, no refusal shown.
    await expect(page.locator('#shareCreateBtn')).toBeEnabled();
    await expect(page.locator('#shareEmptyLine')).toBeHidden();
    await page.keyboard.press('Escape');

    // Delete the words — the note goes empty, and the refusal appears.
    await page.locator('#note').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(700); // let the capture land in the model
    await openSharePanel(page);

    await expect(page.locator('#shareEmptyLine')).toBeVisible();
    await expect(page.locator('#shareCreateBtn')).toBeDisabled();
  });

  test('a note with words shares: one Active card, and the button turns into the update', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'the shareable line');
    await openSharePanel(page);

    // The create fires; the note's ONE link lands as the Active card —
    // not as a row in this panel (the list lives in the popup).
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveCard')).toBeVisible();
    await expect(page.locator('#shareActiveUrl')).toContainText('/share/?t=');
    await expect(page.locator('#shareActiveCard .share-badge.active')).toBeVisible();
    await expect(page.locator('#shareModal .share-link-row')).toHaveCount(0);

    // The dedupe is visible in the language: with a link out, the button
    // updates it. It never offers a second one.
    await expect(page.locator('.share-create-label')).toHaveText('Update link');
    await expect(page.locator('#shareLinkCount')).toHaveText('1');
  });

  test('updating the link refreshes its window — the URL survives, no twin is made', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'the refreshed line');
    await openSharePanel(page);

    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveCard')).toBeVisible();
    const urlBefore = await page.locator('#shareActiveUrl').textContent();
    // A 7-day window read moments later floors to 6 — the countdown is honest.
    await expect(page.locator('#shareActiveMeta')).toContainText(/expires in (6|7) days/i);

    // Pick a longer window and update — the same link, new expiry.
    await page.locator('label[for="shareDur30"]').click();
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveMeta')).toContainText(/expires in (29|30) days/i);
    await expect(page.locator('#shareActiveUrl')).toHaveText(urlBefore ?? '');

    // Still exactly one active link in the account.
    await expect(page.locator('#shareLinkCount')).toHaveText('1');
    await openLinksPanel(page);
    await expect(page.locator('.share-link-row')).toHaveCount(1);
  });

  test('the popup lists active links only — cancelling removes the row for good', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    await typeIntoFreshNote(page, 'the cancellable line');
    await openSharePanel(page);

    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveCard')).toBeVisible();

    // The All-links row swaps the panels — same icon, the list's own room.
    await openLinksPanel(page);
    await expect(page.locator('.share-link-row')).toHaveCount(1);
    await expect(page.locator('#sharePopupCount')).toHaveText('1');

    // First press: the row's button arms — filled, asking the question.
    // No Swal, no stacked dialog: the panel's own DOM is all there is.
    await page.locator('.share-link-row .share-chip-btn.danger').click();
    await expect(page.locator('.share-link-row .share-chip-btn.danger.is-armed')).toHaveText(
      'Really cancel?',
    );
    await expect(page.locator('.swal2-container')).toHaveCount(0);

    // A click anywhere else disarms — the confirm is a gesture on the
    // button, not a state to wander away from.
    await page.locator('#shareLinksTitle').click();
    await expect(page.locator('.share-chip-btn.danger.is-armed')).toHaveCount(0);
    await expect(page.locator('.share-link-row .share-chip-btn.danger')).toHaveText('Cancel link');

    // Arm again; the second press commits — and the row LEAVES. No dimmed
    // ghost, no cancelled badge: the popup lists active links only.
    await page.locator('.share-link-row .share-chip-btn.danger').click();
    await page.locator('.share-link-row .share-chip-btn.danger.is-armed').click();
    await expect(page.locator('.share-link-row')).toHaveCount(0);
    await expect(page.locator('#sharePopupCount')).toBeHidden();
    await expect(page.locator('.share-links-empty')).toBeVisible();

    // Back in the share panel: the card is gone, the button creates again.
    await page.keyboard.press('Escape');
    await openSharePanel(page);
    await expect(page.locator('#shareActiveCard')).toBeHidden();
    await expect(page.locator('.share-create-label')).toHaveText('Create link');
    await expect(page.locator('#shareLinkCount')).toBeHidden();
  });

  test('the scope switch lists other notes\u2019 active links, newest first', async ({ page }) => {
    test.setTimeout(90_000);
    await signUp(page, freshAccount());

    // Two notes, each with its own link.
    await typeIntoFreshNote(page, 'first shared note');
    await openSharePanel(page);
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveCard')).toBeVisible();
    await page.keyboard.press('Escape');

    await typeIntoFreshNote(page, 'second shared note');
    await openSharePanel(page);
    await page.locator('#shareCreateBtn').click();
    await expect(page.locator('#shareActiveCard')).toBeVisible();

    // The popup: "This note" shows only the current note's link; "All
    // notes" shows both, newest first — the link you just made leads.
    await openLinksPanel(page);
    await expect(page.locator('.share-link-row')).toHaveCount(1);
    await page.locator('label[for="shareScopeAll"]').click();
    await expect(page.locator('.share-link-row')).toHaveCount(2);
    await expect(page.locator('#sharePopupCount')).toHaveText('2');
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
    await openSharePanel(page);

    // The trigger toggles: a second click on the share icon closes.
    await page.locator('#shareNotes').click();
    await expect(page.locator('#shareModal')).toBeHidden();

    await openSharePanel(page);
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
    await openSharePanel(page);

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
