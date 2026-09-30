/**
 * Padify cloud — the attachment flush (client → server).
 *
 * Push eagerly, pull lazily:
 *
 *  • Push: after every successful sync cycle, pending local attachments
 *    (uploaded=0 in the IDB store) go up one at a time. Uploads never
 *    block note sync — the flush is fire-and-forget from the cycle's
 *    point of view — and a failed upload is skipped for the rest of the
 *    session instead of burning a 5 MB request every 30 seconds. The
 *    server is idempotent per (id, sha256), so a retry after a dropped
 *    connection is free.
 *
 *  • Pull: other devices' attachments download on demand
 *    (fetchAttachment) — a long voice recording should not follow the
 *    user to every device they sign in on.
 */

import { apiRaw } from './api';
import {
  getAttachmentBytes,
  listPendingAttachments,
  markAttachmentUploaded,
  type AttachmentMeta,
} from '../storage/attachments';

/** Attachments that already failed this session — skipped until reload. */
const failedThisSession = new Set<string>();

let flushInFlight = false;

/**
 * Uploads every pending attachment. Resolves with how many made it;
 * never throws — attachment trouble must not surface as sync errors.
 */
export async function flushAttachmentUploads(): Promise<number> {
  if (flushInFlight) {
    return 0;
  }
  flushInFlight = true;
  try {
    const pending = await listPendingAttachments();
    let uploaded = 0;
    for (const meta of pending) {
      if (failedThisSession.has(meta.id)) {
        continue;
      }
      if (await uploadOne(meta)) {
        uploaded++;
      }
    }
    return uploaded;
  } finally {
    flushInFlight = false;
  }
}

async function uploadOne(meta: AttachmentMeta): Promise<boolean> {
  const bytes = await getAttachmentBytes(meta.id);
  if (!bytes) {
    // The record vanished (wiped mid-flush) — nothing to do.
    return false;
  }
  try {
    const response = await apiRaw('/api/attachments', {
      method: 'POST',
      headers: {
        'x-padify-id': meta.id,
        'x-padify-name': meta.name,
        'content-type': meta.mime,
      },
      body: bytes,
    });
    if (response.ok) {
      await markAttachmentUploaded(meta.id);
      return true;
    }
    // Anything else — 409 (same id, different bytes: a collision that
    // must never be papered over), 413 (over the server's cap: never
    // going to succeed), 4xx/5xx — is poison for this session.
    failedThisSession.add(meta.id);
    console.warn(`[cloud] attachment upload rejected (${response.status}):`, meta.id);
    return false;
  } catch (error) {
    // Network trouble may be transient, but not worth retrying every
    // cycle — the next session (or sign-in) picks it up.
    failedThisSession.add(meta.id);
    console.warn('[cloud] attachment upload failed:', meta.id, error);
    return false;
  }
}

/**
 * Downloads an attachment from the server on demand (the lazy pull).
 * Resolves null when it is unknown, gone, or the network says no.
 */
export async function fetchAttachment(id: string): Promise<Blob | null> {
  try {
    const response = await apiRaw(`/api/attachments/${encodeURIComponent(id)}`);
    if (!response.ok) {
      return null;
    }
    return await response.blob();
  } catch {
    return null;
  }
}

/** Test hook — forget the session's failures. */
export function resetAttachmentFlushForTests(): void {
  failedThisSession.clear();
}
