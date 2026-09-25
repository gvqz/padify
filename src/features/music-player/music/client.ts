/**
 * Free-music client — the browser half of the no-login path.
 *
 * Talks to the Padify API's public music endpoints (server/music.ts):
 *
 *   /api/music/capabilities → what this deployment supports
 *   /api/music/search       → Spotify catalog metadata (Client Credentials)
 *   /api/music/resolve      → a direct audio stream URL for a track
 *
 * Everything here works without a Spotify login. Search results are shaped
 * exactly like `SpotifyTrack` so the player renders one row component for
 * both the free and the connected path.
 */

import { getCloudConfig } from '../../../cloud/config';
import type { SpotifyTrack } from '../spotify/api';

export interface MusicCapabilities {
  search: boolean;
  resolve: boolean;
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
let cachedCapabilities: { value: MusicCapabilities; at: number } | null = null;

function api(path: string): string {
  return `${getCloudConfig().apiBase}${path}`;
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

/** Cheap probe the player shows once per session (5 min client cache). */
export async function fetchMusicCapabilities(): Promise<MusicCapabilities> {
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < CAPABILITIES_TTL_MS) {
    return cachedCapabilities.value;
  }
  let value: MusicCapabilities = { search: false, resolve: false };
  try {
    const response = await fetch(api('/api/music/capabilities'));
    if (response.ok) {
      const data = (await response.json()) as { search?: boolean; resolve?: boolean };
      value = {
        search: Boolean(data.search),
        resolve: Boolean(data.resolve),
      };
    }
  } catch {
    /* offline / static-only deploy — defaults stand */
  }
  cachedCapabilities = { value, at: Date.now() };
  return value;
}

/**
 * Free catalog search. Throws FreeMusicError with a human-readable message
 * (including "not configured" guidance when the server lacks credentials).
 */
export async function freeSearchTracks(q: string, limit = 24): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, limit: String(Math.min(30, Math.max(1, limit))) });
  let response: Response;
  try {
    response = await fetch(api(`/api/music/search?${params.toString()}`));
  } catch {
    throw new FreeMusicError('Could not reach the music service — check your connection.');
  }
  if (!response.ok) {
    throw new FreeMusicError(await readError(response), response.status === 503);
  }
  const data = (await response.json()) as { tracks?: SpotifyTrack[] };
  return (data.tracks ?? []).filter((track) => track && typeof track.uri === 'string');
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
      response = await fetch(api(`/api/music/resolve?${params.toString()}`));
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
