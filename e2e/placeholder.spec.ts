import { expect, test, type Page } from '@playwright/test';

/**
 * The empty-state placeholder: an empty note paints it, readable content
 * takes it away. The subtle half is the second clause — the surface's
 * ELEMENT shape cannot answer it. CSS structural pseudo-classes count
 * elements only, so the pre-fix selector (:has(> br:only-child)) matched
 * a surface holding "text + br" too: a legacy note (older builds stored
 * their soft breaks as brs) opened with the placeholder painted over
 * the user's typed words, pushing them a line down. #note[data-empty]
 * is the engine's text-aware mirror (model-port.ts); these specs pin
 * the states a user actually hits.
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

async function createRichNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect(page.locator('#richToolbar')).toBeVisible();
}

/**
 * Drains the app's save pipeline deterministically: captures the live
 * editor into the model, persists immediately (no 500+400ms debounce
 * roulette), and waits for the IndexedDB write to settle. Tests that
 * then rewrite the stored row by hand can do so without the page's
 * pagehide flush re-persisting the stale model over their edit.
 */
async function settleSaves(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tabs = (await import('/src/tabs.ts')) as typeof import('/src/tabs.ts');
    tabs.getTabManager()?.syncAfterExternalEdit();
    const storage =
      (await import('/src/storage/index.ts')) as typeof import('/src/storage/index.ts');
    await storage.whenNotesIdle();
  });
}

/** True when #note's placeholder pseudo-element is painted. */
const placeholderPainted = (page: Page): Promise<boolean> =>
  page.locator('#note').evaluate((node) => getComputedStyle(node, '::before').content !== 'none');

test.describe('the empty-state placeholder', () => {
  test('an empty note paints it; typing takes it away; deleting everything brings it back', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    const editor = page.locator('#note');
    await expect(editor).toHaveAttribute('data-empty', ''); // bare presence

    await editor.click();
    await page.keyboard.type('hello world');
    await expect(editor).not.toHaveAttribute('data-empty', '');
    await expect.poll(() => placeholderPainted(page)).toBe(false);

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect.poll(() => editor.evaluate((n) => n.innerHTML)).toBe('');
    await expect(editor).toHaveAttribute('data-empty', '');
    await expect.poll(() => placeholderPainted(page)).toBe(true);
  });

  test('THE GLITCH: a legacy "text + br" note opens without the placeholder over its text', async ({
    page,
  }) => {
    await page.goto('/');
    await createRichNote(page);

    // Seed the note so it persists, then rewrite its stored content the
    // way a pre-fix build stored a line break next to text (today's
    // engine stores the newline as text — legacy notes carry the br).
    await page.locator('#note').click();
    await page.keyboard.type('seed');
    await settleSaves(page);
    await page.evaluate(async () => {
      const request = indexedDB.open('padify');
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = database.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const all: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
        const read = store.getAll();
        read.onsuccess = () => resolve(read.result as Array<Record<string, unknown>>);
        read.onerror = () => reject(read.error);
      });
      const rich = all.find((row) => row.noteType === 'rich') as Record<string, unknown>;
      rich.content = 'fffffffffffff<br>second line';
      delete rich.html; // the loader reads content ?? html — content wins
      store.put(rich);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    });

    await page.reload();
    await expect(page.locator('#richToolbar')).toBeVisible();

    const editor = page.locator('#note');
    await expect
      .poll(() => editor.evaluate((n) => n.innerHTML))
      .toBe('fffffffffffff<br>second line');
    // The br is still the surface's only ELEMENT child — exactly the
    // shape the old CSS selector tripped on. The mirror must not be.
    await expect(editor).not.toHaveAttribute('data-empty', '');
    await expect.poll(() => placeholderPainted(page)).toBe(false);

    // And the text sits on the first line — no block placeholder above it.
    const textTop = await editor.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().top;
    });
    const contentEdge = await editor.evaluate(
      (node) => node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).paddingTop),
    );
    expect(Math.abs(textTop - contentEdge)).toBeLessThan(5);

    // Deleting the note empty returns the placeholder.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect.poll(() => placeholderPainted(page)).toBe(true);
  });

  test('a stored bare br still collapses and paints it', async ({ page }) => {
    // The load path normalizes the legacy empty state to truly empty —
    // the placeholder answers the normalized surface, not the stored br.
    await page.goto('/');
    await createRichNote(page);
    await page.locator('#note').click();
    await page.keyboard.type('seed');
    await settleSaves(page);
    await page.evaluate(async () => {
      const request = indexedDB.open('padify');
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = database.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const all: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
        const read = store.getAll();
        read.onsuccess = () => resolve(read.result as Array<Record<string, unknown>>);
        read.onerror = () => reject(read.error);
      });
      const rich = all.find((row) => row.noteType === 'rich') as Record<string, unknown>;
      rich.content = '<br>';
      delete rich.html;
      store.put(rich);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    });

    await page.reload();
    await expect(page.locator('#richToolbar')).toBeVisible();
    const editor = page.locator('#note');
    await expect.poll(() => editor.evaluate((n) => n.innerHTML)).toBe('');
    await expect(editor).toHaveAttribute('data-empty', '');
    await expect.poll(() => placeholderPainted(page)).toBe(true);
  });
});
