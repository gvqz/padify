/**
 * Padify cloud — the attachment flush (client → server), with its LEDGER.
 *
 * Push eagerly, pull lazily:
 *
 *  • Push: after every successful sync cycle, pending local attachments
 *    (uploaded=0 in the IDB store) go up one at a time. Uploads never
 *    block note sync — the flush is fire-and-forget from the cycle's
 *    point of view — and the flush never throws.
 *
 *    THE LEDGER is the difference between this and flush-and-hope: every
 *    id that does not reach the server is remembered with WHY it failed.
 *    TRANSIENT trouble (the network dropped, a 5xx, a rate limit) gets a
 *    per-id exponential backoff — 30 s doubling to a 15-minute ceiling —
 *    so a flaky connection retries itself on the cycle clock instead of
 *    waiting for a reload, while never burning a 5 MB request every 30
 *    seconds. POISON trouble (a 409 collision, a 413 over-cap, a 400 —
 *    requests that cannot succeed as-is, only user action or a reload
 *    changes their answer) is marked and skipped for the session, the
 *    old behavior. A success clears the id's entry. The server is
 *    idempotent per (id, sha256), so every retry after a dropped
 *    connection is free.
 *
 *    The ledger lives in memory on purpose: the IDB `uploaded` flag is
 *    the durable truth (what has reached the server), the ledger only
 *    paces THIS session's retries. A reload starts the schedule fresh,
 *    which the first post-cycle flush immediately re-learns.
 *
 *  • SEEING IT: the upload-pending chip (upload-chip.ts) listens on
 *    onAttachmentLedgerChanged and shows "n uploads pending" while any
 *    attachment has not reached the server — notes have seq-backed sync
 *    integrity and a status line; attachments get the same honesty.
 *    notifyAttachmentLedgerChanged() fires after every flush and after
 *    every new capture, so the chip is current even offline (nothing
 *    will upload until a cycle succeeds, and the chip says so).
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

/** How a single upload attempt ended — the ledger's whole vocabulary. */
type UploadOutcome = 'ok' | 'transient' | 'poison' | 'missing';

/**
 * The statuses whose answer cannot change without user action or a
 * reload: the bytes are over the server's cap, the id collides with
 * different bytes, the request itself is malformed, or the row is gone.
 * Auth trouble (401/403), rate limits (429), 5xx and network throws are
 * TRANSIENT — the session or the server may simply need a moment.
 */
const POISON_STATUS = new Set([400, 404, 409, 413]);

/** Transient backoff: 30 s, 60 s, 120 s … capped at 15 minutes. */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;

interface LedgerEntry {
  /** Failed attempts so far (transient only) — the backoff's exponent. */
  attempts: number;
  /** Epoch ms before which this id is not retried. */
  nextAttemptAt: number;
  /** A poison answer: no more retries this session, whatever the clock says. */
  poison: boolean;
}

const ledger = new Map<string, LedgerEntry>();

function scheduleRetry(id: string, poison: boolean): void {
  const entry = ledger.get(id) ?? { attempts: 0, nextAttemptAt: 0, poison: false };
  if (poison) {
    entry.poison = true;
    ledger.set(id, entry);
    return;
  }
  entry.attempts += 1;
  entry.nextAttemptAt =
    Date.now() + Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_CAP_MS);
  ledger.set(id, entry);
}

// ---------------------------------------------------------------------------
// The change signal — the chip's whole world model
// ---------------------------------------------------------------------------

type LedgerListener = () => void;
const ledgerListeners = new Set<LedgerListener>();

/**
 * Registers a listener for "the pending-upload picture may have changed"
 * — after every flush (uploads landed or re-scheduled) and after every
 * new capture. Returns the unsubscribe.
 */
export function onAttachmentLedgerChanged(listener: LedgerListener): () => void {
  ledgerListeners.add(listener);
  return () => ledgerListeners.delete(listener);
}

function notifyLedgerChanged(): void {
  for (const listener of ledgerListeners) {
    listener();
  }
}

/**
 * The signal's manual trigger — the capture path (note-images.ts) fires
 * it after a successful store, so a new pending upload joins the chip's
 * count without waiting for a sync cycle that may be minutes away (or
 * never come, while offline).
 */
export const notifyAttachmentLedgerChanged = notifyLedgerChanged;

let flushInFlight = false;

/**
 * Uploads every pending attachment whose ledger allows an attempt now.
 * Resolves with how many made it; never throws — attachment trouble must
 * not surface as sync errors.
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
      const entry = ledger.get(meta.id);
      if (entry?.poison) {
        continue;
      }
      if (entry && entry.nextAttemptAt > Date.now()) {
        continue; // backing off — a later cycle retries it
      }
      if ((await uploadOne(meta)) === 'ok') {
        uploaded++;
      }
    }
    return uploaded;
  } finally {
    flushInFlight = false;
    notifyLedgerChanged();
  }
}

async function uploadOne(meta: AttachmentMeta): Promise<UploadOutcome> {
  const bytes = await getAttachmentBytes(meta.id);
  if (!bytes) {
    // The record vanished (wiped mid-flush) — nothing to do. Not a
    // failure: no entry, and the record is gone from the store anyway.
    return 'missing';
  }
  try {
    const response = await apiRaw('/api/attachments', {
      method: 'POST',
      headers: {
        'x-padify-id': meta.id,
        // Header values are ByteStrings (Latin-1); a name with any
        // character above U+00FF — an imported .padify file's filename,
        // say — would THROW in fetch and poison the id for the session,
        // every session. Percent-encoded here, decoded server-side.
        'x-padify-name': encodeURIComponent(meta.name),
        'content-type': meta.mime,
      },
      body: bytes,
    });
    if (response.ok) {
      await markAttachmentUploaded(meta.id);
      ledger.delete(meta.id);
      return 'ok';
    }
    const poison = POISON_STATUS.has(response.status);
    // Anything else — 409 (same id, different bytes: a collision that
    // must never be papered over), 413 (over the server's cap: never
    // going to succeed) — is poison; the rest backs off and retries.
    scheduleRetry(meta.id, poison);
    console.warn(
      `[cloud] attachment upload ${poison ? 'rejected (no retry this session)' : `failed (backing off), status ${response.status}`}:`,
      meta.id,
    );
    return poison ? 'poison' : 'transient';
  } catch (error) {
    // Network trouble may be transient — the ledger says HOW long to
    // wait, and the next cycle pays the request only then.
    scheduleRetry(meta.id, false);
    console.warn('[cloud] attachment upload failed (backing off):', meta.id, error);
    return 'transient';
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

/** Test hooks — forget the session's ledger (and read it directly). */
export function resetAttachmentFlushForTests(): void {
  ledger.clear();
}

export function ledgerEntryForTests(id: string): LedgerEntry | null {
  return ledger.get(id) ?? null;
}
