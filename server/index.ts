/**
 * Padify API — the cloud backend for the main page (notes + shares + auth).
 *
 * Run with bun:
 *   bun run dev    (watch mode, local SQLite file — zero setup)
 *   bun run start
 *
 * Production: set TURSO_DATABASE_URL (libsql://…) and TURSO_AUTH_TOKEN and
 * the exact same code stores everything in the Turso database. See
 * docs/CLOUD_SETUP.md.
 *
 * Surface (all JSON; authenticated routes take `Authorization: Bearer <token>`):
 *   POST /api/auth/signup   {email, password}          → {token, user}
 *   POST /api/auth/signin   {email, password}          → {token, user}
 *   POST /api/auth/signout  (auth)                     → {ok}
 *   GET  /api/me            (auth)                     → {user}
 *   GET  /api/notes         (auth)                     → {rows}
 *   PUT  /api/notes         (auth) {rows}              → {ok}
 *   GET  /api/shares        (auth)                     → {rows}
 *   POST /api/shares        (auth) {note_id,title,html,days} → {row}
 *   PATCH /api/shares       (auth) {token|note_ids|refresh}  → {ok}
 *   GET  /api/share/:token  (public)                   → {row} | 404
 *
 * Security notes:
 *  • Passwords are scrypt-hashed; sessions are stored hashed (see auth.ts).
 *  • The authenticated user id always comes from the session — client-supplied
 *    user ids are ignored, and note upserts are pinned to the owner.
 *  • Share tokens are generated server-side; the public viewer endpoint only
 *    returns rows that are neither revoked nor expired.
 *  • Small per-IP rate limits protect the auth endpoints.
 *
 * Free music surface (public, no session — see music.ts):
 *   GET /api/music/capabilities                       → {search, resolve}
 *   GET /api/music/search?q=&limit=                   → {tracks}
 *   GET /api/music/resolve?trackId=&title=&artist=…   → {url, videoId, …}
 */

import { randomBytes } from 'node:crypto';
import { applySchema, createDb, type Db, type SqlValue, type SqlStatement } from './db';
import {
  createSession,
  destroySession,
  hashPassword,
  userForRequest,
  verifyPassword,
  type SessionUser
} from './auth';
import {
  musicSearch,
  resolveTrackStream,
  resolveConfigured,
  searchConfigured,
  sweepMusicCache
} from './music';

const PORT = Number(process.env.PORT ?? 3041);
const MAX_BODY_BYTES = 2_000_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface RequestContext {
  origin: string | null;
}

function corsHeaders(request: Request): Record<string, string> {
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

function json(request: Request, data: unknown, status = 200): Response {
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
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

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, per IP, in memory)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Buckets for IPs that never come back would otherwise sit in the map for
// the lifetime of the process; sweep expired entries so memory stays flat
// on a long-lived always-data host.
const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}, 5 * 60_000);
rateSweep.unref?.();

function rateLimited(request: Request, bucket: 'auth' | 'api' | 'music-search' | 'music-resolve'): boolean {
  const limits: Record<string, number> = { auth: 30, api: 300, 'music-search': 60, 'music-resolve': 30 };
  const limit = limits[bucket] ?? 300;
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'local';
  const now = Date.now();
  const entry = rateBuckets.get(`${bucket}:${ip}`);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(`${bucket}:${ip}`, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: unknown): string | null {
  const email = asString(value).trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

async function handleSignup(db: Db, request: Request): Promise<Response> {
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

async function handleSignin(db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = asString(body.password);
  if (!email || !password) {
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  const rows = await db.all('select id, email, password_hash from users where email = ?', [email]);
  const user = rows[0];
  if (!user || !verifyPassword(password, String(user.password_hash))) {
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  const token = await createSession(db, String(user.id));
  return json(request, { token, user: { id: String(user.id), email: String(user.email) } });
}

async function handleNotesGet(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const rows = await db.all(
    `select id, user_id, name, html, position, created_at, updated_at, deleted, note_type
     from notes where user_id = ? order by position asc`,
    [user.id]
  );
  return json(request, {
    rows: rows.map(row => ({ ...row, deleted: Number(row.deleted) === 1 }))
  });
}

interface IncomingNoteRow {
  id: string;
  name: string | null;
  html: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  note_type: string | null;
}

function parseNoteRows(value: unknown): IncomingNoteRow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    return null;
  }
  const rows: IncomingNoteRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const id = asString(row.id);
    if (!id || id.length > 100) {
      return null;
    }
    rows.push({
      id,
      name: row.name === null || row.name === undefined ? null : asString(row.name).slice(0, 300),
      html: asString(row.html),
      position: asInt(row.position, 0),
      created_at: asInt(row.created_at, 0),
      updated_at: asInt(row.updated_at, 0),
      deleted: asBool(row.deleted),
      // Only known note kinds are stored; anything else = the default.
      note_type: row.note_type === 'rich' ? 'rich' : null
    });
  }
  return rows;
}

async function handleNotesPut(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const rows = parseNoteRows(body.rows);
  if (!rows) {
    return json(request, { error: 'Invalid notes payload.' }, 400);
  }

  // The owner comes from the session, never from the payload; the conflict
  // clause pins updates to rows the user already owns (no cross-user writes).
  // All rows go out as one batched write (single Turso pipeline request,
  // single local transaction) instead of one round-trip per row.
  await db.runMany(
    rows.map(row => ({
      sql: `insert into notes (id, user_id, name, html, position, created_at, updated_at, deleted, note_type)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         name = excluded.name,
         html = excluded.html,
         position = excluded.position,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted,
         note_type = excluded.note_type
       where notes.user_id = excluded.user_id`,
      args: [row.id, user.id, row.name, row.html, row.position, row.created_at, row.updated_at, row.deleted ? 1 : 0, row.note_type]
    }))
  );

  return json(request, { ok: true });
}

async function handleSharesGet(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const rows = await db.all(
    `select token, note_id, title, html, created_at, expires_at, revoked
     from shares where user_id = ? order by created_at desc limit 200`,
    [user.id]
  );
  return json(request, {
    rows: rows.map(row => ({ ...row, revoked: Number(row.revoked) === 1 }))
  });
}

function createShareToken(): string {
  const bytes = randomBytes(18);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleSharesPost(db: Db, request: Request, user: SessionUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const noteId = asString(body.note_id).slice(0, 100) || null;
  const title = asString(body.title).slice(0, 200);
  const html = asString(body.html);
  const days = Math.min(3650, Math.max(1, asInt(body.days, 7)));

  const token = createShareToken();
  const now = Date.now();
  const expiresAt = now + days * DAY_MS;

  try {
    await db.run(
      `insert into shares (token, user_id, note_id, title, html, created_at, expires_at, revoked)
       values (?, ?, ?, ?, ?, ?, ?, 0)`,
      [token, user.id, noteId, title, html, now, expiresAt]
    );
  } catch {
    // Token collision (vanishingly rare) — ask the client to retry.
    return json(request, { error: 'Could not create the link. Try again.' }, 500);
  }

  return json(request, {
    row: { token, note_id: noteId, title, html, created_at: now, expires_at: expiresAt, revoked: false }
  }, 201);
}

async function handleSharesPatch(db: Db, request: Request, user: SessionUser): Promise<Response> {
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
      sql: `update shares set title = ?, html = ?
            where user_id = ? and note_id = ? and revoked = 0 and expires_at > ?`,
      args: [asString(item.title).slice(0, 200), asString(item.html), user.id, noteId, now]
    });
  }
  if (statements.length > 0) {
    await db.runMany(statements);
  }

  return json(request, { ok: true });
}

async function handlePublicShareGet(db: Db, request: Request, token: string): Promise<Response> {
  const rows = await db.all(
    `select title, html, created_at, expires_at from shares
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
      html: row.html,
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at)
    }
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(db: Db, request: Request, pathname: string): Promise<Response> {
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // ---- public ---------------------------------------------------------------

  const publicShare = /^\/api\/share\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (publicShare && method === 'GET') {
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

  if (rateLimited(request, 'api')) {
    return json(request, { error: 'Too many requests — slow down a little.' }, 429);
  }

  const user = await userForRequest(db, request);
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

  return json(request, { error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const db = await createDb();
await applySchema(db);
await db.run('delete from sessions where expires_at <= ?', [Date.now()]);
await sweepMusicCache(db);

Bun.serve({
  port: PORT,
  // Memory guardrails for small always-on hosts: cap request bodies at the
  // runtime level (the default allows 128 MB to be buffered before any
  // handler runs) and keep Bun's development error pages (with stack traces)
  // out of responses. The handler already returns safe JSON errors itself.
  maxRequestBodySize: MAX_BODY_BYTES,
  development: false,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try {
      return await route(db, request, pathname);
    } catch (error) {
      console.error(`[padify-api] ${request.method} ${pathname} failed:`, error);
      return json(request, { error: 'Something went wrong on the server. Try again.' }, 500);
    }
  }
});

console.log(`[padify-api] listening on http://localhost:${PORT}`);
