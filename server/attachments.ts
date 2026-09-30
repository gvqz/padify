/**
 * Padify API — attachments: validation and shaping (the HTTP handlers
 * live in handlers.ts, same split as notes.ts).
 *
 * Attachments are user-scoped binary blobs — the foundation the voice
 * notes feature (and any future media note type) needs. The wire
 * contract:
 *
 *   POST /api/attachments        raw bytes as the body
 *                                x-padify-id    client-chosen id (required)
 *                                x-padify-name  filename (optional)
 *                                content-type   the mime type (optional)
 *   GET  /api/attachments        the caller's metas, no bytes
 *   GET  /api/attachments/:id    the bytes (binary body, ETag = sha256)
 *   DELETE /api/attachments/:id
 *
 * Bytes are stored base64 in a TEXT column (see schema.sql for why), so
 * the request body is decoded once and the stored form is opaque to the
 * db layer — one code path for bun:sqlite and Turso alike.
 */

import { createHash } from 'node:crypto';

/** Hard ceiling on the decoded size of one attachment, in bytes. */
export const MAX_ATTACHMENT_BYTES = 5_000_000;

/** Attachment ids are client-chosen; keep them tight and URL-safe. */
export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const MAX_NAME_CHARS = 200;
const MAX_MIME_CHARS = 100;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: number;
}

/** Normalizes an upload's id header → the id, or null when unusable. */
export function attachmentIdFrom(value: string | null): string | null {
  const id = (value ?? '').trim();
  return ATTACHMENT_ID_PATTERN.test(id) ? id : null;
}

/** Drops control characters (C0 + DEL) — never valid in a filename or type. */
function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

/**
 * Normalizes the filename header: trimmed, length-capped, control
 * characters stripped. The empty string is a valid "no name".
 */
export function attachmentNameFrom(value: string | null): string {
  return stripControlChars(value ?? '').trim().slice(0, MAX_NAME_CHARS);
}

/**
 * Normalizes the content-type header. Well-formed types — parameters
 * included, since they round-trip to the download — pass through; the
 * malformed and the missing fall back to the generic octet stream, so a
 * lie here only hurts the liar's own download.
 */
export function attachmentMimeFrom(value: string | null): string {
  const mime = stripControlChars(value ?? '').trim().toLowerCase().slice(0, MAX_MIME_CHARS);
  const base = mime.split(';', 1)[0] ?? '';
  return MIME_PATTERN.test(base) && mime.length > 0 ? mime : 'application/octet-stream';
}

/** SHA-256 of the bytes, hex — the dedupe key and the ETag. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The storable form of the bytes. */
export function encodeAttachmentData(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The servable form of the stored bytes. */
export function decodeAttachmentData(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** Shapes a DB row into the client-facing meta (never the bytes). */
export function attachmentMetaFromRow(row: Record<string, unknown>): AttachmentMeta | null {
  const { id, name, mime, size, sha256, created_at: createdAt } = row;
  if (typeof id !== 'string' || typeof sha256 !== 'string') {
    return null;
  }
  return {
    id,
    name: typeof name === 'string' ? name : '',
    mime: typeof mime === 'string' ? mime : 'application/octet-stream',
    size: typeof size === 'number' ? size : 0,
    sha256,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}
