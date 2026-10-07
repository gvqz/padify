import { describe, expect, it } from 'vitest';
import { LocalMusicLibrary, snapshotTrack } from './library';
import type { SpotifyTrack } from '../types';

function track(id: string, name = id, artist = 'Artist'): SpotifyTrack {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: artist, uri: `spotify:artist:${artist}` }],
    album: {
      id: 'alb1',
      uri: 'spotify:album:alb1',
      name: 'Album',
      artists: [{ name: artist, uri: `spotify:artist:${artist}` }],
      images: [{ url: 'https://img/640', height: 640, width: 640 }],
    },
    duration_ms: 200_000,
    preview_url: null,
    explicit: false,
  };
}

function makeLibrary(): { library: LocalMusicLibrary; store: Map<string, string> } {
  const store = new Map<string, string>();
  const library = new LocalMusicLibrary(
    (key) => store.get(key) ?? null,
    (key, value) => store.set(key, value),
  );
  return { library, store };
}

describe('snapshotTrack', () => {
  it('keeps the renderable fields and caps album images at two', () => {
    const fat = {
      ...track('t1'),
      album: {
        ...track('t1').album,
        images: [
          { url: 'a', height: 640, width: 640 },
          { url: 'b', height: 300, width: 300 },
          { url: 'c', height: 64, width: 64 },
          { url: 'd', height: 64, width: 64 },
        ],
      },
    };
    const snap = snapshotTrack(fat);
    expect(snap.album.images).toHaveLength(2);
    expect(snap.name).toBe('t1');
    expect(snap.artists[0].name).toBe('Artist');
  });
});

describe('LocalMusicLibrary favorites', () => {
  it('toggles on and off and persists between instances', () => {
    const { library, store } = makeLibrary();
    expect(library.isFavorite('t1')).toBe(false);
    expect(library.toggleFavorite(track('t1'))).toBe(true);
    expect(library.isFavorite('t1')).toBe(true);

    const revived = new LocalMusicLibrary(
      (key) => store.get(key) ?? null,
      (key, value) => store.set(key, value),
    );
    expect(revived.favorites).toHaveLength(1);
    expect(revived.favorites[0].id).toBe('t1');
    expect(revived.toggleFavorite(track('t1'))).toBe(false);
    expect(revived.favorites).toHaveLength(0);
  });

  it('most-recent first', () => {
    const { library } = makeLibrary();
    library.toggleFavorite(track('a'));
    library.toggleFavorite(track('b'));
    expect(library.favorites.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('drops corrupted persisted JSON gracefully', () => {
    const library = new LocalMusicLibrary(
      () => '{not json',
      () => undefined,
    );
    expect(library.favorites).toEqual([]);
    expect(library.playlist).toBeNull();
  });
});

describe('LocalMusicLibrary playlist', () => {
  it('creates exactly one playlist on first add', () => {
    const { library } = makeLibrary();
    expect(library.playlist).toBeNull();
    expect(library.addToPlaylist(track('p1'))).toBe('created');
    expect(library.playlist?.name).toBe('My Playlist');
    expect(library.addToPlaylist(track('p2'))).toBe('added');
    expect(library.playlist?.tracks).toHaveLength(2);
  });

  it('createPlaylist is a no-op when one already exists', () => {
    const { library } = makeLibrary();
    library.addToPlaylist(track('p1'));
    const existing = library.playlist;
    library.createPlaylist('Another');
    expect(library.playlist).toBe(existing);
    expect(library.playlist?.name).toBe('My Playlist');
  });

  it('rejects duplicates and removes by index', () => {
    const { library } = makeLibrary();
    library.addToPlaylist(track('p1'));
    expect(library.addToPlaylist(track('p1'))).toBe('duplicate');
    library.removeFromPlaylist(0);
    expect(library.playlist?.tracks).toHaveLength(0);
  });

  it('renames with clamping and keeps the name on blank input', () => {
    const { library, store } = makeLibrary();
    library.addToPlaylist(track('p1'));
    library.renamePlaylist('Focus mix');
    expect(library.playlist?.name).toBe('Focus mix');
    library.renamePlaylist('');
    expect(library.playlist?.name).toBe('Focus mix');

    const revived = new LocalMusicLibrary(
      (key) => store.get(key) ?? null,
      (key, value) => store.set(key, value),
    );
    expect(revived.playlist?.name).toBe('Focus mix');
    expect(revived.playlist?.tracks[0].id).toBe('p1');
  });
});
