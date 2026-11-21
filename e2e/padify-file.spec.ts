import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The .padify file — the note as a file, end to end.
 *
 * The flows a human would check by hand: a note saves as a strict
 * .padify envelope (title-named file, every field present), the very
 * bytes downloaded open back as the same kind of note, a native
 * .excalidraw file from excalidraw.com lands as a drawing note with its
 * elements intact, a drawing note exports back out as a native file —
 * and every way a file can fail to be one of ours is refused with an
 * honest toast instead of a mangled note.
 *
 * Scene bytes are read straight from the padify IndexedDB store (same
 * as drawing-canvas.spec.ts) because the DOM alone cannot prove what
 * the note holds.
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

/** A .padify envelope for one note — the format's own shape, hand-built
 * the way a file on disk would be. */
function padifyFile(note: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'padify-note',
    format: 1,
    generator: 'padify',
    exportedAt: 1_737_200_000_000,
    note,
  });
}

async function railCount(page: Page): Promise<number> {
  return page.locator('#tabStripTabs .tab-strip-tab').count();
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
          const cursorRequest = tx.objectStore('notes').openCursor();
          const rows: { id: string; content: string }[] = [];
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              const row = cursor.value as { id: string; content: string; noteType?: string };
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

/** Draws one rectangle on the interactive canvas (from drawing-canvas.spec.ts). */
async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator('#note .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press('r');
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.6, { steps: 8 });
  await page.mouse.up();
}

test.describe('the .padify file', () => {
  test('a note saves as a .padify envelope and the same bytes open back as a note', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const before = await railCount(page);

    await page.locator('#note').click();
    await page.keyboard.type('hello padify file');

    // The save: the app's own row, first in the download menu.
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#iconDropdown')).toHaveClass(/show/);
    const download = page.waitForEvent('download');
    await page.locator('#downloadNotesPadify').click();
    const file = await download;
    // The file is named what the rail calls the note.
    expect(file.suggestedFilename()).toBe('hello padify file.padify');
    const savedPath = testInfo.outputPath('saved.padify');
    await file.saveAs(savedPath);

    // The envelope: strict on every field the format owns.
    const envelope = JSON.parse(readFileSync(savedPath, 'utf8')) as {
      type: string;
      format: number;
      generator: string;
      note: { noteType: string; content: string; name: string | null };
    };
    expect(envelope.type).toBe('padify-note');
    expect(envelope.format).toBe(1);
    expect(envelope.generator).toBe('padify');
    expect(envelope.note.noteType).toBe('standard');
    expect(envelope.note.name).toBe(null);
    expect(envelope.note.content).toContain('hello padify file');

    // The open: the very bytes that left come back as a fresh note.
    await page.locator('input.padify-open-input').setInputFiles(savedPath);
    await expect(page.locator('#toast')).toContainText('Opened "hello padify file".');
    expect(await railCount(page)).toBe(before + 1);
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab).toContainText('hello padify file');
    await expect(page.locator('#note')).toContainText('hello padify file');
  });

  test('every note kind keeps its kind through the file', async ({ page }, testInfo) => {
    await page.goto('/');

    // A Markdown note rides its source verbatim and reopens on the
    // Markdown surface.
    const markdownPath = testInfo.outputPath('markdown.padify');
    writeFileSync(
      markdownPath,
      padifyFile({
        name: 'Readme notes',
        noteType: 'markdown',
        content: '# Imported heading\n\n- one\n- two',
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    await page.locator('input.padify-open-input').setInputFiles(markdownPath);
    await expect(page.locator('#toast')).toContainText('Opened "Readme notes".');
    const activeTab = page.locator('#tabStripTabs .tab-strip-tab.active');
    await expect(activeTab.locator('.tab-strip-type')).toHaveCount(1);
    // The Markdown surface speaks through its source pane, not #note's
    // text content (the html host div the surface mounts inside).
    const source = page.locator('#note .markdown-source');
    await expect(source).toBeVisible();
    await expect(source).toHaveValue(/# Imported heading\n\n- one\n- two/);

    // A drawing note carries its scene and reopens on the canvas.
    const drawingPath = testInfo.outputPath('drawing.padify');
    writeFileSync(
      drawingPath,
      padifyFile({
        name: 'Site sketch',
        noteType: 'drawing',
        content: JSON.stringify({
          version: 1,
          savedAt: 9,
          elements: [{ id: 'el-1', type: 'rectangle', x: 0, y: 0, isDeleted: false }],
          appState: { viewBackgroundColor: '#ffffff' },
        }),
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    await page.locator('input.padify-open-input').setInputFiles(drawingPath);
    await expect(page.locator('#toast')).toContainText('Opened "Site sketch".');
    await expect(page.locator('#note [data-drawing-canvas]')).toBeVisible();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
  });

  test('a native .excalidraw file from excalidraw.com opens as a drawing note', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const before = await railCount(page);

    const nativePath = testInfo.outputPath('my-sketch.excalidraw');
    writeFileSync(
      nativePath,
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements: [
          { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: false },
        ],
        appState: { viewBackgroundColor: '#fafafa', viewModeEnabled: true },
        files: {},
      }),
    );
    await page.locator('input.padify-open-input').setInputFiles(nativePath);

    // The file's own name is the note's name; the canvas mounts.
    await expect(page.locator('#toast')).toContainText('Opened "my-sketch".');
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });
    expect(await railCount(page)).toBe(before + 1);

    // The stored scene: this build's envelope, the element verbatim, the
    // appState whitelisted (viewModeEnabled is a viewport state, not
    // content — it does not survive the whitelist).
    await page.waitForTimeout(1_000);
    const drawings = await readDrawingNotes(page);
    expect(drawings).toHaveLength(1);
    const scene = JSON.parse(drawings[0].content) as {
      version: number;
      elements: { id: string }[];
      appState: Record<string, unknown>;
    };
    expect(scene.version).toBe(1);
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].id).toBe('a');
    expect(scene.appState.viewBackgroundColor).toBe('#fafafa');
    expect(scene.appState.viewModeEnabled).toBeUndefined();
  });

  test('a drawing note exports as a native .excalidraw file', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Drawing' })
      .click();
    await expect(page.locator('#note .excalidraw')).toBeVisible({ timeout: 20_000 });

    // Empty canvas: the interop row stays hidden with the PNG/SVG rows.
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#iconDropdown')).toHaveClass(/show/);
    await expect(page.locator('#downloadNotesExcalidraw')).toBeHidden();
    await page.keyboard.press('Escape');

    // Draw, wait for the save chain, reopen: the row appears.
    await drawRectangle(page);
    await page.waitForTimeout(2_000);
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesExcalidraw')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.locator('#downloadNotesExcalidraw').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Drawing.excalidraw');
    const savedPath = testInfo.outputPath('drawing.excalidraw');
    await file.saveAs(savedPath);

    // Native shape, the drawn element aboard.
    const native = JSON.parse(readFileSync(savedPath, 'utf8')) as {
      type: string;
      version: number;
      elements: { type: string }[];
      appState: Record<string, unknown>;
    };
    expect(native.type).toBe('excalidraw');
    expect(native.version).toBe(2);
    expect(native.elements).toHaveLength(1);
    expect(native.elements[0].type).toBe('rectangle');
    expect(typeof native.appState).toBe('object');
  });

  test('the open door refuses what it cannot open honestly', async ({ page }, testInfo) => {
    await page.goto('/');
    const before = await railCount(page);

    // A newer format version: "update the app", not a mangled note.
    const newerPath = testInfo.outputPath('future.padify');
    writeFileSync(
      newerPath,
      JSON.stringify({
        type: 'padify-note',
        format: 99,
        note: { name: null, noteType: 'standard', content: 'x', createdAt: 0, updatedAt: 0 },
      }),
    );
    await page.locator('input.padify-open-input').setInputFiles(newerPath);
    await expect(page.locator('#toast')).toContainText('newer Padify');
    expect(await railCount(page)).toBe(before);

    // Junk with a familiar extension.
    const junkPath = testInfo.outputPath('junk.padify');
    writeFileSync(junkPath, 'just some text someone renamed');
    await page.locator('input.padify-open-input').setInputFiles(junkPath);
    await expect(page.locator('#toast')).toContainText('is not a Padify or Excalidraw file');
    expect(await railCount(page)).toBe(before);

    // A native drawing with embedded bitmaps — refused, not stripped.
    const imagesPath = testInfo.outputPath('with-images.excalidraw');
    writeFileSync(
      imagesPath,
      JSON.stringify({
        type: 'excalidraw',
        elements: [],
        files: { blob1: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' } },
      }),
    );
    await page.locator('input.padify-open-input').setInputFiles(imagesPath);
    await expect(page.locator('#toast')).toContainText('embedded images');
    expect(await railCount(page)).toBe(before);
  });
});
