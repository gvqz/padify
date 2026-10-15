import { expect, test, type Page } from '@playwright/test';

/**
 * The share flow, end to end against the real API.
 *
 * The modal redesign's two contracts live here:
 *
 *  1. The empty-note refusal — a blank note never becomes a link. The
 *     note card goes dashed and says why, the create button stays dark,
 *     and the server would refuse the row even if the button were forced.
 *
 *  2. The happy path — a note with words shares: the link lands in the
 *     list with an Active badge, cancelling it flips the badge, and the
 *     signed-out gate points at the cloud modal.
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
  test('the signed-out gate points at the cloud modal', async ({ page }) => {
    await page.goto('/');
    await openShareModal(page);

    await expect(page.locator('#shareSignedOutPane')).toBeVisible();
    await page.locator('#shareSignInCta').click();
    await expect(page.locator('#cloudModal')).toBeVisible();
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

  test('a note with words shares: the link lists as Active and cancels to Revoked', async ({
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

    // Cancel: Swal asks first, then the badge flips to Revoked and the row
    // dims.
    await page.locator('.share-link-row .share-chip-btn.danger').click();
    await expect(page.locator('.swal2-confirm')).toBeVisible();
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.share-link-row .share-badge.revoked')).toBeVisible();
  });

  test('the scope switch lists other notes\u2019 links', async ({ page }) => {
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

    // "This note" shows only the current note's link; "All notes" shows both.
    // The segmented control hides its radios (labels take the clicks).
    await page.locator('label[for="shareScopeAll"]').click();
    await expect(page.locator('.share-link-row')).toHaveCount(2);
    await page.locator('label[for="shareScopeNote"]').click();
    await expect(page.locator('.share-link-row')).toHaveCount(1);
  });
});
