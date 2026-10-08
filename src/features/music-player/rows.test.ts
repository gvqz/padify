import { describe, expect, it } from 'vitest';
import { queueRow, rowMenuItems, trackRow } from './rows';
import type { SpotifyTrack } from './types';
import { ambientTracks } from './ambient';

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

  it('gives every row a heart, a direct enqueue button, the ⋯ menu and an equalizer', () => {
    const html = trackRow(track(), 'q');
    expect(html).toContain('data-like');
    expect(html).toContain('data-queue-add');
    expect(html).toContain('data-menu');
    expect(html).toMatch(/sp-row-eq/);
  });

  it('renders ambience tracks with their per-sound icon instead of artwork', () => {
    const [rain] = ambientTracks();
    const html = trackRow(rain, 'ambience');
    expect(html).not.toContain('<img');
    expect(html).toContain('<svg');
    expect(html).toContain('data-track-id="ambient:rain"');
  });
});

describe('queueRow', () => {
  it('carries the queue position instead of a queue id, and removes instead of menus', () => {
    const html = queueRow(track(), 3);
    expect(html).toContain('data-queue-index="3"');
    expect(html).not.toContain('data-queue-id');
    expect(html).toContain('data-remove');
    expect(html).not.toContain('data-menu');
    // The direct enqueue affordance stays out of the queue itself.
    expect(html).not.toContain('data-queue-add');
  });
});

describe('rowMenuItems (the row action menu)', () => {
  it('with no playlist yet offers queue + start-your-playlist', () => {
    const markup = rowMenuItems({ localPlaylistName: null });
    expect(markup).toContain('data-action="queue"');
    expect(markup).toContain('Start your playlist');
    expect(markup).not.toContain('mp-row-menu-divider');
  });

  it('with a playlist names it, escaped', () => {
    const markup = rowMenuItems({ localPlaylistName: 'My <Mix> & Things' });
    expect(markup).toContain('Add to My &lt;Mix&gt; &amp; Things');
    expect(markup).not.toContain('<Mix>');
  });
});
