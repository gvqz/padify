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

describe('runMany on the Turso backend is all-or-nothing per chunk', () => {
  // The pipeline does NOT stop at a failed request, so a transaction over
  // it cannot be bare BEGIN/…/COMMIT — a mid-batch error would let the
  // tail statements run and commit the partial work. The batch's chained
  // conditions are what make the rollback real; these tests pin that
  // request shape and the step_errors read-back.

  function batchResponse(stepErrors: Array<unknown>) {
    const results = [
      { type: 'ok', response: { type: 'batch', result: { step_results: [], step_errors: stepErrors } } },
    ];
    return new Response(JSON.stringify({ results }), { status: 200 });
  }

  it('wraps the chunk in BEGIN, a condition chain, COMMIT and a guarded ROLLBACK', async () => {
    const fetchMock = vi.fn(async () => batchResponse([null, null, null, null, null]));
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await db.runMany([
      { sql: 'insert into t values (?)', args: [1] },
      { sql: 'insert into t values (?)', args: [2] },
      { sql: 'insert into t values (?)', args: [3] },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      requests: Array<{ type: string; batch?: { steps: Array<Record<string, unknown>> } }>;
    };
    // One batch request plus the close — no bare executes.
    expect(body.requests.map((request) => request.type)).toEqual(['batch', 'close']);
    const steps = body.requests[0]!.batch!.steps;
    expect(steps).toHaveLength(6); // BEGIN + 3 statements + COMMIT + ROLLBACK
    expect(steps[0]).toEqual({ stmt: { sql: 'BEGIN' } });
    // Each statement chained on the previous step's ok, args translated.
    expect(steps[1]).toEqual({
      condition: { type: 'ok', step: 0 },
      stmt: { sql: 'insert into t values (?)', args: [{ type: 'integer', value: '1' }] },
    });
    expect(steps[3]).toEqual({
      condition: { type: 'ok', step: 2 },
      stmt: { sql: 'insert into t values (?)', args: [{ type: 'integer', value: '3' }] },
    });
    // COMMIT runs only when the last statement did; ROLLBACK only when
    // COMMIT did not.
    expect(steps[4]).toEqual({ condition: { type: 'ok', step: 3 }, stmt: { sql: 'COMMIT' } });
    expect(steps[5]).toEqual({
      condition: { type: 'not', cond: { type: 'ok', step: 4 } },
      stmt: { sql: 'ROLLBACK' },
    });
  });

  it('a failed step surfaces as an error, not a silent rollback', async () => {
    // The condition chain already rolled the batch back; the throw is the
    // caller's only signal that nothing landed.
    const fetchMock = vi.fn(async () =>
      batchResponse([null, { message: 'UNIQUE constraint failed: notes.id' }, null, null, null])
    );
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await expect(db.runMany([{ sql: 'insert into t values (1)' }])).rejects.toThrow(
      /UNIQUE constraint failed/
    );
  });

  it('an all-ok batch is quiet, and empty input sends nothing', async () => {
    const fetchMock = vi.fn(async () => batchResponse([null, null, null]));
    vi.stubGlobal('fetch', fetchMock);

    const db = await tursoDb();
    await db.runMany([{ sql: 'insert into t values (1)' }]);
    await db.runMany([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
