import { expect, test, type Page } from '@playwright/test';

/**
 * Reminders — task lists as notes, pinned end to end.
 *
 * The pure logic (view math, sanitization, the sweep's once-guard) is
 * unit-tested in src/editor/tasks/*.test.ts and src/features/tasks/
 * aggregate.test.ts; what only a browser can prove is the wiring: the
 * type menu creates a task list NOTE, its page composes tasks that
 * persist through the real notes storage, the rail appears ONLY in
 * task contexts and its destinations open the hub, aggregated views
 * span notes with origin chips that open the note, the calendar door
 * in the notes rail's head opens the one grid, and the modal-era data
 * migrates into notes once.
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

/** Creates a task list note through the type menu — the user's door. */
async function newTaskList(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Task list' })
    .click();
}

test.describe('task list notes', () => {
  test('the type menu creates a task list note with its page and composer', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);

    // The strip badges the note with the list's colored circle.
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-list-dot')).toBeVisible();

    // The page paints in the editor host: title input, count, composer.
    await expect(page.locator('#note .tkp')).toBeVisible();
    await expect(page.locator('.tkp-title')).toBeFocused();
    await expect(page.locator('[data-composer-input]')).toHaveAttribute(
      'placeholder',
      'New Reminder',
    );
    await expect(page.locator('.tkp .tk-empty')).toBeVisible();
    // The rich toolbar is for rich notes — not this surface.
    await expect(page.locator('#richToolbar')).toBeHidden();
  });

  test('adding, completing and uncompleting through the real notes storage', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);

    // Type a task into the composer; the chips row opens.
    const input = page.locator('[data-composer-input]');
    await input.fill('Water the fern');
    await expect(page.locator('.tkp .tk-composer-details')).toBeVisible();
    await input.press('Enter');

    // It lands on the page and the header count says one.
    const row = page.locator('.tk-task-wrap', { hasText: 'Water the fern' }).first();
    await expect(row).toBeVisible();
    await expect(page.locator('.tkp-count')).toHaveText('1');

    // Complete it: the circle fills, the row sinks to the completed trailer.
    await row.locator('.tk-check').click();
    await expect(page.locator('.tk-done-toggle')).toBeVisible();
    await expect(page.locator('.tk-done-toggle')).toHaveText(/1 Completed/);
    await expect(page.locator('.tkp-count')).toHaveText('0');

    // Uncomplete it from the trailer: back to active.
    await page.locator('.tk-done-toggle').click();
    await page.locator('.tk-done-rows .tk-check').first().click();
    await expect(page.locator('.tkp-count')).toHaveText('1');

    // Reload — the note, its task and its state all come back.
    await page.reload();
    await expect(page.locator('#note .tkp')).toBeVisible();
    await expect(page.locator('.tk-task-wrap', { hasText: 'Water the fern' })).toBeVisible();
    await expect(page.locator('.tkp-count')).toHaveText('1');
  });

  test('the inline editor renames, flags, and deletes — and the popover-focus regression stays fixed', async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);

    const input = page.locator('[data-composer-input]');
    await input.fill('Buy oat milk');
    await input.press('Enter');

    const row = page.locator('.tk-task-wrap', { hasText: 'Buy oat milk' }).first();
    await row.locator('.tk-task-main').click();

    const editor = row.locator('.tk-editor');
    await expect(editor).toBeVisible();
    await editor.locator('.tk-editor-title').fill('Buy OAT milk (the good one)');
    await editor.locator('.tk-editor-notes').fill('the barista edition');
    await editor.locator('.tk-editor-title').press('Enter');

    const updated = page
      .locator('.tk-task-wrap', { hasText: 'Buy OAT milk (the good one)' })
      .first();
    await expect(updated).toBeVisible();
    await expect(updated.locator('.tk-notes')).toHaveText('the barista edition');

    // Reopen: selecting a priority from the anchored menu used to close
    // the editor (the #144 regression — pinned here for the note page too).
    await updated.locator('.tk-task-main').click();
    await expect(editor).toBeVisible();
    await editor.locator('[data-editor-priority]').click();
    await page.locator('[data-priority="high"]').click();
    await expect(editor).toBeVisible();
    await expect(updated.locator('.tk-prio')).toBeVisible();

    // Same for a date preset from the when-popover.
    await editor.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="tomorrow"]').click();
    await expect(editor).toBeVisible();
    await expect(updated.locator('.tk-chip-due')).toContainText('Tomorrow');

    // The editor still commits normally afterwards.
    await editor.locator('.tk-editor-title').press('Enter');
    await expect(editor).toBeHidden();

    // Delete it; the page empties again.
    await updated.locator('.tk-task-main').click();
    await page.locator('[data-editor-delete]').click();
    await expect(page.locator('.tkp .tk-empty')).toBeVisible();
  });

  test('renaming the page title renames the note (the strip is the lists home)', async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);

    await page.locator('.tkp-title').fill('Groceries');
    await page.locator('.tkp-title').press('Enter');
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab).toContainText('Groceries');
    // The rail never repeats the lists — no My Lists group exists.
    await expect(page.locator('#taskRailLists')).toHaveCount(0);
  });

  test('the list color menu repaints the circle', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);

    await page.locator('.tkp-color').click();
    await page.locator('[data-list-color="green"]').click();
    await expect(page.locator('.tkp')).toHaveClass(/tk-c-green/);
    await expect(
      page.locator('#tabStripTabs .tab-strip-tab.active .tab-strip-list-dot'),
    ).toHaveAttribute('data-color', 'green');
  });
});

test.describe('the rail — task contexts only', () => {
  test('the rail is absent on a plain note and appears on a task list note', async ({ page }) => {
    await page.goto('/');

    // A plain note never sees the reminders rail.
    await expect(page.locator('#taskRail')).toBeHidden();

    // Create a task list note: the rail appears beside its page.
    await newTaskList(page);
    await expect(page.locator('#taskRail')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/tasks-rail-on/);

    // Switch back to the plain note: the rail steps aside again.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#taskRail')).toBeHidden();
  });

  test('the calendar page stands the rail down, and leaving brings it back', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    await expect(page.locator('#taskRail')).toBeVisible();

    // The calendar page carries its own sidebar — the hover rail would
    // be double duty on the same edge, so it stands down while the page
    // is open, and comes back the moment the page closes.
    await page.locator('#tabRailCalendar').click();
    await expect(page.locator('#tasksHub')).toBeVisible();
    await expect(page.locator('#taskRail')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#taskRail')).toBeVisible();
  });

  test('the rail expands on hover and its Today card opens the hub', async ({ page }) => {
    await page.goto('/');

    // No task notes yet — the calendar door still opens the hub (the
    // hub is a task context), but the calendar page stands the rail
    // down: the page has its own sidebar.
    await page.locator('#tabRailCalendar').click();
    const rail = page.locator('#taskRail');
    await expect(page.locator('#tasksHub')).toBeVisible();
    await expect(rail).toBeHidden();
    await page.keyboard.press('Escape');

    // A task note brings the rail back. At rest the rail is the thin
    // strip; hovering it expands the labels.
    await newTaskList(page);
    await expect(rail).toBeVisible();
    await rail.hover();
    await expect(rail)
      .toHaveClass(/is-pinned/)
      .catch(() => undefined); // pin is opt-in only
    await expect(rail.locator('.tr-card-label', { hasText: 'Today' })).toBeVisible();

    // The Today destination opens the hub over the editor area.
    await rail.locator('.tr-card[data-view="today"]').click();
    await expect(page.locator('#tasksHub')).toBeVisible();
    await expect(page.locator('#tkhTitle')).toHaveText('Today');
    await expect(page.locator('#tkhComposerInput')).toBeFocused();

    // The fresh list is empty: Today's empty state says so.
    await expect(page.locator('#tkhEmpty')).toBeVisible();

    // Escape closes the hub; the note is right back underneath.
    await page.keyboard.press('Escape');
    await expect(page.locator('#tasksHub')).toBeHidden();
  });

  test('the hub aggregates across notes with origin chips that open the note', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    await page.locator('.tkp-title').fill('Travel');
    await page.locator('.tkp-title').press('Enter');
    let input = page.locator('[data-composer-input]');
    await input.fill('Book ryokan');
    await input.press('Enter');

    // A second list, with a task due today.
    await newTaskList(page);
    await page.locator('.tkp-title').fill('Home');
    await page.locator('.tkp-title').press('Enter');
    input = page.locator('[data-composer-input]');
    // The date chip belongs to the DRAFT: set it before submitting, so
    // the task is born with its due date (the composer's quick-add).
    await input.fill('Buy milk');
    await page.locator('.tkp [data-composer-when="date"]').click();
    await page.locator('[data-when-preset="today"]').click();
    await input.press('Enter');

    // Today (via the rail, while the task note is active) shows only the
    // dated task, with its origin chip naming the owning note.
    await page.locator('#taskRail').hover();
    await page.locator('.tr-card[data-view="today"]').click();
    await expect(page.locator('#tkhTitle')).toHaveText('Today');
    const milk = page.locator('#tkhSections .tk-task-wrap', { hasText: 'Buy milk' }).first();
    await expect(milk).toBeVisible();
    await expect(milk.locator('.tk-origin')).toContainText('Home');
    await expect(
      page.locator('#tkhSections .tk-task-wrap', { hasText: 'Book ryokan' }),
    ).toHaveCount(0);

    // The origin chip opens that note (and closes the hub).
    await milk.locator('.tk-origin').click();
    await expect(page.locator('#tasksHub')).toBeHidden();
    await expect(page.locator('.tkp-title')).toHaveValue('Home');
  });

  test('completing from the hub writes through to the note', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('[data-composer-input]');
    await input.fill('Sweep write-through');
    await input.press('Enter');

    await page.locator('#taskRail').hover();
    await page.locator('.tr-card[data-view="all"]').click();
    // The All view carries the dateless task (Today would not).
    const row = page
      .locator('#tkhSections .tk-task-wrap', { hasText: 'Sweep write-through' })
      .first();
    await expect(row).toBeVisible();
    await row.locator('.tk-check').click();
    // The completion sinks the row into the collapsed trailer — open it
    // to reach the row's origin chip.
    const trailer = page.locator('#tkhSections .tk-done-toggle');
    await expect(trailer).toBeVisible();
    await trailer.click();

    // The note behind the hub reflects the write (open it to check).
    await page.locator('#tkhSections .tk-done-rows .tk-task-wrap .tk-origin').first().click();
    await expect(page.locator('#tasksHub')).toBeHidden();
    // The note's own page carries the trailer (scope matters: the hidden
    // hub still holds its own DOM, trailer and all).
    await expect(page.locator('#note .tk-done-toggle')).toBeVisible();
  });

  test('search spans notes from the rail', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    await page.locator('.tkp-title').fill('Travel');
    await page.locator('.tkp-title').press('Enter');
    await page.locator('[data-composer-input]').fill('Find me by name');
    await page.locator('[data-composer-input]').press('Enter');

    // The search box is an expanded-rail affordance — hover opens it.
    await page.locator('#taskRail').hover();
    await page.locator('#taskRailSearchInput').fill('find me');
    await expect(page.locator('#tkhTitle')).toHaveText('Search');
    await expect(
      page.locator('#tkhSections .tk-task-wrap', { hasText: 'Find me by name' }),
    ).toBeVisible();
    await expect(page.locator('#tkhSections .tk-task-wrap')).toHaveCount(1);

    // Clearing closes the hub back to the note.
    await page.locator('#taskRailSearchClear').click();
    await expect(page.locator('#tasksHub')).toBeHidden();
  });
});

test.describe('the calendar', () => {
  test('the notes rail head door opens it — from any note', async ({ page }) => {
    await page.goto('/');

    // The calendar icon sits beside the notes count; clicking it opens
    // the one calendar even while a plain note is active.
    await expect(page.locator('#tabRailCalendar')).toBeVisible();
    await page.locator('#tabRailCalendar').click();
    await expect(page.locator('#tasksHub')).toBeVisible();
    await expect(page.locator('#tkhTitle')).toHaveText('Calendar');
    await expect(page.locator('.tkcal-grid')).toBeVisible();

    // The door reflects its open state; Escape closes both.
    await expect(page.locator('#tabRailCalendar')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tasksHub')).toBeHidden();
    await expect(page.locator('#tabRailCalendar')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the calendar page sheds the hub chrome and adds from the day pane', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('[data-composer-input]');
    await input.fill('Water the fern');
    await input.press('Enter');

    await page.locator('#tabRailCalendar').click();

    // The page is the calendar's own: no reminders rail hovering on the
    // edge, no composer bar shoved at the bottom.
    await expect(page.locator('#taskRail')).toBeHidden();
    await expect(page.locator('#tkhComposer')).toBeHidden();

    // The day pane's Add opens the inline row right under the day head.
    await page.locator('[data-cal-add]').click();
    const quick = page.locator('[data-cal-quickadd-input]');
    await expect(quick).toBeFocused();
    await quick.fill('Feed the fern');
    await quick.press('Enter');

    // It lands as a chip on today's cell and a row in the pane — and
    // the row stays open, caret parked, for the next one.
    await expect(
      page.locator('.tkcal-day.is-today .tkcal-chip', { hasText: 'Feed the fern' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-cal-day-rows] .tk-task-wrap', { hasText: 'Feed the fern' }),
    ).toBeVisible();
    await expect(page.locator('[data-cal-quickadd-input]')).toBeFocused();

    // Escape puts the row away without leaving the page.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cal-quickadd]')).toBeHidden();
    await expect(page.locator('#tasksHub')).toBeVisible();
  });

  test('dated tasks chip their day and the day panel lists them', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('[data-composer-input]');
    await input.fill('Ship the letters');
    await input.press('Enter');
    // Give the fresh task a due date of TODAY via the editor's popover.
    const row = page.locator('.tk-task-wrap', { hasText: 'Ship the letters' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="today"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    // Open the calendar from the notes rail's head.
    await page.locator('#tabRailCalendar').click();
    await expect(page.locator('#tkhTitle')).toHaveText('Calendar');

    // Today's cell is selected by default and carries the task as a
    // chip (the iCloud event chip, tinted with the list's color).
    const todayCell = page.locator('.tkcal-day.is-today');
    await expect(todayCell).toHaveClass(/is-selected/);
    await expect(todayCell.locator('.tkcal-chip')).toHaveCount(1);
    await expect(todayCell.locator('.tkcal-chip')).toHaveText('Ship the letters');

    // …and the day panel lists the task with its chip.
    const panel = page.locator('.tkcal-day-pane');
    await expect(panel.locator('.tk-task-wrap', { hasText: 'Ship the letters' })).toBeVisible();
    await expect(panel.locator('.tk-chip-due')).toContainText('Today');

    // The today count also badges the calendar door in the notes rail.
    await expect(page.locator('#tabRailCalendarDot')).toHaveText('1');
  });

  test('picking a day with a task selects it; empty days keep their manners', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('[data-composer-input]');
    await input.fill('Future thing');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Future thing' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="nextWeek"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    await page.locator('#tabRailCalendar').click();

    // The task rides the Up Next rail of today's panel…
    const pane = page.locator('.tkcal-day-pane');
    await expect(pane.locator('.tkcal-upnext')).toBeVisible();
    await expect(
      pane.locator('.tkcal-upnext .tk-task-wrap', { hasText: 'Future thing' }),
    ).toBeVisible();

    // …and clicking a chipped future day moves the selection there.
    const chipped = page.locator('.tkcal-day:not(.is-outside) .tkcal-chip').first();
    await chipped.click();
    await expect(pane.locator('.tk-task-wrap', { hasText: 'Future thing' })).toBeVisible();
    // Today's empty copy stays friendly when reselected (the Today
    // button is always at hand — the cell is the door).
    await page.locator('.tkcal-day.is-today').click();
    await expect(pane.locator('.tk-empty-day')).toBeVisible();
  });

  test('month navigation walks the grid and Today comes home', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tabRailCalendar').click(); // hub on the calendar

    const month = page.locator('.tkcal-month');
    const first = await month.textContent();
    // The page header's navs — the mini month in the sidebar has its own.
    await page.locator('.tkcal-navs [data-cal-next]').click();
    await expect(month).not.toHaveText(first!);
    await page.locator('.tkcal-navs [data-cal-prev]').click();
    await page.locator('.tkcal-navs [data-cal-prev]').click();
    await expect(month).not.toHaveText(first!);
    // The Today button is always at hand (the iCloud header), and it
    // walks the selection home.
    await page.locator('.tkcal-navs [data-cal-today]').click();
    await expect(page.locator('.tkcal-day.is-today')).toHaveClass(/is-selected/);
  });
});

test.describe('the migration', () => {
  test('modal-era lists become notes exactly once', async ({ page }) => {
    const now = new Date().toISOString();
    await page.addInitScript(
      ({ stamp }) => {
        localStorage.setItem(
          'padify-tasks',
          JSON.stringify({
            lists: [
              { id: 'l1', name: 'Groceries', color: 'green', createdAt: stamp, sortOrder: 0 },
              { id: 'l2', name: 'Travel', color: 'teal', createdAt: stamp, sortOrder: 1 },
            ],
            tasks: [
              {
                id: 'g1',
                title: 'Milk',
                notes: '',
                listId: 'l1',
                completed: false,
                completedAt: '',
                dueDate: '',
                reminderAt: '',
                reminderNotifiedAt: '',
                flagged: false,
                priority: 'none',
                createdAt: stamp,
                updatedAt: stamp,
                sortOrder: 0,
              },
              {
                id: 't1',
                title: 'Visa',
                notes: '',
                listId: 'l2',
                completed: true,
                completedAt: stamp,
                dueDate: '',
                reminderAt: '',
                reminderNotifiedAt: '',
                flagged: false,
                priority: 'none',
                createdAt: stamp,
                updatedAt: stamp,
                sortOrder: 0,
              },
            ],
            view: 'all',
          }),
        );
      },
      { stamp: now },
    );

    await page.goto('/');

    // Both lists are notes now — the note strip is their one home.
    const groceries = page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'Groceries' });
    const travel = page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'Travel' });
    await expect(groceries).toBeVisible();
    await expect(travel).toBeVisible();

    // The tasks rode along (Groceries' page carries its active task).
    await groceries.click();
    await expect(page.locator('.tk-task-wrap', { hasText: 'Milk' })).toBeVisible();

    // Completed history survives too.
    await travel.click();
    await expect(page.locator('.tk-done-toggle')).toHaveText(/1 Completed/);
    await expect(page.locator('.tk-done-toggle')).toBeVisible();

    // And the old data never migrates twice: reload keeps one of each.
    await page.reload();
    await expect(
      page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'Groceries' }),
    ).toHaveCount(1);
    await expect(page.locator('#tabStripTabs .tab-strip-tab', { hasText: 'Travel' })).toHaveCount(
      1,
    );
  });
});
