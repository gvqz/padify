/**
 * Free-music client — the browser half of the no-login path.
 *
 * Talks to the Padify API's public music endpoints (server/music.ts):
 *
 *   /api/music/capabilities → what this deployment supports
 *   /api/music/search       → catalog metadata (Spotify's catalog when the
 *                              API has app credentials, YouTube results
 *                              mapped into the same shape otherwise)
 *   /api/music/resolve      → a direct audio stream URL for a track
 *
 * Everything here works without a Spotify login. Search results are shaped
 * exactly like `SpotifyTrack` (see ../types.ts) so the player renders one
 * row component for whichever backend the API used.
 */

import { getCloudConfig } from '../../../cloud/config';
import type { SpotifyTrack } from '../types';

export interface MusicCapabilities {
  search: boolean;
  resolve: boolean;
  /** The server's own reason when a capability is off ("no Spotify
   * credentials, no yt-dlp") — surfaced to the user instead of the
   * generic "looks offline" copy that hid the real cause. */
  reason?: string;
}

export interface ResolvedStream {
  url: string;
  videoId: string;
  durationSec: number | null;
  cached: boolean;
}

export class FreeMusicError extends Error {
  /** 503-style "not configured on this server" vs a transient failure. */
  unavailable: boolean;

  constructor(message: string, unavailable = false) {
    super(message);
    this.name = 'FreeMusicError';
    this.unavailable = unavailable;
  }
}

const CAPABILITIES_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000; // generous: a cold-booting host takes seconds
const RETRY_DELAY_MS = 700;
let cachedCapabilities: { value: MusicCapabilities; at: number } | null = null;

function api(path: string): string {
  return `${getCloudConfig().apiBase}${path}`;
}

/** fetch + timeout, so a wedged request can't hang a check forever. */
async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    /* non-JSON body */
  }
  return `The music service responded ${response.status}.`;
}

async function fetchCapabilitiesOnce(): Promise<MusicCapabilities> {
  let response: Response;
  try {
    response = await fetchWithTimeout(api('/api/music/capabilities'));
  } catch {
    // Network failure / timeout — often the host cold-booting. Worth one
    // immediate retry before reporting the API as offline.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      response = await fetchWithTimeout(api('/api/music/capabilities'));
    } catch {
      return { search: false, resolve: false };
    }
  }
  if (!response.ok) return { search: false, resolve: false };
  try {
    const data = (await response.json()) as {
      search?: boolean;
      resolve?: boolean;
      reason?: string;
    };
    return {
      search: Boolean(data.search),
      resolve: Boolean(data.resolve),
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    };
  } catch {
    return { search: false, resolve: false };
  }
}

/**
 * Cheap probe the player shows once per session (5 min client cache).
 * Only *successful* answers are cached — a timed-out probe (the host was
 * cold-booting) must not poison the session for the next five minutes,
 * which is exactly how "music sometimes doesn't show up" felt.
 */
export async function fetchMusicCapabilities(): Promise<MusicCapabilities> {
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < CAPABILITIES_TTL_MS) {
    return cachedCapabilities.value;
  }
  const value = await fetchCapabilitiesOnce();
  const trustworthy = value.search || value.resolve;
  if (trustworthy) {
    cachedCapabilities = { value, at: Date.now() };
  } else {
    cachedCapabilities = null; // never cache an offline/unconfigured answer
  }
  return value;
}

/** Test hook — clears the capability cache between cases. */
export function resetMusicClientForTests(): void {
  cachedCapabilities = null;
}

async function searchOnce(q: string, limit: number): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, limit: String(Math.min(30, Math.max(1, limit))) });
  let response: Response;
  try {
    response = await fetchWithTimeout(api(`/api/music/search?${params.toString()}`));
  } catch {
    throw new FreeMusicError('Could not reach the music service — check your connection.', true);
  }
  if (!response.ok) {
    throw new FreeMusicError(await readError(response), response.status === 503);
  }
  const data = (await response.json()) as { tracks?: SpotifyTrack[] };
  return (data.tracks ?? []).filter((track) => track && typeof track.uri === 'string');
}

/**
 * Free catalog search. Transient failures (a cold-booting host, a blip)
 * get one automatic retry before the user sees an error; a 503 "not
 * configured on this server" is permanent and surfaces immediately.
 */
export async function freeSearchTracks(q: string, limit = 24): Promise<SpotifyTrack[]> {
  try {
    return await searchOnce(q, limit);
  } catch (err) {
    if (err instanceof FreeMusicError && !err.unavailable) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return searchOnce(q, limit);
    }
    throw err;
  }
}

const pendingResolves = new Map<string, Promise<ResolvedStream>>();

/**
 * Resolves a direct, playable audio URL for a track (no login required).
 * `fresh` asks the server to bypass its URL cache — used when a previously
 * returned URL fails to play (googlevideo links expire after a few hours).
 */
export function resolveTrackStream(
  input: {
    trackId: string;
    title: string;
    artist: string;
    durationMs: number | null;
  },
  fresh = false,
): Promise<ResolvedStream> {
  const pending = pendingResolves.get(input.trackId);
  if (pending && !fresh) return pending;

  const task = (async (): Promise<ResolvedStream> => {
    const params = new URLSearchParams({
      trackId: input.trackId,
      title: input.title,
      artist: input.artist,
    });
    if (input.durationMs && input.durationMs > 0) {
      params.set('durationMs', String(Math.round(input.durationMs)));
    }
    if (fresh) params.set('fresh', '1');

    let response: Response;
    try {
      // Same timeout as every other call — a wedged resolve used to pin
      // the bar on "Finding a stream…" forever with no way out.
      response = await fetchWithTimeout(api(`/api/music/resolve?${params.toString()}`));
    } catch {
      throw new FreeMusicError('Could not reach the music service — check your connection.');
    }
    if (!response.ok) {
      throw new FreeMusicError(await readError(response), response.status === 503);
    }
    const data = (await response.json()) as Partial<ResolvedStream>;
    if (!data.url || !data.url.startsWith('http')) {
      throw new FreeMusicError('The music service returned an unusable stream.');
    }
    return {
      url: data.url,
      videoId: data.videoId ?? '',
      durationSec: data.durationSec ?? null,
      cached: Boolean(data.cached),
    };
  })();

  pendingResolves.set(input.trackId, task);
  void task
    .catch(() => undefined)
    .then(() => {
      if (pendingResolves.get(input.trackId) === task) pendingResolves.delete(input.trackId);
    });
  return task;
}
