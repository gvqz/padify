/**
 * Padify API — request handlers and the router.
 *
 * Extracted from index.ts (which boots Bun.serve at import time and so can
 * never be imported by a test): everything between "read the request" and
 * "return the response" lives here as pure functions over (db, request, …).
 * index.ts keeps only the boot: create the database, apply the schema, and
 * wire Bun.serve's fetch to route(). The handlers are importable from
 * vitest (Node has the same fetch API globals) — see src/server-handlers.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { type Db, type SqlValue, type SqlStatement } from './db';
import { asInt, asString, parseNoteRows, parseNoteType } from './notes';
import {
  createSession,
  destroySession,
  hashPassword,
  userForRequest,
  verifyPassword,
  type SessionUser
} from './auth';
import { musicSearch, resolveTrackStream, resolveConfigured, searchConfigured } from './music';
import {
  attachmentIdFrom,
  attachmentMetaFromRow,
  attachmentMimeFrom,
  attachmentNameFrom,
  decodeAttachmentData,
  encodeAttachmentData,
  MAX_ATTACHMENT_BYTES,
  sha256Hex
} from './attachments';

export const MAX_BODY_BYTES = 2_000_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function corsHeaders(request: Request): Record<string, string> {
  const allowList = (process.env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin');
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
  if (origin && (allowList.includes('*') || allowList.includes(origin))) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

export function json(request: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // API bodies are JSON, never markup: never let a proxy or browser
      // sniff them into something executable, never let a cache serve a
      // stale answer to a signed-in reader.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': 'no-store',
      ...corsHeaders(request)
    }
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return null;
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, per key, in memory)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Buckets for keys that never come back would otherwise sit in the map for
// the lifetime of the process; sweep expired entries so memory stays flat
// on a long-lived always-data host.
const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
  for (const [key, entry] of authFailures) {
    if (entry.resetAt <= now) {
      authFailures.delete(key);
    }
  }
}, 5 * 60_000);
// Never keep a process alive for the sweeper (tests import this module).
;(rateSweep as unknown as { unref?: () => void }).unref?.();
rateSweep.unref?.();

/** Test hook — forget every bucket and lockout between tests. */
export function resetRateLimitsForTests(): void {
  rateBuckets.clear();
  authFailures.clear();
}

/**
 * The key a rate-limit bucket hangs on.
 *
 * x-forwarded-for is client-forgeable end to end: any hop that appends
 * instead of replacing lets a spoofed value ride the whole chain, and with
 * no proxy in front at all the header is just attacker text. The chain is
 * therefore only read when TRUST_PROXY_HOPS declares how many proxies in
 * front of this server are trusted to append truthful addresses — and the
 * value taken is the one the CLOSEST trusted proxy observed (rightmost
 * minus hops), never the first entry. With the default 0 nothing is
 * trusted and every caller shares the one 'local' bucket: over-strict,
 * never spoofable. Deployments behind the repo's Caddyfile (which sets
 * X-Forwarded-For to the address it actually saw) set TRUST_PROXY_HOPS=1
 * to get honest per-IP buckets back; see docs/CLOUD_SETUP.md.
 */
export function clientKey(request: Request): string {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
  if (Number.isFinite(hops) && hops > 0) {
    const forwarded = request.headers.get('x-forwarded-for');
    const parts = forwarded?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    const index = parts.length - Math.floor(hops);
    if (index >= 0 && index < parts.length) {
      return parts[index]!;
    }
  }
  return 'local';
}

export function rateLimited(
  request: Request,
  bucket: 'auth' | 'api' | 'music-search' | 'music-resolve' | 'share',
  subject?: string,
): boolean {
  const limits: Record<string, number> = {
    auth: 30,
    api: 300,
    'music-search': 60,
    'music-resolve': 30,
    share: 120
  };
  const limit = limits[bucket] ?? 300;
  // Authenticated traffic keys its bucket on the account, not the address:
  // a shared or spoofed IP then cannot pace someone else's requests, and
  // a signing-in stranger cannot get fresh buckets by rotating addresses.
  const key = subject ?? clientKey(request);
  const now = Date.now();
  const entry = rateBuckets.get(`${bucket}:${key}`);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(`${bucket}:${key}`, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

// ---------------------------------------------------------------------------
// Sign-in lockout — the brute-force defense that does not depend on
// addresses at all: failed verifications are counted PER ACCOUNT. A lockout
// outlives any IP rotation because it keys on the one thing the attacker
// cannot change: the account being guessed at.
// ---------------------------------------------------------------------------

const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
const AUTH_FAILURE_LIMIT = 8;
const authFailures = new Map<string, { count: number; resetAt: number }>();

/** True when this account burned through its failed-verification budget. */
function signinBlocked(email: string): boolean {
  const entry = authFailures.get(email);
  return !!entry && entry.resetAt > Date.now() && entry.count >= AUTH_FAILURE_LIMIT;
}

/** One more failed verification against this account. */
function recordSigninFailure(email: string): void {
  const now = Date.now();
  const entry = authFailures.get(email);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(email, { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** A successful sign-in clears the account's failure count. */
function clearSigninFailures(email: string): void {
  authFailures.delete(email);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  const email = asString(value).trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

export async function handleSignup(db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = asString(body.password);
  if (!email) {
    return json(request, { error: 'Enter a valid email address.' }, 400);
  }
  if (password.length < 6 || password.length > 200) {
    return json(request, { error: 'Password must be at least 6 characters.' }, 400);
  }

  const userId = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.run(
      'insert into users (id, email, password_hash, created_at) values (?, ?, ?, ?)',
      [userId, email, hashPassword(password), now]
    );
  } catch (err) {
    // UNIQUE violation on email — the schema's `email text not null unique`
    // constraint is the source of truth. Catching it here lets us return the
    // same generic "Wrong email or password" message the signin endpoint
    // returns, closing the email-enumeration vector the previous SELECT-then-
    // INSERT race had (an attacker could enumerate valid emails by observing
    // 409 vs 201). Also resolves the TOCTOU between the SELECT and INSERT.
    const message = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(message)) {
      return json(request, { error: 'Wrong email or password.' }, 401);
    }
    throw err;
  }
  const token = await createSession(db, userId);
  return json(request, { token, user: { id: userId, email } }, 201);
}

export async function handleSignin(db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = asString(body.password);
  if (!email || !password) {
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  // The lockout check runs before the scrypt verify: a locked account
  // costs the caller one cheap map lookup, not the expensive hash — the
  // brute-forcer's own budget is what gets spent, not the server's.
  if (signinBlocked(email)) {
    return json(request, { error: 'Too many failed attempts for this account — try again in a few minutes.' }, 429);
  }

  const rows = await db.all('select id, email, password_hash from users where email = ?', [email]);
  const user = rows[0];
  if (!user || !verifyPassword(password, String(user.password_hash))) {
    recordSigninFailure(email);
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  clearSigninFailures(email);

  const token = await createSession(db, String(user.id));
  return json(request, { token, user: { id: String(user.id), email: String(user.email) } });
}

export async function handleNotesGet(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const query = new URL(request.url).searchParams;

  // Sync v2: incremental pull. The client sends its last-seen sequence and
  // receives only what changed past it, plus the full position order (the
  // strip's convergence sort needs every note's place, not just the
  // changed ones'). Rows the seq-stamping builds have never written
  // (seq = 0 — the migration's default, or a v1-only server's history)
  // are delivered unconditionally, so a fresh v2 server never hides an
  // untouched row behind an old cursor.
  if (query.get('v') === '2') {
    const cursorParam = Number(query.get('cursor'));
    const cursor = Number.isFinite(cursorParam) && cursorParam > 0 ? Math.floor(cursorParam) : 0;

    const rows = await db.all(
      `select id, name, content, position, created_at, updated_at, deleted, note_type, seq
       from notes where user_id = ? and (seq > ? or seq = 0) order by seq asc`,
      [user.id, cursor]
    );
    const order = await db.all(
      `select id from notes where user_id = ? and deleted = 0 order by position asc`,
      [user.id]
    );
    const nextCursor = rows.reduce(
      (max, row) => Math.max(max, Number(row.seq) || 0),
      cursor
    );
    return json(request, {
      v: 2,
      rows: rows.map(row => ({
        id: String(row.id),
        name: row.name ?? null,
        content: row.content ?? '',
        position: Number(row.position) || 0,
        created_at: Number(row.created_at) || 0,
        updated_at: Number(row.updated_at) || 0,
        deleted: Number(row.deleted) === 1,
        note_type: row.note_type ?? null,
        seq: Number(row.seq) || 0
      })),
      // The full remote position order, by id — unchanged rows included.
      order: order.map(row => String(row.id)),
      // The client's next cursor: everything at or below this has been seen.
      cursor: nextCursor
    });
  }

  const rows = await db.all(
    `select id, user_id, name, content, position, created_at, updated_at, deleted, note_type
     from notes where user_id = ? order by position asc`,
    [user.id]
  );
  return json(request, {
    // Dual-key during the rename transition (see handleSharesGet): rows
    // built before the rename read `html`, everything after it reads
    // `content`, and a deploy gap must never blank a note on pull. V2
    // clients stop emitting the twin (their pulls answer through the v2
    // path above); v1 clients keep receiving it until every install has
    // crossed over.
    rows: rows.map(row => ({ ...row, html: row.content, deleted: Number(row.deleted) === 1 }))
  });
}

export async function handleNotesPut(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const rows = parseNoteRows(body.rows);
  if (!rows) {
    return json(request, { error: 'Invalid notes payload.' }, 400);
  }

  // Sync v2 stamping: every write reserves its batch's numbers from the
  // user's sequence counter in ONE atomic statement — fresh inserts and
  // conflict updates alike, so a re-push, a position drift and a delete
  // all surface to cursored pulls. The reservation is the sequence's only
  // authority: reserved numbers always advance (a batch whose writes never
  // land leaves a gap, never a repeat), and two racing pushes get
  // disjoint ranges — the read-max race this replaces could hand
  // identical numbers to two different versions, and a tie in seq is a
  // lie about which version is newer.
  const reserved = await db.all(
    `insert into sync_counters (user_id, value) values (?, ?)
     on conflict(user_id) do update set value = sync_counters.value + excluded.value
     returning value`,
    [user.id, rows.length]
  );
  let base = Number(reserved[0]?.value ?? 0) - rows.length;
  if (!Number.isFinite(base) || base < 0) {
    // A backend that cannot answer RETURNING (none of the two we ship,
    // but this handler must never stamp garbage): fall back to reading
    // the user's highest stamped seq — the old, racy base. Duplicates
    // under a lost race are recoverable; seq 0 on a conflict update is
    // an unconditional re-delivery on every pull.
    const seqRows = await db.all(
      'select coalesce(max(seq), 0) as base from notes where user_id = ?',
      [user.id]
    );
    base = Number(seqRows[0]?.base ?? 0) || 0;
  }

  // The owner comes from the session, never from the payload; the conflict
  // clause pins updates to rows the user already owns (no cross-user writes).
  // All rows go out as one batched write (single Turso pipeline request,
  // single local transaction) instead of one round-trip per row.
  await db.runMany(
    rows.map((row, index) => ({
      sql: `insert into notes (id, user_id, name, content, position, created_at, updated_at, deleted, note_type, seq)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         name = excluded.name,
         content = excluded.content,
         position = excluded.position,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted,
         note_type = excluded.note_type,
         seq = excluded.seq
       where notes.user_id = excluded.user_id`,
      args: [
        row.id,
        user.id,
        row.name,
        row.content,
        row.position,
        row.created_at,
        row.updated_at,
        row.deleted ? 1 : 0,
        row.note_type,
        base + index + 1
      ]
    }))
  );

  return json(request, { ok: true });
}

export async function handleSharesGet(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const rows = await db.all(
    `select token, note_id, title, content, created_at, expires_at, revoked
     from shares where user_id = ? order by created_at desc limit 200`,
    [user.id]
  );
  return json(request, {
    // The rename transition: every response carries the content under both
    // keys — rows and pages built before the rename read `html`, everything
    // after it reads `content`, and a deploy gap must never blank a share.
    rows: rows.map(row => ({
      ...row,
      html: row.content,
      revoked: Number(row.revoked) === 1
    }))
  });
}

// ---------------------------------------------------------------------------
// Attachments (the blob store — voice notes and future media). The wire
// contract and the base64-in-TEXT decision are documented in
// server/attachments.ts and schema.sql.
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

  const meta = {
    id,
    name: attachmentNameFrom(request.headers.get('x-padify-name')),
    mime: attachmentMimeFrom(request.headers.get('content-type'))
  };
  const createdAt = Date.now();
  await db.run(
    `insert into attachments (id, user_id, name, mime, size, sha256, data, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, meta.name, meta.mime, bytes.byteLength, sha256, encodeAttachmentData(bytes), createdAt]
  );
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
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
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

function createShareToken(): string {
  const bytes = randomBytes(18);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function handleSharesPost(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const noteId = asString(body.note_id).slice(0, 100) || null;
  const title = asString(body.title).slice(0, 200);
  const content = asString(body.content ?? body.html);
  const noteType = parseNoteType(body.note_type);
  const days = Math.min(3650, Math.max(1, asInt(body.days, 7)));

  const token = createShareToken();
  const now = Date.now();
  const expiresAt = now + days * DAY_MS;

  try {
    await db.run(
      `insert into shares (token, user_id, note_id, title, content, note_type, created_at, expires_at, revoked)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [token, user.id, noteId, title, content, noteType, now, expiresAt]
    );
  } catch {
    // Token collision (vanishingly rare) — ask the client to retry.
    return json(request, { error: 'Could not create the link. Try again.' }, 500);
  }

  return json(request, {
    row: { token, note_id: noteId, title, content, html: content, note_type: noteType, created_at: now, expires_at: expiresAt, revoked: false }
  }, 201);
}

export async function handleSharesPatch(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  // Revoke one link by token.
  const token = asString(body.token);
  if (token) {
    await db.run('update shares set revoked = 1 where token = ? and user_id = ?', [token, user.id]);
    return json(request, { ok: true });
  }

  // Revoke every link that points at the given notes (a note was closed).
  // Cap the input array — without an upper bound a 2 MB request body could
  // pack ~25,000 UUIDs into one IN-clause, producing a multi-megabyte SQL
  // statement that Turso rejects.
  const MAX_NOTE_IDS = 500;
  const noteIds = Array.isArray(body.note_ids)
    ? body.note_ids.map(id => asString(id)).filter(Boolean).slice(0, MAX_NOTE_IDS)
    : [];
  if (noteIds.length > 0) {
    const placeholders = noteIds.map(() => '?').join(', ');
    const args: SqlValue[] = [user.id, ...noteIds];
    await db.run(
      `update shares set revoked = 1 where user_id = ? and note_id in (${placeholders})`,
      args
    );
    return json(request, { ok: true });
  }

  // Refresh the denormalised content on still-active links (the note changed).
  // Cap at 100 entries; previously an attacker could pack thousands of refresh
  // items, each triggering a sequential DB round-trip (one HTTP fetch to Turso
  // per item) and locking the rate-limit slot for the full 30 s request budget.
  // Batched via runMany so the writes land in a single pipeline.
  const MAX_REFRESH = 100;
  const refresh = Array.isArray(body.refresh) ? body.refresh.slice(0, MAX_REFRESH) : [];
  const now = Date.now();
  const statements: SqlStatement[] = [];
  for (const entry of refresh) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const noteId = asString(item.note_id);
    if (!noteId) {
      continue;
    }
    statements.push({
      sql: `update shares set title = ?, content = ?, note_type = ?
            where user_id = ? and note_id = ? and revoked = 0 and expires_at > ?`,
      args: [asString(item.title).slice(0, 200), asString(item.content ?? item.html), parseNoteType(item.note_type), user.id, noteId, now]
    });
  }
  if (statements.length > 0) {
    await db.runMany(statements);
  }

  return json(request, { ok: true });
}

export async function handlePublicShareGet(db: Db, request: Request, token: string): Promise<Response> {
  const rows = await db.all(
    `select title, content, note_type, created_at, expires_at from shares
     where token = ? and revoked = 0 and expires_at > ?`,
    [token, Date.now()]
  );
  const row = rows[0];
  if (!row) {
    // Cancelled, expired and never-existed links are deliberately the same 404.
    return json(request, { error: 'This link is not available.' }, 404);
  }
  return json(request, {
    row: {
      title: row.title,
      // Dual-key during the rename transition — see handleSharesGet.
      content: row.content,
      html: row.content,
      note_type: row.note_type ?? null,
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at)
    }
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function route(db: Db, request: Request, pathname: string): Promise<Response> {
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // ---- public ---------------------------------------------------------------

  const publicShare = /^\/api\/share\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (publicShare && method === 'GET') {
    // Share tokens are unguessable, but the endpoint itself is public and
    // unauthenticated — cap the request rate so a scraper cannot hammer
    // the shares table (and the database behind it) through it.
    if (rateLimited(request, 'share')) {
      return json(request, { error: 'Too many requests — wait a moment and try again.' }, 429);
    }
    return handlePublicShareGet(db, request, publicShare[1]);
  }

  // ---- free music (public — this is the no-login path of the music player) --

  if (pathname === '/api/music/capabilities' && method === 'GET') {
    return json(request, { search: searchConfigured(), resolve: resolveConfigured() });
  }

  if (pathname === '/api/music/search' && method === 'GET') {
    if (rateLimited(request, 'music-search')) {
      return json(request, { error: 'Too many searches — wait a moment and try again.' }, 429);
    }
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    const limit = Math.min(30, Math.max(1, asInt(url.searchParams.get('limit'), 20)));
    if (q.length < 1) {
      return json(request, { error: 'Missing search query.' }, 400);
    }
    if (!searchConfigured()) {
      return json(request, {
        error: 'Free search is not configured on this server (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing).'
      }, 503);
    }
    try {
      const tracks = await musicSearch(q, limit);
      return json(request, { tracks });
    } catch {
      return json(request, { error: 'Search is temporarily unavailable — try again.' }, 502);
    }
  }

  if (pathname === '/api/music/resolve' && method === 'GET') {
    if (rateLimited(request, 'music-resolve')) {
      return json(request, { error: 'Too many requests — wait a moment and try again.' }, 429);
    }
    const url = new URL(request.url);
    const trackId = (url.searchParams.get('trackId') ?? '').trim();
    const title = (url.searchParams.get('title') ?? '').trim().slice(0, 200);
    const artist = (url.searchParams.get('artist') ?? '').trim().slice(0, 300);
    const durationMs = asInt(url.searchParams.get('durationMs'), 0);
    const fresh = url.searchParams.get('fresh') === '1';
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(trackId)) {
      return json(request, { error: 'Missing or invalid track id.' }, 400);
    }
    if (!title) {
      return json(request, { error: 'Missing track title.' }, 400);
    }
    if (!resolveConfigured()) {
      return json(request, {
        error: 'Free playback is not configured on this server (yt-dlp missing).'
      }, 503);
    }
    try {
      const stream = await resolveTrackStream(db, {
        key: trackId,
        title,
        artist,
        durationMs: durationMs > 0 ? durationMs : null,
        fresh
      });
      return json(request, stream);
    } catch (error) {
      const message = error instanceof Error && /timed out/.test(error.message)
        ? 'Resolving this song took too long — try again.'
        : 'Could not find a stream for this song.';
      return json(request, { error: message }, 404);
    }
  }

  if (pathname.startsWith('/api/music/') && method === 'GET') {
    return json(request, { error: 'Not found.' }, 404);
  }

  if (!pathname.startsWith('/api/')) {
    return json(request, { error: 'Not found.' }, 404);
  }

  // Liveness probe: 200 with no body worth reading. For the e2e config
  // (which waits on it before running a spec) and for any uptime monitor —
  // a 404-for-unknown-paths router cannot serve as its own probe.
  if (pathname === '/api/health' && method === 'GET') {
    return json(request, { ok: true });
  }

  // ---- auth (rate limited, no session needed) --------------------------------

  if (pathname === '/api/auth/signup' && method === 'POST') {
    if (rateLimited(request, 'auth')) {
      return json(request, { error: 'Too many attempts — wait a moment and try again.' }, 429);
    }
    return handleSignup(db, request);
  }

  if (pathname === '/api/auth/signin' && method === 'POST') {
    if (rateLimited(request, 'auth')) {
      return json(request, { error: 'Too many attempts — wait a moment and try again.' }, 429);
    }
    return handleSignin(db, request);
  }

  // ---- authenticated ----------------------------------------------------------

  const user = await userForRequest(db, request);

  // Keyed on the account when one is present (see rateLimited): signed-in
  // traffic cannot be paced by address games, and anonymous traffic falls
  // back to the client key — 'local' unless TRUST_PROXY_HOPS is set.
  if (rateLimited(request, 'api', user?.id)) {
    return json(request, { error: 'Too many requests — slow down a little.' }, 429);
  }

  const needsAuth = pathname !== '/api/auth/signout';
  if (!user) {
    if (needsAuth) {
      return json(request, { error: 'Not signed in.' }, 401);
    }
  }

  if (pathname === '/api/auth/signout' && method === 'POST') {
    await destroySession(db, request);
    return json(request, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET' && user) {
    return json(request, { user });
  }

  if (pathname === '/api/notes' && method === 'GET' && user) {
    return handleNotesGet(db, request, user);
  }

  if (pathname === '/api/notes' && method === 'PUT' && user) {
    return handleNotesPut(db, request, user);
  }

  if (pathname === '/api/shares' && method === 'GET' && user) {
    return handleSharesGet(db, request, user);
  }

  if (pathname === '/api/shares' && method === 'POST' && user) {
    return handleSharesPost(db, request, user);
  }

  if (pathname === '/api/shares' && method === 'PATCH' && user) {
    return handleSharesPatch(db, request, user);
  }

  // ---- attachments (the blob store) ---------------------------------------

  if (pathname === '/api/attachments' && method === 'GET' && user) {
    return handleAttachmentsList(db, request, user);
  }

  if (pathname === '/api/attachments' && method === 'POST' && user) {
    return handleAttachmentPost(db, request, user);
  }

  const attachment = /^\/api\/attachments\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
  if (attachment && method === 'GET' && user) {
    return handleAttachmentGet(db, request, user, attachment[1]);
  }

  if (attachment && method === 'DELETE' && user) {
    return handleAttachmentDelete(db, request, user, attachment[1]);
  }

  return json(request, { error: 'Not found.' }, 404);
}
