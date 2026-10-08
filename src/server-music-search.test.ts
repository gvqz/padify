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
    // Over-fetch: the catalog pass filters + dedupes, so the raw search asks
    // for more than the user's limit (clamped to 40).
    expect(fake.limit()).toBe(36);
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

  it('clamps the requested limit into the over-fetch range', async () => {
    const fake = installFakeSearch([]);

    await musicSearch('quiet', 99);

    expect(fake.limit()).toBe(40);
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

    // The official Topic upload outranks the fan upload.
    expect(tracks.map((t) => t.name)).toEqual(['One More Time', 'Karma Police, RadioHead']);
    expect(tracks.map((t) => t.artists[0].name)).toEqual(['Daft Punk', 'WhiteDog91202']);
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
      entry({ id: 'pqr12345678', title: 'Daft Punk - Da Funk', thumbnails: undefined }),
    ]);

    const tracks = await musicSearch('art', 5);

    expect(tracks.map((t) => t.album.images[0].url)).toEqual([
      'https://i.ytimg.com/vi/dwDns8x3Jb4/mqdefault.jpg',
      'https://i.ytimg.com/vi/pqr12345678/mqdefault.jpg',
    ]);
  });

  it('strips leading bracket noise before splitting artist from song', async () => {
    installFakeSearch([
      entry({ id: 'aaa12345678', title: '[Official Video] Daft Punk - One More Time' }),
    ]);

    const tracks = await musicSearch('one more time', 5);

    expect(tracks[0].name).toBe('One More Time');
    expect(tracks[0].artists[0].name).toBe('Daft Punk');
  });

  it('strips bare unbracketed trailers like "Official Music Video" and "HD 1080p"', async () => {
    installFakeSearch([
      entry({ id: 'bbb12345678', title: 'Daft Punk - Around The World Official Music Video' }),
      entry({ id: 'ccc12345678', title: 'Daft Punk - Da Funk HD 1080p' }),
    ]);

    const tracks = await musicSearch('daft punk', 10);

    expect(tracks.map((t) => t.name)).toEqual(['Around The World', 'Da Funk']);
  });

  it('splits en-dash and pipe titles, not just ASCII dashes', async () => {
    installFakeSearch([
      entry({ id: 'ddd12345678', title: 'DAFT PUNK – AROUND THE WORLD' }),
      entry({ id: 'eee12345678', title: 'Daft Punk | One More Time' }),
    ]);

    const tracks = await musicSearch('daft punk', 10);

    expect(tracks.map((t) => t.artists[0].name)).toEqual(['DAFT PUNK', 'Daft Punk']);
    expect(tracks.map((t) => t.name)).toEqual(['AROUND THE WORLD', 'One More Time']);
  });
});

describe('musicSearch — catalog quality pass (filter, dedupe, rank)', () => {
  it('filters hour-long dumps, karaoke, reactions and other non-songs', async () => {
    installFakeSearch([
      entry({ id: 'junk1111111', title: 'Daft Punk 1 Hour Mix' }),
      entry({ id: 'junk2222222', title: 'Daft Punk - One More Time (Karaoke Version)' }),
      entry({ id: 'junk3333333', title: 'REACTION to One More Time' }),
      entry({ id: 'junk4444444', title: 'One More Time - Tutorial' }),
      entry({ id: 'junk5555555', title: 'Best of Daft Punk 2020', duration: 3600 }),
      entry(), // the one real song
    ]);

    const tracks = await musicSearch('one more time', 24);

    expect(tracks.map((t) => t.id)).toEqual(['dwDns8x3Jb4']);
  });

  it('keeps songs whose titles merely contain junk-shaped words', async () => {
    installFakeSearch([
      entry({ id: 'ok111111111', title: 'The Fray - How to Save a Life' }),
      entry({ id: 'ok222222222', title: 'Bryan Adams - The Best of Me' }),
    ]);

    const tracks = await musicSearch('how', 24);

    expect(tracks.map((t) => t.name)).toEqual(['How to Save a Life', 'The Best of Me']);
  });

  it('drops clip-length and dump-length entries', async () => {
    installFakeSearch([
      entry({ id: 'short11111', duration: 20 }),
      entry({ id: 'long1111111', duration: 3600 }),
      entry(), // 430s — fine
    ]);

    const tracks = await musicSearch('anything', 24);

    expect(tracks.map((t) => t.id)).toEqual(['dwDns8x3Jb4']);
  });

  it('dedupes the same song, keeping the official Topic upload at the song’s first position', async () => {
    installFakeSearch([
      // A fan lyric upload appears first…
      entry({
        id: 'fan12345678',
        title: 'Daft Punk - Around the World (Lyrics)',
        channel: 'WhiteDog91202',
        view_count: 5_000_000,
      }),
      // …the auto-generated official audio second — it should win the slot.
      entry({
        id: 'top12345678',
        title: 'Daft Punk - Around the World',
        channel: 'Daft Punk - Topic',
        view_count: 40_000,
      }),
      entry({ id: 'oth12345678', title: 'Daft Punk - Da Funk', channel: 'Daft Punk - Topic' }),
    ]);

    const tracks = await musicSearch('around the world', 24);

    expect(tracks.map((t) => t.id)).toEqual(['top12345678', 'oth12345678']);
    expect(tracks[0].name).toBe('Around the World');
    expect(tracks[0].artists[0].name).toBe('Daft Punk');
  });

  it('when no Topic entry exists, keeps the most-viewed video for the song', async () => {
    installFakeSearch([
      entry({ id: 'low12345678', view_count: 10 }),
      entry({ id: 'high1234567', view_count: 9_000, channel: 'Fan Channel' }),
    ]);

    const tracks = await musicSearch('around the world', 24);

    expect(tracks.map((t) => t.id)).toEqual(['high1234567']);
  });

  it('treats “Song (Live)” and “Song” as the same catalog row when identical otherwise', async () => {
    // The dedupe key strips parenthesized qualifiers, so the cleaner title
    // representation wins one slot instead of two near-duplicate rows.
    installFakeSearch([
      entry({ id: 'live1234567', title: 'Daft Punk - Around the World (Live)' }),
      entry(),
    ]);

    const tracks = await musicSearch('around the world', 24);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('Around the World');
  });

  it('retries the flat search once when YouTube soft rate-limits the first attempt', async () => {
    let calls = 0;
    setYtSearchRunnerForTests((_q, _limit) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('soft rate limit'));
      return Promise.resolve([entry()]);
    });

    const tracks = await musicSearch('retry me', 24);

    expect(calls).toBe(2);
    expect(tracks).toHaveLength(1);
  });

  it('fails after the retry, surfacing the original error', async () => {
    let calls = 0;
    setYtSearchRunnerForTests(() => {
      calls += 1;
      return Promise.reject(new Error('down hard'));
    });

    await expect(musicSearch('down', 24)).rejects.toThrow('down hard');
    expect(calls).toBe(2);
  });

  it('falls back to the raw mixes when the junk filter would leave nothing', async () => {
    // A genre query: every result is a mix — those ARE what the searcher
    // wanted, so "Nothing found" would be the wrong answer.
    installFakeSearch([
      entry({
        id: 'mix11111111',
        title: 'cozy lofi beats to study / relax to',
        duration: 3882,
      }),
      entry({
        id: 'mix22222222',
        title: '1 A.M Study Session 📚 [lofi hip hop]',
        duration: 3674,
      }),
      entry({ id: 'dump1111111', title: '8 hours of lofi to sleep', duration: 28_828 }),
    ]);

    const tracks = await musicSearch('lofi hip hop', 24);

    expect(tracks.map((t) => t.id)).toEqual(['mix11111111', 'mix22222222']);
  });

  it('day-long dumps never appear, even in the fallback', async () => {
    installFakeSearch([entry({ id: 'dump22222222', title: 'Chill Lofi 24/7', duration: 86_660 })]);

    const tracks = await musicSearch('lofi', 24);

    expect(tracks).toEqual([]);
  });

  it('the fallback never overrides a clean song result', async () => {
    installFakeSearch([
      entry({ id: 'song1111111', title: 'Daft Punk - One More Time' }),
      entry({ id: 'mix33333333', title: 'study mix 2024', duration: 3600 }),
    ]);

    const tracks = await musicSearch('one more time', 24);

    expect(tracks.map((t) => t.id)).toEqual(['song1111111']);
  });
});
