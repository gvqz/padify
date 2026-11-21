/**
 * Padify API — attachments: the blob store, HTTP handlers included.
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
import { type Db, type SqlStatement } from './db';
import { corsHeaders, json } from './http';
import type { SessionUser } from './auth';
// The one definition of the per-file byte ceiling (shared/wire.ts) —
// re-exported here so the route module's own importers stay put.
import { MAX_ATTACHMENT_BYTES } from '../shared/wire';
// The one attachment id shape — composed and tested from the wire's
// single definition (see shared/wire.ts, the id border).
import { ATTACHMENT_ID_PATTERN } from '../shared/wire';
// The reference grammar and the garbage verdict — the same spelling the
// client's local GC runs (shared/att-refs.ts), so a reference the
// renderer resolves is a reference every reader sees.
import {
  ATTACHMENT_ORPHAN_GRACE_MS,
  collectNoteAttachmentIds,
  orphanVerdicts,
} from '../shared/att-refs';
// The per-user attachment quotas — one home, one boundedness argument
// (quota.ts).
import { MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_BYTES } from './quota';

export { MAX_ATTACHMENT_BYTES };

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
 * Normalizes the filename header: percent-decoded (the client encodes
 * non-Latin-1 names — header values are ByteStrings), then trimmed,
 * length-capped, control characters stripped. The empty string is a
 * valid "no name". A raw name that happens to carry `%` sequences
 * decodes best-effort: a malformed escape falls back to the raw bytes.
 */
export function attachmentNameFrom(value: string | null): string {
  const raw = stripControlChars(value ?? '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding — an old client's raw name. Keep it.
  }
  return decoded.trim().slice(0, MAX_NAME_CHARS);
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleAttachmentsList(
  db: Db,
  request: Request,
  user: SessionUser
): Promise<Response> {
  const rows = await db.all(
    `select id, name, mime, size, sha256, created_at
     from attachments where user_id = ? order by created_at desc limit 1000`,
    [user.id]
  );
  const metas = rows
    .map((row) => attachmentMetaFromRow(row))
    .filter((meta): meta is NonNullable<typeof meta> => meta !== null);
  return json(request, { rows: metas });
}

export async function handleAttachmentPost(
  db: Db,
  request: Request,
  user: SessionUser
): Promise<Response> {
  const id = attachmentIdFrom(request.headers.get('x-padify-id'));
  if (!id) {
    return json(request, { error: 'Missing or invalid attachment id (x-padify-id).' }, 400);
  }

  // Cheap early exit when the client declares an over-cap length; the
  // measured check below is the one that counts.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_ATTACHMENT_BYTES) {
    return json(request, { error: 'Attachments are capped at 5 MB.' }, 413);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json(request, { error: 'Could not read the upload.' }, 400);
  }
  if (bytes.byteLength === 0) {
    return json(request, { error: 'Empty attachment.' }, 400);
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return json(request, { error: 'Attachments are capped at 5 MB.' }, 413);
  }

  const sha256 = sha256Hex(bytes);

  // Idempotent retries: the same (id, digest) is a success; the same id
  // with different bytes is a collision, never a silent overwrite.
  const existing = await db.all(
    'select sha256 from attachments where id = ? and user_id = ?',
    [id, user.id]
  );
  if (existing.length > 0) {
    if (String(existing[0]?.sha256) === sha256) {
      return json(request, { ok: true, id, duplicate: true });
    }
    return json(request, { error: 'That attachment id already has different bytes.' }, 409);
  }

  // Per-user quota: unlimited 5 MB uploads from one throwaway account
  // could fill a small host's storage single-handedly. 200 MB / 500
  // files is far beyond any real use and far below trouble. The
  // constants live in quota.ts with the race-boundedness note.
  const usageRows = await db.all(
    'select count(*) as files, coalesce(sum(size), 0) as bytes from attachments where user_id = ?',
    [user.id]
  );
  const usedBytes = Number(usageRows[0]?.bytes ?? 0) || 0;
  const usedFiles = Number(usageRows[0]?.files ?? 0) || 0;
  if (usedFiles + 1 > MAX_ATTACHMENT_COUNT || usedBytes + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
    return json(
      request,
      { error: 'Attachment storage is full — delete some recordings before uploading more.' },
      413
    );
  }

  const meta = {
    id,
    name: attachmentNameFrom(request.headers.get('x-padify-name')),
    mime: attachmentMimeFrom(request.headers.get('content-type'))
  };
  const createdAt = Date.now();
  try {
    await db.run(
      `insert into attachments (id, user_id, name, mime, size, sha256, data, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, user.id, meta.name, meta.mime, bytes.byteLength, sha256, encodeAttachmentData(bytes), createdAt]
    );
  } catch (error) {
    // Two tabs racing the same new id both passed the existence check
    // above; the loser's INSERT hit the primary key and surfaced as a
    // generic 500 (signup already handled exactly this shape). Re-read
    // and answer the duplicate question honestly.
    const raced = await db.all(
      'select sha256 from attachments where id = ? and user_id = ?',
      [id, user.id]
    );
    if (raced.length > 0 && String(raced[0]?.sha256) === sha256) {
      return json(request, { ok: true, id, duplicate: true });
    }
    console.error('[attachments] insert failed', id, error);
    return json(request, { error: 'Could not save the attachment. Try again.' }, 500);
  }
  return json(request, { ...meta, size: bytes.byteLength, sha256, createdAt }, 201);
}

export async function handleAttachmentGet(
  db: Db,
  request: Request,
  user: SessionUser,
  id: string
): Promise<Response> {
  const rows = await db.all(
    'select name, mime, sha256, data from attachments where id = ? and user_id = ?',
    [id, user.id]
  );
  if (rows.length === 0) {
    return json(request, { error: 'Not found.' }, 404);
  }
  const row = rows[0]!;
  const sha256 = String(row.sha256);

  // Attachments are immutable per id, so the digest is a perfect ETag.
  const etag = `"${sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, ...corsHeaders(request) } });
  }

  const bytes = decodeAttachmentData(String(row.data));
  const name = typeof row.name === 'string' && row.name ? row.name : 'attachment';
  const mime = typeof row.mime === 'string' && row.mime ? row.mime : 'application/octet-stream';
  // The stored mime is pattern-checked, not allow-listed (text/html
  // passes), and this raw Response carries none of the json() helper's
  // security headers — an owner-uploaded HTML attachment opened inline
  // executes same-origin script. Disposition: attachment (download),
  // plus an explicit nosniff for the belt-and-braces.
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      etag,
      'cache-control': 'private, max-age=31536000, immutable',
      ...corsHeaders(request)
    }
  });
}

export async function handleAttachmentDelete(
  db: Db,
  request: Request,
  user: SessionUser,
  id: string
): Promise<Response> {
  // Idempotent by design — deleting an already-deleted id is a success.
  await db.run('delete from attachments where id = ? and user_id = ?', [id, user.id]);
  return json(request, { ok: true });
}

// ---------------------------------------------------------------------------
// The orphan sweep — the store's janitor (H6)
// ---------------------------------------------------------------------------

/** The scope-internal empty set (a user with no notes references nothing). */
const NO_REFERENCES: ReadonlySet<string> = new Set();

/**
 * Deletes the attachments no note references anymore — with a grace
 * window, not a guillotine.
 *
 * THE RULE is shared/att-refs.ts's orphanVerdicts, the same one the
 * client's local GC runs: an attachment referenced by any of its
 * owner's notes (live OR trashed — a restore must find its images) has
 * any grace clock forgotten; one the sweep sees unreferenced for the
 * FIRST time gets the clock stamped (never deleted this pass); one
 * unreferenced past ATTACHMENT_ORPHAN_GRACE_MS is garbage.
 *
 * THE PROMISE the grace buys: a file referenced only by an unsynced
 * second device does not die under this server's broom. The clock
 * starts only when the unreferenced state has REACHED the server (the
 * removal was pushed); a device that reconnects inside the window and
 * pushes its older, referencing copy resets the clock on the next sweep.
 *
 * REFERENCES are read per user and never across users: user A's notes
 * are not evidence that user B's attachment is live (ids are globally
 * unique, but the scoping is the honest reading, not the collision
 * odds). Shares are deliberately NOT tenants — their content is a
 * denormalised snapshot whose images render placeholders today (see
 * the NOW queue's share-links item; that feature will extend the
 * tenant set when it lands).
 *
 * THE COST, stated: one full scan of notes (content included) plus one
 * of the attachments table per pass. Hourly is far tighter than the
 * 7-day window needs, and both scans stay comfortably inside the free
 * tier — the same trade the seq-backfill migrations already accept.
 * The reads never touch `data` (the bytes): judging tenants costs
 * metadata, not blobs.
 */
export async function sweepOrphanAttachments(db: Db, now: number = Date.now()): Promise<number> {
  const noteRows = await db.all('select user_id, content, note_type from notes');
  const refsByUser = new Map<string, Set<string>>();
  for (const row of noteRows) {
    const userId = String(row.user_id ?? '');
    if (!userId) {
      continue;
    }
    const ids = collectNoteAttachmentIds({
      content: typeof row.content === 'string' ? row.content : '',
      noteType: typeof row.note_type === 'string' ? row.note_type : null,
    });
    if (ids.length === 0) {
      continue;
    }
    let refs = refsByUser.get(userId);
    if (!refs) {
      refs = new Set<string>();
      refsByUser.set(userId, refs);
    }
    for (const id of ids) {
      refs.add(id);
    }
  }

  const attachmentRows = await db.all('select id, user_id, orphan_since from attachments');
  const entriesByUser = new Map<string, Array<{ id: string; orphanSince: number | null }>>();
  for (const row of attachmentRows) {
    const userId = String(row.user_id ?? '');
    const id = typeof row.id === 'string' ? row.id : '';
    if (!userId || !id) {
      continue;
    }
    let entries = entriesByUser.get(userId);
    if (!entries) {
      entries = [];
      entriesByUser.set(userId, entries);
    }
    entries.push({ id, orphanSince: typeof row.orphan_since === 'number' ? row.orphan_since : null });
  }

  const clearClock: string[] = [];
  const stampClock: Array<{ id: string; since: number }> = [];
  const garbage: string[] = [];
  for (const [userId, entries] of entriesByUser) {
    const verdicts = orphanVerdicts(
      entries,
      refsByUser.get(userId) ?? NO_REFERENCES,
      now,
      ATTACHMENT_ORPHAN_GRACE_MS
    );
    clearClock.push(...verdicts.clearClock);
    for (const id of verdicts.stampClock) {
      stampClock.push({ id, since: now });
    }
    garbage.push(...verdicts.garbage);
  }

  if (clearClock.length + stampClock.length + garbage.length > 0) {
    // One batch for the whole pass: three statement shapes, all
    // idempotent, none order-dependent (stamps and clears touch
    // disjoint rows from deletes — a row is never stamped and deleted
    // in the same verdict).
    const statements: SqlStatement[] = [
      ...clearClock.map((id): SqlStatement => ({
        sql: 'update attachments set orphan_since = null where id = ?',
        args: [id]
      })),
      ...stampClock.map(({ id, since }): SqlStatement => ({
        sql: 'update attachments set orphan_since = ? where id = ?',
        args: [since, id]
      })),
      ...garbage.map((id): SqlStatement => ({
        sql: 'delete from attachments where id = ?',
        args: [id]
      }))
    ];
    await db.runMany(statements);
  }
  return garbage.length;
}
