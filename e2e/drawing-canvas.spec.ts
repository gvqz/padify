import { expect, test, type Page } from '@playwright/test';

/**
 * The drawing canvas — the phase-2 flows a human would check by hand.
 *
 * The scaffold tests (note-types.spec.ts) pinned the type; these run the
 * canvas itself: the island mounts on a drawing note, a shape drawn with
 * the mouse persists through the full autosave chain (announce → input →
 * save) into the real IndexedDB as a version-1 scene envelope, a reload
 * restores it onto a remounted canvas, the download menu offers the image
 * export row only when there is something to export, and the main menu is
 * the NATIVE set — the vendor's own chrome (Find on canvas, the sheet row,
 * welcome panel) with the white-label policy doors still shut (no Clear
 * canvas — the Padify-confirmed flow owns that — and no vendor links), the
 * command palette retired at the composition layer (the vendor exports
 * that component for HOSTS to mount, and this app no longer mounts it),
 * and the vendor's help dialog deleted outright — the "?" chord, the
 * welcome screen's Help row and the dialog itself all died in the same
 * patch; the app's shortcuts sheet is the one help surface.
 *
 * The scene bytes are read straight from the padify IndexedDB store —
 * the same rows the sync pipeline ships — because the DOM alone cannot
 * prove what the note holds.
 *
 * THE EXPORT STORY (after the restore): the drawing's image exports
 * ride their own dialog again — the download center's image rows are
 * launchers that hand off to it (PNG/SVG, background, dark, embed for
 * both formats, the 3× scale, the clipboard press — the full native
 * option set), and the vendor's own native dialog answers behind the
 * canvas menu row and its Ctrl+Shift+E chord. The center stays the door
 * for the file-type exports (the .excalidraw/.padify envelopes). Three
 * good faces, each with its own door — the one-popup compromise is gone.
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

/** Creates a drawing note and waits for the canvas island. */
async function openDrawingCanvas(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#addTabTypeMenu').click();
  await expect(page.locator('#addTabTypeMenuPopover')).toBeVisible();
  await page.locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' }).click();
  await expect(page.locator('#note [data-drawing-canvas]')).toBeVisible();
  await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
}

/** The drawing notes' rows from the app's IndexedDB (name 'padify'). */
async function readDrawingNotes(page: Page): Promise<{ id: string; content: string }[]> {
  return page.evaluate(
    () =>
      new Promise<{ id: string; content: string }[]>((resolve, reject) => {
        const request = indexedDB.open('padify');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('notes', 'readonly');
          const store = tx.objectStore('notes');
          const rows: { id: string; content: string }[] = [];
          const cursorRequest = store.openCursor();
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              const row = cursor.value as {
                id: string;
                content: string;
                noteType?: string;
              };
              if (row.noteType === 'drawing') {
                rows.push({ id: row.id, content: row.content });
              }
              cursor.continue();
            } else {
              resolve(rows);
              db.close();
            }
          };
        };
      }),
  );
}

/** Draws one rectangle with the mouse on the interactive canvas. */
async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator('#note .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // A click focuses the canvas (autofocus may have been stolen by the
  // menu), then 'r' arms the rectangle tool.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press('r');
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.6, { steps: 8 });
  await page.mouse.up();
}

test.describe('the drawing canvas', () => {
  test('a drawn shape persists as a scene envelope and survives the reload', async ({ page }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);

    // The full chain: 300 ms surface announce + 500 ms app input debounce
    // + the persist debounce. Then the note's bytes must hold exactly one
    // element inside a version-1 envelope.
    await page.waitForTimeout(2_000);
    const saved = await readDrawingNotes(page);
    expect(saved).toHaveLength(1);
    const scene = JSON.parse(saved[0].content) as {
      version: number;
      elements: { id: string; type: string }[];
      appState: Record<string, unknown>;
    };
    expect(scene.version).toBe(1);
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].type).toBe('rectangle');
    expect(typeof scene.appState).toBe('object');

    // The reload restores the note (boot restores the active tab) and
    // remounts the canvas over the same durable bytes.
    await page.reload();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    const reloaded = await readDrawingNotes(page);
    expect(reloaded).toHaveLength(1);
    expect(JSON.parse(reloaded[0].content).elements).toHaveLength(1);
  });

  test('the download center answers a drawing with launchers and envelopes', async ({ page }) => {
    await openDrawingCanvas(page);

    // An empty drawing still opens the center — one door for every
    // state: the launcher rows ride the list, the initial selection is
    // the first SELECTABLE type (the .excalidraw envelope), and its
    // stage speaks the honest gate.
    await page.locator('#downloadNotes').click();
    const center = page.locator('dialog.export-center');
    await expect(center).toBeVisible();
    await expect(
      center.locator('.export-center-type--launch', { hasText: 'PNG image' }),
    ).toBeVisible();
    await expect(
      center.locator('.export-center-type--launch', { hasText: 'SVG image' }),
    ).toBeVisible();
    await expect(
      center.locator('.export-center-type', { hasText: 'Excalidraw file' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(center.locator('.export-center-stage-note')).toContainText(
      'Nothing to export yet — draw something first.',
    );
    await page.keyboard.press('Escape');
    await expect(center).toBeHidden();

    // The launcher click on the empty canvas gates honestly: the center
    // closes, the toast says what an export would need.
    await page.locator('#downloadNotes').click();
    await expect(center).toBeVisible();
    await center.locator('.export-center-type--launch', { hasText: 'PNG image' }).click();
    await expect(center).toBeHidden();
    await expect(page.locator('#toast')).toContainText(
      'Nothing to export yet — draw something first.',
    );

    // Draw, wait for the save chain, reopen: the envelope's stage
    // renders the scene thumbnail.
    await drawRectangle(page);
    await page.waitForTimeout(2_000);
    await page.locator('#downloadNotes').click();
    await expect(center).toBeVisible();
    await expect(center.locator('.export-center-stage-img')).toBeVisible();
  });

  test('the launcher hands the images to the drawing dialog — the full native set', async ({
    page,
  }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);
    await page.waitForTimeout(2_000);

    await page.locator('#downloadNotes').click();
    const center = page.locator('dialog.export-center');
    await expect(center).toBeVisible();
    await center.locator('.export-center-type--launch', { hasText: 'PNG image' }).click();

    // The handoff closed the center and opened the drawing's own dialog:
    // format switch, the three option rows, the 3× scale, the clipboard
    // press — the native option set, whole.
    const dialog = page.locator('dialog.drawing-export-dialog');
    await expect(center).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.drawing-export-seg-btn', { hasText: 'PNG' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.getByText('Background')).toBeVisible();
    await expect(dialog.getByText('Dark mode')).toBeVisible();
    await expect(dialog.getByText('Embed scene')).toBeVisible();
    await expect(dialog.getByText('Copy to clipboard')).toBeVisible();
    await expect(dialog.locator('.drawing-export-seg-btn', { hasText: '3×' })).toBeVisible();

    // NATIVE PARITY, the part the old dialog got wrong: Embed scene and
    // Scale answer for BOTH formats — the vendor's own dialog shows them
    // whatever the export button will be (scale sizes the SVG, embed
    // writes its metadata).
    await dialog.locator('.drawing-export-seg-btn', { hasText: 'SVG' }).click();
    await expect(dialog.locator('.drawing-export-scale-row')).toBeVisible();
    await expect(
      dialog.locator('.drawing-export-option', { hasText: 'Embed scene' }),
    ).toBeVisible();
    await dialog.locator('.drawing-export-seg-btn', { hasText: 'PNG' }).click();

    // Save at 3× with the defaults otherwise: the download carries the
    // PNG bytes and the note's file name.
    await dialog.locator('.drawing-export-seg-btn', { hasText: '3×' }).click();
    const download = page.waitForEvent('download');
    await dialog.locator('button.vz-dialog-confirm', { hasText: 'Save' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    // The dialog closed on the Save press.
    await expect(dialog).toBeHidden();
  });

  test('the vendor export dialog answers behind the canvas menu row — native again', async ({
    page,
  }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);
    await page.waitForTimeout(2_000);

    // The restored native face: the menu row opens the VENDOR's dialog —
    // its own switches, its own preview, its own Export/Copy buttons.
    await page.locator('[data-testid="main-menu-trigger"]').click();
    const menu = page.locator('#note .excalidraw .dropdown-menu');
    await expect(menu.locator('[data-testid="image-export-button"]')).toBeVisible();
    await menu.locator('[data-testid="image-export-button"]').click();

    const vendorDialog = page.locator('.ImageExportModal');
    await expect(vendorDialog).toBeVisible();
    // The vendor's own switches ride along — the full native set (its
    // buttons' text is the short word; the long name is the title).
    await expect(vendorDialog.getByRole('button', { name: 'Export to PNG' })).toBeVisible();
    await expect(vendorDialog.getByRole('button', { name: 'Export to SVG' })).toBeVisible();
    await expect(vendorDialog.getByRole('button', { name: 'Copy PNG to clipboard' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(vendorDialog).toBeHidden();
  });

  test('Ctrl+Shift+E — the vendor dialog on a drawing, the export center on a text note', async ({
    page,
  }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);
    await page.waitForTimeout(2_000);

    // A live drawing: the chord is the canvas's own (the app's dispatcher
    // stands aside) — the vendor's native dialog answers.
    await page.keyboard.press('Control+Shift+E');
    await expect(page.locator('.ImageExportModal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ImageExportModal')).toBeHidden();

    // A text note: the app answers — the export center opens on its
    // file-type rows.
    await page.locator('#addTab').click();
    await page.keyboard.press('Control+Shift+E');
    await expect(page.locator('dialog.export-center')).toBeVisible();
    await expect(
      page.locator('dialog.export-center .export-center-type', { hasText: 'Plain text' }),
    ).toBeVisible();
  });

  test('the Preferences group toggles zen mode and the choice persists', async ({ page }) => {
    await openDrawingCanvas(page);

    // The native menu's Preferences SUBMENU — the vendor's own
    // DefaultItems.Preferences, the same component the site renders. The
    // rows live one click behind the trigger.
    await page.locator('[data-testid="main-menu-trigger"]').click();
    const menu = page.locator('#note .excalidraw .dropdown-menu.main-menu');
    const submenu = page.locator('#note .excalidraw .dropdown-menu.dropdown-submenu');
    await menu.locator('.dropdown-menu-item', { hasText: 'Preferences' }).click();
    const zenRow = submenu.locator('.dropdown-menu-item', { hasText: 'Zen mode' });
    await expect(zenRow).toBeVisible();
    await expect(
      submenu.locator('.dropdown-menu-item', { hasText: 'Snap to objects' }),
    ).toBeVisible();

    // Toggle zen: the submenu STAYS open on select, and the vendor marks
    // the row with its own checkmark ICON (an svg injected into the row's
    // icon slot — the site's checkmark, not the old hand-composed rows'
    // --selected class).
    await zenRow.click();
    await expect(zenRow.locator('.dropdown-menu-item__icon svg')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Zen state is note content now (the whitelist): the save carries it.
    await page.waitForTimeout(2_000);
    const saved = await readDrawingNotes(page);
    expect(JSON.parse(saved[0].content).appState.zenModeEnabled).toBe(true);

    // And a reload restores it from the scene bytes.
    await page.reload();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await menu.locator('.dropdown-menu-item', { hasText: 'Preferences' }).click();
    await expect(
      submenu
        .locator('.dropdown-menu-item', { hasText: 'Zen mode' })
        .locator('.dropdown-menu-item__icon svg'),
    ).toHaveCount(1);
  });

  test('the app chords still win while the canvas listens globally', async ({ page }) => {
    await openDrawingCanvas(page);

    // With the drawing active, the vendor's global keyboard is live — a
    // tool chord arms the tool without any canvas focus. 'r' = rectangle.
    const toolRectangle = page.locator('#note [data-testid="toolbar-rectangle"]');
    await expect(toolRectangle).toBeVisible();
    await page.keyboard.press('r');
    await expect(toolRectangle).toHaveClass(/ToolIcon--checked/);

    // The app's own chord (Ctrl+, → the preferences modal) must still fire
    // — the app's dispatcher answers it and stops the vendor from seeing
    // the event.
    await page.keyboard.press('Control+,');
    const prefsModal = page.locator('#preferencesModal');
    await expect(prefsModal).toHaveClass(/in/);
    await page.keyboard.press('Escape');
    await expect(prefsModal).not.toHaveClass(/in/);

    // And Escape on a quiet page belongs to the canvas again (the app's
    // modal-close branch only wins while an app modal is open) — the
    // vendor's zen-mode chord Alt+Z answers, proving the global handler
    // still receives keys after the app's branches.
    await page.keyboard.press('Alt+z');
    await page.locator('[data-testid="main-menu-trigger"]').click();
    const prefsMenu = page.locator('#note .excalidraw .dropdown-menu.main-menu');
    await prefsMenu.locator('.dropdown-menu-item', { hasText: 'Preferences' }).click();
    await expect(
      page
        .locator('#note .excalidraw .dropdown-menu.dropdown-submenu .dropdown-menu-item', {
          hasText: 'Zen mode',
        })
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('a failed chunk lands on the error card, whose Retry reloads', async ({ page }) => {
    // R3's open-glitch: a deploy renames the chunk a running tab holds;
    // the mount path retries once, then answers with the honest card —
    // whose Retry action refreshes the shell and reloads (the
    // deterministic version of the user's manual hard refresh). The
    // block targets the canvas MODULE itself (the exact module the
    // surface's import('./canvas') requests — dev serves it from src,
    // production from a hashed asset; both spellings share the path).
    await page.route(/editor\/drawing\/canvas\.ts/, (route) =>
      route.fulfill({ status: 404, body: 'gone' }),
    );
    await page.goto('/');
    await page.locator('#addTabTypeMenu').click();
    await expect(page.locator('#addTabTypeMenuPopover')).toBeVisible();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' })
      .click();

    // The card, after the one-shot retry has come up empty.
    const retry = page.locator('#note .unsupported-note-action', { hasText: 'Retry' });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#note .unsupported-note-title')).toContainText(
      'The canvas could not load',
    );

    // Retry reloads the page (the SW shell refresh is a no-op offline in
    // this dev context — the reload itself is the observable contract).
    const reloadPromise = page.waitForEvent('load', { timeout: 15_000 });
    await retry.click();
    await reloadPromise;
    // The route still blocks the chunk (the route survives reloads), so
    // the reloaded page shows the same honest card — proof the retry
    // acted, not that the failure healed.
    await expect(page.locator('#note .unsupported-note-action', { hasText: 'Retry' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('the main menu ships the native set — no vendor clear, no vendor links', async ({
    page,
  }) => {
    await openDrawingCanvas(page);

    await page.locator('[data-testid="main-menu-trigger"]').click();
    // Scoped to the canvas's own menu — the app's download dropdown shares
    // the .dropdown-menu class.
    const menu = page.locator('#note .excalidraw .dropdown-menu');
    await expect(menu.locator('[data-testid="load-button"]')).toBeVisible();
    await expect(menu.locator('[data-testid="image-export-button"]')).toBeVisible();

    // "Save" (saveToActiveFile) only renders once a scene was OPENED from
    // a .excalidraw file (the vendor's fileHandle predicate) — a Padify
    // note is the scene's home, so a fresh drawing has nothing to save
    // over. Open-from-file turns the item on; nothing else should.
    await expect(menu.locator('[data-testid="save-button"]')).toHaveCount(0);

    // The vendor's clear-canvas never appears (the app's confirmed flow
    // owns clearing) and neither does the vendor's link group.
    await expect(menu.getByText('Clear canvas')).toHaveCount(0);
    await expect(menu.getByText('Excalidraw links')).toHaveCount(0);

    // The command palette is retired at the composition layer: the vendor
    // exports the component for hosts to mount and this app no longer
    // does — no menu row, and no chords either (the component bound its
    // own capture-phase keys and it is not mounted).
    await expect(menu.getByText('Command palette')).toHaveCount(0);

    // The help story is the sheet alone: the vendor's Help menu item is a
    // DefaultItems property we never compose, and the vendor's fallback
    // (which still references it in the pin's own source) is not rendered
    // either.
    await expect(menu.locator('[data-testid="help-menu-item"]')).toHaveCount(0);

    // The native chrome the curated build had off: Find on canvas is a
    // menu item again, and the welcome panel stands on an empty scene
    // (the vendor's hand-drawn overlay).
    await expect(menu.getByText('Find on canvas')).toBeVisible();
    await expect(page.locator('#note .excalidraw .welcome-screen-center')).toBeVisible();

    // The welcome center's default menu carries an Open row (the vendor's
    // load-scene item) and — since the help purge — NO Help row: the row
    // opened the vendor's dialog, which the patch deletes outright.
    const center = page.locator('#note .excalidraw .welcome-screen-center');
    await expect(center.getByText('Help')).toHaveCount(0);
  });

  test('the "?" chord answers nothing — the vendor help dialog is deleted', async ({ page }) => {
    await openDrawingCanvas(page);

    // The vendor's App intercepted "?" with a direct setState into its
    // help dialog; the patch deletes the branch. Press it on the live
    // canvas and expect the dialog to never mount — and no page errors
    // from the missing action (the afterEach guard would catch one).
    await page.locator('#note .excalidraw').click({ position: { x: 400, y: 300 } });
    await page.keyboard.press('Shift+Slash'); // the "?" key
    await page.waitForTimeout(400);
    await expect(page.locator('#note .HelpDialog')).toHaveCount(0);
    await expect(page.locator('.excalidraw .HelpDialog')).toHaveCount(0);
  });

  test('the canvas takes over the full stage — edge to edge, no bottom strip', async ({ page }) => {
    await openDrawingCanvas(page);
    await page.waitForTimeout(500);

    // The host wears the takeover state: no reading-column padding, no
    // border, and the bottom strip (save state, stats capsule) is gone.
    const host = page.locator('#note');
    await expect(host).toHaveClass(/drawing-canvas-open/);
    const hostState = await host.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        borderTopWidth: cs.borderTopWidth,
        overflow: cs.overflow,
      };
    });
    expect(hostState.paddingTop).toBe('0px');
    expect(hostState.paddingRight).toBe('0px');
    expect(hostState.paddingBottom).toBe('0px');
    expect(hostState.paddingLeft).toBe('0px');
    expect(hostState.borderTopWidth).toBe('0px');
    expect(hostState.overflow).toBe('hidden');
    await expect(page.locator('.bottom-line')).toBeHidden();

    // The canvas fills the editor column edge to edge — the wrapper's box
    // IS the column's box (the navbar and the notes rail are app chrome,
    // everything below/right of them belongs to the drawing).
    const boxes = await page.evaluate(() => {
      const col = document.getElementById('textareaContainer')!.getBoundingClientRect();
      const wrap = document.querySelector('#note [data-drawing-canvas]')!.getBoundingClientRect();
      return {
        col: { x: col.x, y: col.y, w: col.width, h: col.height },
        wrap: { x: wrap.x, y: wrap.y, w: wrap.width, h: wrap.height },
      };
    });
    expect(boxes.wrap.x).toBeCloseTo(boxes.col.x, 0);
    expect(boxes.wrap.y).toBeCloseTo(boxes.col.y, 0);
    expect(boxes.wrap.w).toBeCloseTo(boxes.col.w, 0);
    expect(boxes.wrap.h).toBeCloseTo(boxes.col.h, 0);

    // Switching to a text note stands the takeover down: the padded
    // reading column comes back with its bottom strip.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#note [data-drawing-canvas]')).toHaveCount(0);
    await expect(page.locator('#note')).not.toHaveClass(/drawing-canvas-open/);
    await expect(page.locator('#note')).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('.bottom-line')).toBeVisible();
  });

  test('zen mode takes the shell down with the vendor chrome — and gives it back', async ({
    page,
  }) => {
    await openDrawingCanvas(page);
    await page.waitForTimeout(500);

    // The vendor's Preferences toggle — the same row the site speaks.
    await page.locator('[data-testid="main-menu-trigger"]').click();
    const menu = page.locator('#note .excalidraw .dropdown-menu.main-menu');
    await menu.locator('.dropdown-menu-item', { hasText: 'Preferences' }).click();
    await menu.locator('.dropdown-menu-item', { hasText: 'Zen mode' }).click();
    await page.keyboard.press('Escape'); // the submenu stays open on select
    await expect(menu).toBeHidden();

    // The host wears the zen state, and the shell's half of the deal:
    // the navbar and the note rail step aside — the drawing owns the
    // whole window, the way zen reads on excalidraw.com (the vendor's
    // own chrome is its business; the navbar and the rail are ours).
    await expect(page.locator('#note')).toHaveClass(/drawing-zen-mode/);
    await expect(page.locator('.navbar-fixed-top')).toBeHidden();
    await expect(page.locator('#tabRail')).toBeHidden();

    // The drawing re-measures for the wider stage (the vendor's
    // ResizeObserver): the canvas box now fills the whole viewport —
    // no navbar strip above, no rail column on the left.
    const full = await page.evaluate(() => {
      const canvas = document.querySelector('#note .excalidraw')?.getBoundingClientRect();
      return canvas
        ? {
            x: Math.round(canvas.x),
            y: Math.round(canvas.y),
            w: Math.round(canvas.width),
            h: Math.round(canvas.height),
            vw: window.innerWidth,
            vh: window.innerHeight,
          }
        : null;
    });
    expect(full).not.toBeNull();
    expect(full!.x).toBeLessThanOrEqual(1);
    expect(full!.y).toBeLessThanOrEqual(1);
    expect(full!.w).toBeGreaterThanOrEqual(full!.vw - 2);
    expect(full!.h).toBeGreaterThanOrEqual(full!.vh - 2);

    // Toggling back hands the chrome home (the vendor's menu button
    // survives zen — the escape hatch, exactly like the site; with the
    // rail hidden it is the ONE in-app way out, the same trap-less
    // model excalidraw.com runs).
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await menu.locator('.dropdown-menu-item', { hasText: 'Preferences' }).click();
    await menu.locator('.dropdown-menu-item', { hasText: 'Zen mode' }).click();
    await expect(page.locator('#note')).not.toHaveClass(/drawing-zen-mode/);
    await expect(page.locator('.navbar-fixed-top')).toBeVisible();
    await expect(page.locator('#tabRail')).toBeVisible();

    // The shell survives the next stage change: leaving the drawing for
    // a text note keeps the chrome (the zen-ON stand-down discipline —
    // dismiss lifts the state whatever repainted the host — is pinned at
    // unit level, where a programmatic stage change is honest).
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#note [data-drawing-canvas]')).toHaveCount(0);
    await expect(page.locator('.navbar-fixed-top')).toBeVisible();
    await expect(page.locator('#tabRail')).toBeVisible();
    await expect(page.locator('.bottom-line')).toBeVisible();
  });

  test('the map starts closed — the footer toggle owns it — and the styles panel keeps its rows', async ({
    page,
  }) => {
    await openDrawingCanvas(page);

    // Parity with excalidraw.com, measured: the vendor's own default has
    // the minimap CLOSED (its toggle sits in the footer beside the zoom
    // menu trigger). Forcing it open was tried and reverted — the vendor
    // reserves 138px of the styles panel's column for an open map
    // (LayerUI's MINIMAP_RESERVED_HEIGHT) and CLIPPED the panel's Layers
    // and Actions rows away. The footer form is identical either way —
    // the zoom readout stays the zoom MENU trigger, not plain buttons.
    const island = page.locator('#note .excalidraw .minimap');
    await expect(island).toBeHidden();
    const toggle = page.locator('#note .excalidraw .minimap-toggle-button');
    await expect(toggle).toBeVisible();
    await expect(page.locator('#note [data-testid="zoom-menu-trigger"]')).toBeVisible();
    await expect(page.locator('#note .excalidraw .zoom-button')).toHaveCount(0);

    // The toggle raises and hides the island.
    await toggle.click();
    await expect(island).toBeVisible();
    await toggle.click();
    await expect(island).toBeHidden();

    // A viewport pref, never scene bytes: the vendor itself refuses to
    // announce the flip (captureUpdate: EVENTUALLY — its own classification
    // of viewport state), so the fresh pad's content stays '' (the
    // open-never-writes guard, byte-exact with the map toggled).
    const saved = await readDrawingNotes(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('');

    // And the default rides every open: a reload keeps the map closed.
    await page.reload();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#note .excalidraw .minimap')).toBeHidden();
    await expect(page.locator('#note .excalidraw .minimap-toggle-button')).toBeVisible();
  });

  test('the styles panel keeps the native height math at the embedded size', async ({ page }) => {
    // The full panel (`.App-menu__left`) only exists above the vendor's
    // compact-form-factor width; the suite's 1280px viewport renders the
    // compact island instead. This test guards the FULL panel, so it
    // opens at the embedded-size session: a 1440×900 window gives the
    // same 1200×850 canvas the side-by-side was measured on.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDrawingCanvas(page);
    await drawRectangle(page);

    // The vendor clamps the panel to `appState.height - 166` (its own
    // LayerUI constant) and lets the panelColumn scroll when the rows
    // exceed it — at this 800px viewport even excalidraw.com scrolls, so
    // "no row below the fold" is NOT the native behavior. What IS native:
    // the clamp's exact value — which is precisely where the old build
    // regressed (forcing the minimap open subtracted the vendor's
    // MINIMAP_RESERVED_HEIGHT, 138px more, and hid the panel's bottom).
    // Assert the formula, not a pixel guess.
    const panel = page.locator('#note .excalidraw .App-menu__left');
    const { maxHeight, wrapperHeight } = await panel.evaluate((el) => ({
      maxHeight: parseFloat(el.style.maxHeight),
      wrapperHeight: el.closest('.excalidraw')?.getBoundingClientRect().height ?? 0,
    }));
    expect(wrapperHeight).toBeGreaterThan(0);
    expect(maxHeight).toBeCloseTo(wrapperHeight - 166, 0);

    // The full native row set rides in the panel, ending with Layers
    // then Actions.
    await expect(panel.locator('fieldset legend', { hasText: 'Layers' })).toBeAttached();
    await expect(panel.locator('fieldset legend', { hasText: 'Actions' })).toBeAttached();
  });

  test('drawing ↔ text switches stand the canvas down and bring it back', async ({ page }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);
    await page.waitForTimeout(2_000);

    // To the first (standard text) note: the canvas leaves the stage and
    // the host becomes an editable again.
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await expect(page.locator('#note [data-drawing-canvas]')).toHaveCount(0);
    await expect(page.locator('#note')).toHaveAttribute('contenteditable', 'true');

    // Back to the drawing: the canvas remounts and the saved shape rides
    // in through initialData (no phantom remount errors, no lost bytes).
    await page.locator('#tabStripTabs .tab-strip-tab').last().click();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    const saved = await readDrawingNotes(page);
    expect(JSON.parse(saved[0].content).elements).toHaveLength(1);
  });

  test('the shortcuts reference teaches the canvas — the app speaks the vendor chords', async ({
    page,
  }) => {
    await page.goto('/');

    // The app's own shortcuts modal (the brand menu's reference), not the
    // vendor's help — the integration: the same sheet that teaches Ctrl+B
    // teaches the canvas. The brand menu itself lost its Help entry (the
    // onboarding tour it opened is deleted; the sheet is the one help
    // surface) — assert the absence while the menu is open.
    await page.locator('#brandMenuButton').click();
    await expect(page.locator('#brandMenu .brand-menu-item', { hasText: 'Help' })).toHaveCount(0);
    await page.locator('#brandMenu .brand-menu-item', { hasText: 'Keyboard shortcuts' }).click();
    const modal = page.locator('#keyboardShortcutsModal');
    await expect(modal).toHaveClass(/in/);

    // The Drawing pane carries the vendor's COMPLETE chord table — the
    // same Tools / View / Editor groups the canvas's HelpDialog speaks
    // (dumped row-by-row from the mounted dialog when this pane was
    // authored). The tool rows:
    const section = modal.locator('.shortcut-section', { hasText: 'Drawing Canvas' });
    await expect(section).toBeVisible();
    await expect(section.locator('[data-search="drawing rectangle r 2 excalidraw"]')).toContainText(
      'R',
    );
    await expect(
      section.locator('[data-search="drawing draw freedraw pen p 7 excalidraw"]'),
    ).toContainText('P');
    await expect(section.locator('[data-search="drawing eraser e 0 excalidraw"]')).toContainText(
      '0',
    );
    await expect(
      section.locator(
        '[data-search="drawing keep selected tool active after drawing q lock excalidraw"]',
      ),
    ).toContainText('Q');
    // The canvas-only chords the old drawing section never carried:
    await expect(
      section.locator('[data-search="drawing zen mode alt z hide chrome"]'),
    ).toContainText('Alt');
    await expect(section.locator('[data-search="drawing group selection ctrl g"]')).toBeVisible();

    // The chords the canvas shares with the app's platform labeling: the
    // history family speaks the hydrated Ctrl (never the Cmd hedge).
    const undoRow = section.locator('[data-search="drawing undo ctrl z"]');
    await expect(undoRow.locator('kbd[data-mod-key]')).toHaveCount(1);
    await expect(undoRow).toContainText('Ctrl');
    await expect(undoRow).not.toContainText('⌘');

    // The search door overrides the pane: from the Drawing nav rail, a
    // query still finds rows everywhere in the sheet.
    await page.locator('.sc-nav-item[data-pane="drawing"]').click();
    await page.locator('#shortcutSearch').fill('sticky');
    await expect(modal.locator('[data-search="drawing sticky note n excalidraw"]')).toBeVisible();
    // A live query flattens every pane — the nav steps aside (the
    // settings' is-searching flow) and the matches take the full width.
    await expect(modal.locator('.sc-layout')).toHaveClass(/is-searching/);
    await expect(modal.locator('.sc-nav')).toBeHidden();
    // The search reaches the other panes too — the markdown pane's bold
    // row answers the same query family.
    await page.locator('#shortcutSearch').fill('strikethrough');
    await expect(
      modal.locator('[data-search="markdown strikethrough strike ctrl cmd shift x source editor"]'),
    ).toBeVisible();
    // The pane's cards are islands of their own: a card whose rows all miss
    // the query goes away instead of lingering as an empty shell.
    await page.locator('#shortcutSearch').fill('zoom');
    await expect(
      modal.locator('.shortcut-section[data-pane="drawing"] .shortcut-card', {
        hasText: 'Zoom in',
      }),
    ).toBeVisible();
    await expect(
      modal.locator('.shortcut-section[data-pane="drawing"] .shortcut-card', {
        hasText: 'Rectangle',
      }),
    ).not.toBeVisible();
    await page.locator('#shortcutSearch').fill('');
    await expect(modal.locator('.sc-layout')).not.toHaveClass(/is-searching/);

    // The redesign's shape: the Settings dialog's two-pane frame — the
    // pane nav rails on the left on wide viewports and rides the top on
    // narrow ones.
    await expect(modal.locator('.sc-layout')).toHaveCSS('grid-template-columns', /^208px/);
    await page.setViewportSize({ width: 480, height: 800 });
    await expect(modal.locator('.sc-nav')).toHaveCSS('flex-direction', 'row');
  });
});
