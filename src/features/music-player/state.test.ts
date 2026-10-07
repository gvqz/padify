import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE,
  FREE_QUEUE_CAP,
  STORAGE_KEY,
  loadPlayerState,
  savePlayerState,
} from './state';
import type { SpotifyTrack } from './types';

function track(id: string, name = id): SpotifyTrack {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: 'Artist', uri: 'spotify:artist:a' }],
    album: {
      id: 'alb1',
      uri: 'spotify:album:alb1',
      name: 'Album',
      artists: [{ name: 'Artist', uri: 'spotify:artist:a' }],
      images: [],
    },
    duration_ms: 100_000,
    preview_url: null,
    explicit: false,
  };
}

describe('loadPlayerState', () => {
  it('returns the defaults for empty storage', () => {
    const state = loadPlayerState(() => null);
    expect(state).toEqual({
      volume: 0.7,
      shuffle: false,
      repeat: 'off',
      view: 'search',
      freeQueue: [],
      freeIndex: -1,
    });
  });

  it('returns fresh defaults each call — the default queue is never aliased', () => {
    // A controller that pushes into a default-issued queue must not be
    // writing into DEFAULT_STATE's array (a later "empty storage" load
    // would otherwise resurrect the discarded queue).
    const first = loadPlayerState(() => null);
    first.freeQueue.push(track('leak'));
    const second = loadPlayerState(() => null);
    expect(second.freeQueue).toEqual([]);
    expect(DEFAULT_STATE.freeQueue).toEqual([]);
  });

  it('falls back to the defaults when storage holds garbage', () => {
    expect(loadPlayerState(() => '{not json')).toEqual(DEFAULT_STATE);
    expect(loadPlayerState(() => 'null')).toEqual(DEFAULT_STATE);
  });

  it('round-trips through savePlayerState', () => {
    const store = new Map<string, string>();
    const state = {
      volume: 0.4,
      shuffle: true,
      repeat: 'all' as const,
      view: 'queue' as const,
      freeQueue: [track('a'), track('b')],
      freeIndex: 1,
    };
    savePlayerState(state, (k, v) => store.set(k, v));
    expect(loadPlayerState((k) => store.get(k) ?? null)).toEqual(state);
  });

  describe('field sanitization', () => {
    const load = (patch: Record<string, unknown>) => loadPlayerState(() => JSON.stringify(patch));

    it('clamps volume into 0..1 and rejects NaN or non-numbers', () => {
      expect(load({ volume: 4 }).volume).toBe(1);
      expect(load({ volume: -2 }).volume).toBe(0);
      expect(load({ volume: Number.NaN }).volume).toBe(0.7);
      expect(load({ volume: 'loud' }).volume).toBe(0.7);
      expect(load({}).volume).toBe(0.7);
    });

    it('coerces shuffle with Boolean() — the string "false" is truthy', () => {
      // Pinned quirk: only real booleans round-trip sanely.
      expect(load({ shuffle: true }).shuffle).toBe(true);
      expect(load({ shuffle: 0 }).shuffle).toBe(false);
      expect(load({ shuffle: 'false' }).shuffle).toBe(true);
    });

    it('accepts exactly the three repeat modes and the five views', () => {
      expect(load({ repeat: 'one' }).repeat).toBe('one');
      expect(load({ repeat: 'ALL' }).repeat).toBe('off');
      expect(load({ repeat: 'loop' }).repeat).toBe('off');
      expect(load({ view: 'ambience' }).view).toBe('ambience');
      expect(load({ view: 'favorites' }).view).toBe('favorites');
      expect(load({ view: 'playlist' }).view).toBe('playlist');
      expect(load({ view: 'settings' }).view).toBe('search');
    });

    it('maps the pre-revamp tab views onto the new sidebar destinations', () => {
      expect(load({ view: 'music' }).view).toBe('search');
      expect(load({ view: 'queue' }).view).toBe('queue');
      expect(load({ view: 'ambience' }).view).toBe('ambience');
    });

    it('keeps only entries that still look like tracks', () => {
      const state = load({
        freeQueue: [track('a'), null, { id: 'no-name' }, 'nope', { name: 'no-id' }, track('b')],
      });
      expect(state.freeQueue.map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('caps the restored queue at FREE_QUEUE_CAP rows', () => {
      const many = Array.from({ length: FREE_QUEUE_CAP + 40 }, (_, i) => track(`t${i}`));
      const state = load({ freeQueue: many, freeIndex: 5 });
      expect(state.freeQueue).toHaveLength(FREE_QUEUE_CAP);
      expect(state.freeIndex).toBe(5);
    });

    it('clamps freeIndex to [-1, queue.length-1], rounding fractions', () => {
      const two = [track('a'), track('b')];
      expect(load({ freeQueue: two, freeIndex: 99 }).freeIndex).toBe(1);
      expect(load({ freeQueue: two, freeIndex: -7 }).freeIndex).toBe(-1);
      expect(load({ freeQueue: two, freeIndex: 1.9 }).freeIndex).toBe(1); // rounds to 2, clamps to 1
      expect(load({ freeQueue: two, freeIndex: 0.4 }).freeIndex).toBe(0);
      expect(load({ freeQueue: two, freeIndex: 'x' }).freeIndex).toBe(-1);
      expect(load({ freeQueue: two }).freeIndex).toBe(-1);
    });
  });
});

describe('savePlayerState', () => {
  it('writes JSON under the storage key', () => {
    const store = new Map<string, string>();
    savePlayerState(DEFAULT_STATE, (k, v) => store.set(k, v));
    expect(store.get(STORAGE_KEY)).toBe(JSON.stringify(DEFAULT_STATE));
  });

  it('swallows a throwing storage backend', () => {
    expect(() =>
      savePlayerState(DEFAULT_STATE, () => {
        throw new Error('quota exceeded');
      }),
    ).not.toThrow();
  });
});
