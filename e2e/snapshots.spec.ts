import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Snapshots e2e — the History sheet, driven the way a person uses it.
 *
 * The sheet is a right-side timeline: one continuous chronology (no
 * type sections, no folding), day anchors on the rail, entries that
 * expand in place into a detail card owning the actions. Restore is
 * one click (the pre-restore safety copy is the undo path); deletes
 * confirm with a two-step arm on the button itself. Coverage spans
 * the note types (the feature must behave identically on plain, rich
 * and markdown notes), duplicate prevention (including the restore
 * loop), the note-identity contract (restores go to the note a
 * snapshot came from; deleted notes resurrect as their own notes),
 * and both faces of the empty state.
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
  return page.locator('#snapshotsList .snap-item');
}

/** An entry's actions live inside its detail card — expand it first,
 *  the way a person would. */
async function expandRow(page: Page, row: Locator): Promise<void> {
  await row.locator('.snap-row').click();
  await expect(row.locator('.snap-detail')).toBeVisible();
}

/** Seeds a snapshot row with an arbitrary timestamp, straight into the
 *  store — the one way to test a menu whose history spans days without
 *  waiting for midnight. Attributed to a note that does not exist, the
 *  same shape a deleted note's rows keep. */
async function seedSnapshotDaysAgo(page: Page, daysAgo: number): Promise<void> {
  await page.evaluate((ago) => {
    const timestamp = Date.now() - ago * 24 * 60 * 60 * 1000;
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('NotepadSnapshotsDB');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['snapshots'], 'readwrite');
        tx.objectStore('snapshots').add({
          noteId: 'seed-old-note',
          noteName: 'Old days',
          title: 'an entry from days ago',
          content: '<div>an entry from days ago</div>',
          preview: 'an entry from days ago',
          timestamp,
          formattedDate: '',
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  }, daysAgo);
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
    await expect(page.locator('#snapshotsCount')).toHaveText('0 of 200');
  });

  test('the sheet opens docked to the right edge, full height', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSnapshots(page);
    // Let the slide-in transition settle before measuring geometry.
    await page.waitForTimeout(400);

    const dialog = page.locator('#snapshotsModal .modal-dialog');
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width, 'the sheet hugs the right edge').toBeGreaterThan(1279);
    expect(box!.height, 'the sheet owns the full viewport height').toBeGreaterThanOrEqual(790);
  });

  test('the take button snapshots the active note and refreshes the count', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');

    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snap-name')).toContainText('Welcome');
    await expect(page.locator('#snapshotsCount')).toHaveText('1 of 200');
    await expect(page.locator('#deleteAllSnapshotsBtn')).toBeEnabled();
    // A plain unnamed note carries no note chip — its first line IS its
    // label, and the name line already shows it.
    await expect(snapshotRows(page).first().locator('.snap-note')).toHaveCount(0);
  });

  test('the keyboard shortcut works with the sheet closed', async ({ page }) => {
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
    const editor = page.locator('#note');

    await page.locator('#addTab').click();
    await editor.click();
    await page.keyboard.type('background note body');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // Switch to the Welcome note, then close the background one.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'background note body' })
      .locator('.tab-strip-close')
      .click();
    // The close takes a safety copy of the CLOSING note (silent — the
    // tab-close toast is the message) and asks about deleting it.
    await page.locator('dialog.vz-dialog .vz-dialog-confirm').click();
    await expect(page.locator('#tabStripTabs .tab-strip-tab')).toHaveCount(1);

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snap-name')).toContainText(
      'background note body',
    );
  });

  test('an unchanged note is declined — no duplicate rows', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await page.keyboard.press('Control+U');
    await toastSays(page, 'No changes since the last snapshot.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
  });

  test('two rapid captures store one row — the second sees the first', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();

    await Promise.all([page.keyboard.press('Control+U'), page.keyboard.press('Control+U')]);

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
  });

  test('the restore loop cannot save the same version twice', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type(' version one');
    await page.keyboard.press('Control+U');

    await page.keyboard.type(' version two words');
    await page.keyboard.press('Control+U');

    // Restore v1: v1's bytes return to the note...
    await openSnapshots(page);
    const rows = snapshotRows(page);
    await expandRow(page, rows.nth(1));
    await rows.nth(1).locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');

    // ...so the next capture is a duplicate of v1 and must be declined.
    // v1 is not the newest row anymore — the pre-restore safety copy
    // (the v2 bytes the note held) leads the timeline — so the decline
    // is the deeper one: this exact version is already saved.
    await page.keyboard.press('Escape');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'This version is already saved.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);
  });

  test('an edited note snapshots again and the newest row comes first', async ({ page }) => {
    await page.goto('/');
    // Short content of our own — the welcome template's derived title
    // truncates long before a second edit would show in the name.
    await page.locator('#note').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('first words');
    await page.keyboard.press('Control+U');

    await page.keyboard.type(' second words');
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    const rows = snapshotRows(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.snap-name')).toContainText('second words');
    await expect(rows.nth(1).locator('.snap-name')).toContainText('first words');
  });

  test('an empty note is declined with a toast, not a row', async ({ page }) => {
    await page.goto('/');
    // A fresh note starts empty — make sure the welcome text is gone.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('#note').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');

    await page.keyboard.press('Control+U');
    await toastSays(page, 'Note is empty. Nothing to save as snapshot.');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(0);
  });
});

test.describe('the sheet frame', () => {
  test('a backdrop click closes the sheet', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    // The host element itself is the backdrop area (the sheet hangs off
    // its right edge) — a click left of the sheet lands on the host.
    await page.locator('#snapshotsModal').click({ position: { x: 200, y: 300 } });
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
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
  test('a restore applies at once: the note is replaced, the menu stays open', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' version A');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // The note drifts on — the snapshot no longer matches it.
    await page.keyboard.type(' and then some more words');
    await openSnapshots(page);

    // No confirmation dialog — the detail card already named the target,
    // and the pre-restore safety copy is the undo path.
    const rows = snapshotRows(page);
    await expandRow(page, rows.first());
    await rows.first().locator('.restore').click();

    await toastSays(page, 'Snapshot restored!');
    // The menu STAYS open — the next version to compare is right there,
    // and the row that now matches the note wears the Current chip.
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);
    // The restored row is the one WITHOUT the replaced words — v1 and
    // the safety copy share their first hundred characters, so the
    // words that were replaced are the only discriminator.
    const restoredRow = page
      .locator('#snapshotsList .snap-item')
      .filter({ hasNotText: 'and then some more words' })
      .first();
    await expect(restoredRow).toHaveClass(/is-current/);
    await expect(editor).toContainText('version A');
    await expect(editor).not.toContainText('and then some more words');
  });

  test('the restore is undoable: the pre-restore text lands as a snapshot', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' version A');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await page.keyboard.type(' and then some more words');
    await openSnapshots(page);

    const rows = snapshotRows(page);
    await expandRow(page, rows.first());
    await rows.first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');

    // The safety copy of the pre-restore text leads the timeline —
    // the undo path is a row, not a promise.
    await expect(snapshotRows(page).first().locator('.snap-name')).toContainText(
      'Before restoring',
    );
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(editor).toContainText('version A');
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

    // Restore the Welcome snapshot from here — the restore must land on
    // the WELCOME note.
    await openSnapshots(page);
    await expandRow(page, snapshotRows(page).first());
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    // The menu stays open; the tab switch happened underneath. Close it
    // before driving the tab strip again.
    await page.keyboard.press('Escape');
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
    await expect(snapshotRows(page).first().locator('.snap-note')).toHaveText('Phoenix');
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    // The note is deleted — the safety copy on close declines silently
    // (nothing changed since the snapshot), so exactly one row remains.
    await page
      .locator('#tabStripTabs .tab-strip-tab', { hasText: 'Phoenix' })
      .first()
      .locator('.tab-strip-close')
      .click();
    await page.locator('dialog.vz-dialog .vz-dialog-confirm').click();
    await expect(page.locator('#tabStripTabs .tab-strip-tab')).toHaveCount(1);

    // Restore — the note is gone, so it comes back as its OWN note.
    await openSnapshots(page);
    await expandRow(page, snapshotRows(page).first());
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);

    const tabs = page.locator('#tabStripTabs .tab-strip-tab');
    await expect(tabs).toHaveCount(2);
    await expect(page.locator('#tabStripTabs .tab-strip-tab.active')).toContainText('Phoenix');
    await expect(editor).toContainText('Phoenix rises');
  });
});

test.describe('note types — consistent behavior', () => {
  test('a markdown note snapshots into the one timeline and restores its surface', async ({
    page,
  }) => {
    await page.goto('/');
    await newTypedNote(page, 'Markdown note');

    const editor = page.locator('#note .markdown-source');
    await editor.click();
    await page.keyboard.type('# Trail log');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    // No type sections exist — the timeline is one chronology. The kind
    // identifies, it does not organize: the detail card says it.
    await expandRow(page, snapshotRows(page).first());
    await expect(page.locator('.snap-detail-meta')).toContainText('Markdown');
    await expect(page.locator('#snapshotsList .snap-day')).toHaveCount(1);

    // Restoring from a DIFFERENT note still lands on the markdown note —
    // its surface comes back with its content, and the plain note that
    // was on stage is never touched.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#addTab').click();
    await openSnapshots(page);
    await expandRow(page, snapshotRows(page).first());
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    // The source pane holds the bytes — a textarea's VALUE is its text.
    await expect(page.locator('#note .markdown-source')).toHaveValue(
      '# Trail log',
    );
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
    await expandRow(page, snapshotRows(page).first());
    await expect(page.locator('.snap-detail-meta')).toContainText('Rich Text');

    // Editing then restoring brings the words back — one click, no ask.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('replaced entirely');
    await openSnapshots(page);
    await expandRow(page, snapshotRows(page).first());
    await snapshotRows(page).first().locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#note')).toContainText('rich words');
  });

  test('the sheet carries the platform key hints', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    // The empty-state hint spells the device's modifier — never the
    // Ctrl/Cmd hedge (see lib/platform.ts). The take button keeps its
    // shortcut OUT of the label (chips inside a primary button are
    // noise); the tooltip carries it, hydrated platform-correct by
    // data-shortcut-title.
    await expect(page.locator('#noSnapshotsHint kbd').first()).toHaveText('Ctrl');
    await expect(page.locator('#createSnapshotBtn')).toHaveAttribute(
      'title',
      'Take snapshot [Ctrl + U]',
    );
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
    const editor = page.locator('#note .markdown-source');
    await editor.click();
    await page.keyboard.type('# Not the welcome note');
    await expect(page.locator('#markdownToolbar')).toBeVisible();

    // Restore the plain snapshot — the row whose name is the Welcome
    // text. Its note (the Welcome note) is unchanged, and the note
    // being edited is not the one being written to.
    await openSnapshots(page);
    const plainRow = page
      .locator('#snapshotsList .snap-item', {
        hasText: 'Welcome! Padify is an offline-capable',
      })
      .first();
    await expandRow(page, plainRow);
    await plainRow.locator('.restore').click();
    await toastSays(page, 'Snapshot restored!');
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);
    // Close the menu before driving the tab strip again.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);

    // The Welcome note is on stage; the markdown chrome stood down.
    await expect(page.locator('#markdownToolbar')).toBeHidden();
    await expect(page.locator('#note')).toContainText('Welcome');

    // The markdown note was never touched — its words and chrome survive,
    // and the switch survives a reload. (The source pane shows the bytes
    // themselves — the '#' included.)
    await page.locator('#tabStripTabs .tab-strip-tab').nth(1).click();
    await expect(page.locator('#markdownToolbar')).toBeVisible();
    await expect(page.locator('#note .markdown-source')).toHaveValue(
      '# Not the welcome note',
    );
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.locator('#note .markdown-source')).toHaveValue(
      '# Not the welcome note',
    );
    await expect(page.locator('#markdownToolbar')).toBeVisible();
  });

  test('the timeline is one chronology — the newest version leads, type never reorders', async ({
    page,
  }) => {
    await page.goto('/');

    // A markdown snapshot taken FIRST, a plain snapshot LATER — a
    // type-sectioned menu would group them apart; the timeline keeps
    // recency as the only order.
    await newTypedNote(page, 'Markdown note');
    const md = page.locator('#note .markdown-source');
    await md.click();
    await page.keyboard.type('# markdown words');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await page.keyboard.press('Escape');
    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('plain words');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await openSnapshots(page);
    // No section headers exist at all.
    await expect(page.locator('#snapshotsList .snapshots-type')).toHaveCount(0);
    // The newest (plain) row leads, whatever its type.
    const rows = snapshotRows(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.snap-name')).toContainText('plain words');
    await expect(rows.nth(1).locator('.snap-name')).toContainText('markdown words');
  });
});

test.describe('deleting', () => {
  test('one row deletes on the second press — the arm is the confirm', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    const row = snapshotRows(page).first();
    await expandRow(page, row);
    const del = row.locator('.delete');

    // First press arms: the label says Confirm, nothing is gone.
    await del.click();
    await expect(del).toHaveClass(/is-armed/);
    await expect(del).toContainText('Confirm');
    await expect(snapshotRows(page)).toHaveCount(1);

    // Second press commits.
    await del.click();
    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#snapshotsCount')).toHaveText('0 of 200');
    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
    await expect(page.locator('#deleteAllSnapshotsBtn')).toBeDisabled();
  });

  test('an armed delete disarms on a click elsewhere — the confirm is a gesture', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    const row = snapshotRows(page).first();
    await expandRow(page, row);
    const del = row.locator('.delete');

    await del.click();
    await expect(del).toHaveClass(/is-armed/);

    // A click anywhere else is not a confirmation.
    await page.locator('.snap-head').click();
    await expect(del).not.toHaveClass(/is-armed/);
    await expect(del).toContainText('Delete');
    await expect(snapshotRows(page)).toHaveCount(1);
  });

  test('delete all arms, then clears the store on the second press', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' two');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);

    const delAll = page.locator('#deleteAllSnapshotsBtn');
    await delAll.click();
    await expect(delAll).toHaveClass(/is-armed/);
    await expect(delAll).toContainText('Really delete all?');
    await expect(snapshotRows(page)).toHaveCount(2); // nothing yet

    await delAll.click();
    await expect(snapshotRows(page)).toHaveCount(0);
    await expect(page.locator('#snapshotsCount')).toHaveText('0 of 200');
    await expect(page.locator('#noSnapshotsEmpty')).toBeVisible();
  });
});

test.describe('the day-anchored timeline', () => {
  test('a same-day history still anchors under Today', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await page.keyboard.type(' more words');
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    // One day, one anchor — always present, a run of entries needs it
    // even when every entry is from today.
    const days = page.locator('#snapshotsList .snap-day');
    await expect(days).toHaveCount(1);
    await expect(days.first()).toHaveText('Today');
    await expect(snapshotRows(page)).toHaveCount(2);
  });

  test('day anchors split a history that spans days', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await seedSnapshotDaysAgo(page, 2);

    await openSnapshots(page);
    const days = page.locator('#snapshotsList .snap-day');
    await expect(days).toHaveCount(2);
    await expect(days.first()).toHaveText('Today');
    // The older run groups under its own calendar label.
    await expect(days.nth(1).textContent()).not.toBe('Today');
    await expect(snapshotRows(page)).toHaveCount(2);
  });

  test('an entry expands to its detail card and collapses again', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' expandable body copy lives here');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const row = snapshotRows(page).first();
    const main = row.locator('.snap-row');
    await expect(main).toHaveAttribute('aria-expanded', 'false');

    await main.click();
    await expect(main).toHaveAttribute('aria-expanded', 'true');
    const detail = row.locator('.snap-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('expandable body copy');
    // The card says when and what kind — the identity a version owes.
    await expect(row.locator('.snap-detail-meta')).toContainText('Plain note');
    // ...and where a restore would land.
    await expect(row.locator('.snap-detail-hint')).toContainText('Restores into');

    await main.click();
    await expect(main).toHaveAttribute('aria-expanded', 'false');
    await expect(detail).toBeHidden();
  });

  test('one entry opens at a time — the accordion keeps the rail readable', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await page.keyboard.type(' more words');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const rows = snapshotRows(page);
    await expandRow(page, rows.first());
    await rows.nth(1).locator('.snap-row').click();
    await expect(rows.nth(1).locator('.snap-detail')).toBeVisible();
    await expect(rows.first().locator('.snap-detail')).toBeHidden();
  });

  test('Enter toggles the expansion from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const main = snapshotRows(page).first().locator('.snap-row');
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
    await expect(row.locator('.snap-current')).toBeVisible();
    await expect(row.locator('.snap-current')).toContainText('Current');

    // Change the note WITHOUT snapshotting — the row no longer matches.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' changed after the fact');
    await openSnapshots(page);
    await expect(snapshotRows(page).first()).not.toHaveClass(/is-current/);
  });

  test('two snapshots holding the note’s bytes still show ONE Current', async ({ page }) => {
    // The user's exact state: a real capture of the open note, PLUS an
    // older row from another note's chain holding the same bytes (what
    // a restore's safety copy produces). The old chip logic green-lit
    // BOTH — which answers "which version am I in?" twice, no answer.
    // The chip belongs to the newest identical row alone.
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    // Seed the older twin: identical content, another chain, an older
    // clock — the shape a pre-restore copy lands in.
    await page.evaluate(() => {
      const active = document.getElementById('note')?.textContent ?? '';
      return new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('NotepadSnapshotsDB');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['snapshots'], 'readwrite');
          tx.objectStore('snapshots').add({
            noteId: 'note-twin-chain',
            noteName: 'Welcome!',
            title: 'Before closing "Welcome!"',
            content: active,
            preview: active.slice(0, 100),
            noteType: 'standard',
            timestamp: Date.now() - 60_000,
            formattedDate: '',
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    });

    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);
    const currents = page.locator('#snapshotsList .snap-item.is-current');
    await expect(currents).toHaveCount(1);
    await expect(currents.locator('.snap-current')).toContainText('Current');
    // The wearer is the newest of the twins — the row on top.
    await expect(snapshotRows(page).first()).toHaveClass(/is-current/);
    // Its older twin wears nothing.
    await expect(snapshotRows(page).nth(1)).not.toHaveClass(/is-current/);
  });

  test('a just-taken row arrives flashing', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');
    await expect(snapshotRows(page).first()).toHaveClass(/is-new/);
  });

  test('the detail card owns the actions — nothing opens a second dialog', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const row = snapshotRows(page).first();
    await expandRow(page, row);
    await expect(row.locator('.restore')).toHaveText('Restore');
    await expect(row.locator('.copy')).toBeVisible();
    await expect(row.locator('.delete')).toBeVisible();
  });

  test('the footer tells the whole story: N of 200', async ({ page }) => {
    await page.goto('/');
    await openSnapshots(page);
    await expect(page.locator('#snapshotsCount')).toHaveText('0 of 200');
  });

  test('the toolbar stays pinned while the timeline scrolls', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.locator('#note').click();
    // Enough rows to overflow the sheet's scroll area at this height.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.type(` row number ${i}`);
      await page.keyboard.press('Control+U');
    }
    await seedSnapshotDaysAgo(page, 2);
    await openSnapshots(page);

    const scroller = page.locator('#snapshotsModal .snap-scroll');
    const scrolls = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls, 'the timeline overflows its own scroll area').toBe(true);

    // Scroll the timeline to the bottom — the toolbar must still be on
    // stage (the sheet is a fixed frame; only the list scrolls).
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);

    const toolbar = page.locator('#snapshotsModal .snap-toolbar');
    await expect(toolbar).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height, 'toolbar stays inside the viewport').toBeLessThan(
      560,
    );
  });

  test('mobile: the sheet fills the screen and every action stays reachable', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');

    // The navbar collapses its tools behind the hamburger at this width.
    await page.locator('.navbar-toggle').click();
    await openSnapshots(page);

    // The sheet is the whole screen.
    const dialog = page.locator('#snapshotsModal .modal-dialog');
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(375, 0);

    // The timeline runs with day anchors and expandable entries; the
    // actions live in the detail card, one tap away.
    await expect(page.locator('#snapshotsList .snap-day')).toHaveCount(1);
    const row = snapshotRows(page).first();
    await expandRow(page, row);
    await expect(row.locator('.restore')).toBeVisible();
    await expect(row.locator('.copy')).toBeVisible();
    await expect(row.locator('.delete')).toBeVisible();
  });
});

test.describe('the version diffstat', () => {
  test('a row carries its change against the previous snapshot of its note', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U'); // the baseline — no badge

    await page.keyboard.press('Control+End');
    await page.keyboard.type(' two new words'); // +3 words: "two new words"
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    const rows = snapshotRows(page);
    await expect(rows).toHaveCount(2);
    // The newest row answers 'what changed here?' — the edit the badge
    // reports is exactly what separates the twins.
    await expect(rows.first().locator('.snap-delta')).toHaveText('+3 words');
    // The baseline carries nothing.
    await expect(rows.nth(1).locator('.snap-delta')).toHaveCount(0);
  });
});

test.describe('the search and the footer', () => {
  test('Escape clears the query first; the second Escape closes the sheet', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const search = page.locator('#searchSnapshots');
    await search.fill('welcome');
    await expect(snapshotRows(page)).toHaveCount(1);

    await page.keyboard.press('Escape');
    // The query cleared, the rows came back — the sheet stayed.
    await expect(search).toHaveValue('');
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
  });

  test('the footer reports results while filtering, the store against its cap otherwise', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' tail copy');
    await page.keyboard.press('Control+U');
    await page.keyboard.type(' xylophone concert');
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    await expect(page.locator('#snapshotsCount')).toHaveText('2 of 200');

    // 'xylophone' exists only in the second version's text — one match.
    await page.locator('#searchSnapshots').fill('xylophone');
    await expect(page.locator('#snapshotsCount')).toHaveText('1 of 2');

    await page.locator('#searchSnapshots').fill('zzz-no-match');
    await expect(page.locator('#snapshotsCount')).toHaveText('0 of 2');
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();
    await page.locator('#searchSnapshots').fill('');
    await expect(page.locator('#snapshotsCount')).toHaveText('2 of 200');
  });

  test('a capture that MATCHES the active filter keeps the query', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' grocery run');
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    // A query the new snapshot still answers: the refresh honors the
    // query — the new row sits in the filtered list, still flashing.
    await page.locator('#searchSnapshots').fill('grocery');
    await expect(snapshotRows(page)).toHaveCount(1);

    // Change the note so the capture is not declined as a duplicate.
    // (Focus is in the field: Escape clears the query first, a second
    // press closes the sheet.)
    await page.keyboard.press('Escape');
    await expect(page.locator('#searchSnapshots')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and a snack');
    await openSnapshots(page);
    // The query is gone and the list is whole — refill it.
    await page.locator('#searchSnapshots').fill('grocery');
    await expect(snapshotRows(page)).toHaveCount(1);

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');

    // The query survives (the capture answered it) and the fresh row
    // shows through the filter, flash and all.
    await expect(page.locator('#searchSnapshots')).toHaveValue('grocery');
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(snapshotRows(page).first()).toHaveClass(/is-new/);
  });

  test('a capture the filter would HIDE clears the filter so the flash is visible', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' grocery run');
    await page.keyboard.press('Control+U');

    await openSnapshots(page);
    // A query that matches nothing, under which a NEW snapshot is taken.
    // The old behavior kept the query and hid the row the user JUST
    // created — a flash aimed at a row the list refuses to show. The
    // filter now gives way: the new snapshot is the thing the user
    // asked for, the query was yesterday's context.
    await page.locator('#searchSnapshots').fill('zzz-no-match');
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();

    // Change the note so the capture is not declined as a duplicate.
    // (Focus is in the field: Escape clears the dead query first, a
    // second press closes the sheet.)
    await page.keyboard.press('Escape');
    await expect(page.locator('#searchSnapshots')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' second thought');
    await openSnapshots(page);
    await page.locator('#searchSnapshots').fill('zzz-no-match');
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();

    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');

    // The query cleared itself; the whole history is on stage again —
    // the fresh row leads it, still flashing.
    await expect(page.locator('#searchSnapshots')).toHaveValue('');
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(snapshotRows(page).first()).toHaveClass(/is-new/);
  });

  test('the search field clears itself with the × and focuses from "/"', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    const search = page.locator('#searchSnapshots');
    await search.fill('welcome');
    await expect(snapshotRows(page)).toHaveCount(1);
    // The clear button is on stage with a query to clear…
    const clear = page.locator('#clearSnapshotSearch');
    await expect(clear).toBeVisible();
    // …and the live count sits beside the query it describes.
    await expect(page.locator('#snapshotSearchMeta')).toHaveText('1 hit');

    // "/" focuses the field without typing a slash into it.
    await search.blur();
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('welcome');

    // The × clears the query and hands the focus back.
    await clear.click();
    await expect(search).toHaveValue('');
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(search).toBeFocused();
  });

  test('the no-match state offers the way out: Clear the filter', async ({ page }) => {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await openSnapshots(page);

    await page.locator('#searchSnapshots').fill('zzz-nothing-matches');
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();
    const clearMiss = page.locator('#clearSearchFromEmpty');
    await expect(clearMiss).toBeVisible();

    await clearMiss.click();
    await expect(page.locator('#searchSnapshots')).toHaveValue('');
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(page.locator('#noSnapshotsMiss')).toBeHidden();
  });
});

test.describe('the type filter', () => {
  /** A store with two kinds in it: the welcome note's plain snapshot
   *  and a markdown note's snapshot. The one way to see a filter work
   *  against a mixed history. */
  async function seedPlainAndMarkdown(page: Page): Promise<void> {
    await page.goto('/');
    await page.locator('#note').click();
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');

    await newTypedNote(page, 'Markdown note');
    const editor = page.locator('#note .markdown-source');
    await editor.click();
    await page.keyboard.type('# Trail log today');
    await page.keyboard.press('Control+U');
    await toastSays(page, 'Snapshot created!');
  }

  test('narrows the timeline to one kind — the footer tells the truth', async ({ page }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(2);

    const trigger = page.locator('#snapshotTypeFilter');
    await expect(trigger).toContainText('All types');

    await trigger.click();
    const menu = page.locator('#snapshotTypeMenu');
    await expect(menu).toBeVisible();
    // "All types" plus each kind PRESENT — no dead-end options — each
    // with its live count.
    await expect(menu.locator('.snap-type-opt')).toHaveCount(3);
    await expect(menu.locator('.snap-type-opt', { hasText: 'Notes' })).toContainText('1');
    await expect(menu.locator('.snap-type-opt', { hasText: 'Markdown' })).toContainText('1');

    await menu.locator('.snap-type-opt', { hasText: 'Markdown' }).click();
    await expect(menu).toBeHidden();
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first().locator('.snap-name')).toContainText('Trail log');
    // The trigger says what is shown and dresses the part; the footer
    // counts the narrowed list against the whole store.
    await expect(trigger).toContainText('Markdown');
    await expect(trigger).toHaveClass(/is-active/);
    await expect(page.locator('#snapshotsCount')).toHaveText('1 of 2');

    // Back to everything.
    await trigger.click();
    await menu.locator('.snap-type-opt', { hasText: 'All types' }).click();
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(trigger).toContainText('All types');
    await expect(trigger).not.toHaveClass(/is-active/);
    await expect(page.locator('#snapshotsCount')).toHaveText('2 of 200');
  });

  test('a capture the type filter would HIDE clears the filter so the flash is visible', async ({
    page,
  }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);

    // Filter to Markdown.
    await page.locator('#snapshotTypeFilter').click();
    await page.locator('#snapshotTypeMenu .snap-type-opt', { hasText: 'Markdown' }).click();
    await expect(snapshotRows(page)).toHaveCount(1);

    // The PLAIN note takes a new snapshot — the filter would hide it.
    // Close the sheet with the header × (Escape is the filter's reset
    // now, and this test is about the CAPTURE clearing the filter).
    await page.locator('.snap-head .close').click();
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
    await expect(page.locator('#snapshotTypeFilter')).toContainText('Markdown');
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await page.locator('#note').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' grocery run');
    await openSnapshots(page);
    await expect(snapshotRows(page)).toHaveCount(1);
    await page.locator('#createSnapshotBtn').click();
    await toastSays(page, 'Snapshot created!');

    // The filter gave way: the fresh plain row leads the WHOLE list,
    // flash and all, and the trigger says so.
    await expect(snapshotRows(page)).toHaveCount(3);
    await expect(page.locator('#snapshotTypeFilter')).toContainText('All types');
    await expect(snapshotRows(page).first()).toHaveClass(/is-new/);
  });

  test('Escape clears the type filter first; the sheet closes on the next press', async ({
    page,
  }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);

    await page.locator('#snapshotTypeFilter').click();
    await page.locator('#snapshotTypeMenu .snap-type-opt', { hasText: 'Markdown' }).click();
    await expect(snapshotRows(page)).toHaveCount(1);

    // Escape (focus on the body, not the search field) clears the
    // filter — the sheet stays.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotTypeFilter')).toContainText('All types');
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);

    // The next Escape is the sheet's.
    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotsModal')).not.toHaveClass(/in/);
  });

  test('Escape with the menu open closes THE MENU, not the sheet', async ({ page }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);

    await page.locator('#snapshotTypeFilter').click();
    await expect(page.locator('#snapshotTypeMenu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#snapshotTypeMenu')).toBeHidden();
    await expect(page.locator('#snapshotsModal')).toHaveClass(/in/);
  });

  test('a click outside the menu closes it without choosing', async ({ page }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);

    await page.locator('#snapshotTypeFilter').click();
    await expect(page.locator('#snapshotTypeMenu')).toBeVisible();

    await page.locator('.snap-head').click();
    await expect(page.locator('#snapshotTypeMenu')).toBeHidden();
    // Nothing was chosen — the whole history still shows.
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(page.locator('#snapshotTypeFilter')).toContainText('All types');
  });

  test('combined filters miss honestly, and the way out clears BOTH', async ({ page }) => {
    await seedPlainAndMarkdown(page);
    await openSnapshots(page);

    // Markdown rows only…
    await page.locator('#snapshotTypeFilter').click();
    await page.locator('#snapshotTypeMenu .snap-type-opt', { hasText: 'Markdown' }).click();
    await expect(snapshotRows(page)).toHaveCount(1);

    // …then a query only the plain row could answer: a dead end two
    // filters built. The recovery button clears the pair of them.
    await page.locator('#searchSnapshots').fill('Welcome');
    await expect(page.locator('#noSnapshotsMiss')).toBeVisible();
    await expect(page.locator('#clearSearchFromEmpty')).toBeVisible();

    await page.locator('#clearSearchFromEmpty').click();
    await expect(page.locator('#searchSnapshots')).toHaveValue('');
    await expect(page.locator('#snapshotTypeFilter')).toContainText('All types');
    await expect(snapshotRows(page)).toHaveCount(2);
    await expect(page.locator('#noSnapshotsMiss')).toBeHidden();
  });
});
