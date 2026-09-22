import { describe, expect, it } from 'vitest';
import { TRACKS, PLAYLIST_LABELS, getTrackById, formatTime, type PlaylistId } from './tracks';

describe('formatTime', () => {
  it('formats minutes:seconds with zero padding', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(61)).toBe('1:01');
    expect(formatTime(600)).toBe('10:00');
    expect(formatTime(3661)).toBe('61:01');
  });

  it('clamps negative input to 0:00', () => {
    expect(formatTime(-3)).toBe('0:00');
  });
});

describe('getTrackById', () => {
  it('resolves a known id to its track object', () => {
    expect(TRACKS.length).toBeGreaterThan(0);
    expect(getTrackById(TRACKS[0].id)).toBe(TRACKS[0]);
  });

  it('returns undefined for unknown ids', () => {
    expect(getTrackById('definitely-not-a-track-id')).toBeUndefined();
  });
});

describe('TRACKS integrity', () => {
  it('has unique ids', () => {
    const ids = TRACKS.map((track) => track.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references only known playlists', () => {
    const known = Object.keys(PLAYLIST_LABELS);
    for (const track of TRACKS) {
      expect(known).toContain(track.playlist);
    }
  });

  it('carries a playable recipe on every track', () => {
    for (const track of TRACKS) {
      expect(track.title.trim().length).toBeGreaterThan(0);
      expect(track.durationSec).toBeGreaterThan(0);
      expect(track.bpm).toBeGreaterThan(0);
      expect(track.scale.length).toBeGreaterThan(0);
      expect(track.chords.length).toBeGreaterThan(0);
      expect(Number.isInteger(track.seed)).toBe(true);
      expect(track.artPalette).toHaveLength(3);
      expect((track.artPalette as string[]).every((hex) => /^#[0-9a-f]{6}$/i.test(hex))).toBe(true);
    }
  });

  it('labels every playlist', () => {
    const labels: string[] = Object.values(PLAYLIST_LABELS);
    expect(labels).toHaveLength(4);
    const playlists = new Set<PlaylistId>(TRACKS.map((track) => track.playlist));
    for (const playlist of playlists) {
      expect(PLAYLIST_LABELS[playlist].trim().length).toBeGreaterThan(0);
    }
  });
});
