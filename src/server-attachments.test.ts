import { describe, expect, it } from 'vitest';
import type { Db, Row, SqlStatement, SqlValue } from '../server/db';
import {
  attachmentMimeFrom,
  attachmentNameFrom,
  decodeAttachmentData,
  encodeAttachmentData,
  handleAttachmentDelete,
  handleAttachmentGet,
  handleAttachmentPost,
  handleAttachmentsList,
  MAX_ATTACHMENT_BYTES,
  sweepOrphanAttachments,
} from '../server/attachments';
import { handlePublicShareAttachmentGet } from '../server/shares';
import { route } from '../server/routes';

/**
 * Attachment handler contracts, same harness as server-handlers.test.ts:
 * a scripted Db answers from canned rows and records every statement, so
 * the tests pin what the server DOES — validation, idempotency, the
 * base64 round trip, and the route gate — without booting Bun.
 */

class ScriptedDb implements Db {
  readonly kind = 'scripted';
  statements: SqlStatement[] = [];
  sqls: string[] = [];

  constructor(private scripts: Array<{ match: string; rows: Row[] }> = []) {}

  async all(sql: string): Promise<Row[]> {
    this.sqls.push(sql);
    const script = this.scripts.find((entry) => sql.includes(entry.match));
    return script ? script.rows : [];
  }

  async run(sql: string, args?: SqlValue[]): Promise<void> {
    this.sqls.push(sql);
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

const ID = 'voice-2026-abcdef';

function uploadRequest(
  bytes: Uint8Array,
  headers: Record<string, string> = {},
  path = '/api/attachments',
): Request {
  return new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: {
      'x-padify-id': ID,
      'content-type': 'audio/webm',
      'x-padify-name': 'voice-note.webm',
      ...headers,
    },
    // The raw bytes. (Cast only for the DOM-lib-less server tsconfig; at
    // runtime this is a Uint8Array, which fetch accepts as an
    // ArrayBufferView — a Blob here would be jsdom's, not undici's, and
    // get stringified instead of uploaded.)
    body: bytes as unknown as ArrayBuffer,
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe('handleAttachmentPost — the upload contract', () => {
  it('stores the bytes base64-encoded with the digest and echoes the meta', async () => {
    const db = new ScriptedDb();
    const response = await handleAttachmentPost(db, uploadRequest(PAYLOAD), user);

    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      id: ID,
      name: 'voice-note.webm',
      mime: 'audio/webm',
      size: PAYLOAD.byteLength,
    });
    expect(typeof body.sha256).toBe('string');

    expect(db.statements).toHaveLength(1);
    const [statement] = db.statements;
    expect(statement!.sql).toContain('insert into attachments');
    // The bytes are stored decodably: what went in comes back out.
    expect(decodeAttachmentData(String(statement!.args![6]))).toEqual(PAYLOAD);
  });

  it('answers a retried identical upload with 200 and no second insert', async () => {
    const digest = 'a'.repeat(64);
    const db = new ScriptedDb([
      { match: 'select sha256 from attachments', rows: [{ sha256: digest }] },
    ]);
    // Feed bytes whose digest matches the scripted row: reuse the encoder.
    const sameBytes = decodeAttachmentData(encodeAttachmentData(PAYLOAD));
    const db2 = new ScriptedDb([
      {
        match: 'select sha256 from attachments',
        rows: [{ sha256: await sha256Of(sameBytes) }],
      },
    ]);

    const response = await handleAttachmentPost(db2, uploadRequest(sameBytes), user);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ ok: true, id: ID, duplicate: true });
    expect(db2.statements).toHaveLength(0);
    expect(db.statements).toHaveLength(0);
  });

  it('refuses the same id with different bytes (409, no overwrite)', async () => {
    const db = new ScriptedDb([
      { match: 'select sha256 from attachments', rows: [{ sha256: 'f'.repeat(64) }] },
    ]);
    const response = await handleAttachmentPost(db, uploadRequest(PAYLOAD), user);
    expect(response.status).toBe(409);
    expect(db.statements).toHaveLength(0);
  });

  it('rejects a missing or malformed id', async () => {
    const db = new ScriptedDb();
    const missing = await handleAttachmentPost(
      db,
      uploadRequest(PAYLOAD, { 'x-padify-id': '' }),
      user,
    );
    expect(missing.status).toBe(400);
    const short = await handleAttachmentPost(
      db,
      uploadRequest(PAYLOAD, { 'x-padify-id': 'abc' }),
      user,
    );
    expect(short.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('rejects an empty body and caps the size (declared and measured)', async () => {
    const db = new ScriptedDb();
    const empty = await handleAttachmentPost(db, uploadRequest(new Uint8Array(0)), user);
    expect(empty.status).toBe(400);

    const declared = await handleAttachmentPost(
      db,
      uploadRequest(PAYLOAD, { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }),
      user,
    );
    expect(declared.status).toBe(413);
    expect(db.sqls).toHaveLength(0); // rejected before touching the db
  });

  it('normalizes the filename and the mime type', async () => {
    const db = new ScriptedDb();
    const response = await handleAttachmentPost(
      db,
      uploadRequest(PAYLOAD, {
        'x-padify-name': '  bad\u0007 name.bin ',
        'content-type': 'not a mime///type',
      }),
      user,
    );
    const body = await bodyOf(response);
    expect(body.name).toBe('bad name.bin');
    expect(body.mime).toBe('application/octet-stream');
  });
});

describe('handleAttachmentGet — the download contract', () => {
  function storedRow(): Row {
    return {
      name: 'voice-note.webm',
      mime: 'audio/webm',
      sha256: 'd'.repeat(64),
      data: encodeAttachmentData(PAYLOAD),
    };
  }

  it('serves the decoded bytes with an immutable, ETagged response', async () => {
    const db = new ScriptedDb([{ match: 'from attachments where id', rows: [storedRow()] }]);
    const request = new Request('http://api.test/api/attachments/xyz');
    const response = await handleAttachmentGet(db, request, user, 'xyz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/webm');
    expect(response.headers.get('etag')).toBe(`"${'d'.repeat(64)}"`);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-disposition')).toContain('voice-note.webm');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const db = new ScriptedDb([{ match: 'from attachments where id', rows: [storedRow()] }]);
    const request = new Request('http://api.test/api/attachments/xyz', {
      headers: { 'if-none-match': `"${'d'.repeat(64)}"` },
    });
    const response = await handleAttachmentGet(db, request, user, 'xyz');
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  it('404s a missing row without leaking existence', async () => {
    const db = new ScriptedDb();
    const response = await handleAttachmentGet(
      db,
      new Request('http://api.test/api/attachments/xyz'),
      user,
      'xyz',
    );
    expect(response.status).toBe(404);
  });
});

describe('handleAttachmentsList and Delete', () => {
  it('lists metas newest-first without the data column', async () => {
    const db = new ScriptedDb([
      {
        match: 'from attachments where user_id',
        rows: [
          { id: 'a', name: 'a.webm', mime: 'audio/webm', size: 10, sha256: 'aa', created_at: 2 },
          { id: 'b', name: '', mime: 'audio/ogg', size: 5, sha256: 'bb', created_at: 1 },
        ],
      },
    ]);
    const response = await handleAttachmentsList(db, new Request('http://api.test/x'), user);
    const body = await bodyOf(response);
    expect(body.rows).toEqual([
      { id: 'a', name: 'a.webm', mime: 'audio/webm', size: 10, sha256: 'aa', createdAt: 2 },
      { id: 'b', name: '', mime: 'audio/ogg', size: 5, sha256: 'bb', createdAt: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain('data');
  });

  it('deletes are idempotent and scoped to the owner', async () => {
    const db = new ScriptedDb();
    const response = await handleAttachmentDelete(
      db,
      new Request('http://api.test/x', { method: 'DELETE' }),
      user,
      'gone-attachment',
    );
    expect(response.status).toBe(200);
    expect(db.statements[0]!.sql).toContain('delete from attachments where id = ? and user_id = ?');
  });
});

describe('route — the attachment gate', () => {
  it('requires a session for every attachment route', async () => {
    const db = new ScriptedDb();
    for (const [method, path] of [
      ['GET', '/api/attachments'],
      ['POST', '/api/attachments'],
      ['GET', `/api/attachments/${ID}`],
      ['DELETE', `/api/attachments/${ID}`],
    ] as const) {
      const response = await route(db, new Request(`http://api.test${path}`, { method }), path);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('answers unauthenticated requests with 401 before any path matching', async () => {
    // The auth gate precedes routing for every /api path (pinned in
    // server-handlers.test.ts), so even a malformed id answers 401 first.
    const db = new ScriptedDb();
    const response = await route(
      db,
      new Request('http://api.test/api/attachments/short'),
      '/api/attachments/short',
    );
    expect(response.status).toBe(401);
  });
});

describe('the base64 codec', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(1024).map((_, i) => (i * 37 + 11) % 256);
    expect(decodeAttachmentData(encodeAttachmentData(bytes))).toEqual(bytes);
  });
});

describe('header shaping helpers', () => {
  it('caps long names and strips control characters', () => {
    expect(attachmentNameFrom('x'.repeat(500))).toHaveLength(200);
    expect(attachmentNameFrom(null)).toBe('');
  });

  it('keeps well-formed mimes, falls back for the rest', () => {
    expect(attachmentMimeFrom('Audio/WebM; codecs=opus')).toBe('audio/webm; codecs=opus');
    expect(attachmentMimeFrom('text/plain')).toBe('text/plain');
    expect(attachmentMimeFrom('garbage')).toBe('application/octet-stream');
    expect(attachmentMimeFrom(null)).toBe('application/octet-stream');
  });
});

/** sha256 hex of bytes, computed with the same node:crypto the server uses. */
async function sha256Of(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// The orphan sweep — the store's janitor (the rule is shared/att-refs.ts's;
// these tests pin the server's READING of it: the per-user scoping, the
// trash-as-tenant rule, the one runMany batch, and what each verdict does).
// ---------------------------------------------------------------------------

const SWEEP_NOW = 1_700_000_000_000;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function sweepDb(
  notes: Row[],
  attachments: Row[],
  shares: Row[] = [],
): { db: ScriptedDb; verdicts: Promise<number> } {
  const db = new ScriptedDb([
    { match: 'from notes', rows: notes },
    { match: 'from shares where revoked', rows: shares },
    { match: 'from attachments', rows: attachments },
  ]);
  return { db, verdicts: sweepOrphanAttachments(db, SWEEP_NOW) };
}

function noteRow(userId: string, content: string, noteType: string | null = null): Row {
  return { user_id: userId, content, note_type: noteType };
}

function attachmentRow(id: string, userId: string, orphanSince: number | null = null): Row {
  return { id, user_id: userId, orphan_since: orphanSince };
}

describe('sweepOrphanAttachments — the orphan sweep', () => {
  it('stamps newcomers, clears revived references, deletes past grace', async () => {
    const { db, verdicts } = sweepDb(
      [
        noteRow(
          'user-1',
          '![live](padify-att:att-aaaaaaaaaaaaaaaa)\n\n![revived](padify-att:att-cccccccccccccccc)',
        ),
      ],
      [
        // Referenced, never judged — nothing to do.
        attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-1', null),
        // Unreferenced, no clock yet — stamp it.
        attachmentRow('att-bbbbbbbbbbbbbbbb', 'user-1', null),
        // Referenced again but still carrying an old clock — clear it.
        attachmentRow('att-cccccccccccccccc', 'user-1', SWEEP_NOW - GRACE_MS - 1),
        // Unreferenced past the window — garbage.
        attachmentRow('att-dddddddddddddddd', 'user-1', SWEEP_NOW - GRACE_MS - 1),
      ],
    );

    expect(await verdicts).toBe(1);
    const writes = db.statements;
    expect(writes).toHaveLength(3);
    expect(writes[0]).toEqual({
      sql: 'update attachments set orphan_since = null where id = ?',
      args: ['att-cccccccccccccccc'],
    });
    expect(writes[1]).toEqual({
      sql: 'update attachments set orphan_since = ? where id = ?',
      args: [SWEEP_NOW, 'att-bbbbbbbbbbbbbbbb'],
    });
    expect(writes[2]).toEqual({
      sql: 'delete from attachments where id = ?',
      args: ['att-dddddddddddddddd'],
    });
  });

  it('never writes when every attachment is referenced without a clock', async () => {
    const { db, verdicts } = sweepDb(
      [noteRow('user-1', '<img src="padify-att:att-aaaaaaaaaaaaaaaa">')],
      [attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-1', null)],
    );

    expect(await verdicts).toBe(0);
    expect(db.statements).toHaveLength(0);
  });

  it("scopes references per user — another user's note does not protect a blob", async () => {
    const { db, verdicts } = sweepDb(
      // user-1's note references the id; the ATTACHMENT belongs to user-2.
      [noteRow('user-1', '![x](padify-att:att-aaaaaaaaaaaaaaaa)')],
      [attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-2', SWEEP_NOW - GRACE_MS - 1)],
    );

    expect(await verdicts).toBe(1);
    expect(db.statements.map((statement) => statement.sql)).toEqual([
      'delete from attachments where id = ?',
    ]);
  });

  it('counts trashed rows as tenants (a restore must find its images)', async () => {
    // The sweep reads every notes row — the deleted flag is the trash
    // sweep's business, not this one's; a grave's images stay until the
    // grave itself is retired.
    const { verdicts } = sweepDb(
      [
        noteRow('user-1', '![grave](padify-att:att-aaaaaaaaaaaaaaaa)'),
        noteRow('user-1', '', null), // a live empty note rides along
      ],
      [attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-1', SWEEP_NOW - GRACE_MS - 1)],
    );

    expect(await verdicts).toBe(0);
  });

  it('reads drawing notes through the scene grammar', async () => {
    const scene = JSON.stringify({
      version: 1,
      elements: [{ type: 'image', fileId: 'file-aaaabbbbccccdddd' }],
    });
    const { verdicts } = sweepDb(
      [noteRow('user-1', scene, 'drawing')],
      [
        attachmentRow('file-aaaabbbbccccdddd', 'user-1', SWEEP_NOW - GRACE_MS - 1),
        attachmentRow('att-bbbbbbbbbbbbbbbb', 'user-1', SWEEP_NOW - GRACE_MS - 1),
      ],
    );

    // The scene's fileId is live; the unreferenced blob dies.
    expect(await verdicts).toBe(1);
  });

  it('counts a LIVE share as a tenant — bytes the link still serves are not garbage', async () => {
    // The owner removed the image from the note, but the link (a
    // denormalised snapshot) still renders it through the public
    // attachment endpoint. The snapshot is a promise the store keeps —
    // and the orphan clock the blob already carried REVIVES: one honest
    // clear, no delete.
    const { db, verdicts } = sweepDb(
      [noteRow('user-1', 'words without the image now')],
      [attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-1', SWEEP_NOW - GRACE_MS - 1)],
      [
        {
          user_id: 'user-1',
          content: '![kept](padify-att:att-aaaaaaaaaaaaaaaa)',
          note_type: 'markdown',
        },
      ],
    );

    expect(await verdicts).toBe(0);
    expect(db.statements).toEqual([
      {
        sql: 'update attachments set orphan_since = null where id = ?',
        args: ['att-aaaaaaaaaaaaaaaa'],
      },
    ]);
  });

  it('a DEAD share protects nothing — the clock keeps its stamp and the blob dies', async () => {
    // Revoked or expired, the share answers 404 to its reader — the
    // sweep's SQL reads live rows only, so the orphan clock the row
    // already carries runs on to garbage.
    const { db, verdicts } = sweepDb(
      [],
      [attachmentRow('att-aaaaaaaaaaaaaaaa', 'user-1', SWEEP_NOW - GRACE_MS - 1)],
      // The shares script answers EMPTY for the live-only query.
    );

    expect(await verdicts).toBe(1);
    expect(db.statements.map((statement) => statement.sql)).toEqual([
      'delete from attachments where id = ?',
    ]);
  });

  it('a share of a drawing note reads the scene grammar too', async () => {
    const scene = JSON.stringify({
      version: 1,
      elements: [{ type: 'image', fileId: 'file-aaaabbbbccccdddd' }],
    });
    const { verdicts } = sweepDb(
      [],
      [attachmentRow('file-aaaabbbbccccdddd', 'user-1', SWEEP_NOW - GRACE_MS - 1)],
      [{ user_id: 'user-1', content: scene, note_type: 'drawing' }],
    );

    expect(await verdicts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The public share-attachment endpoint — share links carry their images
// (the viewer's /api/share/:token/att/:id). The handler lives in
// server/shares.ts; its read path is the attachment store's, so its
// contracts sit beside the download contracts above.
// ---------------------------------------------------------------------------

function shareRow(content: string, noteType: string | null = 'markdown'): Row {
  return { user_id: 'user-1', content, note_type: noteType };
}

describe('handlePublicShareAttachmentGet — the share viewer image contract', () => {
  it('serves the bytes the live share references, with the download contract', async () => {
    const db = new ScriptedDb([
      { match: 'from shares', rows: [shareRow('![x](padify-att:att-aaaaaaaaaaaaaaaa)')] },
      {
        match: 'from attachments where id',
        rows: [
          {
            name: 'shot.png',
            mime: 'image/png',
            sha256: 'e'.repeat(64),
            data: encodeAttachmentData(PAYLOAD),
          },
        ],
      },
    ]);
    const response = await handlePublicShareAttachmentGet(
      db,
      new Request('http://api.test/api/share/TOK/att/x'),
      'TOK',
      'att-aaaaaaaaaaaaaaaa',
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  it('answers the unified 404 for a dead token — and never reads the store', async () => {
    const db = new ScriptedDb();
    const response = await handlePublicShareAttachmentGet(
      db,
      new Request('http://api.test/api/share/TOK/att/x'),
      'TOK',
      'att-aaaaaaaaaaaaaaaa',
    );

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'This link is not available.' });
    expect(db.sqls).toHaveLength(1); // the share read only
  });

  it('refuses an id the share does not reference — even one the owner owns', async () => {
    // The tenant check is the whole authorization: a token names ONE
    // share's content, not the owner's store.
    const db = new ScriptedDb([
      { match: 'from shares', rows: [shareRow('![x](padify-att:att-aaaaaaaaaaaaaaaa)')] },
      {
        match: 'from attachments where id',
        rows: [
          {
            name: 'steal.png',
            mime: 'image/png',
            sha256: 'f'.repeat(64),
            data: encodeAttachmentData(PAYLOAD),
          },
        ],
      },
    ]);
    const response = await handlePublicShareAttachmentGet(
      db,
      new Request('http://api.test/api/share/TOK/att/x'),
      'TOK',
      'att-zzzzzzzzzzzzzzzz',
    );

    expect(response.status).toBe(404);
    // The attachment table was never touched — the verdict came from the
    // snapshot's reference grammar.
    expect(db.sqls.some((sql) => sql.includes('from attachments'))).toBe(false);
  });

  it('answers 404 when the referenced bytes are missing (the flush has not landed)', async () => {
    const db = new ScriptedDb([
      { match: 'from shares', rows: [shareRow('![x](padify-att:att-aaaaaaaaaaaaaaaa)')] },
    ]);
    const response = await handlePublicShareAttachmentGet(
      db,
      new Request('http://api.test/api/share/TOK/att/x'),
      'TOK',
      'att-aaaaaaaaaaaaaaaa',
    );

    expect(response.status).toBe(404);
  });

  it('dispatches public — no session, the share bucket, both params wired', async () => {
    // The route row's auth/bucket story, pinned at the dispatcher: the
    // request carries NO authorization header and still gets bytes — a
    // required-auth regression here would blank every shared image.
    const db = new ScriptedDb([
      { match: 'from shares', rows: [shareRow('![x](padify-att:att-aaaaaaaaaaaaaaaa)')] },
      {
        match: 'from attachments where id',
        rows: [
          {
            name: 's.png',
            mime: 'image/png',
            sha256: 'e'.repeat(64),
            data: encodeAttachmentData(PAYLOAD),
          },
        ],
      },
    ]);
    const response = await route(
      db,
      new Request('http://api.test/api/share/TOK1234/att/att-aaaaaaaaaaaaaaaa'),
      '/api/share/TOK1234/att/att-aaaaaaaaaaaaaaaa',
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  it('the route gate keeps malformed ids from ever reaching the handler', async () => {
    const db = new ScriptedDb();
    // 'short' (5 chars) is below the wire's 8-char id floor: no route
    // matches. The unknown-path gate still runs — a signed-out caller
    // sees 401, and the handler (and its SQL) is never reached.
    const response = await route(
      db,
      new Request('http://api.test/api/share/TOK1234/att/short'),
      '/api/share/TOK1234/att/short',
    );

    expect(response.status).toBe(401);
    expect(db.sqls.some((sql) => sql.includes('from shares'))).toBe(false);
    expect(db.sqls.some((sql) => sql.includes('from attachments'))).toBe(false);
  });
});
