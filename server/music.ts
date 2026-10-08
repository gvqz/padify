/**
 * Padify API — free music endpoints (no account needed).
 *
 * The music player's server side: clients get full-song playback with no
 * Spotify login at all. Three pieces:
 *
 *   1. Metadata search — Spotify's public /v1/search (tracks only) through
 *      a Client-Credentials proxy when the app credentials below are set.
 *      The client never sees them. When they are NOT set, search falls back
 *      to YouTube itself: yt-dlp's flat playlist search, mapped into the
 *      same catalog shape, so the player works with zero configuration.
 *
 *   2. Stream resolution — given a track's title/artist/duration, run
 *      yt-dlp against YouTube search, pick the candidate whose duration is
 *      closest to the catalog duration, and return the direct `bestaudio`
 *      stream URL. Tracks that arrived from the fallback search carry an
 *      11-character YouTube video id, and resolve directly by that id —
 *      no second search needed (Spotify ids are 22 chars, so the two
 *      never collide).
 *
 *   3. The same yt-dlp guards apply to both paths: only the ~10 KB text
 *      URL crosses the wire — the audio flows client → googlevideo.com,
 *      never through this server, so the 10 GB/month AlwaysData bandwidth
 *      budget is essentially untouched.
 *
 * Resolutions are cached (SQLite + memory) keyed by track id with a
 * TTL well inside googlevideo URL lifetimes, so repeat plays are one cheap
 * SELECT. In-flight requests for the same track dedupe into one yt-dlp run,
 * and at most a couple of yt-dlp processes run at once to protect the
 * 128 MB RAM budget of small always-on hosts (a bestaudio resolution
 * peaks around ~55 MB; a flat search is ~2 MB).
 *
 * Environment:
 *   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET  — optional. App credentials
 *       for the catalog search (a Spotify app you own; no user login
 *       involved). When set they take precedence over the YouTube fallback.
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
const YTDLP_SEARCH_TIMEOUT_MS = 20_000;
const YTDLP_CANDIDATES = 3;
const MEMORY_CACHE_MAX = 200;
/** YouTube video ids are exactly 11 chars of [A-Za-z0-9_-]; Spotify's are 22. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

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

/** True when the Spotify catalog backend has its app credentials. */
function spotifyCatalogConfigured(): boolean {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

export function searchConfigured(): boolean {
  return spotifyCatalogConfigured() || resolveConfigured();
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
  artists: { name: string; uri: string }[];
  album: {
    id: string;
    uri: string;
    name: string | null;
    images: { url: string }[];
    artists?: { name: string; uri: string }[];
  };
  duration_ms: number;
  explicit: boolean;
  preview_url: string | null;
  is_playable?: boolean;
}

export async function musicSearch(q: string, limit: number): Promise<SearchTrack[]> {
  return spotifyCatalogConfigured() ? spotifySearch(q, limit) : youtubeSearch(q, limit);
}

async function spotifySearch(q: string, limit: number): Promise<SearchTrack[]> {
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
// Search fallback: yt-dlp's flat YouTube search, catalog-shaped
// ---------------------------------------------------------------------------

/** The slice of a flat-search entry the mapping reads (everything is best-effort). */
interface YtSearchEntry {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  channel?: unknown;
  uploader?: unknown;
  channel_id?: unknown;
  channel_url?: unknown;
  live_status?: unknown;
  thumbnails?: unknown;
  view_count?: unknown;
}

/**
 * Test seam for the flat-search runner, mirroring setYtDlpRunnerForTests
 * below: the vitest suite swaps the process out for a fake that returns
 * raw entries, so the mapping (title cleanup, artist split, artwork,
 * duration filters) runs under Node where Bun.spawn does not exist.
 */
let ytSearchRunnerForTests: ((q: string, limit: number) => Promise<unknown[]>) | null = null;

/** Test hook — see the seam doc above. */
export function setYtSearchRunnerForTests(
  runner: ((q: string, limit: number) => Promise<unknown[]>) | null,
): void {
  ytSearchRunnerForTests = runner;
}

/** Runs yt-dlp's fast flat search (no format extraction, ~2 MB of RAM). */
function runYtSearch(q: string, limit: number): Promise<unknown[]> {
  if (ytSearchRunnerForTests) {
    return ytSearchRunnerForTests(q, limit);
  }
  return new Promise<unknown[]>((resolve, reject) => {
    const proc = Bun.spawn(
      [
        YTDLP_PATH,
        '--no-warnings',
        '--flat-playlist',
        '--dump-single-json',
        `ytsearch${limit}:${q}`,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    );

    let settled = false;
    const done = (err: Error | null, out: string): void => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      try {
        const data = JSON.parse(out) as { entries?: unknown };
        resolve(Array.isArray(data.entries) ? data.entries : []);
      } catch {
        reject(new Error('yt-dlp search returned unusable JSON.'));
      }
    };

    const timer = setTimeout(() => {
      proc.kill();
      done(new Error('yt-dlp search timed out.'), '');
    }, YTDLP_SEARCH_TIMEOUT_MS);

    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([out, , code]) => {
        clearTimeout(timer);
        done(code === 0 ? null : new Error(`yt-dlp search exited with code ${code}.`), out);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        done(error instanceof Error ? error : new Error('yt-dlp search failed.'), '');
      });
  });
}

/** One retry after a beat — YouTube's soft rate limits are transient. */
const SEARCH_RETRY_DELAY_MS = 900;

async function runYtSearchWithRetry(q: string, limit: number): Promise<unknown[]> {
  try {
    return await runYtSearch(q, limit);
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_RETRY_DELAY_MS));
    try {
      return await runYtSearch(q, limit);
    } catch {
      throw first; // surface the original failure
    }
  }
}

/** Parenthesized/bracketed suffixes that carry no song information. */
const TITLE_NOISE =
  /official|audio|video|lyrics?|lyrical|visualizer|visualiser|hd|hq|4k|1080p|720p|mv|remaster|mono|stereo|full\s+song|single|explicit|clean|edit|version|album|radio|audio\s+only/i;

/** Bare, unbracketed trailers: "Song Official Music Video", "Song HD 1080p". */
const TITLE_TAIL_NOISE =
  /\s+((official\s+)?(music\s+)?(video|audio|visuali[sz]er|lyrics?))\s*$/i;
const TITLE_TAIL_QUALITY = /\s+((hd|hq|4k|1080p|720p)(\s+remastered)?)\s*$/i;

/** Drops trailing "(Official Audio)"-style suffixes, repeatedly. */
function cleanTrackTitle(raw: string): string {
  let title = raw.trim();
  // Leading bracket noise first: "[Official Video] Song".
  for (;;) {
    const lead = title.match(/^\s*[([{]([^()[\]{}]*)[)}\]]\s+/);
    if (!lead || !TITLE_NOISE.test(lead[1] ?? '')) break;
    title = title.slice((lead.index ?? 0) + lead[0].length).trim();
  }
  // Then trailing "(Official Audio)" suffixes.
  for (;;) {
    const match = title.match(/\s+[([{]([^()[\]{}]*)[)}\]]\s*$/);
    if (!match || !TITLE_NOISE.test(match[1] ?? '')) break;
    title = title.slice(0, match.index ?? 0).trim();
  }
  // Then bare trailers: "Song Official Music Video", "Song HD 1080p" —
  // repeatedly, so "HD 1080p" loses both tokens.
  for (;;) {
    const next = title.replace(TITLE_TAIL_NOISE, '').replace(TITLE_TAIL_QUALITY, '').trim();
    if (next === title) break;
    title = next;
  }
  return title || raw.trim();
}

/** "Daft Punk - Topic" (auto-generated music channels) → "Daft Punk". */
function cleanChannelName(entry: YtSearchEntry): string {
  const raw = typeof entry.channel === 'string' && entry.channel.trim()
    ? entry.channel
    : typeof entry.uploader === 'string'
      ? entry.uploader
      : '';
  return raw.replace(/\s*-\s*Topic$/i, '').trim();
}

/** "Artist - Song" titles (also en/em dashes, "Artist | Song") split into
 *  their two halves; anything else stays whole. */
const TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' | '];

function splitTitle(title: string, channel: string): { name: string; artist: string } {
  for (const separator of TITLE_SEPARATORS) {
    const dash = title.indexOf(separator);
    if (dash > 0 && dash <= 80) {
      const artist = title.slice(0, dash).trim();
      const name = title.slice(dash + separator.length).trim();
      if (artist && name) return { name, artist };
    }
  }
  return { name: title, artist: channel || 'YouTube' };
}

/** The largest thumbnail yt-dlp reported, or the always-available one. */
function entryThumbnail(entry: YtSearchEntry, id: string): { url: string }[] {
  if (Array.isArray(entry.thumbnails)) {
    const best = [...entry.thumbnails]
      .filter((t): t is { url: string } => Boolean(t) && typeof (t as { url?: unknown }).url === 'string')
      .map((t) => ({ url: (t as { url: string }).url }))
      .pop();
    if (best) return [best];
  }
  return [{ url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }];
}

/** True when the flat entry came from an auto-generated "X - Topic" channel. */
function isTopicChannel(entry: YtSearchEntry): boolean {
  const raw =
    typeof entry.channel === 'string' && entry.channel.trim()
      ? entry.channel
      : typeof entry.uploader === 'string'
        ? entry.uploader
        : '';
  return /\s-\s*Topic$/i.test(raw);
}

/** The entry's view count, when yt-dlp reported one (ranking only). */
function entryViewCount(entry: YtSearchEntry): number {
  return typeof entry.view_count === 'number' && entry.view_count > 0 ? entry.view_count : 0;
}

/** Maps flat-search entries into the catalog shape the player renders. */
function youtubeTrackFrom(entry: YtSearchEntry): SearchTrack | null {
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (!YT_ID.test(id)) return null; // not a video we can resolve later
  if (entry.live_status === 'is_live') return null; // no length to align against
  const durationSec =
    typeof entry.duration === 'number' && entry.duration > 0 ? Math.round(entry.duration) : null;
  if (durationSec === null) return null; // live/unknown length — skip, not a song row

  const rawTitle = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : '';
  if (!rawTitle) return null;
  const channel = cleanChannelName(entry);
  const { name, artist } = splitTitle(cleanTrackTitle(rawTitle), channel);
  const artistUri =
    typeof entry.channel_url === 'string' && entry.channel_url ? entry.channel_url : '';
  const channelId = typeof entry.channel_id === 'string' ? entry.channel_id : '';

  return {
    id,
    uri: `youtube:video:${id}`,
    name,
    artists: [{ name: artist, uri: artistUri }],
    album: {
      id: channelId,
      uri: artistUri,
      name: 'YouTube',
      images: entryThumbnail(entry, id),
      artists: [{ name: artist, uri: artistUri }],
    },
    duration_ms: durationSec * 1000,
    explicit: false,
    preview_url: null,
    is_playable: true,
  };
}

// ---- catalog quality: junk filter, dedupe, ranking -------------------------

/**
 * Titles that mark a video as NOT the song itself: hour-long dumps, loops,
 * compilations, reactions, karaoke/instrumental stand-ins, nightcore edits.
 * Deliberately keeps remixes and live performances — those are real tracks.
 */
const JUNK_TITLE =
  /\b\d{1,2}\s*(hour|hr|hours|hrs)\b|\bhour\s+long\b|\bextended\b|\bloop(s|ed)?\b|\bcompilation\b|\bfull\s+album\b|\bcomplete\s+album\b|\bnon[-\s]?stop\b|\breaction\b|\breacts?\b|\bkaraoke\b|\binstrumental\b|\btutorial\b|\bhow\s+to\s+play\b|\bblack\s+screen\b|\bnightcore\b|\bsped\s+up\b|\bspeed\s+up\b|\bslowed\b|\b8d\b|\basmr\b|\bmashup\b|\bmedley\b|\bbest\s+of\s+(the\s+)?(19|20)\d\d\b|\bgreatest\s+hits\b|\btop\s+\d+\b|\b24\/7\b|\bplaylist\b|\bsong\s+of\s+the\s+day\b|\bsong\s+des\s+tages\b|\bin\s+reverse\b|\breversed\b/i;

/** Song rows shorter/longer than this are clips or dumps, not tracks. */
const MIN_SONG_SEC = 40;
const MAX_SONG_SEC = 1200;

/** Lowercased alphanumerics only — the dedupe spelling of artist + name. */
function dedupeKey(artist: string, name: string): string {
  const norm = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/(^|\s)the\s/g, ' ')
      .replace(/[^a-z0-9]+/g, '');
  return `${norm(artist)}|${norm(name)}`;
}

interface RankedEntry {
  entry: YtSearchEntry;
  track: SearchTrack;
  key: string;
  topic: boolean;
  views: number;
  index: number; // YouTube's own relevance position
}

/**
 * The catalog pass: filter junk, dedupe (one row per song, the best video
 * for it), then surface the official "- Topic" uploads at the top while
 * keeping YouTube's relevance order within each group.
 */
function buildCatalog(entries: unknown[], limit: number): SearchTrack[] {
  const ranked: RankedEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as YtSearchEntry;
    if (
      typeof raw.duration === 'number' &&
      (raw.duration < MIN_SONG_SEC || raw.duration > MAX_SONG_SEC)
    ) {
      continue; // shorts/clip dumps — not song rows
    }
    if (JUNK_TITLE.test(typeof raw.title === 'string' ? raw.title : '')) continue;
    const track = youtubeTrackFrom(raw);
    if (!track) continue;
    const artist = track.artists[0]?.name ?? '';
    ranked.push({
      entry: raw,
      track,
      key: dedupeKey(artist, track.name),
      topic: isTopicChannel(raw),
      views: entryViewCount(raw),
      index: ranked.length,
    });
  }

  // One row per song: keep the group's best video (official Topic upload
  // first, then the most-viewed, then the plainer title) at the position of
  // its first appearance.
  const bestByKey = new Map<string, RankedEntry>();
  for (const item of ranked) {
    const incumbent = bestByKey.get(item.key);
    const beats =
      !incumbent ||
      (item.topic && !incumbent.topic) ||
      (item.topic === incumbent.topic &&
        (item.views > incumbent.views ||
          (item.views === incumbent.views &&
            item.track.name.length < incumbent.track.name.length)));
    if (beats) {
      const withPos = { ...item, index: incumbent ? incumbent.index : item.index };
      bestByKey.set(item.key, withPos);
    }
  }

  return [...bestByKey.values()]
    .sort((a, b) => (b.topic ? 1 : 0) - (a.topic ? 1 : 0) || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.track);
}

async function youtubeSearch(q: string, limit: number): Promise<SearchTrack[]> {
  // Over-fetch on purpose: filtering + dedupe trim the raw list back down,
  // so the user still sees `limit` clean rows instead of a thin, junky page.
  const fetch = Math.min(40, limit + 12);
  const entries = await runYtSearchWithRetry(q, fetch);
  return buildCatalog(entries, limit);
}

// ---------------------------------------------------------------------------
// yt-dlp: availability probe + guarded execution
// ---------------------------------------------------------------------------

let ytDlpAvailable: boolean | null = null;

export function resolveConfigured(): boolean {
  if (ytDlpAvailable === null) {
    // typeof guard: the vitest suite imports this module under Node, where
    // the Bun global (and Bun.which) does not exist — production always runs Bun.
    ytDlpAvailable = typeof Bun !== 'undefined' && Boolean(Bun.which(YTDLP_PATH));
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
  ytSearchRunnerForTests = null;
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
    const candidates = await runYtDlp(buildResolveQuery(input));
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

/**
 * What the resolver asks yt-dlp for: tracks whose id is a YouTube video id
 * (they arrived from the fallback search) resolve directly by that id —
 * Spotify's 22-character ids fall back to the title/artist search.
 */
function buildResolveQuery(input: { key: string; title: string; artist: string }): string {
  if (YT_ID.test(input.key)) {
    return `https://www.youtube.com/watch?v=${input.key}`;
  }
  return buildSearchQuery(input.title, input.artist);
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
    return json(
      request,
      { error: 'Free search is not configured on this server (no Spotify credentials, no yt-dlp).' },
      503,
    );
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
