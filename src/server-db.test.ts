import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../server/db';

// The Turso HTTP backend, pinned at the boundary that matters for
// resilience: every pipeline request must carry a deadline (a wedged Turso
// connection used to hang every request forever — Bun.serve has no
// per-request timeout of its own), and a timeout must surface as an error
// a caller can read and retry, not as silence.

const ORIGINAL_URL = process.env.TURSO_DATABASE_URL;
const ORIGINAL_TOKEN = process.env.TURSO_AUTH_TOKEN;

async function tursoDb(): Promise<Db> {
  process.env.TURSO_DATABASE_URL = 'https://example-db.turso.io';
  process.env.TURSO_AUTH_TOKEN = 'test-token';
  return createDb();
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_URL === undefined) {
    delete process.env.TURSO_DATABASE_URL;
  } else {
    process.env.TURSO_DATABASE_URL = ORIGINAL_URL;
  }
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.TURSO_AUTH_TOKEN;
  } else {
    process.env.TURSO_AUTH_TOKEN = ORIGINAL_TOKEN;
  }
});

describe('the Turso backend talks to a clock', () => {
  it('sends an abort signal with every pipeline request', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      const results = [{ type: 'ok', response: { result: { cols: [], rows: [] } } }];
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await db.all('select 1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    // No signal means no deadline — and no deadline means the fetch hangs
    // forever on a wedged connection.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a timed-out request surfaces as a clear, retryable error', async () => {
    // AbortSignal.timeout() aborts the fetch with a TimeoutError
    // DOMException; the backend must translate that into words a user and
    // a log reader understand, not re-throw an opaque abort.
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await expect(db.all('select 1')).rejects.toThrow(/timed out after 10s/);
    await expect(db.run('delete from sessions')).rejects.toThrow(/timed out after 10s/);
  });

  it('an unreachable Turso still says so in its own words', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await expect(db.all('select 1')).rejects.toThrow(/Turso is unreachable/);
  });

  it('unwraps Hrana cells the way the live pipeline delivers them', async () => {
    // The real /v2/pipeline answers with typed cell objects — integers and
    // floats arrive as strings, NULL as {"type":"null"} — not the bare JSON
    // scalars a naive reading of the examples suggests. A regression here
    // turns every row into {"type":...} objects and quietly breaks every
    // integer comparison in the sync layer.
    const results = [
      {
        type: 'ok',
        response: {
          result: {
            cols: [
              { name: 'id' },
              { name: 'seq' },
              { name: 'name' },
              { name: 'ratio' },
              { name: 'tombstone' },
            ],
            rows: [
              [
                { type: 'text', value: 'note-1' },
                { type: 'integer', value: '42' },
                { type: 'null' },
                { type: 'float', value: '1.5' },
                { type: 'integer', value: '0' },
              ],
            ],
          },
        },
      },
    ];
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    const rows = await db.all('select id, seq, name, ratio, tombstone from notes');

    expect(rows).toEqual([
      {
        id: 'note-1',
        seq: 42,
        name: null,
        ratio: 1.5,
        tombstone: 0,
      },
    ]);
    // Numbers must be real numbers — '42' (string) would sort wrongly against
    // every seq cursor the sync layer compares against.
    expect(typeof rows[0]!.seq).toBe('number');
  });
});
