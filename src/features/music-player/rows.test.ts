import { describe, expect, it } from 'vitest';
import { albumCard, artistCard, playlistCard, queueRow, rowMenuItems, trackRow } from './rows';
import type {
  SpotifyAlbum,
  SpotifyPlaylist,
  SpotifySimpleArtist,
  SpotifyTrack,
} from './spotify/api';

const images = (urls: string[]) => urls.map((url) => ({ url, height: 640, width: 640 }));

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Song',
    artists: [{ name: 'Artist', uri: 'spotify:artist:a' }],
    album: {
      id: 'alb1',
      uri: 'spotify:album:alb1',
      name: 'Album',
      artists: [{ name: 'Artist', uri: 'spotify:artist:a' }],
      images: images(['https://img/64', 'https://img/300', 'https://img/640']),
    },
    duration_ms: 200_000,
    preview_url: null,
    explicit: false,
    ...overrides,
  };
}

describe('trackRow', () => {
  it('wires the queue id, track id and uri into the row dataset', () => {
    const html = trackRow(track(), 'favorites');
    expect(html).toContain('data-queue-id="favorites"');
    expect(html).toContain('data-track-id="t1"');
    expect(html).toContain('data-track-uri="spotify:track:t1"');
  });

  it('prefers the smallest artwork (index 2 of the largest-first list), falling back to the largest', () => {
    // Spotify orders images largest-first; the row wants the thumbnail.
    const ordered = track({
      album: {
        ...track().album,
        images: images(['https://img/640', 'https://img/300', 'https://img/64']),
      },
    });
    expect(trackRow(ordered, 'q')).toContain('src="https://img/64"');
    const only = trackRow(track({ album: { ...track().album, images: images(['only']) } }), 'q');
    expect(only).toContain('src="only"');
    const noArt = trackRow(track({ album: undefined }), 'q');
    expect(noArt).not.toContain('<img');
  });

  it('escapes hostile track and artist names everywhere they appear', () => {
    const hostile = track({
      name: '"><script>alert(1)</script>',
      artists: [{ name: "<b>&'bad'", uri: 'x' }],
    });
    const html = trackRow(hostile, 'q');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('alert(1)');
  });

  it('marks explicit tracks and formats the duration', () => {
    const html = trackRow(track({ explicit: true, duration_ms: 61_000 }), 'q');
    expect(html).toContain('· E');
    expect(html).toContain('1:01');
  });

  it('gives every row a heart, a menu button, and an equalizer', () => {
    const html = trackRow(track(), 'q');
    expect(html).toContain('data-like');
    expect(html).toContain('data-menu');
    expect(html).toMatch(/sp-row-eq/);
  });
});

describe('queueRow', () => {
  it('carries the queue position instead of a queue id, and removes instead of menus', () => {
    const html = queueRow(track(), 3);
    expect(html).toContain('data-queue-index="3"');
    expect(html).not.toContain('data-queue-id');
    expect(html).toContain('data-remove');
    expect(html).not.toContain('data-menu');
  });
});

describe('cards', () => {
  const playlist: SpotifyPlaylist = {
    id: 'p1',
    uri: 'spotify:playlist:p1',
    name: 'Late <Night>',
    images: images(['cover']),
    tracks: { total: 42 },
  };

  it('playlist cards carry id, uri, track count, and escaped names', () => {
    const html = playlistCard(playlist);
    expect(html).toContain('data-playlist-id="p1"');
    expect(html).toContain('data-playlist-uri="spotify:playlist:p1"');
    expect(html).toContain('42 songs');
    expect(html).toContain('Late &lt;Night&gt;');
    expect(html).not.toContain('Late <Night>');
  });

  const album: SpotifyAlbum = {
    id: 'a1',
    uri: 'spotify:album:a1',
    name: 'Album',
    artists: [
      { name: 'A', uri: 'u' },
      { name: 'B', uri: 'u' },
    ],
    images: [],
  };

  it('album cards list the artists and fall back to the icon without art', () => {
    const html = albumCard(album);
    expect(html).toContain('data-album-id="a1"');
    expect(html).toContain('A, B');
    expect(html).not.toContain('<img');
  });

  const artist: SpotifySimpleArtist = {
    id: 'ar1',
    uri: 'spotify:artist:ar1',
    name: 'DJ "Quote"',
    images: images(['face']),
  };

  it('artist cards escape the name in the attribute and the label', () => {
    const html = artistCard(artist);
    expect(html).toContain('data-artist-id="ar1"');
    expect(html).toContain('DJ &quot;Quote&quot;');
    expect(html).toContain('src="face"');
    expect(html).toContain('>Artist</span>');
  });
});

describe('rowMenuItems (the row action menu)', () => {
  it('anonymous with no playlist yet offers queue + start-your-playlist', () => {
    const markup = rowMenuItems({
      connected: false,
      localPlaylistName: null,
      spotifyPlaylists: [],
    });
    expect(markup).toContain('data-action="queue"');
    expect(markup).toContain('Start your playlist');
    expect(markup).not.toContain('mp-row-menu-divider');
    expect(markup).not.toContain('data-action="spotify-playlist"');
  });

  it('anonymous with a playlist names it, escaped', () => {
    const markup = rowMenuItems({
      connected: false,
      localPlaylistName: 'My <Mix> & Things',
      spotifyPlaylists: [],
    });
    expect(markup).toContain('Add to My &lt;Mix&gt; &amp; Things');
    expect(markup).not.toContain('<Mix>');
  });

  it('connected users get their playlists behind a divider, capped', () => {
    const playlists: SpotifyPlaylist[] = Array.from({ length: 12 }, (_, i) => ({
      id: `pl-${i}`,
      uri: `spotify:playlist:pl-${i}`,
      name: `Playlist ${i}`,
      images: [],
      tracks: { total: 1 },
    }));
    const markup = rowMenuItems({
      connected: true,
      localPlaylistName: null,
      spotifyPlaylists: playlists,
      maxPlaylists: 8,
    });
    expect(markup).toContain('mp-row-menu-divider');
    expect(markup).toContain('data-playlist-id="pl-0"');
    expect(markup).toContain('data-playlist-id="pl-7"');
    expect(markup).not.toContain('data-playlist-id="pl-8"');
    expect(markup).not.toContain('local-playlist');
  });

  it('connected with no playlists gets only the queue action', () => {
    const markup = rowMenuItems({
      connected: true,
      localPlaylistName: null,
      spotifyPlaylists: [],
    });
    expect(markup).toContain('data-action="queue"');
    expect(markup).not.toContain('mp-row-menu-divider');
  });
});
