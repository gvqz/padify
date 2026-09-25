/**
 * Typed Spotify Web API client.
 *
 * Every call goes through `request()` which attaches a bearer token from the
 * auth module (refreshing it transparently). All types describe the response
 * subsets the music player actually renders.
 */

import { getAccessToken, refreshAccessToken, SpotifyAuthError } from './auth';

const API_BASE = 'https://api.spotify.com/v1';

export class SpotifyApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// API types (only the fields we render)
// ---------------------------------------------------------------------------

export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface SpotifyArtistRef {
  name: string;
  uri: string;
}

export interface SpotifyAlbum {
  id: string;
  uri: string;
  name: string;
  images: SpotifyImage[];
  release_date?: string;
  total_tracks?: number;
  artists: SpotifyArtistRef[];
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: SpotifyArtistRef[];
  album: SpotifyAlbum;
  duration_ms: number;
  preview_url: string | null;
  explicit?: boolean;
  is_local?: boolean;
  is_playable?: boolean;
}

export interface SpotifySimpleArtist {
  id: string;
  uri: string;
  name: string;
  images: SpotifyImage[];
}

export interface SpotifyPlaylist {
  id: string;
  uri: string;
  name: string;
  images: SpotifyImage[];
  owner?: { display_name?: string; id?: string };
  tracks: { total: number; href?: string };
  public?: boolean;
}

export interface SpotifySavedTrack {
  added_at: string;
  track: SpotifyTrack | null;
}

export interface SpotifyProfile {
  id: string;
  display_name: string | null;
  images: SpotifyImage[];
  product: string;
  email?: string;
}

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_restricted?: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

export interface SpotifyPaged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

export interface SpotifySearchResults {
  tracks?: SpotifyPaged<SpotifyTrack>;
  albums?: SpotifyPaged<SpotifyAlbum>;
  artists?: SpotifyPaged<SpotifySimpleArtist>;
  playlists?: SpotifyPaged<SpotifyPlaylist>;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice | null;
  repeat_state?: 'off' | 'track' | 'context';
  shuffle_state?: boolean;
  is_playing: boolean;
  context?: { uri: string | null };
  progress_ms: number | null;
  item: SpotifyTrack | null;
}

// ---------------------------------------------------------------------------
// Request core
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit, retryToken?: string): Promise<T> {
  const token = retryToken ?? (await getAccessToken());
  const response = await fetch(path.startsWith('http') ? path : `${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // A 401 usually means the token was revoked elsewhere — force one
  // refresh and retry once before surfacing the error.
  if (response.status === 401 && !retryToken) {
    const fresh = await refreshAccessToken();
    return request<T>(path, init, fresh);
  }

  if (response.status === 204 || response.status === 202) {
    return undefined as T;
  }

  if (!response.ok) {
    let message = `Spotify API ${response.status}`;
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new SpotifyApiError(message, response.status);
  }

  return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function getMe(): Promise<SpotifyProfile> {
  return request<SpotifyProfile>('/me');
}

export function getSavedTracks(limit = 50, offset = 0): Promise<SpotifyPaged<SpotifySavedTrack>> {
  return request<SpotifyPaged<SpotifySavedTrack>>(`/me/tracks?${query({ limit, offset })}`);
}

export function getSavedTracksPage(url: string): Promise<SpotifyPaged<SpotifySavedTrack>> {
  return request<SpotifyPaged<SpotifySavedTrack>>(url);
}

export function getPlaylists(limit = 50, offset = 0): Promise<SpotifyPaged<SpotifyPlaylist>> {
  return request<SpotifyPaged<SpotifyPlaylist>>(`/me/playlists?${query({ limit, offset })}`);
}

export function getTopTracks(
  timeRange: 'short_term' | 'medium_term' | 'long_term' = 'short_term',
  limit = 20,
): Promise<SpotifyPaged<SpotifyTrack>> {
  return request<SpotifyPaged<SpotifyTrack>>(
    `/me/top/tracks?${query({ time_range: timeRange, limit })}`,
  );
}

export function search(
  q: string,
  types: string = 'track,album,playlist,artist',
  limit = 12,
): Promise<SpotifySearchResults> {
  return request<SpotifySearchResults>(`/search?${query({ q, type: types, limit })}`);
}

export function getPlaylistTracks(
  playlistId: string,
  limit = 100,
  offset = 0,
): Promise<SpotifyPaged<{ track: SpotifyTrack | null }>> {
  return request<SpotifyPaged<{ track: SpotifyTrack | null }>>(
    `/playlists/${playlistId}/tracks?${query({ limit, offset })}`,
  );
}

/** Album track listings lack `preview_url`; batch-resolve the full objects. */
export function getAlbumTracks(albumId: string, limit = 50): Promise<SpotifyTrack[]> {
  return request<SpotifyPaged<SpotifyTrack>>(`/albums/${albumId}/tracks?${query({ limit })}`).then(
    async (page) => {
      const ids = page.items
        .map((track) => track.id)
        .filter(Boolean)
        .slice(0, 50)
        .join(',');
      if (!ids) return page.items;
      const full = await request<{ tracks: SpotifyTrack[] }>(`/tracks?${query({ ids })}`);
      const byId = new Map(full.tracks.map((track) => [track.id, track]));
      return page.items.map((track) => byId.get(track.id) ?? track);
    },
  );
}

export function getArtistTopTracks(
  artistId: string,
  market = 'from_token',
): Promise<{ tracks: SpotifyTrack[] }> {
  return request<{ tracks: SpotifyTrack[] }>(
    `/artists/${artistId}/top-tracks?${query({ market })}`,
  );
}

export function getDevices(): Promise<{ devices: SpotifyDevice[] }> {
  return request<{ devices: SpotifyDevice[] }>('/me/player/devices');
}

export function transferPlayback(deviceId: string, play = true): Promise<void> {
  return request<void>('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}

export interface PlayRequest {
  contextUri?: string;
  uris?: string[];
  offsetTrackUri?: string;
  positionMs?: number;
}

export function playOnDevice(deviceId: string | null, body: PlayRequest): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (body.contextUri) payload.context_uri = body.contextUri;
  if (body.uris) payload.uris = body.uris;
  if (body.offsetTrackUri) payload.offset = { uri: body.offsetTrackUri };
  if (body.positionMs !== undefined) payload.position_ms = body.positionMs;
  return request<void>(`/me/player/play${deviceId ? `?${query({ device_id: deviceId })}` : ''}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function pausePlayback(deviceId?: string): Promise<void> {
  return request<void>(`/me/player/pause${deviceId ? `?${query({ device_id: deviceId })}` : ''}`, {
    method: 'PUT',
  });
}

export function skipToNext(deviceId?: string): Promise<void> {
  return request<void>(`/me/player/next${deviceId ? `?${query({ device_id: deviceId })}` : ''}`, {
    method: 'POST',
  });
}

export function skipToPrevious(deviceId?: string): Promise<void> {
  return request<void>(
    `/me/player/previous${deviceId ? `?${query({ device_id: deviceId })}` : ''}`,
    { method: 'POST' },
  );
}

export function setPlaybackShuffle(state: boolean, deviceId?: string): Promise<void> {
  return request<void>(
    `/me/player/shuffle?${query({ state: state ? 'true' : 'false', device_id: deviceId })}`,
    { method: 'PUT' },
  );
}

export function setPlaybackRepeat(
  state: 'off' | 'track' | 'context',
  deviceId?: string,
): Promise<void> {
  return request<void>(`/me/player/repeat?${query({ state, device_id: deviceId })}`, {
    method: 'PUT',
  });
}

/** null when no playback is happening (204 → undefined → normalized here). */
export async function getPlaybackState(): Promise<SpotifyPlaybackState | null> {
  try {
    const state = await request<SpotifyPlaybackState | undefined>('/me/player');
    return state ?? null;
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 204) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Library interactions (likes, queues, playlists) — the "do everything the
// Spotify app can" surface for connected users.
// ---------------------------------------------------------------------------

/** GET /me/tracks/contains — true per id (batch, max 50 per call). */
export async function checkSavedTracks(ids: string[]): Promise<boolean[]> {
  const chunk = ids.slice(0, 50);
  if (chunk.length === 0) return [];
  return request<boolean[]>(`/me/tracks/contains?${query({ ids: chunk.join(',') })}`);
}

/** PUT /me/tracks — save (like) tracks. */
export function saveTracks(ids: string[]): Promise<void> {
  return request<void>('/me/tracks', {
    method: 'PUT',
    body: JSON.stringify({ ids: ids.slice(0, 50) }),
  });
}

/** DELETE /me/tracks — remove (unlike) tracks. */
export function removeSavedTracks(ids: string[]): Promise<void> {
  return request<void>('/me/tracks', {
    method: 'DELETE',
    body: JSON.stringify({ ids: ids.slice(0, 50) }),
  });
}

/** POST /me/player/queue — queue a track on the active device (Premium). */
export function addToQueue(uri: string, deviceId?: string): Promise<void> {
  return request<void>(`/me/player/queue?${query({ uri, device_id: deviceId })}`, {
    method: 'POST',
  });
}

/** POST /playlists/{id}/tracks — append tracks to one of the user's playlists. */
export function addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  return request<void>(`/playlists/${playlistId}/tracks`, {
    method: 'POST',
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
}

export { SpotifyAuthError };
