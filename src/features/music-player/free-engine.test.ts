import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeEngine, type FreeEngineEvent, type FreeEngineHost } from './free-engine';
import type { SpotifyTrack } from './types';

/**
 * Characterization of the free engine — the resolve/retry/fallback
 * machine, extracted verbatim from the controller. The audio element is
 * faked (jsdom cannot play), the resolve API is mocked, and the host is
 * a spy; what these tests pin is the decision sequence: which events
 * fire, in what order, and what ends up on the element.
 */

vi.mock('./music/client', () => ({
  FreeMusicError: class FreeMusicError extends Error {},
  resolveTrackStream: vi.fn(),
}));

import { resolveTrackStream } from './music/client';

const resolveMock = vi.mocked(resolveTrackStream);

// ---- the fake element ------------------------------------------------------

class FakeAudio {
  src = '';
  volume = 1;
  preload = '';
  paused = true;
  currentTime = 0;
  duration = NaN;
  loop = false;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removedAttr: string | null = null;
  playShouldReject = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  play(): Promise<void> {
    this.playCalls++;
    if (this.playShouldReject) {
      return Promise.reject(new Error('Not allowed to call play()'));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
  }

  removeAttribute(name: string): void {
    this.removedAttr = name;
    if (name === 'src') this.src = '';
  }

  load(): void {
    this.loadCalls++;
  }
}

// ---- the fake host ----------------------------------------------------------

class HostSpy implements FreeEngineHost {
  volumeValue = 0.7;
  canResolveValue = true;
  activeTrack: SpotifyTrack | null = null;
  events: FreeEngineEvent[] = [];

  readonly volume = vi.fn((): number => this.volumeValue);
  readonly canResolve = vi.fn(async (): Promise<boolean> => this.canResolveValue);
  readonly activeFreeTrack = vi.fn((): SpotifyTrack | null => this.activeTrack);
  readonly notify = vi.fn((event: FreeEngineEvent): void => {
    this.events.push(event);
  });
}

function kinds(host: HostSpy): string[] {
  return host.events.map((e) => e.kind);
}

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: 't-1',
    name: 'Song',
    uri: 'spotify:track:t-1',
    duration_ms: 200_000,
    preview_url: 'https:// previews.example/30s.mp3',
    album: { name: 'Album', images: [] },
    artists: [{ name: 'Artist' }],
    ...overrides,
  } as SpotifyTrack;
}

function stream(url: string): {
  url: string;
  videoId: string;
  durationSec: number;
  cached: boolean;
} {
  return { url, videoId: 'v1', durationSec: 200, cached: false };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FreeEngine', () => {
  let host: HostSpy;
  let engine: FreeEngine;
  let instances: FakeAudio[];
  let rejectNextPlays: boolean;

  beforeEach(() => {
    resolveMock.mockReset();
    host = new HostSpy();
    engine = new FreeEngine(host);
    instances = [];
    rejectNextPlays = false;
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          const a = new FakeAudio();
          a.playShouldReject = rejectNextPlays;
          instances.push(a);
          return a;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function element(): FakeAudio {
    if (instances.length === 0) throw new Error('no audio element created yet');
    return instances[instances.length - 1];
  }

  describe('the happy path', () => {
    it('resolves, notifies, and plays the stream', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());

      expect(kinds(host)).toEqual(['resolving', 'stream']);
      const audio = element();
      expect(audio.src).toBe('https://cdn.example/full.mp3');
      expect(audio.preload).toBe('none');
      expect(audio.volume).toBe(0.7);
      expect(audio.playCalls).toBe(1);
      expect(audio.paused).toBe(false);
      expect(engine.mode).toBe('resolve');
      expect(engine.hasResolved).toBe(true);
      expect(engine.isPlaying).toBe(true);
    });

    it('emits stream before assigning the source (the subtitle leads)', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      const order: string[] = [];
      host.events.forEach((e, i) => order.push(`${i}:${e.kind}`));
      expect(order[0]).toBe('0:resolving');
      expect(order[1]).toBe('1:stream');
    });
  });

  describe('the token guard', () => {
    it('ignores a stale resolve when a newer track took over', async () => {
      const first = deferred<{
        url: string;
        videoId: string;
        durationSec: number;
        cached: boolean;
      }>();
      resolveMock.mockReturnValueOnce(first.promise);
      resolveMock.mockResolvedValue(stream('https://cdn.example/second.mp3'));

      const p1 = engine.playTrack(track({ id: 'a' }));
      const p2 = engine.playTrack(track({ id: 'b' }));
      first.resolve(stream('https://cdn.example/first.mp3'));
      await Promise.all([p1, p2]);

      expect(element().src).toBe('https://cdn.example/second.mp3');
      // No 'stream' event for the stale first track — only resolving×2 + stream(b).
      expect(kinds(host)).toEqual(['resolving', 'resolving', 'stream']);
    });

    it('stop() invalidates in-flight resolves and drops the source', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      engine.stop();
      const audio = element();
      expect(audio.removedAttr).toBe('src');
      expect(audio.src).toBe('');
      expect(audio.loadCalls).toBe(1);
      expect(engine.hasSource).toBe(false);
    });
  });

  describe('the retry policy', () => {
    it('retries exactly once, cache-busted, and plays the fresh stream', async () => {
      resolveMock.mockRejectedValueOnce(new Error('502'));
      resolveMock.mockResolvedValueOnce(stream('https://cdn.example/fresh.mp3'));

      await engine.playTrack(track());
      await vi.waitFor(() => expect(element().src).toBe('https://cdn.example/fresh.mp3'));

      expect(resolveMock).toHaveBeenCalledTimes(2);
      const second = resolveMock.mock.calls[1]!;
      expect(second[1]).toBe(true); // cache-busted
      expect(kinds(host)).toEqual(['resolving', 'retrying', 'stream']);
      expect(element().playCalls).toBe(1);
    });

    it('falls back to the 30-second preview when both resolves fail', async () => {
      resolveMock.mockRejectedValue(new Error('gone'));
      await engine.playTrack(track({ preview_url: 'https://p.example/30s.mp3' }));
      await vi.waitFor(() => expect(element().src).toBe('https://p.example/30s.mp3'));

      expect(engine.mode).toBe('preview');
      const preview = host.events.find((e) => e.kind === 'preview');
      expect(preview).toMatchObject({ kind: 'preview', message: 'gone' });
    });

    it('gives up with the error message when no preview exists', async () => {
      resolveMock.mockRejectedValue(new Error('gone'));
      await engine.playTrack(track({ preview_url: null }));
      await vi.waitFor(() => expect(kinds(host)).toContain('unavailable'));
      expect(host.events.find((e) => e.kind === 'unavailable')).toMatchObject({
        message: 'gone',
      });
      // No element was ever created — nothing to play.
      expect(instances.length).toBe(0);
    });

    it('maps a non-Error rejection to the generic message', async () => {
      resolveMock.mockRejectedValue('just a string');
      await engine.playTrack(track({ preview_url: null }));
      await vi.waitFor(() => expect(kinds(host)).toContain('unavailable'));
      expect(host.events.find((e) => e.kind === 'unavailable')).toMatchObject({
        message: 'Could not play this song.',
      });
    });
  });

  describe('the capabilities gate', () => {
    it('skips resolving entirely and goes straight to the preview', async () => {
      host.canResolveValue = false;
      await engine.playTrack(track({ preview_url: 'https://p.example/30s.mp3' }));

      expect(resolveMock).not.toHaveBeenCalled();
      expect(element().src).toBe('https://p.example/30s.mp3');
      expect(engine.mode).toBe('preview');
      const preview = host.events.find((e) => e.kind === 'preview');
      expect(preview).toMatchObject({
        message: 'Free playback is not available on this deployment.',
      });
    });
  });

  describe('autoplay blocking', () => {
    it('notifies and does not cascade into failure handling', async () => {
      rejectNextPlays = true;
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());

      expect(kinds(host)).toEqual(['resolving', 'stream', 'autoplay-blocked']);
      // No retry was started — the stream itself is fine.
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(element().playCalls).toBe(1);
    });
  });

  describe('audio element events', () => {
    it('forwards playback, time, metadata and ended to the host', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      const audio = element();
      host.events.length = 0;

      audio.dispatch('play');
      audio.dispatch('timeupdate');
      audio.dispatch('loadedmetadata');
      audio.dispatch('ended');
      audio.dispatch('pause');

      expect(kinds(host)).toEqual(['playback', 'time', 'metadata', 'ended', 'playback']);
      expect(host.events[0]).toMatchObject({ kind: 'playback', playing: true });
      expect(host.events[4]).toMatchObject({ kind: 'playback', playing: false });
    });

    it('re-resolves on an element error when a free track is active', async () => {
      host.activeTrack = track();
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(host.activeTrack);
      host.events.length = 0;
      resolveMock.mockClear();
      resolveMock.mockRejectedValue(new Error('502'));

      element().dispatch('error');
      await vi.waitFor(() => expect(kinds(host)).toContain('retrying'));
      expect(resolveMock).toHaveBeenCalledTimes(1);
      // The recovery uses the expired-stream message.
      expect(host.events.find((e) => e.kind === 'retrying')).toBeDefined();
    });

    it('ignores element errors when the free engine is not the source', () => {
      host.activeTrack = null; // the controller's folded source guard
      const before = host.events.length;
      // No element yet — create one via toggle, then error it.
      engine.toggle();
      element().dispatch('error');
      expect(host.events.length).toBe(before); // unchanged, no crash
    });
  });

  describe('transport facts', () => {
    it('restarts a track more than three seconds in instead of skipping', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      const audio = element();
      audio.paused = false;
      audio.currentTime = 12;
      expect(engine.restartIfActive()).toBe(true);
      expect(audio.currentTime).toBe(0);

      audio.currentTime = 2;
      expect(engine.restartIfActive()).toBe(false);
      expect(audio.currentTime).toBe(2);
    });

    it('caps preview seeks to 29.5s but not full streams', async () => {
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      engine.seekToMs(600_000);
      expect(element().currentTime).toBe(600);

      // Preview mode (caps at 29.5s).
      host.canResolveValue = false;
      await engine.playTrack(track({ id: 't-2', preview_url: 'https://p.example/30s.mp3' }));
      engine.seekToMs(600_000);
      expect(element().currentTime).toBe(29.5);
    });

    it('pauseIfPlaying only pauses a playing element', async () => {
      expect(engine.isPlaying).toBe(false);
      engine.pauseIfPlaying(); // no element — a no-op
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      expect(engine.isPlaying).toBe(true); // the fake's play() started it
      element().paused = true; // simulate an existing pause
      engine.pauseIfPlaying(); // already paused — nothing to do
      expect(element().pauseCalls).toBe(0);
      element().paused = false;
      engine.pauseIfPlaying();
      expect(element().pauseCalls).toBe(1);
      expect(element().paused).toBe(true);
      expect(engine.isPlaying).toBe(false);
    });

    it('resetMode restores the display mode without touching audio', async () => {
      host.canResolveValue = false;
      await engine.playTrack(track({ preview_url: 'https://p.example/30s.mp3' }));
      expect(engine.mode).toBe('preview');
      engine.resetMode();
      expect(engine.mode).toBe('resolve');
    });

    it('exposes position and duration from the element only with a source', async () => {
      expect(engine.positionMs).toBe(0);
      expect(engine.audioDurationMs).toBeNull();
      expect(engine.hasSource).toBe(false);

      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track());
      const audio = element();
      audio.currentTime = 5;
      audio.duration = 200;
      expect(engine.positionMs).toBe(5000);
      expect(engine.audioDurationMs).toBe(200_000);
      expect(engine.hasSource).toBe(true);
    });
  });

  describe('bundled ambience tracks (local_url)', () => {
    const rain = (): SpotifyTrack =>
      track({
        id: 'ambient:rain',
        uri: 'padify:ambient:rain',
        name: 'Rain',
        preview_url: null,
        local_url: 'sounds/rain.mp3',
      });

    it('plays the bundled file directly, looping, without resolving', async () => {
      await engine.playTrack(rain());

      expect(resolveMock).not.toHaveBeenCalled();
      expect(host.canResolve).not.toHaveBeenCalled();
      expect(kinds(host)).toEqual(['resolving', 'stream']);
      const audio = element();
      expect(audio.src).toBe('sounds/rain.mp3');
      expect(audio.loop).toBe(true);
      expect(audio.playCalls).toBe(1);
    });

    it('an ambience error is unavailable, never a resolve retry', async () => {
      host.activeTrack = rain();
      await engine.playTrack(rain());
      host.events.length = 0;

      element().dispatch('error');

      expect(kinds(host)).toEqual(['unavailable']);
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('a normal track after ambience clears the loop flag', async () => {
      await engine.playTrack(rain());
      resolveMock.mockResolvedValue(stream('https://cdn.example/full.mp3'));
      await engine.playTrack(track({ id: 't-2' }));

      expect(element().src).toBe('https://cdn.example/full.mp3');
      expect(element().loop).toBe(false);
    });
  });
});
