/**
 * Local music library — the anonymous user's music, on their device.
 *
 * Everyone can use the player without an account, so they keep their own
 * tiny library locally (storage layer → IndexedDB + localStorage mirror):
 *
 *   • favorites — hearted tracks (full metadata snapshots, no API needed)
 *   • exactly one playlist — created on first add, renameable, removable
 *
 * The scope is deliberately narrow (one playlist, capped sizes) so we stay
 * a good citizen: no server calls, bounded storage, zero rate limits.
 */

import { stateGet, stateSet } from '../../../storage';
import type { SpotifyTrack } from '../types';

const LIBRARY_KEY = 'padify-music-library';
const DEFAULT_PLAYLIST_NAME = 'My Playlist';
const MAX_FAVORITES = 300;
const MAX_PLAYLIST_TRACKS = 300;

export interface LocalPlaylist {
  name: string;
  tracks: SpotifyTrack[];
}

export interface LocalLibraryData {
  favorites: SpotifyTrack[];
  playlist: LocalPlaylist | null;
}

export type PlaylistAddResult = 'created' | 'added' | 'duplicate' | 'full';

/**
 * Trims a track down to the fields the player actually renders so a
 * persisted library stays small (no link objects, no episode payloads…).
 */
export function snapshotTrack(track: SpotifyTrack): SpotifyTrack {
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => ({ name: artist.name, uri: artist.uri ?? '' })),
    album: {
      id: track.album?.id ?? '',
      uri: track.album?.uri ?? '',
      name: track.album?.name ?? '',
      images: (track.album?.images ?? []).slice(0, 2).map((image) => ({
        url: image.url,
        height: image.height ?? null,
        width: image.width ?? null,
      })),
      artists: [],
    },
    duration_ms: track.duration_ms ?? 0,
    preview_url: track.preview_url ?? null,
    explicit: Boolean(track.explicit),
    is_playable: track.is_playable !== false,
  };
}

function isTrackShape(value: unknown): value is SpotifyTrack {
  if (!value || typeof value !== 'object') return false;
  const track = value as Record<string, unknown>;
  return typeof track.id === 'string' && typeof track.name === 'string';
}

function sanitizeTracks(value: unknown, cap: number): SpotifyTrack[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isTrackShape)
    .map((track) => snapshotTrack(track))
    .slice(0, cap);
}

/** Storage accessors are injectable so unit tests can run without IDB. */
export type StateReader = (key: string) => string | null;
export type StateWriter = (key: string, value: string) => void;

export class LocalMusicLibrary {
  favorites: SpotifyTrack[] = [];
  playlist: LocalPlaylist | null = null;

  private readonly read: StateReader;
  private readonly write: StateWriter;

  constructor(read: StateReader = stateGet, write: StateWriter = stateSet) {
    this.read = read;
    this.write = write;
    this.load();
  }

  load(): void {
    try {
      const raw = this.read(LIBRARY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LocalLibraryData>;
        this.favorites = sanitizeTracks(parsed.favorites, MAX_FAVORITES);
        this.playlist =
          parsed.playlist && typeof parsed.playlist === 'object'
            ? {
                name: String(parsed.playlist.name ?? DEFAULT_PLAYLIST_NAME).slice(0, 80),
                tracks: sanitizeTracks(parsed.playlist.tracks, MAX_PLAYLIST_TRACKS),
              }
            : null;
        return;
      }
    } catch {
      /* corrupted JSON — start clean */
    }
    this.favorites = [];
    this.playlist = null;
  }

  persist(): void {
    try {
      const data: LocalLibraryData = {
        favorites: this.favorites,
        playlist: this.playlist,
      };
      this.write(LIBRARY_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — library lives for this page only */
    }
  }

  // ---- favorites -----------------------------------------------------------

  isFavorite(trackId: string): boolean {
    return this.favorites.some((track) => track.id === trackId);
  }

  /** Returns the new state (true = now a favorite). */
  toggleFavorite(track: SpotifyTrack): boolean {
    const index = this.favorites.findIndex((item) => item.id === track.id);
    if (index === -1) {
      this.favorites.unshift(snapshotTrack(track));
      if (this.favorites.length > MAX_FAVORITES) this.favorites.pop();
      this.persist();
      return true;
    }
    this.favorites.splice(index, 1);
    this.persist();
    return false;
  }

  removeFavorite(trackId: string): void {
    const index = this.favorites.findIndex((item) => item.id === trackId);
    if (index !== -1) {
      this.favorites.splice(index, 1);
      this.persist();
    }
  }

  // ---- the single local playlist --------------------------------------------

  createPlaylist(name: string): LocalPlaylist {
    if (this.playlist) return this.playlist; // one playlist, max — by design
    this.playlist = {
      name: (name.trim() || DEFAULT_PLAYLIST_NAME).slice(0, 80),
      tracks: [],
    };
    this.persist();
    return this.playlist;
  }

  addToPlaylist(track: SpotifyTrack): PlaylistAddResult {
    if (!this.playlist) {
      this.playlist = { name: DEFAULT_PLAYLIST_NAME, tracks: [] };
    }
    if (this.playlist.tracks.some((item) => item.id === track.id)) {
      return 'duplicate';
    }
    if (this.playlist.tracks.length >= MAX_PLAYLIST_TRACKS) {
      return 'full';
    }
    this.playlist.tracks.push(snapshotTrack(track));
    this.persist();
    return this.playlist.tracks.length === 1 ? 'created' : 'added';
  }

  removeFromPlaylist(index: number): void {
    if (!this.playlist) return;
    if (index < 0 || index >= this.playlist.tracks.length) return;
    this.playlist.tracks.splice(index, 1);
    this.persist();
  }

  renamePlaylist(name: string): void {
    if (!this.playlist) return;
    this.playlist.name = (name.trim() || this.playlist.name).slice(0, 80);
    this.persist();
  }
}
