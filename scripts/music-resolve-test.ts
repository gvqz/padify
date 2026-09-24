/**
 * Unit-style test for the yt-dlp resolver in server/music.ts using a fake
 * yt-dlp binary. Verifies: candidate parsing, duration-based selection,
 * SQLite + memory caching, fresh-bypass, and in-flight dedupe.
 *
 * Run: bun scripts/music-resolve-test.ts
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// --- fake yt-dlp -------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'ytdlp-'));
const fakeBin = join(dir, 'yt-dlp');

// Call counter lives on disk so successive "processes" see it.
const counterFile = join(dir, 'calls');

const fakeScript = `#!/bin/sh
n=$(cat ${counterFile} 2>/dev/null || echo 0)
n=$((n + 1))
echo $n > ${counterFile}
# Every call must be a search-based resolve (not a download).
echo "$@" | grep -q "ytsearch" || { echo "not a search call" >&2; exit 9; }
if [ "$n" -eq 3 ]; then
  # "fresh" re-resolve returns a new winner only.
  printf '%b\\n' 'zzz999\\t199\\thttps://stream.example/fresh'
else
  printf '%b\\n' 'abc123\\t200\\thttps://stream.example/first' 'def456\\t42\\thttps://stream.example/short' 'live000\\tNA\\thttps://stream.example/live'
fi
exit 0
`;
writeFileSync(fakeBin, fakeScript, { mode: 0o755 });
chmodSync(fakeBin, 0o755);
process.env.YTDLP_PATH = fakeBin;
writeFileSync(counterFile, '0');

// Import AFTER the env var is set.
const { resolveTrackStream, pick } = await import('../server/music.js');
const resolve = resolveTrackStream as unknown as (
  db: unknown,
  input: {
    key: string;
    title: string;
    artist: string;
    durationMs: number | null;
    fresh: boolean;
  },
) => Promise<{ url: string; videoId: string; durationSec: number | null; cached: boolean }>;

// --- local sqlite db -----------------------------------------------------------

const dbFile = join(dir, 'test.db');
const db = new Database(dbFile);
db.run(`create table if not exists music_resolutions (
  key text primary key, video_id text not null, url text not null,
  duration_sec integer, resolved_at integer not null default 0, expires_at integer not null)`);
const dbAdapter = {
  all: (sql: string, args: unknown[]) => db.query(sql).all(...(args ?? [])) as unknown[],
  run: (sql: string, args: unknown[]) => {
    db.run(sql, ...(args ?? []));
  },
  runMany: () => undefined,
  kind: 'sqlite',
};

const input = {
  key: '0VjIjW4GlUSh6m7YnU3fY3',
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  durationMs: 200040,
  fresh: false,
};

const readCalls = (): number => Number(require('node:fs').readFileSync(counterFile, 'utf8').trim());

// --- the actual assertions ------------------------------------------------------

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures += 1;
};

// 1. First resolve: picks the candidate closest to 200.04 s (abc123).
const first = await resolve(dbAdapter, { ...input });
check('picks duration-matched candidate (abc123)', first.videoId === 'abc123');
check('returns the direct stream url', first.url === 'https://stream.example/first');
check('reports durationSec', first.durationSec === 200);
check('not served from cache', first.cached === false);
check('ran exactly one yt-dlp process', readCalls() === 1);

// 2. Second resolve (same key): served from cache, no new process.
const second = await resolve(dbAdapter, { ...input });
check('second resolve is cached', second.cached === true);
check('cache hits the same url', second.url === first.url);
check('no extra yt-dlp run for cached track', readCalls() === 1);

// 3. Two concurrent resolves of the same key dedupe into one process.
const [a, b] = await Promise.all([
  resolve(dbAdapter, { ...input, key: 'concurrentTrackId', fresh: false }),
  resolve(dbAdapter, { ...input, key: 'concurrentTrackId', fresh: false }),
]);
check('concurrent resolves share one result', a.url === b.url);
check('concurrent resolves ran one process', readCalls() === 2);

// 4. fresh=1 bypasses the cache and re-resolves.
const fresh = await resolve(dbAdapter, { ...input, fresh: true });
check('fresh resolve re-runs yt-dlp', readCalls() === 3);
check('fresh resolve wins the new candidate', fresh.videoId === 'zzz999');
check('fresh resolve reports not-cached', fresh.cached === false);

// 5. No expected duration → first usable candidate.
const noDur = await resolve(dbAdapter, {
  key: 'noDurationTrackId00',
  title: 'Song',
  artist: 'Artist',
  durationMs: null,
  fresh: false,
});
check('no-duration resolve falls back to first candidate', noDur.videoId === 'abc123');

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL RESOLVER TESTS PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
