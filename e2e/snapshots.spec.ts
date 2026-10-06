import { expect, test, type Page } from '@playwright/test';

/**
 * Snapshots e2e — the rebuilt menu, driven the way a person uses it.
 *
 * Coverage deliberately spans the note types (the rebuild's brief: the
 * feature must behave identically on plain, rich and markdown notes),
 * the duplicate prevention, and both faces of the empty state.
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

async function openSnapshots(page: Page): Promise<void> {
  await page.locator('#snapshotsButton').click();
  await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);
}

function snapshotRows(page: Page) {
  return page.locator('#snapshotsList .snapshot-item');
}

async function toastSays(page: Page, text: string): Promise<void> {
  await expect(page.locator('#toast')).toHaveText(text, { timeout: 5_000 });
}

async function newTypedNote(page: Page, kind: 'Rich text note' | 'Markdown note'): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: kind }).click();
  await expect(
    kind === 'Markdown note' ? page.locator('#markdownToolbar') : page.locator('#richToolbar'),
  ).toBeVisible();
}

test.describe('the rebuilt menu', () => {
  test('boots empty: the empty state explains itself, delete-all is disabled', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
    await expect(page.locator('#noSnapshotsHint')).toContainText('Take one with the button above');
    await expect(page.locator('#noSnapshotsMiss')).toBeHidden();
    await expect(page.locator('#deleteAllSnapshotsBtn')).toBeDisabled();
    await expect(page.locator('#snapshotsCount')).toHaveText('0');
  });

  test('the take button snapshots the active note and refreshes the count', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');

    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snapshot-title')).toContainText('Welcome');
    await expect(page.locator('#snapshotsCount')).toHaveText('1');
    await expect(page.locator('#deleteAllSnapshotsBtn')).toBeEnabled();
    // A plain note carries no type badge — restoring it never switches type.
    await expect(snapshotRows(page).first().locator('.snapshot-type-badge')).toHaveCount(0);
  });

  test('the keyboard shortcut works with the modal closed', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();

    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
  });

  test('an unchanged note is declined — no duplicate rows', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();

    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');
    // Nothing changed in between.
    await page.keyboard.press('Control+U');
    await toastSays(page, 'No changes since the last snapshot.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(page.locator('#snapshotsCount')).toHaveText('1');
  });

  test('an edited note snapshots again and the newest row comes first', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' first version');

    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await page.keyboard.type(' plus a second edit');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);
    // Newest first.
    await expect(snapshotRows(page).first().locator('.snapshot-title')).toContainText('Welcome');
  });

  test('an empty note is declined with a toast, not a row', async ({ page }) => {
    await page.goto('/');
    await page.locator('#addTab').click();

    await page.keyboard.press('Control+U');
    await toastSays(page, 'Note is empty. Nothing to save as snapshot.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
  });
});

test.describe('search', () => {
  test('filters by the copy the rows show, and reports a miss honestly', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' grocery run');

    await page.keyboard.press('Control+U');
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);

    // The title derived from the note answers the search.
    await page.locator('#searchSnapshots').fill('grocery');
    await expect(snapshotRows(page)).toHaveCount(1);

    // A miss is a miss — the empty state says so instead of "yet".
    await page.locator('#searchSnapshots').fill('zzz-nothing-matches-this');
    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();
    await expect(page.locator('#noSnapshotsEmpty')).toBeHidden();

    // Clearing the search brings the rows back.
    await page.locator('#searchSnapshots').fill('');
    await expect(snapshotRows(page)).toHaveCount(1);
  });

  test('html markup never answers a search for tags', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    await page.locator('#searchSnapshots').fill('div');
    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();
  });
});

test.describe('restore', () => {
  test('a confirmed restore replaces the note and closes the modal', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' version A');
    await page.keyboard.press('Control+U');

    await page.keyboard.type(' and then some more words');
    await openSnapshots(page);

    await snapshotRows(page).first().locator('.restore').click();
    // Swal asks before overwriting a non-empty note.
    await page.locator('.swal2-confirm').click();

    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await expect(editor).toContainText('version A');
    await expect(editor).not.toContainText('and then some more words');
  });

  test('a declined restore leaves the note untouched', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+U');

    await page.keyboard.press('Control+End');
    await page.keyboard.type(' later additions');
    await openSnapshots(page);

    await snapshotRows(page).first().locator('.restore').click();
    await page.locator('.swal2-cancel').click();

    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);
    await expect(editor).toContainText('later additions');
  });

  test('restoring into an empty note skips the confirmation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    // A fresh empty note restores without Swal asking.
    await page.locator('#addTab').click();
    await openSnapshots(page);
    await snapshotRows(page).first().locator('.restore').click();

    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await expect(page.locator('#note')).toContainText('Welcome');
  });
});

test.describe('note types — consistent behavior', () => {
  test('a markdown note snapshots with its type badge and restores its surface', async ({
    page,
  }) => {
    await page.goto('/');
    await newTypedNote(page, 'Markdown note');

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Trail log');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snapshot-type-badge')).toHaveText('Markdown');

    // Restoring into an empty PLAIN note switches it back to markdown.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#addTab').click();
    await openSnapshots(page);
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    await expect(page.locator('#note')).toContainText('Trail log');
  });

  test('a rich note snapshots and restores like any other', async ({ page }) => {
    await page.goto('/');
    await newTypedNote(page, 'Rich text note');

    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('rich words');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snapshot-type-badge')).toHaveText(
      'Rich Text',
    );

    // Editing then restoring brings the words back.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('replaced entirely');
    await openSnapshots(page);
    await snapshotRows(page).first().locator('.restore').click();
    await page.locator('.swal2-confirm').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#note')).toContainText('rich words');
  });

  test('the rebuilt menu carries the platform key hints', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    // The take button and the empty-state hint both spell the device's
    // modifier — never the Ctrl/Cmd hedge (see lib/platform.ts).
    const buttonKeys = page.locator('#createSnapshotBtn .snapshots-kbd-hint kbd');
    await expect(buttonKeys).toHaveCount(2);
    await expect(buttonKeys.first()).toHaveText('Ctrl');
    await expect(buttonKeys.nth(1)).toHaveText('U');
    await expect(page.locator('#noSnapshotsHint kbd').first()).toHaveText('Ctrl');
  });

  test('restoring a plain snapshot into a markdown note switches it back', async ({ page }) => {
    await page.goto('/');
    // Snapshot the welcome note while it is plain.
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // A markdown note with its own content and chrome.
    await newTypedNote(page, 'Markdown note');
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Not the welcome note');
    await expect(page.locator('#markdownToolbar')).toBeVisible();

    // Restore the plain snapshot — the row without a type badge.
    await openSnapshots(page);
    const plainRow = page
      .locator('#snapshotsList .snapshot-item', { hasNot: page.locator('.snapshot-type-badge') })
      .first();
    await plainRow.locator('.restore').click();
    await page.locator('.swal2-confirm').click();
    await toastSays(page, 'Snapshot restored!');

    // The markdown chrome stands down and the html content paints.
    await expect(page.locator('#markdownToolbar')).toBeHidden();
    await expect(page.locator('#note')).toContainText('Welcome');
    // The switch survives a reload — the note's stored type moved too.
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.locator('#note')).toContainText('Welcome');
    await expect(page.locator('#markdownToolbar')).toBeHidden();
  });
});

test.describe('deleting', () => {
  test('one row deletes after its confirmation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    await snapshotRows(page).first().locator('.delete').click();
    await page.locator('.swal2-cancel').click();
    await expect(snapshotRows(page)).toHaveCount(1); // nothing happened

    await snapshotRows(page).first().locator('.delete').click();
    await page.locator('.swal2-confirm').click();

    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#snapshotsCount')).toHaveText('0');
    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
    await expect(page.locator('#deleteAllSnapshotsBtn')).toBeDisabled();
  });

  test('delete all clears the store after its confirmation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' two');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);

    await page.locator('#deleteAllSnapshotsBtn').click();
    await page.locator('.swal2-confirm').click();

    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#snapshotsCount')).toHaveText('0');
    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
  });
});
