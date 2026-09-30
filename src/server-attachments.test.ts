import { describe, expect, it } from 'vitest';
import type { Db, Row, SqlStatement, SqlValue } from '../server/db';
import {
  attachmentMimeFrom,
  attachmentNameFrom,
  decodeAttachmentData,
  encodeAttachmentData,
  MAX_ATTACHMENT_BYTES,
} from '../server/attachments';
import {
  handleAttachmentDelete,
  handleAttachmentGet,
  handleAttachmentPost,
  handleAttachmentsList,
  route,
} from '../server/handlers';

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
