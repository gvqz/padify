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
});
