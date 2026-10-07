/**
 * Track metadata for the free (no-login) music path.
 *
 * The Padify API's /api/music/search returns track metadata in Spotify's own
 * shape — from Spotify's public catalog when the server has app credentials,
 * or from YouTube results mapped into the same shape when it doesn't — so
 * the free player renders one row component for the data it gets. These
 * types describe exactly the fields the player uses; nothing here talks to
 * Spotify (or YouTube) from the browser.
 */

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
  /** Catalog flags that ride along in persisted snapshots. */
  is_local?: boolean;
  is_playable?: boolean;
}
