/**
 * Note rows — the contract between the client sync layer (src/cloud/sync.ts)
 * and storage.
 *
 * The server is deliberately schema-light about note types: it stores any
 * well-formed type id verbatim and never interprets what a type MEANS —
 * the client's registry (src/editor/note-types.ts) owns that. A type this
 * server has never heard of must survive the round trip, because the note
 * belongs to a newer build and has to arrive home intact.
 *
 * Extracted from index.ts (which boots Bun.serve at import time) so the
 * parsing rules can be pinned by tests without starting a server.
 */

import { type Db } from './db';
import { json, readJson } from './http';
import type { SessionUser } from './auth';
import {
  MAX_ROWS_PER_PUSH,
  NOTE_TYPE_ID_PATTERN,
  type IncomingNoteRow,
  type NotesPullV2,
} from '../shared/wire';

// The PUT row contract lives in shared/wire.ts — the one definition the
// client (src/cloud/sync.ts) and this parser both read from. Re-exported
// here for existing importers.
export type { IncomingNoteRow };

// The slug shape a note type id must carry — NOTE_TYPE_ID_PATTERN — is
// likewise defined once in shared/wire.ts and re-exported here for the
// server's tests and importers.
export { NOTE_TYPE_ID_PATTERN };

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A well-formed note type id passes through; anything else reads as null. */
export function parseNoteType(value: unknown): string | null {
  return typeof value === 'string' && NOTE_TYPE_ID_PATTERN.test(value) ? value : null;
}

/**
 * Validates a PUT /api/notes body into storable rows. One malformed row
 * rejects the whole batch — the client batches by size AND row count (see
 * shared/wire.ts MAX_ROWS_PER_PUSH), so a rejected batch is retried as
 * smaller batches, never partially applied.
 */
export function parseNoteRows(value: unknown): IncomingNoteRow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS_PER_PUSH) {
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
      // The rename transition: clients built before it send `html`, clients
      // after it send `content`, some send both with the same value. Either
      // key is accepted; a deploy gap between site and API must never cost
      // a note its body. Readers prefer `content`.
      content: asString(row.content ?? row.html),
      position: asInt(row.position, 0),
      created_at: asInt(row.created_at, 0),
      updated_at: asInt(row.updated_at, 0),
      deleted: asBool(row.deleted),
      note_type: parseNoteType(row.note_type)
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Route handlers — the notes SQL lives with its contract, above.
// ---------------------------------------------------------------------------

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
    const payload: NotesPullV2 = {
      v: 2,
      rows: rows.map(row => ({
        id: String(row.id),
        name: row.name == null ? null : String(row.name),
        content: String(row.content ?? ''),
        position: Number(row.position) || 0,
        created_at: Number(row.created_at) || 0,
        updated_at: Number(row.updated_at) || 0,
        deleted: Number(row.deleted) === 1,
        note_type: row.note_type == null ? null : String(row.note_type),
        seq: Number(row.seq) || 0
      })),
      // The full remote position order, by id — unchanged rows included.
      order: order.map(row => String(row.id)),
      // The client's next cursor: everything at or below this has been seen.
      cursor: nextCursor
    };
    return json(request, payload);
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

  // ---- per-user storage quota ---------------------------------------------
  // One authenticated account used to be able to store unlimited 2 MB
  // note bodies — a cheap way to exhaust a small host's storage. The cap
  // counts live note bytes (tombstones are empty), net of what this batch
  // replaces.
  const NOTE_BYTES_QUOTA = 25 * 1024 * 1024;
  const incomingIds = rows.map((row) => row.id);
  const placeholders = incomingIds.map(() => '?').join(', ');
  const existingRows = await db.all(
    `select id, coalesce(length(content), 0) as bytes from notes where user_id = ? and id in (${placeholders})`,
    [user.id, ...incomingIds]
  );
  const existingById = new Map(existingRows.map((row) => [String(row.id), Number(row.bytes) || 0]));
  const incomingBytes = rows.reduce(
    (total, row) => total + (row.deleted ? 0 : row.content.length),
    0
  );
  const replacedBytes = rows.reduce((total, row) => total + (existingById.get(row.id) ?? 0), 0);
  const totalsRows = await db.all(
    'select coalesce(sum(length(content)), 0) as total from notes where user_id = ? and deleted = 0',
    [user.id]
  );
  const currentTotal = Number(totalsRows[0]?.total ?? 0) || 0;
  if (currentTotal - replacedBytes + incomingBytes > NOTE_BYTES_QUOTA) {
    return json(request, { error: 'This account is out of storage space — delete some notes to sync more.' }, 413);
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
  //
  // The delete-race guard: the upsert used to take ANY incoming row
  // wholesale, so a live row re-published after a delete (another window's
  // stale position-drift push, an offline device's wake-up flush)
  // un-deleted the note — the closing device watched the tab reopen on
  // every sync cycle. Now a live write may not resurrect a tombstone
  // unless it is strictly NEWER than the delete (a real edit made after
  // it — the "a delete may not bury a newer edit" rule, enforced at the
  // one place every client version passes through), and a tombstone may
  // not bury a strictly newer live row. Ties go to the delete, exactly as
  // the client merge already rules. A refused row is a no-op: it still
  // answers ok (the row exists, the server's state is the truth being
  // pushed), and its reserved seqs simply leave a gap.
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
       where notes.user_id = excluded.user_id
         and not (
           (notes.deleted = 1 and excluded.deleted = 0
             and excluded.updated_at <= notes.updated_at)
           or (notes.deleted = 0 and excluded.deleted = 1
             and excluded.updated_at < notes.updated_at)
         )`,
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

  // Honest accounting: the upsert's WHERE pins updates to rows the user
  // owns, but a cross-user id collision made the write a silent NO-OP
  // while the response still said ok — the client dropped the row from
  // its push queue and the note existed on exactly one device forever,
  // with no error anywhere. Verify what actually landed.
  const landedRows = await db.all(
    `select count(*) as landed from notes where user_id = ? and id in (${placeholders})`,
    [user.id, ...incomingIds]
  );
  const landed = Number(landedRows[0]?.landed ?? 0);
  if (landed < rows.length) {
    // Some rows didn't land (a different account owns those ids —
    // near-impossible with the client's random ids, but no longer
    // invisible when it happens).
    return json(
      request,
      { error: 'Some notes could not be stored — their ids conflict with another account.' },
      409
    );
  }

  return json(request, { ok: true });
}
