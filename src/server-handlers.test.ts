import { describe, expect, it } from 'vitest';
import type { Db, Row, SqlStatement, SqlValue } from '../server/db';
import {
  handleNotesGet,
  handleNotesPut,
  handlePublicShareGet,
  handleSharesPatch,
  handleSignup,
  MAX_BODY_BYTES,
  route,
} from '../server/handlers';

// The server's first handler tests. The handlers were extracted from
// index.ts precisely so this file can exist: they are pure functions over
// (db, request, …), and the database is an interface — a scripted fake
// records what the handler tried to run and answers with canned rows, so
// the tests pin what the server DOES, without booting Bun.

/**
 * A Db that records every statement it is asked to run and answers every
 * query from a script. `failOn` turns the next matching insert into a
 * thrown error (the signup test needs the UNIQUE violation the real
 * schema raises on a duplicate email).
 */
class ScriptedDb implements Db {
  readonly kind = 'scripted';
  statements: SqlStatement[] = [];
  sqls: string[] = [];
  failOn: { fragment: string; message: string } | null = null;

  constructor(private scripts: Array<{ match: string; rows: Row[] }> = []) {}

  async all(sql: string): Promise<Row[]> {
    this.sqls.push(sql);
    const script = this.scripts.find((entry) => sql.includes(entry.match));
    return script ? script.rows : [];
  }

  async run(sql: string, args?: SqlValue[]): Promise<void> {
    this.sqls.push(sql);
    if (this.failOn && sql.includes(this.failOn.fragment)) {
      const message = this.failOn.message;
      this.failOn = null;
      throw new Error(message);
    }
    this.statements.push({ sql, args });
  }

  async runMany(statements: SqlStatement[]): Promise<void> {
    for (const statement of statements) {
      this.sqls.push(statement.sql);
      this.statements.push(statement);
    }
  }
}

const user = { id: 'user-1', email: 'user@example.test' };

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://api.test/api/x', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('handleSignup — the enumeration fix stays shut', () => {
  it('answers a duplicate email with the signin message, not a 409', async () => {
    const db = new ScriptedDb();
    db.failOn = { fragment: 'insert into users', message: 'UNIQUE constraint failed: users.email' };

    const response = await handleSignup(
      db,
      jsonRequest('POST', {
        email: 'taken@example.test',
        password: 'long enough',
      }),
    );

    // Same status AND same message as signin: an observer cannot tell a
    // signup duplicate from a bad password, so neither endpoint enumerates.
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: 'Wrong email or password.' });
  });

  it('creates the account and answers a token on the happy path', async () => {
    const db = new ScriptedDb();

    const response = await handleSignup(
      db,
      jsonRequest('POST', {
        email: 'fresh@example.test',
        password: 'long enough',
      }),
    );

    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe('');
    // Two writes: the user row, then the session row.
    expect(db.statements.map((statement) => statement.sql)).toEqual([
      'insert into users (id, email, password_hash, created_at) values (?, ?, ?, ?)',
      'insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)',
    ]);
  });
});

describe('handleSharesPatch — the input caps hold', () => {
  it('caps note_ids at 500 and refresh at 100', async () => {
    const db = new ScriptedDb();
    const noteIds = Array.from({ length: 650 }, (_, index) => `note-${index}`);
    const refresh = Array.from({ length: 250 }, (_, index) => ({
      note_id: `note-${index}`,
      title: `t${index}`,
      content: `c${index}`,
    }));

    const response = await handleSharesPatch(
      db,
      jsonRequest('PATCH', {
        note_ids: noteIds,
        revoked: true,
        refresh,
      }),
      user,
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });

    // The revoke-all-for-notes statement ran once with at most 500 ids…
    const revokes = db.statements.filter((statement) =>
      statement.sql.includes('update shares set revoked = 1 where user_id'),
    );
    expect(revokes).toHaveLength(1);
    expect(revokes[0].args!.length).toBeLessThanOrEqual(501); // 500 ids + user id
    // …and the refresh updates wrote at most 100 rows, batched in one pipeline.
    const updates = db.statements.filter((statement) =>
      statement.sql.includes('update shares set title'),
    );
    expect(updates.length).toBeLessThanOrEqual(100);
  });
});

describe('handlePublicShareGet — 404 identity', () => {
  it('answers the same 404 for cancelled, expired and never-existed links', async () => {
    const db = new ScriptedDb(); // every select answers empty

    const response = await handlePublicShareGet(
      db,
      jsonRequest('GET', undefined),
      'whatever-token',
    );

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'This link is not available.' });
  });
});

describe('route — dispatch edges', () => {
  it('answers OPTIONS with CORS headers and no body', async () => {
    const db = new ScriptedDb();
    const response = await route(
      db,
      new Request('http://api.test/api/notes', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.test' },
      }),
      '/api/notes',
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  it('answers the health probe with 200 and ok', async () => {
    const db = new ScriptedDb();
    const response = await route(db, jsonRequest('GET', undefined), '/api/health');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
  });

  it('answers unknown paths with a JSON 404 (signed in)', async () => {
    // Route guards authenticated areas before the fallback, so the 404
    // only speaks for a caller with a live session — script one.
    const db = new ScriptedDb([
      {
        match: 'select sessions.expires_at',
        rows: [{ expires_at: Date.now() + 60_000, user_id: 'user-1', email: 'user@example.test' }],
      },
    ]);
    const response = await route(
      db,
      new Request('http://api.test/api/nope', {
        headers: { authorization: 'Bearer anything', origin: 'https://app.test' },
      }),
      '/api/nope',
    );

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Not found.' });
  });
});

describe('MAX_BODY_BYTES', () => {
  it('matches the documented 2 MB server cap the client batches under', () => {
    // The client's PUSH_BATCH_BYTES (1.5 MB) must stay below this; the
    // value is pinned here so the two sides drift loudly, not silently.
    expect(MAX_BODY_BYTES).toBe(2_000_000);
  });
});

describe('handleNotesPut — sync v2 seq stamping', () => {
  it('hands out the batch sequence in row order, base read from the user max', async () => {
    const db = new ScriptedDb([
      // The user's sequence already stands at 41 — this batch hands out 42, 43.
      { match: 'coalesce(max(seq)', rows: [{ base: 41 }] },
    ]);
    const response = await handleNotesPut(
      db,
      jsonRequest('PUT', {
        rows: [
          { id: 'a', content: 'one', updated_at: 5, deleted: false },
          { id: 'b', content: 'two', updated_at: 6, deleted: false },
        ],
      }),
      user,
    );
    expect(response.status).toBe(200);

    // The base read happened exactly once, before the batch.
    expect(db.sqls.filter((sql) => sql.includes('coalesce(max(seq)'))).toHaveLength(1);

    const seqs = db.statements.map((statement) => statement.args?.[9]);
    expect(seqs).toEqual([42, 43]);
    // Both rows carry the seq column in their INSERT — fresh writes get
    // stamped exactly like conflict updates.
    expect(db.statements.every((statement) => statement.sql.includes('seq = excluded.seq'))).toBe(
      true,
    );
  });

  it('an empty script answers base 0 — a fresh database stamps 1..n', async () => {
    const db = new ScriptedDb();
    await handleNotesPut(
      db,
      jsonRequest('PUT', { rows: [{ id: 'a', content: 'x', updated_at: 1, deleted: false }] }),
      user,
    );
    expect(db.statements[0]?.args?.[9]).toBe(1);
  });
});

describe('handleNotesGet — the v2 cursor pull', () => {
  const v2Rows = [
    {
      id: 'n2',
      name: null,
      content: '<p>newer</p>',
      position: 1,
      created_at: 10,
      updated_at: 20,
      deleted: 0,
      note_type: null,
      seq: 12,
    },
    {
      // seq 0: a row the stamping builds never wrote — delivered regardless
      // of the cursor, so a fresh v2 server never hides an untouched note.
      id: 'n1',
      name: null,
      content: '<p>legacy body</p>',
      position: 0,
      created_at: 5,
      updated_at: 6,
      deleted: 0,
      note_type: null,
      seq: 0,
    },
  ];

  it('answers changed rows, the full order, and the next cursor', async () => {
    const db = new ScriptedDb([
      { match: 'seq > ? or seq = 0', rows: v2Rows },
      { match: 'order by position asc', rows: [{ id: 'n1' }, { id: 'n2' }] },
    ]);
    const response = await handleNotesGet(
      db,
      new Request('http://api.test/api/notes?v=2&cursor=9'),
      user,
    );
    const body = await bodyOf(response);

    expect(body.v).toBe(2);
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: 'n1', seq: 0, deleted: false });
    expect(body.order).toEqual(['n1', 'n2']);
    // The cursor advanced past the highest delivered seq (12); the seq-0
    // row does not drag it back.
    expect(body.cursor).toBe(12);
    // V2 rows speak one key — the rename's legacy twin is dead here.
    expect(JSON.stringify(body)).not.toContain('"html"');
  });

  it('a cursor past everything answers an empty page and keeps the cursor', async () => {
    const db = new ScriptedDb([
      { match: 'seq > ? or seq = 0', rows: [] },
      { match: 'order by position asc', rows: [{ id: 'n1' }] },
    ]);
    const response = await handleNotesGet(
      db,
      new Request('http://api.test/api/notes?v=2&cursor=500'),
      user,
    );
    const body = await bodyOf(response);
    expect(body.rows).toEqual([]);
    expect(body.cursor).toBe(500);
    expect(body.order).toEqual(['n1']);
  });

  it('v1 keeps the full dual-key answer untouched', async () => {
    const db = new ScriptedDb([
      {
        match: 'order by position asc',
        rows: [
          {
            id: 'n1',
            user_id: 'user-1',
            name: null,
            content: '<p>body</p>',
            position: 0,
            created_at: 1,
            updated_at: 2,
            deleted: 0,
            note_type: null,
          },
        ],
      },
    ]);
    const response = await handleNotesGet(db, new Request('http://api.test/api/notes'), user);
    const body = await bodyOf(response);
    expect(body.v).toBeUndefined();
    // The legacy twin rides v1 responses until every install crossed over.
    expect(JSON.stringify(body)).toContain('"html"');
  });
});
