// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  musicSearch,
  resetMusicResolverForTests,
  setYtSearchRunnerForTests,
} from '../server/music';

// The YouTube search fallback in server/music.ts: when no Spotify app
// credentials are configured, /api/music/search maps yt-dlp's flat-search
// entries into the catalog shape the player renders. The
// setYtSearchRunnerForTests seam swaps the yt-dlp process for a fake (same
// pattern as setYtDlpRunnerForTests in server-music-resolve.test.ts), so the
// mapping — title cleanup, artist split, " - Topic" stripping, artwork,
// live/duration/malformed filters — runs under Node where Bun.spawn does
// not exist.

/** A flat-search entry as yt-dlp's --dump-single-json reports them. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dwDns8x3Jb4',
    title: 'Daft Punk - Around the World',
    duration: 430,
    channel: 'Daft Punk',
    channel_id: 'UCq19-LqvG35A-30oyAiPiqA',
    channel_url: 'https://www.youtube.com/channel/UCq19-LqvG35A-30oyAiPiqA',
    live_status: 'not_live',
    thumbnails: [{ url: 'https://i.ytimg.com/vi/dwDns8x3Jb4/hq720.jpg?sqp=abc' }],
    ...overrides,
  };
}

/** Installs the fake flat-search runner; returns what it saw. */
function installFakeSearch(entries: unknown[]): {
  query: () => string;
  limit: () => number;
} {
  let seenQuery = '';
  let seenLimit = 0;
  setYtSearchRunnerForTests((q, limit) => {
    seenQuery = q;
    seenLimit = limit;
    return Promise.resolve(entries);
  });
  return { query: () => seenQuery, limit: () => seenLimit };
}

beforeEach(() => {
  resetMusicResolverForTests();
});

afterEach(() => {
  setYtSearchRunnerForTests(null);
  resetMusicResolverForTests();
});

describe('musicSearch — YouTube fallback (no Spotify credentials)', () => {
  it('maps flat-search entries into the catalog shape', async () => {
    const fake = installFakeSearch([entry()]);

    const tracks = await musicSearch('daft punk around the world', 24);

    expect(tracks).toHaveLength(1);
    expect(fake.query()).toBe('daft punk around the world');
    expect(fake.limit()).toBe(24);
    expect(tracks[0]).toMatchObject({
      id: 'dwDns8x3Jb4',
      uri: 'youtube:video:dwDns8x3Jb4',
      name: 'Around the World',
      duration_ms: 430_000,
      explicit: false,
      preview_url: null,
      is_playable: true,
    });
    expect(tracks[0].artists[0]).toMatchObject({
      name: 'Daft Punk',
      uri: 'https://www.youtube.com/channel/UCq19-LqvG35A-30oyAiPiqA',
    });
    expect(tracks[0].album.name).toBe('YouTube');
    expect(tracks[0].album.images).toEqual([
      { url: 'https://i.ytimg.com/vi/dwDns8x3Jb4/hq720.jpg?sqp=abc' },
    ]);
  });

  it('clamps the requested limit into yt-dlp search range', async () => {
    const fake = installFakeSearch([]);

    await musicSearch('quiet', 99);

    expect(fake.limit()).toBe(30);
  });

  it('splits "Artist - Song" titles and strips "(Official Audio)" noise', async () => {
    installFakeSearch([
      entry({
        id: 'abc12345678',
        title: 'Daft Punk - Around the World (Official Audio)',
      }),
      entry({
        id: 'def12345678',
        title: 'Radiohead - Karma Police [Official Music Video Remastered]',
      }),
    ]);

    const tracks = await musicSearch('songs', 10);

    expect(tracks.map((t) => t.name)).toEqual(['Around the World', 'Karma Police']);
    expect(tracks.map((t) => t.artists[0].name)).toEqual(['Daft Punk', 'Radiohead']);
  });

  it('keeps parenthesized information that is not noise', async () => {
    installFakeSearch([
      entry({ id: 'ghi12345678', title: 'Pink Floyd - Another Brick (Part II)' }),
    ]);

    const tracks = await musicSearch('brick', 5);

    expect(tracks[0].name).toBe('Another Brick (Part II)');
  });

  it('uses the channel for the artist when the title has no dash', async () => {
    installFakeSearch([
      entry({
        id: 'jkl12345678',
        title: 'Karma Police, RadioHead (Lyrics)',
        channel: 'WhiteDog91202',
      }),
      // Auto-generated music channels: "Artist - Topic" → the artist.
      entry({ id: 'mno12345678', title: 'One More Time', channel: 'Daft Punk - Topic' }),
    ]);

    const tracks = await musicSearch('karma', 5);

    expect(tracks.map((t) => t.name)).toEqual(['Karma Police, RadioHead', 'One More Time']);
    expect(tracks.map((t) => t.artists[0].name)).toEqual(['WhiteDog91202', 'Daft Punk']);
  });

  it('skips live, duration-less and malformed entries', async () => {
    installFakeSearch([
      entry({ live_status: 'is_live' }),
      entry({ duration: null }),
      entry({ duration: 0 }),
      entry({ id: 'short' }),
      entry({ id: 12345678901 }),
      entry({ title: '   ' }),
      'not an object',
      entry(), // the one valid row
    ]);

    const tracks = await musicSearch('anything', 20);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe('dwDns8x3Jb4');
  });

  it('falls back to the always-available thumbnail when yt-dlp reports none', async () => {
    installFakeSearch([
      entry({ thumbnails: [] }),
      entry({ id: 'pqr12345678', thumbnails: undefined }),
    ]);

    const tracks = await musicSearch('art', 5);

    expect(tracks.map((t) => t.album.images[0].url)).toEqual([
      'https://i.ytimg.com/vi/dwDns8x3Jb4/mqdefault.jpg',
      'https://i.ytimg.com/vi/pqr12345678/mqdefault.jpg',
    ]);
  });
});
