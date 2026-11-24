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
 * the NATIVE set — the vendor's own chrome (palette, Find on canvas, Help,
 * welcome panel) with the white-label policy doors still shut (no Clear
 * canvas — the Padify-confirmed flow owns that — and no vendor links).
 *
 * The scene bytes are read straight from the padify IndexedDB store —
 * the same rows the sync pipeline ships — because the DOM alone cannot
 * prove what the note holds.
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

  test('the download menu offers the export row only once there is something to save', async ({
    page,
  }) => {
    await openDrawingCanvas(page);

    // An empty drawing: the rows stay hidden, exactly like the Markdown row.
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#iconDropdown')).toHaveClass(/show/);
    await expect(page.locator('#downloadNotesImage')).toBeHidden();
    await page.keyboard.press('Escape');

    // Draw, wait for the save, reopen: both rows appear.
    await drawRectangle(page);
    await page.waitForTimeout(2_000);
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#iconDropdown')).toHaveClass(/show/);
    await expect(page.locator('#downloadNotesImage')).toBeVisible();
    await expect(page.locator('#downloadNotesExcalidraw')).toBeVisible();
  });

  test('the export dialog speaks the native options and downloads the render', async ({ page }) => {
    await openDrawingCanvas(page);
    await drawRectangle(page);
    await page.waitForTimeout(2_000);

    await page.locator('#downloadNotes').click();
    await page.locator('#downloadNotesImage').click();

    // The dialog: format switch, the three option rows, the scale switch.
    const dialog = page.locator('dialog.drawing-export-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.drawing-export-seg-btn', { hasText: 'PNG' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.getByText('Background')).toBeVisible();
    await expect(dialog.getByText('Dark mode')).toBeVisible();
    await expect(dialog.getByText('Embed scene')).toBeVisible();

    // Scale is PNG-only semantics — flip the format and the SVG-only rows
    // step aside, exactly like the vendor's own dialog.
    await dialog.locator('.drawing-export-seg-btn', { hasText: 'SVG' }).click();
    await expect(dialog.locator('.drawing-export-scale-row')).toBeHidden();
    await expect(dialog.locator('.drawing-export-option', { hasText: 'Embed scene' })).toBeHidden();
    await dialog.locator('.drawing-export-seg-btn', { hasText: 'PNG' }).click();
    await expect(dialog.locator('.drawing-export-scale-row')).toBeVisible();

    // Save at 2× with the defaults otherwise: the download carries the
    // note's file name and the PNG bytes.
    await dialog.locator('.drawing-export-seg-btn', { hasText: '2×' }).click();
    const download = page.waitForEvent('download');
    await dialog.locator('button.vz-dialog-confirm').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    // The dialog closed on the Save press.
    await expect(dialog).toBeHidden();
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

    // The native chrome the curated build had off: the command palette and
    // Find on canvas are menu items again, and the welcome panel stands on
    // an empty scene (the vendor's hand-drawn overlay).
    await expect(menu.getByText('Command palette')).toBeVisible();
    await expect(menu.getByText('Find on canvas')).toBeVisible();
    await expect(page.locator('#note .excalidraw .WelcomeScreen')).toBeVisible();
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

  test('the map island opens with the pad — the footer toggle owns it', async ({ page }) => {
    await openDrawingCanvas(page);

    // Parity with excalidraw.com: the minimap is ON at open (the Padify
    // default — the vendor's own is off, and the toggle is a browser-level
    // viewport pref the appState whitelist rightly never persists, so
    // every open falls back to the pad's default), floating above the
    // footer's zoom controls with its toggle beside them.
    const island = page.locator('#note .excalidraw .minimap');
    await expect(island).toBeVisible();
    const toggle = page.locator('#note .excalidraw .minimap-toggle-button');
    await expect(toggle).toBeVisible();

    // With the minimap UI on, the zoom controls are the zoom MENU (the
    // vendor's own footer form for this mode), not the plain
    // zoom-out / readout / zoom-in buttons.
    await expect(page.locator('#note [data-testid="zoom-menu-trigger"]')).toBeVisible();
    await expect(page.locator('#note .excalidraw .zoom-button')).toHaveCount(0);

    // The toggle hides the island.
    await toggle.click();
    await expect(island).toBeHidden();

    // A viewport pref, never scene bytes: the vendor itself refuses to
    // announce the flip (captureUpdate: EVENTUALLY — its own classification
    // of viewport state), so the fresh pad's content stays '' (the
    // open-never-writes guard, byte-exact with the map on).
    const saved = await readDrawingNotes(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('');

    // And the default rides every open: a reload brings the island back.
    await page.reload();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#note .excalidraw .minimap')).toBeVisible();
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
    // teaches the canvas.
    await page.locator('#brandMenuButton').click();
    await page.locator('#brandMenu .brand-menu-item', { hasText: 'Keyboard shortcuts' }).click();
    const modal = page.locator('#keyboardShortcutsModal');
    await expect(modal).toHaveClass(/in/);

    // The Drawing Canvas section lists the tool chords this build's
    // canvas actually answers to (probe-verified against the installed
    // vendor): the number row, the letter row, the eraser and the lock.
    const section = modal.locator('.shortcut-section', { hasText: 'Drawing Canvas' });
    await expect(section).toBeVisible();
    await expect(section.locator('.shortcut-row', { hasText: 'Tools by number' })).toContainText(
      '1 select · 2 rectangle · 3 diamond · 4 ellipse · 5 arrow · 6 line · 7 freedraw · 8 text',
    );
    await expect(
      section.locator('.shortcut-row', { hasText: 'Same tools by letter' }),
    ).toContainText('X or P freedraw');
    await expect(section.locator('.shortcut-row', { hasText: 'Eraser' })).toContainText('0');
    await expect(section.locator('.shortcut-row', { hasText: 'Lock tool' })).toContainText('Q');

    // The chords the canvas shares with the app's platform labeling: the
    // history family speaks the hydrated Ctrl (never the Cmd hedge).
    const undoRow = section.locator('.shortcut-row', { hasText: 'Undo / Redo' });
    await expect(undoRow.locator('kbd[data-mod-key]')).toHaveCount(2);
    await expect(undoRow).toContainText('Ctrl');
    await expect(undoRow).not.toContainText('⌘');

    // The search door finds the canvas rows like any other.
    await page.locator('#shortcutSearch').fill('sticky');
    await expect(modal.locator('.shortcut-row', { hasText: 'Sticky note' })).toBeVisible();
    await expect(modal.locator('.shortcut-row', { hasText: 'Bold' })).toBeHidden();
  });
});
