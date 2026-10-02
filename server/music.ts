/**
 * Padify API — free music endpoints (no account needed).
 *
 * The "free path" of the music player: clients that are NOT connected to a
 * personal Spotify account still get full-song playback. Two pieces:
 *
 *   1. Metadata search — a Client-Credentials proxy for Spotify's public
 *      /v1/search (tracks only). The client never sees app credentials.
 *
 *   2. Stream resolution — given a track's title/artist/duration, run
 *      yt-dlp against YouTube search, pick the candidate whose duration is
 *      closest to the Spotify duration, and return the direct `bestaudio`
 *      stream URL. Only the ~10 KB text URL crosses the wire — the audio
 *      flows client → googlevideo.com, never through this server, so the
 *      10 GB/month AlwaysData bandwidth budget is essentially untouched.
 *
 * Resolutions are cached (SQLite + memory) keyed by Spotify track id with a
 * TTL well inside googlevideo URL lifetimes, so repeat plays are one cheap
 * SELECT. In-flight requests for the same track dedupe into one yt-dlp run,
 * and at most a couple of yt-dlp processes run at once to protect the
 * 128 MB RAM budget of small always-on hosts.
 *
 * Environment:
 *   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET  — app credentials for the
 *       catalog search (same Spotify app the user connects with works).
 *   SPOTIFY_MARKET  — optional market code for search (e.g. "US").
 *   YTDLP_PATH      — override the yt-dlp binary location.
 *   MUSIC_RESOLVE_CONCURRENCY — simultaneous yt-dlp processes (default 2).
 */

import type { Db, SqlValue } from './db';

const DAY_MS = 86_400_000;
/** googlevideo URLs live ~6h; refresh comfortably before that. */
const RESOLVE_TTL_MS = 3 * 60 * 60 * 1000;
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SEARCH_URL = 'https://api.spotify.com/v1/search';
const YTDLP_TIMEOUT_MS = 30_000;
const YTDLP_CANDIDATES = 3;
const MEMORY_CACHE_MAX = 200;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? '';
const SPOTIFY_MARKET = (process.env.SPOTIFY_MARKET ?? '').trim().toUpperCase();
const YTDLP_PATH = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
const RESOLVE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.MUSIC_RESOLVE_CONCURRENCY ?? '2') || 2),
);

// ---------------------------------------------------------------------------
// Client-Credentials token (catalog access, no user)
// ---------------------------------------------------------------------------

let appToken: { value: string; expiresAt: number } | null = null;

export function searchConfigured(): boolean {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

async function getAppToken(): Promise<string> {
  if (appToken && Date.now() < appToken.expiresAt - 60_000) {
    return appToken.value;
  }
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Spotify token endpoint responded ${response.status}`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Spotify token response missing access_token');
  }
  appToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return appToken.value;
}

// ---------------------------------------------------------------------------
// Search: proxy /v1/search (tracks), trimmed to what the player renders
// ---------------------------------------------------------------------------

interface SearchTrack {
  id: string;
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string | null; images: { url: string }[] };
  duration_ms: number;
  explicit: boolean;
  preview_url: string | null;
  is_playable?: boolean;
}

export async function musicSearch(q: string, limit: number): Promise<SearchTrack[]> {
  const token = await getAppToken();
  const params = new URLSearchParams({
    q,
    type: 'track',
    limit: String(limit),
  });
  if (SPOTIFY_MARKET) params.set('market', SPOTIFY_MARKET);

  const response = await fetch(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 401) {
      appToken = null; // stale cached token — next call re-fetches
    }
    throw new Error(`Spotify search responded ${response.status}`);
  }
  const data = (await response.json()) as {
    tracks?: { items?: unknown[] };
  };
  return (data.tracks?.items ?? []).filter(isRenderableTrack);
}

function isRenderableTrack(value: unknown): value is SearchTrack {
  if (!value || typeof value !== 'object') return false;
  const track = value as Record<string, unknown>;
  return (
    typeof track.id === 'string' &&
    typeof track.uri === 'string' &&
    typeof track.name === 'string' &&
    Array.isArray(track.artists)
  );
}

// ---------------------------------------------------------------------------
// yt-dlp: availability probe + guarded execution
// ---------------------------------------------------------------------------

let ytDlpAvailable: boolean | null = null;

export function resolveConfigured(): boolean {
  if (ytDlpAvailable === null) {
    ytDlpAvailable = Boolean(Bun.which(YTDLP_PATH));
  }
  return ytDlpAvailable;
}

/** Small semaphore so a burst of plays can't fan out into many processes. */
let activeResolvers = 0;
const resolverQueue: (() => void)[] = [];

async function withResolverSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeResolvers >= RESOLVE_CONCURRENCY) {
    await new Promise<void>((resolve) => resolverQueue.push(resolve));
  }
  activeResolvers += 1;
  try {
    return await task();
  } finally {
    activeResolvers -= 1;
    const next = resolverQueue.shift();
    if (next) next();
  }
}

interface Candidate {
  videoId: string;
  durationSec: number | null;
  url: string;
}

/**
 * Test seam for the yt-dlp process runner. Production runs Bun.spawn
 * (below); the vitest suite (src/server-music-resolve.test.ts) swaps in a
 * fake so the whole resolver pipeline — candidate parsing, duration
 * selection, SQLite + memory caching, fresh-bypass, in-flight dedupe —
 * runs under Node, where Bun.spawn does not exist. The old coverage was
 * a hand-rolled bun-only script outside CI; the seam puts it in `npm run
 * test` with the rest of the gates. Null restores the real runner.
 */
let ytDlpRunnerForTests: ((query: string) => Promise<Candidate[]>) | null = null;

/** Test hook — see the seam doc above. */
export function setYtDlpRunnerForTests(
  runner: ((query: string) => Promise<Candidate[]>) | null,
): void {
  ytDlpRunnerForTests = runner;
}

/** Test hook — clears the memory cache and the in-flight dedupe map. */
export function resetMusicResolverForTests(): void {
  memoryCache.clear();
  inFlight.clear();
}

/** Runs yt-dlp over YouTube search and returns the parsed candidates. */
function runYtDlp(query: string): Promise<Candidate[]> {
  if (ytDlpRunnerForTests) {
    return ytDlpRunnerForTests(query);
  }
  return withResolverSlot(
    () =>
      new Promise<Candidate[]>((resolve, reject) => {
        const proc = Bun.spawn(
          [
            YTDLP_PATH,
            '--no-warnings',
            '--skip-download',
            '--quiet',
            '--simulate',
            '-f',
            'bestaudio',
            '--print',
            '%(id)s\t%(duration)s\t%(url)s',
            `ytsearch${YTDLP_CANDIDATES}:${query}`,
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'ignore',
          },
        );

        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('yt-dlp timed out.'));
        }, YTDLP_TIMEOUT_MS);

        const done = (err: Error | null, out: string): void => {
          clearTimeout(timer);
          if (err) {
            reject(err);
            return;
          }
          const candidates: Candidate[] = [];
          for (const line of out.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const [videoId, duration, url] = trimmed.split('\t');
            if (!videoId || !url || !url.startsWith('http')) continue;
            const dur = Number(duration);
            candidates.push({
              videoId,
              durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
              url,
            });
          }
          if (candidates.length === 0) {
            reject(new Error('No playable audio found.'));
            return;
          }
          resolve(candidates);
        };

        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
          .then(([out, , code]) => {
            done(code === 0 ? null : new Error(`yt-dlp exited with code ${code}.`), out);
          })
          .catch((error: unknown) => done(error as Error, ''));
      }),
  );
}

/** Pick the candidate whose duration best matches the Spotify duration. */
function pickCandidate(
  candidates: Candidate[],
  targetSec: number | null,
): Candidate | null {
  const usable = candidates.filter((c) => c.url && c.videoId);
  if (usable.length === 0) return null;
  if (!targetSec || targetSec <= 0) return usable[0];
  let best: Candidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of usable) {
    if (candidate.durationSec === null) continue;
    const score = Math.abs(candidate.durationSec - targetSec);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best ?? usable[0];
}

// ---------------------------------------------------------------------------
// Resolution cache (memory + SQLite) with in-flight dedupe
// ---------------------------------------------------------------------------

export interface ResolvedStream {
  url: string;
  videoId: string;
  durationSec: number | null;
  cached: boolean;
}

interface CacheRow {
  video_id: string;
  url: string;
  duration_sec: number | null;
  expires_at: number;
}

const memoryCache = new Map<string, CacheRow>();
const inFlight = new Map<string, Promise<ResolvedStream>>();

function rememberRow(key: string, row: CacheRow): void {
  memoryCache.set(key, row);
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
}

async function readCache(db: Db, key: string): Promise<CacheRow | null> {
  const mem = memoryCache.get(key);
  if (mem && mem.expires_at > Date.now()) return mem;

  try {
    const rows = await db.all(
      'select video_id, url, duration_sec, expires_at from music_resolutions where key = ?',
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    const parsed: CacheRow = {
      video_id: String(row.video_id),
      url: String(row.url),
      duration_sec: row.duration_sec === null ? null : Number(row.duration_sec),
      expires_at: Number(row.expires_at),
    };
    if (parsed.expires_at <= Date.now()) {
      await db
        .run('delete from music_resolutions where key = ?', [key])
        .catch(() => undefined);
      return null;
    }
    rememberRow(key, parsed);
    return parsed;
  } catch {
    return null; // cache table missing/unavailable — resolution still works
  }
}

async function writeCache(db: Db, key: string, row: CacheRow): Promise<void> {
  rememberRow(key, row);
  try {
    await db.run(
      `insert into music_resolutions (key, video_id, url, duration_sec, resolved_at, expires_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(key) do update set
         video_id = excluded.video_id,
         url = excluded.url,
         duration_sec = excluded.duration_sec,
         resolved_at = excluded.resolved_at,
         expires_at = excluded.expires_at`,
      [key, row.video_id, row.url, row.duration_sec, Date.now(), row.expires_at] as SqlValue[],
    );
  } catch {
    /* cache write is best-effort */
  }
}

/**
 * Resolves a direct audio stream URL for a track. `fresh` bypasses the
 * cached URL (the client asks for this when a previously served URL fails
 * to play — googlevideo links die after a few hours).
 */
export async function resolveTrackStream(
  db: Db,
  input: {
    key: string;
    title: string;
    artist: string;
    durationMs: number | null;
    fresh: boolean;
  },
): Promise<ResolvedStream> {
  const pending = inFlight.get(input.key);
  if (pending) return pending;

  const task = (async (): Promise<ResolvedStream> => {
    if (!input.fresh) {
      const cached = await readCache(db, input.key);
      if (cached) {
        return {
          url: cached.url,
          videoId: cached.video_id,
          durationSec: cached.duration_sec,
          cached: true,
        };
      }
    }

    const targetSec =
      input.durationMs && input.durationMs > 0 ? Math.round(input.durationMs / 1000) : null;
    const query = buildSearchQuery(input.title, input.artist);
    const candidates = await runYtDlp(query);
    const chosen = pickCandidate(candidates, targetSec);
    if (!chosen) {
      throw new Error('No playable audio found.');
    }

    const row: CacheRow = {
      video_id: chosen.videoId,
      url: chosen.url,
      duration_sec: chosen.durationSec,
      expires_at: Date.now() + RESOLVE_TTL_MS,
    };
    await writeCache(db, input.key, row);
    return {
      url: chosen.url,
      videoId: chosen.videoId,
      durationSec: chosen.durationSec,
      cached: false,
    };
  })();

  inFlight.set(input.key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(input.key);
  }
}

function buildSearchQuery(title: string, artist: string): string {
  const parts = [artist, title].map((part) => part.trim()).filter(Boolean);
  return `${parts.join(' - ')} audio`.slice(0, 200);
}

/** Housekeeping for boot: drop resolution rows that are long dead. */
export async function sweepMusicCache(db: Db): Promise<void> {
  try {
    await db.run('delete from music_resolutions where expires_at <= ?', [Date.now() - DAY_MS]);
  } catch {
    /* table may not exist on first boot before applySchema */
  }
}

// ---------------------------------------------------------------------------
// Route handlers — the no-login endpoints, HTTP-shaped.
// ---------------------------------------------------------------------------

import { json } from './http';
import { asInt } from './notes';

export async function handleMusicCapabilities(request: Request): Promise<Response> {
  return json(request, { search: searchConfigured(), resolve: resolveConfigured() });
}

export async function handleMusicSearch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const limit = Math.min(30, Math.max(1, asInt(url.searchParams.get('limit'), 20)));
  if (q.length < 1) {
    return json(request, { error: 'Missing search query.' }, 400);
  }
  if (!searchConfigured()) {
    return json(request, {
      error: 'Free search is not configured on this server (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing).'
    }, 503);
  }
  try {
    const tracks = await musicSearch(q, limit);
    return json(request, { tracks });
  } catch {
    return json(request, { error: 'Search is temporarily unavailable — try again.' }, 502);
  }
}

export async function handleMusicResolve(db: Db, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const trackId = (url.searchParams.get('trackId') ?? '').trim();
  const title = (url.searchParams.get('title') ?? '').trim().slice(0, 200);
  const artist = (url.searchParams.get('artist') ?? '').trim().slice(0, 300);
  const durationMs = asInt(url.searchParams.get('durationMs'), 0);
  const fresh = url.searchParams.get('fresh') === '1';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(trackId)) {
    return json(request, { error: 'Missing or invalid track id.' }, 400);
  }
  if (!title) {
    return json(request, { error: 'Missing track title.' }, 400);
  }
  if (!resolveConfigured()) {
    return json(request, {
      error: 'Free playback is not configured on this server (yt-dlp missing).'
    }, 503);
  }
  try {
    const stream = await resolveTrackStream(db, {
      key: trackId,
      title,
      artist,
      durationMs: durationMs > 0 ? durationMs : null,
      fresh
    });
    return json(request, stream);
  } catch (error) {
    const message = error instanceof Error && /timed out/.test(error.message)
      ? 'Resolving this song took too long — try again.'
      : 'Could not find a stream for this song.';
    return json(request, { error: message }, 404);
  }
}
