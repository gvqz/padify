/**
 * Padify storage — attachments: the client half of the blob store
 * (server half in server/attachments.ts).
 *
 * Attachments are recorded offline-first: a recording lands in
 * IndexedDB immediately with uploaded=0, and the cloud layer
 * (cloud/attachments.ts) flushes the pending ones in the background.
 *
 * Records hold the raw bytes (ArrayBuffer) plus the mime type, not a
 * Blob object: structured-clone handling of Blobs varies by engine
 * while ArrayBuffers clone identically everywhere, and Blobs are cheap
 * to reconstruct at this module's boundary. The store is deliberately
 * NOT mirrored to localStorage, which cannot hold bytes at all.
 *
 * Degradation rule: when IndexedDB is unavailable (the storage layer
 * fell back to localStorage), writes report failure and reads report
 * nothing — callers must treat that as "this device cannot keep
 * attachments", not as a crash. Feature code should surface the
 * limitation at capture time, not at sync time.
 */

import { ATTACHMENTS_STORE, readAll, readOne, storageBackend, writeAll } from './idb';

/** The meta everyone sees; the bytes never leave this module's callers. */
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  /** 0 = waiting for upload, 1 = on the server. */
  uploaded: 0 | 1;
}

interface AttachmentRecord extends AttachmentMeta {
  bytes: ArrayBuffer;
}

/** A fresh client-chosen id, matching the server's shape (see its regex). */
export function newAttachmentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return (
    'att-' +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 24)
  );
}

/**
 * Stores an attachment locally as pending upload. Resolves false when
 * the storage layer is degraded (no IndexedDB) — the bytes are NOT kept
 * anywhere in that case.
 */
export async function putAttachment(
  meta: Omit<AttachmentMeta, 'uploaded' | 'createdAt'>,
  blob: Blob,
): Promise<boolean> {
  if (storageBackend() !== 'indexeddb') {
    return false;
  }
  try {
    const record: AttachmentRecord = {
      ...meta,
      size: blob.size,
      createdAt: Date.now(),
      uploaded: 0,
      bytes: await blob.arrayBuffer(),
    };
    await writeAll(ATTACHMENTS_STORE, [record], []);
    return true;
  } catch (error) {
    console.warn('[storage] attachment write failed', error);
    return false;
  }
}

/** The stored bytes as a Blob, or null when unknown or degraded. */
export async function getAttachmentBlob(id: string): Promise<Blob | null> {
  // Point lookup: records carry whole ArrayBuffers, so a store-wide scan
  // here would deserialize every attachment's bytes to play one.
  const record = await readOne<AttachmentRecord>(ATTACHMENTS_STORE, id);
  return record ? new Blob([record.bytes], { type: record.mime }) : null;
}

/** The stored bytes, or null — for the upload flush (no Blob needed). */
export async function getAttachmentBytes(id: string): Promise<ArrayBuffer | null> {
  const record = await readOne<AttachmentRecord>(ATTACHMENTS_STORE, id);
  return record?.bytes ?? null;
}

/** Every attachment's meta, newest first, bytes stripped. */
export async function listAttachmentMetas(): Promise<AttachmentMeta[]> {
  const rows = await readAll<AttachmentRecord>(ATTACHMENTS_STORE);
  return rows.map(({ bytes: _bytes, ...meta }) => meta).sort((a, b) => b.createdAt - a.createdAt);
}

/** The subset the upload flush has to push. */
export async function listPendingAttachments(): Promise<AttachmentMeta[]> {
  const metas = await listAttachmentMetas();
  return metas.filter((meta) => meta.uploaded === 0);
}

/** Marks an attachment as safely on the server. */
export async function markAttachmentUploaded(id: string): Promise<void> {
  const record = await readOne<AttachmentRecord>(ATTACHMENTS_STORE, id);
  if (!record || record.uploaded === 1) return;
  record.uploaded = 1;
  await writeAll(ATTACHMENTS_STORE, [record], []);
}

/** Removes the local record and bytes. */
export async function deleteAttachment(id: string): Promise<void> {
  await writeAll(ATTACHMENTS_STORE, [], [id]);
}

/** Removes every local record (sign-out / wipe flows, tests). */
export async function clearAttachments(): Promise<void> {
  const rows = await readAll<AttachmentRecord>(ATTACHMENTS_STORE);
  await writeAll(
    ATTACHMENTS_STORE,
    [],
    rows.map((row) => row.id),
  );
}

/** The meta of one record, or null. */
export async function getAttachmentMeta(id: string): Promise<AttachmentMeta | null> {
  const record = await readOne<AttachmentRecord>(ATTACHMENTS_STORE, id);
  if (!record) return null;
  const { bytes: _bytes, ...meta } = record;
  return meta;
}
