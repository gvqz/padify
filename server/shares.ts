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

const DAY_MS = 86_400_000;

function createShareToken(): string {
  const bytes = randomBytes(18);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  // Per-user cap: shares each carry a full denormalized copy of the note
  // (up to the body limit) — unlimited shares were unlimited storage.
  // Revoked/expired rows still count until pruned; keeping the cap on
  // LIVE rows matches what the user perceives as "my links".
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

  const token = createShareToken();
  const now = Date.now();
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
