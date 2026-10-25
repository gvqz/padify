import { expect, test, type Page } from '@playwright/test';

/**
 * Snapshots e2e — the typed timeline, driven the way a person uses it.
 *
 * Coverage spans the note types (the feature must behave identically on
 * plain, rich and markdown notes), duplicate prevention (including the
 * restore loop), the note-identity contract (restores go to the note a
 * snapshot came from; deleted notes resurrect as their own notes),
 * type-sectioned sorting, and both faces of the empty state.
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

  test('closing a background tab snapshots THE CLOSING note, not the active one', async ({
    page,
  }) => {
    await page.goto('/');
    // Two notes with distinct content: "alpha" stays active, "beta" is
    // closed in the background. Regression: createSnapshot() read the
    // ACTIVE note — the safety snapshot stored alpha's content under
    // beta's name (or declined silently when alpha was empty).
    await page.locator('#note').click();
    await page.keyboard.type('alpha content');
    await page.waitForTimeout(600);
    await page.locator('#addTab').click();
    await page.locator('#note').click();
    await page.keyboard.type('beta background content');
    await page.waitForTimeout(600);

    // Switch back to the first tab so beta is a BACKGROUND tab, then close
    // beta through its tab-strip × (the middle-click path shares closeNow).
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#note')).toContainText('alpha content');
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).locator('.tab-strip-close').click();
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('#tabStripTabs .tab-strip-tab')).toHaveCount(1);

    // The safety snapshot must hold BETA's words.
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    const row = snapshotRows(page).first();
    await expect(row.locator('.snapshot-title')).toContainText('beta');
    await expect(row.locator('.snapshot-preview')).toContainText('beta background');
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

  test('two rapid captures store one row — the second sees the first', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();

    // Two presses before either toast settles: captures serialize through
    // a queue, so the duplicate check re-runs after the first write lands.
    await page.keyboard.press('Control+U');
    await page.keyboard.press('Control+U');

    await expect(page.locator('#toast')).toHaveText('No changes since the last snapshot.', {
      timeout: 5_000,
    });
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(page.locator('#snapshotsCount')).toHaveText('1');
  });

  test('the restore loop cannot save the same version twice', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' version one');
    await page.keyboard.press('Control+U'); // v1
    await page.keyboard.type(' and version two');
    await page.keyboard.press('Control+U'); // v2 — the note's latest

    // Restore v1 (the older row). The pre-restore safety copy of v2 is
    // declined — v2 already IS the latest snapshot.
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);
    await snapshotRows(page).nth(1).locator('.restore').click();
    await page.locator('.swal2-confirm').click();
    await toastSays(page, 'Snapshot restored!');

    // The note is back at v1; capturing it again must NOT file v1 twice.
    await page.keyboard.press('Control+U');
    await toastSays(page, 'This version is already saved.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);
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

test.describe('restore — to the note it came from', () => {
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
    // Swal asks before overwriting a note that holds something else.
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

  test('a restore goes to ITS note — the note you are editing is untouched', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+U'); // snapshot the Welcome note
    await toastSays(page, 'Snapshot created!');

    // A second note, being edited, with its own words.
    await page.locator('#addTab').click();
    await editor.click();
    await page.keyboard.type('work in progress');

    // Restore the Welcome snapshot from here — no confirm (its note is
    // unchanged), and the restore must land on the WELCOME note.
    await openSnapshots(page);
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    // The Welcome note is on stage again...
    await expect(editor).toContainText('Welcome');
    // ...and the note being edited keeps its words, untouched.
    const tabs = page.locator('#tabStripTabs .tab-strip-tab');
    await expect(tabs).toHaveCount(2);
    await tabs.nth(1).click();
    await expect(editor).toContainText('work in progress');
  });

  test('a snapshot of a deleted note resurrects it as its own note', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');

    // A named note with content, snapshotted.
    await page.locator('#addTab').click();
    await editor.click();
    await page.keyboard.type('Phoenix rises');
    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'Phoenix rises' })
      .first()
      .dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Phoenix');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // The row carries the note's name — identity on a shared timeline.
    await openSnapshots(page);
    const row = snapshotRows(page).first();
    await expect(row.locator('.snapshot-note')).toHaveText('Phoenix');
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    // The note is deleted — the safety copy on close declines silently
    // (nothing changed since the snapshot), so exactly one row remains.
    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'Phoenix' })
      .first()
      .locator('.tab-strip-close')
      .click();
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('#tabStripTabs .tab-strip-tab')).toHaveCount(1);

    // Restore — the note is gone, so it comes back as its OWN note.
    await openSnapshots(page);
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    const tabs = page.locator('#tabStripTabs .tab-strip-tab');
    await expect(tabs).toHaveCount(2);
    await expect(page.locator('#tabStripTabs .tab-strip-tab.active')).toContainText('Phoenix');
    await expect(editor).toContainText('Phoenix rises');
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

    // Restoring from a DIFFERENT note still lands on the markdown note —
    // its surface comes back with its content, and the plain note that
    // was on stage is never touched.
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

  test('restoring a plain snapshot while editing a markdown note leaves yours alone', async ({
    page,
  }) => {
    await page.goto('/');
    // Snapshot the welcome note while it is plain.
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // A markdown note with its own content and chrome, now on stage.
    await newTypedNote(page, 'Markdown note');
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Not the welcome note');
    await expect(page.locator('#markdownToolbar')).toBeVisible();

    // Restore the plain snapshot — the row without a type badge. No
    // confirm: ITS note (the Welcome note) is unchanged, and the note
    // being edited is not the one being written to.
    await openSnapshots(page);
    const plainRow = page
      .locator('#snapshotsList .snapshot-item', { hasNot: page.locator('.snapshot-type-badge') })
      .first();
    await plainRow.locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    // The Welcome note is on stage; the markdown chrome stood down.
    await expect(page.locator('#markdownToolbar')).toBeHidden();
    await expect(page.locator('#note')).toContainText('Welcome');

    // The markdown note was never touched — its words and chrome survive,
    // and the switch survives a reload. (The heading renders without its
    // literal '#' — the editor shows prose, not source.)
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    await expect(page.locator('#note')).toContainText('Not the welcome note');
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.locator('#note')).toContainText('Not the welcome note');
    await expect(page.locator('#markdownToolbar')).toBeVisible();
  });

  test('the menu sorts by note type — sections in registry order, not recency', async ({
    page,
  }) => {
    await page.goto('/');

    // A plain snapshot FIRST, a markdown snapshot LATER — recency would
    // put markdown on top; the menu's sort must not.
    await page.locator('#addTab').click();
    await page.locator('#note').click();
    await page.keyboard.type('plain words');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await newTypedNote(page, 'Markdown note');
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# markdown words');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    const headers = page.locator('#snapshotsList .snapshots-type');
    await expect(headers).toHaveCount(2);
    // Registry order: Notes before Markdown, however recent markdown is.
    await expect(headers.nth(0).locator('.snapshots-type-label')).toHaveText('Notes');
    await expect(headers.nth(0).locator('.snapshots-type-count')).toHaveText('1');
    await expect(headers.nth(1).locator('.snapshots-type-label')).toHaveText('Markdown');
    await expect(headers.nth(1).locator('.snapshots-type-count')).toHaveText('1');

    // Each row sits under its own section — the plain row leads the list.
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(snapshotRows(page).first().locator('.snapshot-preview')).toContainText(
      'plain words',
    );
    await expect(snapshotRows(page).first().locator('.snapshot-type-badge')).toHaveCount(0);
    await expect(snapshotRows(page).nth(1).locator('.snapshot-type-badge')).toHaveText('Markdown');
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

test.describe('the typed timeline', () => {
  test('rows group under one Notes section and one Today header', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await page.keyboard.type(' more words');
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    const sections = page.locator('#snapshotsList .snapshots-type');
    await expect(sections).toHaveCount(1);
    await expect(sections.first().locator('.snapshots-type-label')).toHaveText('Notes');
    await expect(sections.first().locator('.snapshots-type-count')).toHaveText('2');
    const days = page.locator('#snapshotsList .snapshots-day');
    await expect(days).toHaveCount(1);
    await expect(days.first()).toHaveText('Today');
    await expect(snapshotRows(page)).toHaveCount(2);
    // The headers are not rows.
    await expect(sections.first()).not.toHaveClass(/snapshot-item/);
    await expect(days.first()).not.toHaveClass(/snapshot-item/);
  });

  test('a row expands to its readable text and collapses again', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' expandable body copy lives here');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const row = snapshotRows(page).first();
    const main = row.locator('.snapshot-main');
    await expect(main).toHaveAttribute('aria-expanded', 'false');

    await main.click();
    await expect(main).toHaveAttribute('aria-expanded', 'true');
    const panel = row.locator('.snapshot-expand');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('expandable body copy');

    await main.click();
    await expect(main).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
  });

  test('Enter toggles the expansion from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const main = snapshotRows(page).first().locator('.snapshot-main');
    await main.focus();
    await page.keyboard.press('Enter');
    await expect(main).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(main).toHaveAttribute('aria-expanded', 'false');
  });

  test('the matching row wears the Current chip; an edit drops it', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const row = snapshotRows(page).first();
    await expect(row).toHaveClass(/is-current/);
    await expect(row.locator('.snapshot-current')).toBeVisible();
    await expect(row.locator('.snapshot-current')).toContainText('Current');

    // Change the note WITHOUT snapshotting — the row no longer matches.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' changed after the fact');
    await openSnapshots(page);
    await expect(snapshotRows(page).first()).not.toHaveClass(/is-current/);
  });

  test('a just-taken row arrives flashing', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');
    await expect(snapshotRows(page).first()).toHaveClass(/is-new/);
  });

  test('restore is a labeled button, delete sits apart', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const actions = snapshotRows(page).first().locator('.snapshot-actions');
    await expect(actions.locator('.restore')).toHaveText('Restore');
    // The hairline between copy and delete keeps a slip off the trash.
    await expect(actions.locator('.snapshot-actions-sep')).toBeVisible();
    await expect(actions.locator('.copy')).toBeVisible();
    await expect(actions.locator('.delete')).toBeVisible();
  });

  test('the footer tells the whole story: N of 200', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);
    await expect(page.locator('#snapshotsCount')).toHaveText('0');
    await expect(page.locator('#snapshotsModal .snapshots-cap')).toHaveText('of 200');
  });

  test('the toolbar stays pinned while the list scrolls, headers stack under it', async ({
    page,
  }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.locator('#note').click();
    // Enough rows to overflow the list's scroll area at this height.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.type(` row number ${i}`);
      await page.keyboard.press('Control+U');
    }
    await openSnapshots(page);

    const container = page.locator('.snapshots-list-container');
    const scrolls = await container.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls, 'the list overflows its own scroll area').toBe(true);

    // Scroll the LIST to the bottom — the toolbar must still be on stage.
    await container.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);

    const toolbar = page.locator('.snapshots-toolbar');
    await expect(toolbar).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height, 'toolbar stays inside the viewport').toBeLessThan(
      560,
    );

    // The headers are a two-level sticky stack: the TYPE header pins to
    // the container's top, the day header rides exactly under it (its
    // 42px reserved lane).
    const offsets = await page.evaluate(() => {
      const typeHeader = document.querySelector('.snapshots-type') as HTMLElement;
      const dayHeader = document.querySelector('.snapshots-day') as HTMLElement;
      const box = document.querySelector('.snapshots-list-container') as HTMLElement;
      return {
        typeTop: typeHeader.getBoundingClientRect().top,
        dayTop: dayHeader.getBoundingClientRect().top,
        boxTop: box.getBoundingClientRect().top,
      };
    });
    expect(Math.abs(offsets.typeTop - offsets.boxTop)).toBeLessThan(2);
    expect(Math.abs(offsets.dayTop - (offsets.boxTop + 42))).toBeLessThan(2);
  });

  test('mobile: rows stack, headers stay pinned, every action stays reachable', async ({
    page,
  }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    // The navbar collapses its tools behind the hamburger at this width.
    await page.locator('.navbar-toggle').click();
    await openSnapshots(page);

    await expect(page.locator('#snapshotsList .snapshots-type')).toHaveText(/Notes/);
    await expect(page.locator('#snapshotsList .snapshots-day')).toHaveText('Today');
    const row = snapshotRows(page).first();
    await expect(row.locator('.snapshot-main')).toBeVisible();
    await expect(row.locator('.restore')).toBeVisible();
    await expect(row.locator('.copy')).toBeVisible();
    await expect(row.locator('.delete')).toBeVisible();
    // The side column stacks under the content as a full-width row.
    const side = await row.locator('.snapshot-side').boundingBox();
    const main = await row.locator('.snapshot-main').boundingBox();
    expect(side).not.toBeNull();
    expect(main).not.toBeNull();
    expect(side!.y).toBeGreaterThan(main!.y);
  });
});
