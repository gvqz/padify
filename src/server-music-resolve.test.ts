// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetMusicResolverForTests,
  resolveTrackStream,
  setYtDlpRunnerForTests,
} from '../server/music';
import type { Db, SqlValue } from '../server/db';

// node:sqlite through createRequire: Vite's import analysis (vitest rides
// it) does not carry node:sqlite in its builtin list, and a plain import
// would be resolved as a bare module. The require path sidesteps that;
// the local interface below is the slice of DatabaseSync this suite uses.
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: SqlValue[]): Record<string, unknown>[];
    run(...args: SqlValue[]): void;
  };
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

// The yt-dlp resolver in server/music.ts, end to end: candidate parsing,
// duration-based selection, SQLite + memory caching, fresh-bypass and
// in-flight dedupe. This used to be scripts/music-resolve-test.ts — a
// hand-rolled bun-only script that CI never ran (npm run test is vitest,
// and Bun.spawn does not exist under Node). The setYtDlpRunnerForTests seam
// swaps the process runner for a fake, so the pipeline now runs under the
// same gate as everything else; the fake reproduces the old script's fake
// yt-dlp binary exactly (counter, search-only guard, candidate sets).
// Track ids from the YouTube search fallback (11 chars) resolve directly by
// their watch URL instead — covered by the direct-id test below.

let dbFile: string;
let db: DatabaseSyncLike;

/** The server's local-SQLite adapter shape, over node:sqlite. */
function sqliteDb(): Db {
  return {
    kind: 'node:sqlite (test)',
    async all(sql: string, args: SqlValue[] = []) {
      return db.prepare(sql).all(...(args ?? [])) as Record<string, unknown>[];
    },
    async run(sql: string, args: SqlValue[] = []) {
      db.prepare(sql).run(...(args ?? []));
    },
    async runMany() {
      /* unused by the resolver */
    },
    close() {
      db.close();
    },
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'padify-music-'));
  dbFile = join(dir, 'test.db');
  db = new DatabaseSync(dbFile);
  db.exec(`create table if not exists music_resolutions (
    key text primary key, video_id text not null, url text not null,
    duration_sec integer, resolved_at integer not null default 0, expires_at integer not null)`);
  resetMusicResolverForTests();
});

afterEach(() => {
  setYtDlpRunnerForTests(null);
  resetMusicResolverForTests();
  db.close();
  rmSync(join(dbFile, '..'), { recursive: true, force: true });
});

interface ResolveInput {
  key: string;
  title: string;
  artist: string;
  durationMs: number | null;
  fresh: boolean;
}

const input = (overrides: Partial<ResolveInput> = {}): ResolveInput => ({
  key: '0VjIjW4GlUSh6m7YnU3fY3',
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  durationMs: 200_040,
  fresh: false,
  ...overrides,
});

/**
 * The fake yt-dlp: counts calls, refuses non-search queries, and answers
 * with the same candidate sets the old bun script used — 200.04 s is the
 * target, abc123 (200 s) the match, def456 (42 s) the wrong length,
 * live000 the no-duration candidate. (The ytsearchN: prefix is added by
 * the REAL runner's argv — the seam sees the bare search query, so the
 * guard here checks the query shape, not the prefix.)
 *
 * `freshWinnerOnCall`: the call number that answers with only the NEW
 * winner (the fresh re-resolve) instead of the usual candidate set —
 * the old bun script's third process, renumbered per scenario.
 */
function installFakeYtDlp(options: { freshWinnerOnCall?: number } = {}): {
  calls: () => number;
} {
  const freshWinnerOnCall = options.freshWinnerOnCall ?? Number.POSITIVE_INFINITY;
  let calls = 0;
  setYtDlpRunnerForTests((query: string) => {
    calls += 1;
    if (!/audio/.test(query) || query.length > 200) {
      return Promise.reject(new Error(`not a search call: ${query}`));
    }
    if (calls === freshWinnerOnCall) {
      // The fresh re-resolve call: only a new winner.
      return Promise.resolve([
        { videoId: 'zzz999', durationSec: 199, url: 'https://stream.example/fresh' },
      ]);
    }
    return Promise.resolve([
      { videoId: 'abc123', durationSec: 200, url: 'https://stream.example/first' },
      { videoId: 'def456', durationSec: 42, url: 'https://stream.example/short' },
      { videoId: 'live000', durationSec: null, url: 'https://stream.example/live' },
    ]);
  });
  return { calls: () => calls };
}

describe('resolveTrackStream', () => {
  it('picks the duration-matched candidate, reports it uncached', async () => {
    const fake = installFakeYtDlp();

    const first = await resolveTrackStream(sqliteDb(), input());

    expect(first.videoId).toBe('abc123');
    expect(first.url).toBe('https://stream.example/first');
    expect(first.durationSec).toBe(200);
    expect(first.cached).toBe(false);
    expect(fake.calls()).toBe(1);
  });

  it('serves a repeat resolve from cache without another run', async () => {
    const fake = installFakeYtDlp();
    const db = sqliteDb();

    const first = await resolveTrackStream(db, input());
    const second = await resolveTrackStream(db, input());

    expect(second.cached).toBe(true);
    expect(second.url).toBe(first.url);
    expect(fake.calls()).toBe(1);
  });

  it('dedupes concurrent resolves of one track into a single run', async () => {
    const fake = installFakeYtDlp();
    const db = sqliteDb();

    const [a, b] = await Promise.all([
      resolveTrackStream(db, input({ key: 'concurrentTrackId' })),
      resolveTrackStream(db, input({ key: 'concurrentTrackId' })),
    ]);

    expect(a.url).toBe(b.url);
    expect(fake.calls()).toBe(1);
  });

  it('fresh=true bypasses the cache and re-resolves', async () => {
    const fake = installFakeYtDlp({ freshWinnerOnCall: 2 });
    const db = sqliteDb();

    await resolveTrackStream(db, input());
    const fresh = await resolveTrackStream(db, input({ fresh: true }));

    expect(fake.calls()).toBe(2);
    expect(fresh.videoId).toBe('zzz999');
    expect(fresh.url).toBe('https://stream.example/fresh');
    expect(fresh.cached).toBe(false);
  });

  it('without an expected duration, the first usable candidate wins', async () => {
    installFakeYtDlp();

    const noDuration = await resolveTrackStream(sqliteDb(), input({ durationMs: null }));

    expect(noDuration.videoId).toBe('abc123');
  });

  it('resolves an 11-character YouTube id directly by its watch URL', async () => {
    let seenQuery = '';
    setYtDlpRunnerForTests((query) => {
      seenQuery = query;
      return Promise.resolve([
        { videoId: 'dwDns8x3Jb4', durationSec: 430, url: 'https://stream.example/direct' },
      ]);
    });

    const result = await resolveTrackStream(
      sqliteDb(),
      input({
        key: 'dwDns8x3Jb4',
        title: 'Around the World',
        artist: 'Daft Punk',
        durationMs: 430_000,
      }),
    );

    expect(seenQuery).toBe('https://www.youtube.com/watch?v=dwDns8x3Jb4');
    expect(result.videoId).toBe('dwDns8x3Jb4');
    expect(result.url).toBe('https://stream.example/direct');
    expect(result.cached).toBe(false);
  });

  it('the protocol ladder retries the other address family before giving up', async () => {
    // The OS-preferred family gets bot-blocked; the forced-IPv4 retry
    // answers. The seam stands in for every attempt, succeeding on #2.
    let calls = 0;
    setYtDlpRunnerForTests((_query: string) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('Sign in to confirm you are not a bot'));
      return Promise.resolve([
        { videoId: 'abc123', durationSec: 200, url: 'https://stream.example/v4-retry' },
      ]);
    });

    const result = await resolveTrackStream(sqliteDb(), input({ key: 'ladderTrackId' }));

    expect(result.url).toBe('https://stream.example/v4-retry');
    expect(calls).toBe(2);
  });
});
