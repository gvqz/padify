import { expect, test, type Locator, type Page } from '@playwright/test';

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

/**
 * Drives an HTML5 drag between two calendar elements — the shared
 * DataTransfer Chromium's constructor path needs, dragstart →
 * dragover(at) → drop, with the drop point `offsetY` into the target
 * (the hour slot's height is the hour, so the offset is the minute).
 * The target rides the middle of its scroll box first: the drag's own
 * edge auto-scroll must not move the ground under a dispatched drop —
 * a dragover near the rim scrolls the hours and shifts the very slot
 * the drop is measured against.
 */
async function calDrag(page: Page, from: Locator, to: Locator, offsetY = 8): Promise<void> {
  await to.evaluate((el) => {
    const box = el.closest<HTMLElement>('.tkcal-wk-time, .tkcal-daypage-scroll');
    if (!box) return;
    const br = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    box.scrollTop += r.top + r.height / 2 - (br.top + br.height / 2);
  });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent('dragstart', { dataTransfer: transfer });
  const box = await to.boundingBox();
  const clientY = (box?.y ?? 0) + offsetY;
  await to.dispatchEvent('dragover', { dataTransfer: transfer, clientY });
  // Let the ground settle before the drop measures: a dragover-driven
  // rim nudge — or the persistence write completing mid-drag and its
  // re-render restoring the hours' scroll — can shift the very slot
  // the drop is measured against (the 10:20-not-10:05 flake). The drop
  // re-aims at the slot's settled position, 8px in, whatever moved.
  await page.waitForTimeout(60);
  const settled = await to.boundingBox();
  const dropY = (settled?.y ?? box?.y ?? 0) + offsetY;
  await to.dispatchEvent('drop', { dataTransfer: transfer, clientY: dropY });
}

test.describe('task list notes', () => {
  test('the type menu creates a task list note with its page and composer', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);

    // The strip badges the note with the list's colored circle.
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-list-dot')).toBeVisible();

    // The page paints in the editor host: title input, count, quick-add.
    await expect(page.locator('#note .tkp')).toBeVisible();
    await expect(page.locator('.tkp-title')).toBeFocused();
    await expect(page.locator('.tkp [data-composer-input]')).toHaveAttribute(
      'placeholder',
      'Add a reminder — “dentist tomorrow 9am” works',
    );
    await expect(page.locator('.tkp .tk-empty')).toBeVisible();
    // The rich toolbar is for rich notes — not this surface.
    await expect(page.locator('#richToolbar')).toBeHidden();
  });

  test('adding, completing and uncompleting through the real notes storage', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);

    // Type a task into the quick-add; the chips ride the row itself.
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Water the fern');
    await expect(page.locator('.tkp .tk-quickadd')).toBeVisible();
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

    const input = page.locator('.tkp [data-composer-input]');
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

    // Reopen: choosing a date preset from the anchored popover used to
    // close the editor (the #144 regression — pinned here for the note
    // page too; the flag chip covers the same "menu inside the editor"
    // ground the priority chip once did).
    await updated.locator('.tk-task-main').click();
    await expect(editor).toBeVisible();
    await editor.locator('[data-editor-flag]').click();
    await editor.locator('.tk-editor-title').click();
    await expect(editor).toBeVisible();
    await expect(updated.locator('.tk-flag')).toBeVisible();

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

  test('the quick-add wears two chips, the editor four — no priority anywhere', async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);

    // The quick-add's chips: Date, Flag. No Priority, no Remind (the
    // natural language speaks "at 9" now).
    await page.locator('.tkp [data-composer-input]').click();
    await expect(page.locator('.tkp [data-composer-priority]')).toHaveCount(0);
    await expect(page.locator('.tkp [data-composer-flag]')).toBeVisible();
    await expect(page.locator('.tkp .tk-quickadd-tools .tk-chip-btn')).toHaveCount(2);

    // A task lands; its editor wears Date / Remind / Flag / Delete only,
    // and the row paints no ! marks even though the model still carries
    // the field for old notes.
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Priorities are not a feature');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Priorities are not a feature' });
    await row.locator('.tk-task-main').click();
    await expect(row.locator('.tk-editor')).toBeVisible();
    await expect(page.locator('[data-editor-priority]')).toHaveCount(0);
    await expect(page.locator('.tk-editor-chips .tk-chip-btn')).toHaveCount(4);
    await expect(page.locator('[data-editor-delete]')).toBeVisible();
    await expect(row.locator('.tk-prio')).toHaveCount(0);
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
    await expect(rail).not.toHaveClass(/is-pinned/); // pinning is gone — hover is the whole deal
    await expect(rail.locator('.tr-card-label', { hasText: 'Today' })).toBeVisible();

    // The Today destination opens the hub over the editor area.
    await rail.locator('.tr-card[data-view="today"]').click();
    await expect(page.locator('#tasksHub')).toBeVisible();
    await expect(page.locator('#tkhTitle')).toHaveText('Today');
    await expect(page.locator('#tasksHub [data-composer-input]')).toBeFocused();

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
    let input = page.locator('.tkp [data-composer-input]');
    await input.fill('Book ryokan');
    await input.press('Enter');

    // A second list, with a task due today.
    await newTaskList(page);
    await page.locator('.tkp-title').fill('Home');
    await page.locator('.tkp-title').press('Enter');
    input = page.locator('.tkp [data-composer-input]');
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

  test("the All view's heads name the lists; the rows don't repeat them", async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('First chore');
    await input.press('Enter');
    await input.fill('Second chore');
    await input.press('Enter');

    await page.locator('#taskRail').hover();
    await page.locator('.tr-card[data-view="all"]').click();
    await expect(page.locator('#tkhTitle')).toHaveText('All');

    // The section head carries the list (dot + name); the active rows
    // carry NO origin chip — the head already said it.
    const section = page.locator('#tkhSections .tk-section').first();
    await expect(section.locator('.tk-section-head h5')).toContainText('Untitled list');
    await expect(section.locator('.tk-origin')).toHaveCount(0);
    await expect(section.locator('.tk-task-wrap')).toHaveCount(2);
  });

  test('completing from the hub writes through to the note', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
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
    await page.locator('.tkp [data-composer-input]').fill('Find me by name');
    await page.locator('.tkp [data-composer-input]').press('Enter');

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
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Water the fern');
    await input.press('Enter');

    await page.locator('#tabRailCalendar').click();

    // The page is the calendar's own: no reminders rail hovering on the
    // edge, no composer bar shoved at the bottom.
    await expect(page.locator('#taskRail')).toBeHidden();
    await expect(page.locator('#tasksHub .tk-quickadd-wrap')).toBeHidden();

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
    const input = page.locator('.tkp [data-composer-input]');
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
    const input = page.locator('.tkp [data-composer-input]');
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

  test('the year view spreads twelve little months and the title is just the year', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#tabRailCalendar').click();

    // Month first, then flip to Year the way a user would.
    await page.locator('[data-cal-mode="year"]').click();

    const title = page.locator('.tkcal-month');
    await expect(title).toHaveText(String(new Date().getFullYear()));
    await expect(page.locator('.tkcal-year-month')).toHaveCount(12);
    // Year is pressed, Month is not, and every mode is a real button
    // now — no stubs left on the bench.
    await expect(page.locator('[data-cal-mode="year"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-cal-mode="month"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-cal-mode="day"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-cal-mode-wip]')).toHaveCount(0);
    // The sidebar keeps its lists + day inspector; the mini month sits
    // out — twelve months are already on the glass.
    await expect(page.locator('.tkcal-lists')).toBeVisible();
    await expect(page.locator('.tkcal-mini')).toHaveCount(0);
    // The arrows now step years.
    await expect(page.locator('.tkcal-navs [data-cal-prev]')).toHaveAttribute(
      'title',
      'Previous year',
    );
    // …and flipping back to Month restores the ruled grid.
    await page.locator('[data-cal-mode="month"]').click();
    await expect(page.locator('.tkcal-grid')).toBeVisible();
  });

  test('year navigation steps whole years and Today comes home', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="year"]').click();

    const title = page.locator('.tkcal-month');
    await page.locator('.tkcal-navs [data-cal-next]').click();
    await expect(title).toHaveText(String(new Date().getFullYear() + 1));
    await page.locator('.tkcal-navs [data-cal-prev]').click();
    await page.locator('.tkcal-navs [data-cal-prev]').click();
    await expect(title).toHaveText(String(new Date().getFullYear() - 1));
    // No today in a year that isn't this one.
    await expect(page.locator('.tkcal-year-day.is-today')).toHaveCount(0);
    await page.locator('.tkcal-navs [data-cal-today]').click();
    await expect(title).toHaveText(String(new Date().getFullYear()));
    await expect(page.locator('.tkcal-year-day.is-today')).toHaveClass(/is-selected/);
  });

  test('the year spread marks event days; the month name zooms into Month', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Year mark');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Year mark' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="nextWeek"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="year"]').click();

    // The marked day reads darker (the has-events state) — unless the
    // due date crossed into next year, in which case the spread steps
    // to it first.
    const marked = page.locator('.tkcal-year-day.has-events');
    if ((await marked.count()) === 0) {
      await page.locator('.tkcal-navs [data-cal-next]').click();
    }
    await marked.first().click();
    const pane = page.locator('.tkcal-day-pane');
    await expect(pane.locator('.tk-task-wrap', { hasText: 'Year mark' })).toBeVisible();

    // The month name is the zoom: it opens that month in Month view,
    // selection carried over.
    const monthName = marked
      .first()
      .locator(
        'xpath=ancestor::section[contains(@class,"tkcal-year-month")]//button[@data-cal-jump]',
      );
    await monthName.click();
    await expect(page.locator('.tkcal-grid')).toBeVisible();
    await expect(
      page.locator('.tkcal-day.is-selected .tkcal-chip', { hasText: 'Year mark' }),
    ).toBeVisible();
  });

  test('the week view lines up the hours, steps by the week, Today comes home', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="week"]').click();

    // Seven day headers, today's picked by default, the title reading
    // the week's range with the year in it.
    await expect(page.locator('.tkcal-wk-head')).toHaveCount(7);
    await expect(page.locator('.tkcal-wk-head.is-today')).toHaveClass(/is-selected/);
    const title = page.locator('.tkcal-month');
    await expect(title).toContainText(String(new Date().getFullYear()));
    await expect(page.locator('.tkcal-navs [data-cal-prev]')).toHaveAttribute(
      'title',
      'Previous week',
    );
    // The mini month keeps out of the week page (its arrows step months).
    await expect(page.locator('.tkcal-mini')).toHaveCount(0);

    // The hour ruling: 24 gutter labels over 168 shared slots, and
    // Apple's red now-line sitting in today's current hour.
    await expect(page.locator('.tkcal-wk-time .tkcal-hour')).toHaveCount(24);
    await expect(page.locator('.tkcal-wk-slot')).toHaveCount(24 * 7);
    await expect(page.locator('.tkcal-wk-time .tkcal-now')).toHaveCount(1);

    // The arrows step whole weeks — off today's page there is no today,
    // and the now-line goes with it.
    const home = await title.textContent();
    await page.locator('.tkcal-navs [data-cal-next]').click();
    await expect(title).not.toHaveText(home!);
    await expect(page.locator('.tkcal-wk-head.is-today')).toHaveCount(0);
    await expect(page.locator('.tkcal-wk-time .tkcal-now')).toHaveCount(0);
    await page.locator('.tkcal-navs [data-cal-today]').click();
    await expect(title).toHaveText(home!);
    await expect(page.locator('.tkcal-wk-head.is-today')).toHaveClass(/is-selected/);
  });

  test('the week carries its chips at their hours; picking feeds the day pane; Month picks up the week', async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Week chip');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Week chip' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="today"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="week"]').click();

    // The date-only reminder rides the All-Day band under today's
    // header.
    await expect(
      page.locator('.tkcal-wk-allday-cell.is-today .tkcal-chip', { hasText: 'Week chip' }),
    ).toBeVisible();

    // A timed one — the day pane's quick-add files at 9:00 — anchors
    // in the 9 AM slot wearing its hour.
    await page.locator('[data-cal-add]').click();
    const quick = page.locator('[data-cal-quickadd-input]');
    await expect(quick).toBeFocused();
    await quick.fill('Timed chip');
    await quick.press('Enter');
    const timedSlot = page.locator('.tkcal-wk-slot.is-today', { hasText: 'Timed chip' });
    await expect(timedSlot).toBeVisible();
    await expect(timedSlot.locator('.tkcal-chip-time')).toContainText(/AM|PM/);

    // Picking another header moves the wash — and the day pane — to it.
    const another = page.locator('.tkcal-wk-head:not(.is-today)').first();
    await another.click();
    await expect(another).toHaveClass(/is-selected/);
    await expect(page.locator('.tkcal-wk-head.is-today')).not.toHaveClass(/is-selected/);
    await expect(page.locator('.tkcal-day-pane .tk-empty-day')).toBeVisible();

    // The hour slots pick too: any hour of a day belongs to that day.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const tomorrowKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(
      tomorrow.getDate(),
    )}`;
    await page.locator(`.tkcal-wk-slot[data-cal-day="${tomorrowKey}"]`).first().click();
    await expect(page.locator(`.tkcal-wk-head[data-cal-day="${tomorrowKey}"]`)).toHaveClass(
      /is-selected/,
    );

    // Flipping back to Month lands on the week's month — the glass
    // never jumps somewhere the user wasn't looking.
    await page.locator('[data-cal-mode="month"]').click();
    await expect(page.locator('.tkcal-grid')).toBeVisible();
    await expect(page.locator('.tkcal-day.is-selected')).toHaveCount(1);
  });

  test('the day view opens on the picked day, steps by the day, Today comes home', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="day"]').click();

    // One wide sheet, opened on today: the numeral matches, today's
    // sheet wears the red mark, and the sidebar's day inspector stands
    // down — the sheet IS the inspector.
    const sheet = page.locator('.tkcal-daypage');
    await expect(sheet).toHaveCount(1);
    const todayNum = String(new Date().getDate());
    await expect(page.locator('.tkcal-daypage-num')).toHaveText(todayNum);
    await expect(sheet).toHaveClass(/is-today/);
    await expect(page.locator('.tkcal-day-pane')).toHaveCount(0);

    // The sheet is hour-ruled: 24 gutter labels over 24 slots, and
    // Apple's red now-line through the current hour.
    await expect(page.locator('.tkcal-day-hours .tkcal-hour')).toHaveCount(24);
    await expect(page.locator('.tkcal-day-slot')).toHaveCount(24);
    await expect(page.locator('.tkcal-day-hours .tkcal-now')).toHaveCount(1);

    // The arrows step the picked day itself.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await page.locator('.tkcal-navs [data-cal-next]').click();
    await expect(page.locator('.tkcal-daypage-num')).toHaveText(String(tomorrow.getDate()));
    await expect(sheet).not.toHaveClass(/is-today/);
    await expect(page.locator('.tkcal-day-hours .tkcal-now')).toHaveCount(0);
    // …and Today walks the sheet home.
    await page.locator('.tkcal-navs [data-cal-today]').click();
    await expect(page.locator('.tkcal-daypage-num')).toHaveText(todayNum);
    await expect(sheet).toHaveClass(/is-today/);
    await expect(page.locator('.tkcal-day-hours .tkcal-now')).toHaveCount(1);

    // Flipping to Month lands on the stepped day's month, selection
    // carried over.
    await page.locator('[data-cal-mode="month"]').click();
    await expect(page.locator('.tkcal-grid')).toBeVisible();
    await expect(page.locator('.tkcal-day.is-selected')).toHaveCount(1);
  });

  test("the day sheet lists the day's reminders as real rows; completing empties it", async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);
    await page.locator('.tkp-title').fill('Personal');
    await page.locator('.tkp-title').press('Enter');
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Day page thing');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Day page thing' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="today"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="day"]').click();

    // The reminder is on the sheet as a REAL row — not a chip — with
    // its due chip and its list origin, in the All-Day band (it was
    // filed without a time).
    await expect(page.locator('.tkcal-day-allday .tkcal-hour')).toHaveText('All-Day');
    const rows = page.locator('[data-cal-daypage-rows]');
    const sheetRow = rows.locator('.tk-task-wrap', { hasText: 'Day page thing' });
    await expect(sheetRow).toBeVisible();
    await expect(sheetRow.locator('.tk-chip-due')).toContainText('Today');
    await expect(sheetRow.locator('.tk-origin')).toContainText('Personal');

    // Completing right on the sheet writes through — the day empties
    // into its friendly copy, floated over the ruling.
    await sheetRow.locator('.tk-check').click();
    await expect(page.locator('.tkcal-daypage .tk-empty-day')).toBeVisible();
    await expect(page.locator('.tkcal-day-allday')).toHaveCount(0);

    // The Add button lives in the sheet's head; the inline row files
    // into the shown day (9:00) and the fresh row lands as a real row
    // in the 9 AM slot.
    await page.locator('[data-cal-add]').click();
    const quick = page.locator('[data-cal-quickadd-input]');
    await expect(quick).toBeFocused();
    await quick.fill('Second thing');
    await quick.press('Enter');
    await expect(page.locator('.tkcal-day-slot', { hasText: 'Second thing' })).toBeVisible();
    await expect(page.locator('.tkcal-daypage .tk-empty-day')).toHaveCount(0);

    // Escape puts the row away without leaving the page.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cal-quickadd]')).toBeHidden();
    await expect(page.locator('#tasksHub')).toBeVisible();
  });

  test('a week chip drags between the hours and the reminder retimes', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Nine o clock');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Nine o clock' }).first();
    await row.locator('.tk-task-main').click();
    await page.locator('[data-editor-when="date"]').click();
    await page.locator('[data-when-preset="today"]').click();
    await page.locator('.tk-editor-title').press('Enter');

    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="week"]').click();

    // The day pane's quick-add files at 9:00 — the chip anchors there,
    // carrying its task id (the drop machinery's handle).
    await page.locator('[data-cal-add]').click();
    const quick = page.locator('[data-cal-quickadd-input]');
    await quick.fill('Retime me');
    await quick.press('Enter');
    const chip = page.locator('.tkcal-chip', { hasText: 'Retime me' });
    await expect(chip).toBeVisible();
    expect(await chip.getAttribute('data-cal-task')).toBeTruthy();
    await expect(page.locator('.tkcal-wk-slot[data-hour="9"] .tkcal-chip')).toHaveCount(1);

    // Drag it into today's 2 PM slot — the drop line previews the
    // exact minute before the drop.
    const slot = page.locator('.tkcal-wk-slot.is-today[data-hour="14"]');
    await calDrag(page, chip, slot);
    await expect(slot.locator('.tkcal-dropline-time')).toHaveCount(0); // paint cleared after the drop
    const landed = page.locator('.tkcal-wk-slot[data-hour="14"] .tkcal-chip', {
      hasText: 'Retime me',
    });
    await expect(landed).toBeVisible();
    await expect(landed.locator('.tkcal-chip-time')).toContainText(/2:0\d PM/);
    await expect(page.locator('.tkcal-wk-slot[data-hour="9"] .tkcal-chip')).toHaveCount(0);

    // The write went through to the reminder itself: the day pane's
    // row wears the new time on its due chip.
    const paneRow = page.locator('.tkcal-day-pane .tk-task-wrap', { hasText: 'Retime me' });
    await expect(paneRow.locator('.tk-chip-due')).toContainText(/2:0\d PM/);
  });

  test('the All-Day band and the hours trade a chip', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    for (const title of ['Band chip', 'Still all day']) {
      await input.fill(title);
      await input.press('Enter');
      const row = page.locator('.tk-task-wrap', { hasText: title }).first();
      await row.locator('.tk-task-main').click();
      await page.locator('[data-editor-when="date"]').click();
      await page.locator('[data-when-preset="today"]').click();
      await page.locator('.tk-editor-title').press('Enter');
    }

    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="week"]').click();

    // Date-only rides the band; dropping it into the 10 AM slot gives
    // it a time — and the band keeps standing (the other chip holds it).
    const bandChip = page.locator('.tkcal-wk-allday-cell.is-today .tkcal-chip', {
      hasText: 'Band chip',
    });
    await expect(bandChip).toBeVisible();
    const slot = page.locator('.tkcal-wk-slot.is-today[data-hour="10"]');
    await calDrag(page, bandChip, slot);
    const timed = page.locator('.tkcal-wk-slot[data-hour="10"] .tkcal-chip', {
      hasText: 'Band chip',
    });
    await expect(timed).toBeVisible();
    await expect(timed.locator('.tkcal-chip-time')).toContainText(/10:0\d AM/);
    await expect(page.locator('.tkcal-wk-allday')).toBeVisible();

    // …and back: dropping on the band takes the time off again.
    const cell = page.locator('.tkcal-wk-allday-cell.is-today');
    await calDrag(page, timed, cell);
    await expect(
      page.locator('.tkcal-wk-allday-cell.is-today .tkcal-chip', { hasText: 'Band chip' }),
    ).toBeVisible();
    await expect(
      page
        .locator('.tkcal-wk-allday-cell.is-today .tkcal-chip', { hasText: 'Band chip' })
        .locator('.tkcal-chip-time'),
    ).toHaveCount(0);
    await expect(page.locator('.tkcal-wk-slot[data-hour="10"] .tkcal-chip')).toHaveCount(0);
  });

  test('double-clicking a bare hour files a reminder right there', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    await page.locator('#tabRailCalendar').click();
    await page.locator('[data-cal-mode="day"]').click();

    // Two quick clicks on the 3 PM slot open the quick-add aimed at
    // that exact hour — the placeholder says so.
    const slot = page.locator('.tkcal-day-slot[data-hour="15"]');
    await slot.scrollIntoViewIfNeeded();
    const box = await slot.boundingBox();
    await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const quick = page.locator('[data-cal-quickadd-input]');
    await expect(quick).toBeFocused();
    await expect(quick).toHaveAttribute('placeholder', 'New Reminder at 3 PM');

    // Enter files at 3:00 — the row lands in the 3 PM slot on the sheet.
    await quick.fill('Three o clock');
    await quick.press('Enter');
    const landedRow = page.locator('.tkcal-day-slot[data-hour="15"] .tk-task-wrap', {
      hasText: 'Three o clock',
    });
    await expect(landedRow).toBeVisible();
    await expect(landedRow.locator('.tk-chip-due')).toContainText('3:00 PM');

    // Escape puts the row away without leaving the page.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cal-quickadd]')).toBeHidden();
    await expect(page.locator('#tasksHub')).toBeVisible();
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

test.describe('the desktop rework — quick-add, tools, popover, destinations', () => {
  test('the quick-add speaks natural language: live chip, date words stripped on submit', async ({
    page,
  }) => {
    await page.goto('/');
    await newTaskList(page);

    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Call the dentist tomorrow 9am');
    // The live read: the parse sees a date while you type.
    await expect(page.locator('.tkp [data-quickadd-live]')).toHaveText(/Tomorrow\s*9:00 AM/u);
    await input.press('Enter');

    // The when-words went into the date, not the title.
    const row = page.locator('.tk-task-wrap', { hasText: 'Call the dentist' }).first();
    await expect(row).toBeVisible();
    await expect(page.locator('.tk-title', { hasText: 'tomorrow' })).toHaveCount(0);
    await expect(row.locator('.tk-chip-due')).toContainText(/Tomorrow\s*9:00 AM/u);

    // A line without when-words files as plain text, no chip.
    await input.fill('Just a plain note to self');
    await input.press('Enter');
    const plain = page.locator('.tk-task-wrap', { hasText: 'Just a plain note to self' }).first();
    await expect(plain).toBeVisible();
    await expect(plain.locator('.tk-chip-due')).toHaveCount(0);
  });

  test('the row tools set a date and a flag without opening the editor', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Hover tools target');
    await input.press('Enter');

    const row = page.locator('.tk-task-wrap', { hasText: 'Hover tools target' }).first();
    // The tools exist on the row (hover-revealed on fine pointers).
    await expect(row.locator('[data-row-when]')).toBeAttached();
    await expect(row.locator('[data-row-flag]')).toBeAttached();

    // The when tool opens the month-grid popover anchored to the row.
    await row.hover();
    await row.locator('[data-row-when]').click();
    const grid = page.locator('.tk-when .tk-wgrid');
    await expect(grid).toBeVisible();
    await grid.locator('.tk-wgrid-day:not(.is-blank)').first().click();
    // The day lands on the row without any accordion ever opening.
    await expect(row.locator('.tk-chip-due')).toBeVisible();
    await expect(row.locator('.tk-editor')).toBeHidden();

    // The flag tool flips the row's flag in one click.
    await row.hover();
    await row.locator('[data-row-flag]').click();
    await expect(row.locator('.tk-flag')).toBeVisible();
  });

  test('the when-popover walks months and picks a far day', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Far away thing');
    await input.press('Enter');
    const row = page.locator('.tk-task-wrap', { hasText: 'Far away thing' }).first();

    await row.hover();
    await row.locator('[data-row-when]').click();
    const grid = page.locator('.tk-when .tk-wgrid');
    const label = grid.locator('.tk-wgrid-month');
    const first = await label.textContent();

    // Next month walks the grid; the value stays untouched so far.
    await grid.locator('[data-when-nav="1"]').click();
    await expect(label).not.toHaveText(first!);
    // …and a day in THAT month lands as the due date.
    await grid.locator('.tk-wgrid-day:not(.is-blank)').first().click();
    await expect(row.locator('.tk-chip-due')).toBeVisible();
    // The popover closed; the grid is gone; the row carries the date.
    await expect(grid).toHaveCount(0);
  });

  test('no back arrow on desktop, and the calendar sidebar opens the views', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    const input = page.locator('.tkp [data-composer-input]');
    await input.fill('Visible from everywhere');
    await input.press('Enter');

    // Desktop hub heads carry no back arrow.
    await page.locator('.tr-card[data-view="all"]').click();
    await expect(page.locator('#tkhTitle')).toHaveText('All');
    await expect(page.locator('.tkh-back')).toBeHidden();

    // The calendar's sidebar destinations open the other views — the
    // desktop way out, no arrow needed.
    await page.locator('#tabRailCalendar').click();
    await expect(page.locator('.tkcal-grid')).toBeVisible();
    await page.locator('.tkcal-dest[data-cal-dest="all"]').click();
    await expect(page.locator('#tkhTitle')).toHaveText('All');
    await expect(
      page.locator('#tkhSections .tk-task-wrap', { hasText: 'Visible from everywhere' }),
    ).toBeVisible();
    // …and the calendar keeps its own sidebar (lists + day pane + mini).
    await page.locator('#tabRailCalendar').click();
    await expect(page.locator('.tkcal-dests')).toBeVisible();
    await expect(page.locator('.tkcal-lists')).toBeVisible();
  });

  test('the quick-add lives at the top of the hub views with its target chip', async ({ page }) => {
    await page.goto('/');
    await newTaskList(page);
    await page.locator('.tr-card[data-view="all"]').click();
    await expect(page.locator('#tkhTitle')).toHaveText('All');

    // The quick-add sits above the sections, target chip present.
    const quick = page.locator('#tasksHub .tk-quickadd');
    await expect(quick).toBeVisible();
    await expect(quick.locator('#tkhTarget')).toBeVisible();
    const box = await quick.boundingBox();
    const sectionsBox = await page.locator('#tkhSections').boundingBox();
    expect(box!.y).toBeLessThan(sectionsBox!.y);

    // Filing from the hub lands in the target list and re-renders the view.
    await page.locator('#tasksHub [data-composer-input]').fill('Filed from the hub');
    await page.locator('#tasksHub [data-composer-input]').press('Enter');
    await expect(
      page.locator('#tkhSections .tk-task-wrap', { hasText: 'Filed from the hub' }),
    ).toBeVisible();
  });
});
