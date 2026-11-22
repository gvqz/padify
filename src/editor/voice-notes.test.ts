/**
 * Voice notes — the capture session's rules, the card's wiring and the
 * clock, pinned.
 *
 * The recorder and the mic are injectable seams (jsdom has neither
 * MediaRecorder nor getUserMedia), so every path the browser can take —
 * the blocked mic, the dead take, the over-cap recording, the degraded
 * store — is exercised with fakes. The card decoration runs against the
 * real DOM; playback stays behind its seams (jsdom's Audio cannot play).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decorateVoiceNotes,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_MS,
  formatVoiceClock,
  pickRecorderMime,
  resetVoiceNotesForTests,
  startVoiceCapture,
  stopVoicePlayback,
  voiceFailureMessage,
  voiceRecordingName,
  VoiceUrlCache,
  type VoiceRecorderLike,
} from './voice-notes';
import { padifyAttRef } from '../../shared/att-refs';

const GOOD_ID = 'att-0123456789abcdef01234567';

/** A mic that answers with a stream whose tracks remember being stopped. */
function fakeStream() {
  const tracks = [{ stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

/** A recorder whose take is whatever the test pushes. */
function fakeRecorder() {
  let dataHandler: ((chunk: Blob) => void) | null = null;
  let errorHandler: (() => void) | null = null;
  const recorder: VoiceRecorderLike = {
    start: vi.fn(),
    stop: vi.fn(async () => {}), // the real encoder delivers its tail here
    onData: (handler) => {
      dataHandler = handler;
    },
    onError: (handler) => {
      errorHandler = handler;
    },
  };
  return {
    recorder,
    emit: (chunk: Blob) => dataHandler?.(chunk),
    fail: () => errorHandler?.(),
  };
}

/** The MediaRecorder stub — the module's mime gate answers through it. */
function stubMediaRecorder(): void {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {
    static isTypeSupported(): boolean {
      return true;
    }
  };
}

function unstubMediaRecorder(original: unknown): void {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
}

describe('pickRecorderMime', () => {
  it('answers null where MediaRecorder does not exist', () => {
    // jsdom has no MediaRecorder — and the browser gates on this before
    // ever touching the mic.
    expect(pickRecorderMime()).toBeNull();
  });
});

describe('startVoiceCapture', () => {
  it('refuses before touching the mic when no encoder exists', async () => {
    const openMic = vi.fn();
    const start = await startVoiceCapture({ openMic });
    expect(start).toEqual({ started: false, reason: 'unsupported' });
    expect(openMic).not.toHaveBeenCalled();
  });

  it('maps a blocked mic to the honest reason', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { tracks } = fakeStream();
      const openMic = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
      const start = await startVoiceCapture({ openMic });
      expect(start).toEqual({ started: false, reason: 'mic-blocked' });
      expect(openMic).toHaveBeenCalledOnce();
      expect(tracks[0]!.stop).not.toHaveBeenCalled(); // never opened
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('records, caps to the base mime, stores and answers the card coordinates', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream, tracks } = fakeStream();
      const take = fakeRecorder();
      let clock = 0;
      const store = vi.fn().mockResolvedValue(true);
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        store,
        now: () => clock,
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      take.emit(new Blob([new Uint8Array(64)], { type: 'audio/webm;codecs=opus' }));

      clock = 42_000;
      const result = await start.session.stop();

      expect(result).toEqual({
        ok: true,
        id: expect.any(String),
        mime: 'audio/webm', // the parameter-bearing recorder mime lands base
        durationMs: 42_000,
      });
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({ mime: 'audio/webm', size: 64, name: expect.any(String) }),
        expect.any(Blob),
      );
      // Session-per-recording teardown: the mic is released on stop.
      expect(tracks[0]!.stop).toHaveBeenCalled();
      expect(start.session.elapsedMs()).toBe(0); // ended — the clock stops
      const storedMeta = store.mock.calls[0]![0] as { id: string };
      expect(result.ok && result.id).toBe(storedMeta.id);
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('refuses an over-cap take with the honest reason', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream } = fakeStream();
      const take = fakeRecorder();
      const store = vi.fn();
      let clock = 0;
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        store,
        now: () => clock,
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      clock = 1_000;
      take.emit(new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)]));
      const result = await start.session.stop();
      expect(result).toEqual({ ok: false, reason: 'too-large' });
      expect(store).not.toHaveBeenCalled();
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('refuses a dead take (nothing recorded, nothing worth keeping)', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream } = fakeStream();
      const take = fakeRecorder();
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        now: () => 100, // under MIN_RECORDING_MS
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      const result = await start.session.stop();
      expect(result).toEqual({ ok: false, reason: 'empty' });
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('surfaces a degraded store at capture time (no-storage)', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream } = fakeStream();
      const take = fakeRecorder();
      const store = vi.fn().mockResolvedValue(false);
      let clock = 0;
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        store,
        now: () => clock,
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      clock = 1_000;
      take.emit(new Blob([new Uint8Array(64)]));
      const result = await start.session.stop();
      expect(result).toEqual({ ok: false, reason: 'no-storage' });
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('cancel tears the mic down and keeps nothing', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream, tracks } = fakeStream();
      const take = fakeRecorder();
      const store = vi.fn();
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        store,
        now: () => 5_000,
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      take.emit(new Blob([new Uint8Array(64)]));
      start.session.cancel();
      expect(tracks[0]!.stop).toHaveBeenCalled();
      expect(start.session.elapsedMs()).toBe(0);
      const result = await start.session.stop();
      expect(result).toEqual({ ok: false, reason: 'failed' }); // already ended
      expect(store).not.toHaveBeenCalled();
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('a mid-take device error ends the session as failed', async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    stubMediaRecorder();
    try {
      const { stream } = fakeStream();
      const take = fakeRecorder();
      const start = await startVoiceCapture({
        openMic: async () => stream,
        createRecorder: () => take.recorder,
        now: () => 2_000,
      });
      if (!start.started) {
        throw new Error('the fake session must start');
      }
      take.fail();
      const result = await start.session.stop();
      expect(result).toEqual({ ok: false, reason: 'failed' });
    } finally {
      unstubMediaRecorder(original);
    }
  });

  it('the auto-stop guard sits well inside the byte cap', () => {
    // 20 minutes of Opus voice at a frugal 16 kbit/s stays under 5 MB —
    // the guard must never push a recordable take into discard territory.
    const bytesAtGuard = (MAX_RECORDING_MS / 1000) * (16_000 / 8);
    expect(bytesAtGuard).toBeLessThan(MAX_RECORDING_BYTES);
  });
});

describe('the card and the clock', () => {
  it('the clock speaks m:ss', () => {
    expect(formatVoiceClock(0)).toBe('0:00');
    expect(formatVoiceClock(59_400)).toBe('0:59');
    expect(formatVoiceClock(65_000)).toBe('1:05');
    expect(formatVoiceClock(MAX_RECORDING_MS)).toBe('20:00');
  });

  it('the stored name names the take', () => {
    expect(voiceRecordingName(new Date('2026-11-22T14:41:00'))).toMatch(/^Voice recording — /);
  });

  it('every failure reason carries an honest sentence', () => {
    for (const reason of [
      'unsupported',
      'mic-blocked',
      'no-mic',
      'empty',
      'too-large',
      'no-storage',
      'failed',
    ] as const) {
      expect(voiceFailureMessage(reason), reason).not.toHaveLength(0);
    }
  });
});

describe('decorateVoiceNotes', () => {
  beforeEach(() => {
    resetVoiceNotesForTests();
  });
  afterEach(() => {
    resetVoiceNotesForTests();
    document.body.innerHTML = '';
  });

  it('wraps only the attachment-ref cards, as atoms, honest about duration', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      `<audio src="${padifyAttRef(GOOD_ID)}" data-duration="42000"></audio>`,
      '<audio src="https://example.com/track.mp3"></audio>',
      '<audio></audio>',
    ].join('');
    document.body.appendChild(root);

    decorateVoiceNotes(root);

    // The stored hook rides inside the wrapper, the chrome around it.
    const wrapper = root.querySelector('figure.padify-voice') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute('contenteditable')).toBe('false');
    const ours = wrapper.querySelector(`audio[src="${padifyAttRef(GOOD_ID)}"]`);
    expect(ours).not.toBeNull();
    // The chrome: play/pause button, the wave band, the stored duration.
    expect(wrapper.querySelector('.padify-voice-btn')).not.toBeNull();
    expect(wrapper.querySelector('.padify-voice-wave')).not.toBeNull();
    expect(wrapper.querySelector<HTMLElement>('.padify-voice-time')!.textContent).toBe(
      '0:00 / 0:42',
    );
    // A foreign src is not ours: untouched, unwrapped.
    const foreign = root.querySelector('audio[src^="https:"]') as HTMLElement;
    expect(foreign.parentElement!.classList.contains('padify-voice')).toBe(false);
  });

  it('is idempotent — a wrapped card is never wrapped twice', () => {
    const root = document.createElement('div');
    root.innerHTML = `<audio src="${padifyAttRef(GOOD_ID)}" data-duration="1000"></audio>`;
    document.body.appendChild(root);

    decorateVoiceNotes(root);
    expect(root.querySelectorAll('figure.padify-voice').length).toBe(1);
    decorateVoiceNotes(root);
    expect(root.querySelectorAll('figure.padify-voice').length).toBe(1);
    // The chrome never duplicated either.
    expect(root.querySelectorAll('.padify-voice-btn').length).toBe(1);
  });

  it('stopVoicePlayback with no player is a quiet no-op', () => {
    expect(() => stopVoicePlayback()).not.toThrow();
  });
});

describe('VoiceUrlCache', () => {
  /** A fake URL factory: the n-th blob gets `blob:n`, listed in order. */
  function fakeUrls() {
    const created: string[] = [];
    const revoked: string[] = [];
    const cache = new VoiceUrlCache(
      () => {
        const url = `blob:${created.length}`;
        created.push(url);
        return url;
      },
      (url) => revoked.push(url),
    );
    return { cache, created, revoked };
  }

  const blob = new Blob([new Uint8Array(8)]);

  it('hands the same URL back for the same id', () => {
    const { cache, created, revoked } = fakeUrls();
    const first = cache.put(GOOD_ID, blob);
    expect(cache.get(GOOD_ID)).toBe(first);
    expect(cache.get(GOOD_ID)).toBe(first); // repeated reads stay stable
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it('evicts the least-recently-used beyond the limit, revoking its URL', () => {
    const { cache, created, revoked } = fakeUrls();
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    for (const id of ids) {
      cache.put(id, blob);
    }
    // a1 was the first in — it must be gone, and its URL revoked.
    expect(cache.get('a1')).toBeUndefined();
    expect(revoked).toEqual([created[0]]);
    // The second-oldest survives this single eviction.
    expect(cache.get('a2')).toBeDefined();
  });

  it('a re-read refreshes recency and saves the entry from eviction', () => {
    const { cache, created, revoked } = fakeUrls();
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
      cache.put(id, blob);
    }
    // b1 is the oldest — a read makes it the newest.
    expect(cache.get('b1')).toBeDefined();
    cache.put('b9', blob); // evicts b2, not b1
    expect(cache.get('b1')).toBeDefined();
    expect(cache.get('b2')).toBeUndefined();
    expect(revoked).toEqual([created[1]]);
  });

  it('drop revokes and forgets one entry', () => {
    const { cache, revoked } = fakeUrls();
    cache.put(GOOD_ID, blob);
    cache.drop(GOOD_ID);
    expect(cache.get(GOOD_ID)).toBeUndefined();
    expect(revoked).toHaveLength(1);
  });
});
