/**
 * Padify API — share links (the /api/shares family).
 *
 * A share is a denormalised READ-ONLY copy of a note at an unguessable
 * token URL, with a chosen expiry and instant revocation. The copy is
 * refreshed by the owner's client while the note is edited, so the
 * public endpoint never joins against notes — anonymous readers cost one
 * indexed lookup on the shares table and nothing else.
 *
 * The wire shape carries the note body under both `content` and `html`
 * during the storage rename transition; see handleSharesGet.
 */

import { randomBytes } from 'node:crypto';
import { type Db, type SqlValue, type SqlStatement } from './db';
import { json, readJson } from './http';
import type { SessionUser } from './auth';
import { asInt, asString, parseNoteType } from './notes';
// The PATCH input caps, defined once where the contract lives — the
// client chunks its lists on the same numbers (shared/wire.ts).
import { MAX_SHARE_PATCH_NOTE_IDS, MAX_SHARE_REFRESH_ENTRIES } from '../shared/wire';

const DAY_MS = 86_400_000;

/**
 * Per-account ceiling on LIVE share bytes. The row cap bounds COUNT, but
 * each row carries a full denormalized copy of the note — 200 live rows
 * at the 2 MB body ceiling was 400 MB per account, 16x the notes quota,
 * on hosts whose whole budget is 128 MB. Refresh updates count against
 * the same budget, as deltas (shrinking a big row frees room).
 */
const SHARE_BYTES_QUOTA = 10 * 1024 * 1024;

/** Measures UTF-8 bytes — the unit the share budget counts in. */
const utf8 = new TextEncoder();

/** Live-row byte total for the account — the storage the user perceives. */
async function liveShareBytes(db: Db, userId: string, now: number): Promise<number> {
  const rows = await db.all(
    `select coalesce(sum(length(cast(content as blob))), 0) as total
       from shares where user_id = ? and revoked = 0 and expires_at > ?`,
    [userId, now]
  );
  return Number(rows[0]?.total ?? 0) || 0;
}

/**
 * Tokens are drawn from a confusable-free alphabet: no 0/O/Q, 1/I/l,
 * 2/Z, 5/S, 6/G, 8/B, 9/g, and no lowercase at all — a link read aloud,
 * scribbled down, screenshotted at small sizes or retyped by a human
 * cannot silently mutate into a different valid-looking token (the
 * production share dialog renders at small monospace, where Q/0 and 5/S
 * are genuinely hard to tell apart). 24 characters of this 21-symbol
 * alphabet is ~105 bits of entropy — brute force is not a thing at the
 * share bucket's rate limit. Pre-existing tokens keep working unchanged:
 * lookup is by exact string, only minting changes.
 */
const TOKEN_ALPHABET = '347ACDEFHJKMNPRTUVWXY';
const TOKEN_LENGTH = 24;
/**
 * Rejection-sampling cut-off, DERIVED from the alphabet size — never
 * hardcoded: 256 is a multiple of no alphabet but a power of two, so
 * bytes at or above 256 - (256 % size) would weight the first
 * (256 % size) symbols once reduced modulo the size. Deriving the band
 * keeps the draw uniform no matter how TOKEN_ALPHABET is edited later —
 * the band this replaces was hardcoded 240, which is uniform only for a
 * 20-symbol alphabet; with these 21 symbols it biased the first nine
 * ~9% over the rest (harmless for entropy, wrong for the claim).
 */
const TOKEN_BYTE_LIMIT = 256 - (256 % TOKEN_ALPHABET.length);

export function createShareToken(): string {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    const bytes = randomBytes(TOKEN_LENGTH * 2);
    for (const byte of bytes) {
      // Rejection band — see TOKEN_BYTE_LIMIT: bytes at or above it
      // would weight the alphabet's head once reduced modulo its size.
      if (byte >= TOKEN_BYTE_LIMIT) {
        continue;
      }
      if (token.length >= TOKEN_LENGTH) {
        break;
      }
      token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    }
  }
  return token;
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

  // An empty note is not shareable — the link would hand a reader a blank
  // page. Html kinds are blank when their tag-stripped text is blank (a
  // bare <p></p> or <br> is emptiness wearing markup); every other kind
  // is stored raw, so blank means blank. The client refuses the create
  // first; this is the contract the wire keeps on its own.
  const htmlLike = noteType === null || noteType === 'standard' || noteType === 'rich';
  const readable = (htmlLike ? content.replace(/<[^>]*>/g, '') : content).trim();
  if (readable === '') {
    return json(
      request,
      { error: 'This note is empty — write something before sharing it.' },
      400
    );
  }

  // One active link per note — the contract the client's panel already
  // follows (its create button becomes an expiry update when a link is
  // out). Enforced here so a stale client, a second tab or a racing
  // double-click can never mint a twin: a create for a note that has a
  // live link returns that link unchanged (200, `existing: true`), and
  // any further duplicates an older build left behind are revoked so
  // the note converges to exactly one. Checked BEFORE the live cap —
  // returning an existing row adds no storage, the cap must not block
  // the idempotent answer.
  if (noteId) {
    const now = Date.now();
    const actives = await db.all(
      `select token, note_id, title, content, note_type, created_at, expires_at, revoked
       from shares
       where user_id = ? and note_id = ? and revoked = 0 and expires_at > ?
       order by created_at desc`,
      [user.id, noteId, now]
    );
    if (actives.length > 0) {
      const keeper = actives[0];
      if (actives.length > 1) {
        const staleTokens = actives.slice(1).map(row => String(row.token));
        const placeholders = staleTokens.map(() => '?').join(', ');
        await db.run(
          `update shares set revoked = 1, revoked_at = ? where user_id = ? and token in (${placeholders})`,
          [now, user.id, ...staleTokens]
        );
      }
      return json(request, {
        existing: true,
        row: {
          token: String(keeper.token),
          note_id: keeper.note_id,
          title: keeper.title,
          content: keeper.content,
          html: keeper.content,
          note_type: keeper.note_type ?? null,
          created_at: Number(keeper.created_at),
          expires_at: Number(keeper.expires_at),
          revoked: false
        }
      }, 200);
    }
  }

  // Per-user cap: shares each carry a full denormalized copy of the note
  // (up to the body limit) — unlimited shares were unlimited storage.
  // Revoked/expired rows leave via the sweep below after a grace window;
  // keeping the cap on LIVE rows matches what the user perceives as "my
  // links".
  const MAX_LIVE_SHARES = 200;
  const liveRows = await db.all(
    'select count(*) as live from shares where user_id = ? and revoked = 0 and expires_at > ?',
    [user.id, Date.now()]
  );
  if (Number(liveRows[0]?.live ?? 0) >= MAX_LIVE_SHARES) {
    return json(
      request,
      { error: 'Too many active share links — revoke or let expire a few before making more.' },
      403
    );
  }

  // Per-account BYTE budget on top of the row cap: rows alone never
  // bounded storage, because each row is a full copy of the note. Live
  // rows only, counted in UTF-8 bytes the way the database holds them —
  // the character-counted version let a CJK-heavy account stand at 3x
  // whatever number it thought it was enforcing.
  const byteNow = Date.now();
  if ((await liveShareBytes(db, user.id, byteNow)) + utf8.encode(content).length > SHARE_BYTES_QUOTA) {
    return json(
      request,
      { error: 'This account is out of share-link storage — revoke or let expire a few links.' },
      413
    );
  }

  const token = createShareToken();
  const now = byteNow;
  const expiresAt = now + days * DAY_MS;

  try {
    await db.run(
      `insert into shares (token, user_id, note_id, title, content, note_type, created_at, expires_at, revoked)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [token, user.id, noteId, title, content, noteType, now, expiresAt]
    );
  } catch (error) {
    // Token collisions are vanishingly rare — a real failure here is
    // almost certainly the DATABASE, and swallowing it with a retry
    // message left outages with zero server-side evidence.
    console.error('[shares] insert failed', error);
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

  // Refresh one link's expiry window by token — the client's dedupe
  // contract: a note keeps ONE active link, so a second share request
  // for it updates the first instead of minting a twin. Updating implies
  // the link is (still) live: revoked links refuse, expired ones come
  // back — the reader's 404 contract stays untouched.
  const days = asInt(body.days, 0);
  if (token && days > 0) {
    const now = Date.now();
    const expiresAt = now + Math.min(3650, Math.max(1, days)) * DAY_MS;
    const updated = await db.all(
      `update shares set expires_at = ?
       where token = ? and user_id = ? and revoked = 0
       returning token, note_id, title, content, created_at, expires_at, revoked`,
      [expiresAt, token, user.id]
    );
    const row = updated[0];
    if (!row) {
      return json(request, { error: 'This link is no longer active.' }, 404);
    }
    return json(request, {
      ok: true,
      row: {
        token: String(row.token),
        note_id: row.note_id,
        title: row.title,
        content: row.content,
        html: row.content,
        note_type: row.note_type ?? null,
        created_at: Number(row.created_at),
        expires_at: Number(row.expires_at),
        revoked: Number(row.revoked) === 1
      }
    });
  }

  if (token) {
    await db.run('update shares set revoked = 1, revoked_at = ? where token = ? and user_id = ?', [Date.now(), token, user.id]);
    return json(request, { ok: true });
  }

  // Revoke every link that points at the given notes (a note was closed).
  // Cap the input array (shared/wire.ts MAX_SHARE_PATCH_NOTE_IDS) — without
  // an upper bound a 2 MB request body could pack ~25,000 UUIDs into one
  // IN-clause, producing a multi-megabyte SQL statement that Turso rejects.
  const noteIds = Array.isArray(body.note_ids)
    ? body.note_ids.map(id => asString(id)).filter(Boolean).slice(0, MAX_SHARE_PATCH_NOTE_IDS)
    : [];
  if (noteIds.length > 0) {
    const placeholders = noteIds.map(() => '?').join(', ');
    const args: SqlValue[] = [Date.now(), user.id, ...noteIds];
    await db.run(
      `update shares set revoked = 1, revoked_at = ? where user_id = ? and note_id in (${placeholders})`,
      args
    );
    return json(request, { ok: true });
  }

  // Refresh the denormalised content on still-active links (the note changed).
  // Cap at shared/wire.ts MAX_SHARE_REFRESH_ENTRIES; previously an attacker
  // could pack thousands of refresh items, each triggering a sequential DB
  // round-trip (one HTTP fetch to Turso per item) and locking the rate-limit
  // slot for the full 30 s request budget. Batched via runMany so the writes
  // land in a single pipeline.
  const refresh = Array.isArray(body.refresh) ? body.refresh.slice(0, MAX_SHARE_REFRESH_ENTRIES) : [];
  const now = Date.now();
  const statements: SqlStatement[] = [];
  const refreshed: Array<{ noteId: string; bytes: number }> = [];
  for (const entry of refresh) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const noteId = asString(item.note_id);
    if (!noteId) {
      continue;
    }
    const nextContent = asString(item.content ?? item.html);
    statements.push({
      sql: `update shares set title = ?, content = ?, note_type = ?
            where user_id = ? and note_id = ? and revoked = 0 and expires_at > ?`,
      args: [asString(item.title).slice(0, 200), nextContent, parseNoteType(item.note_type), user.id, noteId, now]
    });
    refreshed.push({ noteId, bytes: utf8.encode(nextContent).length });
  }
  if (statements.length > 0) {
    // The refresh path used to grow live rows with no ceiling in sight —
    // a create-time byte cap alone was theater when every existing row
    // could be refreshed up to the body limit. The same per-account
    // budget applies here (see SHARE_BYTES_QUOTA), counted as deltas so
    // a refresh that shrinks a big row FREES room; a note with no live
    // row updates nothing and costs nothing.
    const placeholders = refreshed.map(() => '?').join(', ');
    const oldRows = await db.all(
      `select note_id, sum(length(cast(content as blob))) as bytes
         from shares
        where user_id = ? and revoked = 0 and expires_at > ? and note_id in (${placeholders})
        group by note_id`,
      [user.id, now, ...refreshed.map(entry => entry.noteId)]
    );
    const oldById = new Map(oldRows.map(row => [String(row.note_id), Number(row.bytes) || 0]));
    const delta = refreshed.reduce(
      (total, entry) => total + entry.bytes - (oldById.get(entry.noteId) ?? 0),
      0
    );
    if ((await liveShareBytes(db, user.id, now)) + delta > SHARE_BYTES_QUOTA) {
      return json(
        request,
        { error: 'This account is out of share-link storage — revoke or let expire a few links.' },
        413
      );
    }
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
// The dead-link sweep
// ---------------------------------------------------------------------------

/** How long a dead link stays visible in the owner's list before it goes. */
const SHARE_DEATH_GRACE_MS = 7 * DAY_MS;

/**
 * Prunes dead share rows — revoked links and expired ones, a grace window
 * past their death. Every cap above counts LIVE rows only, but the dead
 * rows themselves used to live forever: an account could cycle 200-live-
 * row generations (create, revoke, repeat) and keep every generation's
 * bytes, because nothing in the server ever said `delete from shares`.
 * The public endpoint already 404s these rows — the grace only keeps a
 * fresh revoke visible in the owner's list long enough to read its
 * "revoked" state.
 *
 * Revocation time (revoked_at) is the grace clock; rows revoked before
 * that column existed fall back to their expiry — the best available
 * "long dead by now" evidence.
 */
export async function sweepStaleShares(db: Db, now: number = Date.now()): Promise<number> {
  const cutoff = now - SHARE_DEATH_GRACE_MS;
  const retired = await db.all(
    `delete from shares
      where (revoked = 0 and expires_at <= ?)
         or (revoked = 1 and coalesce(revoked_at, expires_at, created_at) < ?)
      returning token`,
    [cutoff, cutoff]
  );
  return retired.length;
}
