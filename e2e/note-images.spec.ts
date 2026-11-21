/**
 * Note images, end-to-end: a real paste into the markdown source lands a
 * `padify-att:` reference in the note and the preview resolves it to a
 * blob: URL; the toolbar's image row inserts through the file chooser; a
 * reference with no bytes renders the missing placeholder — never a
 * broken-image glyph. The pixels are generated in the browser itself (a
 * canvas → data URL), so the paste carries a genuine decodable PNG and
 * the capture pipeline's downscale/WebP path runs for real.
 */
import { expect, test, type Page } from '@playwright/test';

/** A real PNG built in the page's own canvas — 640×400, one solid color. */
async function realPngBase64(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#4f6df5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
}

/** Dispatches a paste event carrying one file, the way an OS paste does.
 * The ClipboardEvent constructor does not reliably carry clipboardData
 * across engines, so the event is a plain Event with the DataTransfer
 * grafted on — the surface's handler reads `event.clipboardData?.files`
 * duck-typed, exactly what a native paste hands it. */
async function pasteFile(page: Page, selector: string, base64: string): Promise<void> {
  await page.evaluate(
    ([target, bytes]) => {
      const element = document.querySelector(target) as HTMLTextAreaElement;
      const transfer = new DataTransfer();
      const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      transfer.items.add(new File([raw], 'shot.png', { type: 'image/png' }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    },
    [selector, base64] as const,
  );
}

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

test.describe('note images', () => {
  test('a pasted screenshot becomes a reference, and the preview resolves it', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    const png = await realPngBase64(page);
    await pasteFile(page, '#note .markdown-source', png);

    // The capture wrote a tiny reference into the source — not pixels.
    // (The pipeline is async — decode, downscale, encode, store — so this
    // retries until the insert lands.)
    await expect(source).toHaveValue(/^!\[shot\]\(padify-att:att-[a-f0-9]{24}\)$/, {
      timeout: 10_000,
    });

    // The preview (250 ms debounce) resolved the reference to a blob URL —
    // the only way an <img> inside the app ever shows real bytes.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    await expect(page.locator('#note .markdown-preview img')).toHaveAttribute('src', /^blob:/, {
      timeout: 10_000,
    });
    // The placeholder marker is gone once the bytes arrived.
    await expect(page.locator('#note .markdown-preview img[data-padify-missing]')).toHaveCount(0);
  });

  test('a dropped file inserts the same way a paste does', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    const png = await realPngBase64(page);
    await page.evaluate(
      ([target, bytes]) => {
        const element = document.querySelector(target) as HTMLTextAreaElement;
        const transfer = new DataTransfer();
        const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
        transfer.items.add(new File([raw], 'dropped.png', { type: 'image/png' }));
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        element.dispatchEvent(event);
      },
      ['#note .markdown-source', png] as const,
    );

    await expect(source).toHaveValue(/^!\[dropped\]\(padify-att:att-[a-f0-9]{24}\)$/, {
      timeout: 10_000,
    });
  });

  test('the toolbar\u2019s image row opens the picker and inserts the picked file', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    const png = await realPngBase64(page);
    const buffer = Buffer.from(png, 'base64');

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#markdownToolbar [data-md-action="image"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles([{ name: 'picked.png', mimeType: 'image/png', buffer }]);

    await expect(source).toHaveValue(/!\[picked\]\(padify-att:att-[a-f0-9]{24}\)/);
  });

  test('a reference with no bytes renders the missing placeholder, not a broken glyph', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const source = page.locator('#note .markdown-source');
    await source.click();
    await source.fill('![ghost](padify-att:att-00000000000000000000)');
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();

    const ghost = page.locator('#note .markdown-preview img[data-padify-missing]');
    await expect(ghost).toHaveCount(1);
    // The raw reference stays in the src (nothing pretends it resolved)…
    await expect(ghost).toHaveAttribute('src', 'padify-att:att-00000000000000000000');
    // …and the alt text is the reader's label.
    await expect(ghost).toHaveAttribute('alt', 'ghost');
  });
});
