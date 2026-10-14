import { expect, test, type Page } from '@playwright/test';

/**
 * Reminders smoke — the controller's DOM wiring, pinned end to end.
 *
 * The pure logic (view math, sanitization, the sweep's once-guard) is
 * unit-tested in src/features/tasks/*.test.ts; what only a browser can
 * prove is the wiring: the modal opens from the navbar with its engine
 * lazy-loaded, the composer adds a task that renders with its chips, the
 * circle completes and sinks to the trailer, the inline editor commits a
 * rename, a custom list files tasks by color, and everything survives a
 * reload through the real storage path.
 *
 * Zero-console-error bar, same as the rest of the suite.
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

async function openReminders(page: Page): Promise<void> {
  await page.locator('a[data-target="#tasksModal"]').click();
  await expect(page.locator('#tasksModal')).toHaveClass(/in/);
}

test.describe('reminders', () => {
  test('opens from the navbar with the composer ready and the empty state', async ({ page }) => {
    await page.goto('/');
    await openReminders(page);

    await expect(page.locator('#tkViewTitle')).toHaveText('Today');
    await expect(page.locator('#tkEmpty')).toBeVisible();
    await expect(page.locator('#tkComposerInput')).toHaveAttribute('placeholder', 'New Reminder');
    // The composer grabbed focus (desktop pointer) — typing goes straight in.
    await expect(page.locator('#tkComposerInput')).toBeFocused();
  });

  test('adding, completing and uncompleting a task through the real storage path', async ({
    page,
  }) => {
    await page.goto('/');
    await openReminders(page);

    // Type a task into the composer; the chips row opens.
    await page.locator('#tkComposerInput').fill('Water the fern');
    await expect(page.locator('#tkComposerDetails')).toBeVisible();
    await page.locator('#tkComposerInput').press('Enter');

    // It lands in the view and in the All count.
    const row = page.locator('.tk-task-wrap', { hasText: 'Water the fern' }).first();
    await expect(row).toBeVisible();
    await expect(page.locator('#tkCountAll')).toHaveText('1');

    // Complete it: the circle fills, the row sinks to the completed trailer.
    await row.locator('.tk-check').click();
    await expect(page.locator('.tk-done-toggle')).toBeVisible();
    await expect(page.locator('.tk-done-toggle')).toHaveText(/1 Completed/);
    await expect(page.locator('#tkCountAll')).toHaveText('');
    await expect(page.locator('#tkCountCompleted')).toHaveText('1');

    // Uncomplete it from the trailer: back to active.
    await page.locator('.tk-done-toggle').click();
    await expect(
      page.locator('.tk-done-rows .tk-task-wrap', { hasText: 'Water the fern' }),
    ).toBeVisible();
    await page.locator('.tk-done-rows .tk-check').first().click();
    await expect(page.locator('#tkCountAll')).toHaveText('1');
  });

  test('the inline editor renames, flags, and deletes', async ({ page }) => {
    await page.goto('/');
    await openReminders(page);

    await page.locator('#tkComposerInput').fill('Buy oat milk');
    await page.locator('#tkComposerInput').press('Enter');

    const row = page.locator('.tk-task-wrap', { hasText: 'Buy oat milk' }).first();
    await row.locator('.tk-task-main').click();

    const editor = row.locator('.tk-editor');
    await expect(editor).toBeVisible();
    await editor.locator('.tk-editor-title').fill('Buy OAT milk (the good one)');
    await editor.locator('.tk-editor-notes').fill('the barista edition');
    await editor.locator('.tk-editor-title').press('Enter');

    const updated = page
      .locator('.tk-task-wrap', {
        hasText: 'Buy OAT milk (the good one)',
      })
      .first();
    await expect(updated).toBeVisible();
    await expect(updated.locator('.tk-notes')).toHaveText('the barista edition');

    // Flag it through the editor; the flag chip sticks to the row.
    await updated.locator('.tk-task-main').click();
    await editor.locator('[data-editor-flag]').click();
    await expect(page.locator('#tkCountFlagged')).toHaveText('1');
    await expect(updated.locator('.tk-flag')).toBeVisible();

    // Delete it; the view empties again.
    await page.locator('.tk-task-wrap [data-editor-delete]').click();
    await expect(page.locator('#tkEmpty')).toBeVisible();
    await expect(page.locator('#tkCountAll')).toHaveText('');
  });

  test('custom lists: add, file, colored title, rename — and survival across a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await openReminders(page);

    // Create a list from the sidebar.
    await page.locator('#tkAddList').click();
    await page.locator('.tk-list-add-form input').fill('Groceries');
    await page.locator('.tk-list-add-form input').press('Enter');

    // The view switched to the fresh list, titled with its color class.
    await expect(page.locator('#tkViewTitle')).toHaveText('Groceries');
    await expect(page.locator('#tkViewTitle')).toHaveClass(/tk-c-/);

    // Quick-add inside the list view files to the list.
    await page.locator('#tkComposerInput').fill('Milk');
    await page.locator('#tkComposerInput').press('Enter');
    await expect(page.locator('.tk-task-wrap', { hasText: 'Milk' })).toBeVisible();

    // The All view groups by list under the list's name.
    await page.locator('#tkNavAll').click();
    const allSection = page.locator('.tk-section', { hasText: 'Groceries' }).first();
    await expect(allSection.locator('.tk-task-wrap', { hasText: 'Milk' })).toBeVisible();

    // Reload — the list, the task and the last view all come back.
    await page.reload();
    await openReminders(page);
    await expect(page.locator('#tkViewTitle')).toHaveText('All');
    await expect(
      page.locator('.tk-nav-lists .tk-list-item', { hasText: 'Groceries' }),
    ).toBeVisible();
    const restored = page.locator('.tk-task-wrap', { hasText: 'Milk' }).first();
    await expect(restored).toBeVisible();

    // Rename the list from ITS view's actions (the All view has none).
    await page.locator('.tk-nav-lists .tk-list-item', { hasText: 'Groceries' }).click();
    await expect(page.locator('#tkViewTitle')).toHaveText('Groceries');
    await page.locator('[data-action="rename-list"]').click();
    const dialog = page.locator('.swal2-modal');
    await expect(dialog).toBeVisible();
    await dialog.locator('.swal2-input').fill('Groceries & stuff');
    await dialog.locator('.swal2-confirm').click();
    await expect(page.locator('#tkViewTitle')).toHaveText('Groceries & stuff');
  });

  test('date chips and overdue tone render on the row', async ({ page }) => {
    await page.goto('/');
    await openReminders(page);

    // A task due today (via the composer's date popover presets).
    await page.locator('#tkComposerInput').fill('Ship the letters');
    await page.locator('#tkComposerDate').click();
    await page.locator('[data-when-preset="today"]').click();
    await page.locator('#tkComposerInput').press('Enter');

    const row = page.locator('.tk-task-wrap', { hasText: 'Ship the letters' }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('.tk-chip-due')).toContainText('Today');
    // The chip-set composer carries the date into the new task.
    await expect(page.locator('#tkComposerDateLabel')).toHaveText('Date');

    // A reminder set for today reads as a bell chip too.
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="remind"]').click();
    await page.locator('[data-when-preset="tomorrow"]').click();
    await expect(row.locator('.tk-chip-remind')).toContainText('Tomorrow');
  });

  test('search finds tasks by title and clears back to the view', async ({ page }) => {
    await page.goto('/');
    await openReminders(page);

    await page.locator('#tkComposerInput').fill('Find me by name');
    await page.locator('#tkComposerInput').press('Enter');
    await page.locator('#tkComposerInput').fill('Something else entirely');
    await page.locator('#tkComposerInput').press('Enter');

    await page.locator('#tkSearchInput').fill('find me');
    await expect(page.locator('#tkViewTitle')).toHaveText('Search');
    await expect(page.locator('.tk-task-wrap', { hasText: 'Find me by name' })).toBeVisible();
    await expect(page.locator('#tkSections .tk-task-wrap')).toHaveCount(1);

    // Clearing returns to the underlying view — which followed the tasks to
    // All when they were added (dateless tasks do not live in Today).
    await page.locator('#tkSearchClear').click();
    await expect(page.locator('#tkViewTitle')).toHaveText('All');
    await expect(page.locator('#tkSections .tk-task-wrap')).toHaveCount(2);
  });
});
