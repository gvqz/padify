/**
 * The upload-pending chip — the status bar's second honest flag.
 *
 * Notes have seq-backed sync integrity and a status line that says so;
 * attachments had flush-and-hope — an image that never reached the
 * server was invisible forever. The chip closes that gap in the same
 * voice as the offline chip beside it (same capsule, same quietness): it
 * appears while any attachment on this device has not reached the sync
 * server and counts them — "2 uploads pending".
 *
 * The truth it renders is the IDB store's `uploaded` flags (the durable
 * answer to "what has NOT reached the server"), read fresh on every
 * signal; the flush's retry ledger only paces attempts, it never lies to
 * this chip. Updates ride cloud/attachments.ts's change signal — after
 * every flush and every new capture — so the count is current even
 * offline, where nothing can upload and the chip says exactly that by
 * existing. Deliberately auth-blind: an upload pending while signed out
 * is still the truth (the bytes are only here), and the tooltip says
 * when it will leave.
 */

import { onAttachmentLedgerChanged } from './cloud/attachments';
import { listPendingAttachments } from './storage/attachments';

export function initUploadChip(): void {
  const chip = document.getElementById('uploadChip');
  if (!chip) {
    return;
  }
  const text = document.getElementById('uploadChipText');

  const refresh = async (): Promise<void> => {
    const pending = await listPendingAttachments();
    if (pending.length === 0) {
      chip.hidden = true;
      return;
    }
    if (text) {
      text.textContent =
        pending.length === 1 ? '1 upload pending' : `${pending.length} uploads pending`;
    }
    chip.hidden = false;
  };

  onAttachmentLedgerChanged(() => {
    void refresh();
  });
  void refresh();
}
