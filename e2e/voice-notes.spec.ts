/**
 * Voice notes, end-to-end: the rich note's mic records through Chromium's
 * fake media device (a real MediaRecorder producing real audio bytes),
 * the take stores as an attachment, and the card lands in the note as the
 * storage subset's `<audio src="padify-att:…">` form — wired, labeled
 * with the capture-time duration, and gone again after one undo.
 *
 * The fake device (`--use-fake-device-for-media-stream`) generates a real
 * audio tone, so the capture pipeline's chunks, cap check, store write
 * and card insert all run for real; the fake UI flag auto-grants the mic
 * permission the way a user's "Allow" click would.
 */
import { expect, test } from '@playwright/test';

// Chromium's fake media: the mic permission auto-grants and the device
// streams a real generated tone, so MediaRecorder produces real bytes.
// Top-level (a describe group would force a new worker).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test.describe('voice notes', () => {
  async function newRichNote(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#addTabTypeMenu').click();
    await page
      .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
      .click();
    await expect(page.locator('#richToolbar')).toBeVisible();
  }

  test('a recording becomes a voice card in the note', async ({ page }) => {
    await page.goto('/');
    await newRichNote(page);

    // Park the caret in the note, then open the session from the toolbar.
    await page.locator('#note').click();
    await page.locator('#richToolbar [data-rich-action="voice"]').click();

    // The bar is up and counting; the fake device is already talking.
    const bar = page.locator('#voiceRecordBar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#voiceRecordTime')).not.toHaveText('0:00', {
      timeout: 5_000,
    });

    // Keep the take: assemble → cap → store → insert. The bar closes.
    await page.locator('#voiceRecordStop').click();
    await expect(bar).toBeHidden({ timeout: 10_000 });

    // The card: the storage subset's exact shape, wrapped as an atom, and
    // honest about its length (a little over half a second of tone).
    const wrapper = page.locator('#note figure.padify-voice');
    await expect(wrapper).toHaveCount(1, { timeout: 10_000 });
    const card = page.locator('#note audio[src^="padify-att:"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('src', /^padify-att:att-[a-f0-9]{24}$/);
    // Capture-time duration in ms — anything from the 300 ms keep-floor up.
    await expect(card).toHaveAttribute('data-duration', /^\d{3,}$/);
    await expect(wrapper).toHaveAttribute('contenteditable', 'false');
    await expect(wrapper).not.toHaveAttribute('data-padify-missing', /.*/, {
      timeout: 10_000,
    });
    const durationLabel = await wrapper.locator('.padify-voice-time').textContent();
    expect(durationLabel ?? '').toMatch(/^0:00 \/ \d+:\d{2}$/);

    // The bytes are really in the store: the attachment layer answers
    // with the recorded take (this is the same IDB store the upload
    // flush reads).
    const stored = await page.evaluate(async () => {
      const { listAttachmentMetas } = await import('/src/storage/attachments.ts');
      const metas = await listAttachmentMetas();
      return metas.find((meta) => meta.mime.startsWith('audio/')) ?? null;
    });
    expect(stored).not.toBeNull();
    expect(stored?.size).toBeGreaterThan(0);
    expect(stored?.name).toContain('Voice recording');
  });

  test('one undo takes the card back out', async ({ page }) => {
    // Fresh context, fresh recording — then the card lands and one undo
    // (the insert is one history group of its own, exactly like an
    // equation) is the whole removal.
    await page.goto('/');
    await newRichNote(page);
    await page.locator('#note').click();
    await page.locator('#richToolbar [data-rich-action="voice"]').click();
    await expect(page.locator('#voiceRecordBar')).toBeVisible();
    await page.waitForTimeout(1_100);
    await page.locator('#voiceRecordStop').click();

    const wrapper = page.locator('#note figure.padify-voice');
    await expect(wrapper).toHaveCount(1, { timeout: 10_000 });

    await page.locator('#note').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('#note audio[src^="padify-att:"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(wrapper).toHaveCount(0);
  });
});
