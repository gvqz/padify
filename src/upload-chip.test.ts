import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageForTests, storageReady } from './storage';
import { clearAttachments, listPendingAttachments, putAttachment, newAttachmentId } from './storage/attachments';
import { notifyAttachmentLedgerChanged, onAttachmentLedgerChanged } from './cloud/attachments';
import { initUploadChip } from './upload-chip';

/**
 * The upload-pending chip's contract, beside the offline chip's: visible
 * exactly while an attachment on this device has not reached the server,
 * counting them honestly, updating on the ledger's change signal (the
 * flush after a cycle and the capture in the editor), and inert when the
 * markup is absent (the markup contract owns the chip's presence).
 */

const chip = () => document.getElementById('uploadChip')!;
const text = () => document.getElementById('uploadChipText')!;

function mount(): void {
  document.body.innerHTML =
    '<div class="bottom-line"><span id="uploadChip" class="offline-chip upload-chip" hidden>' +
    '<span id="uploadChipText"></span></span></div>';
}

async function addPending(name: string): Promise<void> {
  const id = newAttachmentId();
  const stored = await putAttachment({ id, name, mime: 'image/png', size: 10 }, new Blob(['x']));
  expect(stored).toBe(true);
}

describe('the upload chip', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
    await clearAttachments();
    mount();
  });

  afterEach(() => {
    resetStorageForTests();
    document.body.innerHTML = '';
  });

  it('starts hidden with nothing pending and shows the count when a capture lands', async () => {
    initUploadChip();
    expect(chip().hidden).toBe(true);

    await addPending('shot.png');
    notifyAttachmentLedgerChanged();
    await vi.waitFor(() => expect(chip().hidden).toBe(false));
    expect(text().textContent).toBe('1 upload pending');

    await addPending('second.png');
    notifyAttachmentLedgerChanged();
    await vi.waitFor(() => expect(text().textContent).toBe('2 uploads pending'));
  });

  it('the count reads the STORE, not the flush outcome — a capture offline is seen', async () => {
    // No flush ever runs here; the capture's own notify carries the news.
    initUploadChip();
    await addPending('offline-shot.png');
    notifyAttachmentLedgerChanged();
    await vi.waitFor(() => expect(chip().hidden).toBe(false));
  });

  it('hides again once nothing is pending', async () => {
    initUploadChip();
    await addPending('soon-gone.png');
    notifyAttachmentLedgerChanged();
    await vi.waitFor(() => expect(chip().hidden).toBe(false));

    // The flush marking it uploaded shrinks the pending list to zero —
    // the signal still fires (outcome regardless), the chip reads the store.
    const pending = await listPendingAttachments();
    expect(pending).toHaveLength(1);
    const { markAttachmentUploaded } = await import('./storage/attachments');
    await markAttachmentUploaded(pending[0]!.id);
    notifyAttachmentLedgerChanged();
    await vi.waitFor(() => expect(chip().hidden).toBe(true));
  });

  it('is inert when the markup is absent', async () => {
    document.body.innerHTML = '';
    initUploadChip(); // must not throw
    // The listener still registered — the signal fires into the void.
    let fired = 0;
    const off = onAttachmentLedgerChanged(() => fired++);
    notifyAttachmentLedgerChanged();
    expect(fired).toBe(1);
    off();
  });
});
