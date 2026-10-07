import { FreeMusicError, resolveTrackStream } from './music/client';
import type { SpotifyTrack } from './types';
import { trackArtistNames } from './helpers';
import { isAmbientTrack } from './ambient';

/**
 * The free engine — the `<audio>` element and the resolve/retry/fallback
 * machine that feeds it, extracted from the controller verbatim.
 *
 * The engine owns exactly one thing: turning "play this track" into sound
 * without a login, deciding between a resolved full stream, one fresh
 * retry, and the public 30-second preview. Everything the user sees —
 * the player bar, rows, queue, toasts — stays in the controller and is
 * reached through {@link FreeEngineEvent} notifications, so the engine
 * has no UI imports and is pinnable in tests with a fake element.
 *
 * Guarantees preserved from the controller era:
 * - A stale resolve never overwrites a newer track (the token guard).
 * - A failed resolve is retried exactly once, cache-busted.
 * - The preview is the last resort, and only when one exists.
 */

export type FreeEngineMode = 'resolve' | 'preview';

/** Everything the engine needs from its host (the controller). */
export interface FreeEngineHost {
  /** The persisted volume (0..1), applied when the audio element is created. */
  volume(): number;
  /**
   * Whether this deployment's API can resolve full streams. The host is
   * expected to check lazily (once) — the engine asks before every play.
   */
  canResolve(): Promise<boolean>;
  /**
   * The track the engine should consider current, or null when the free
   * engine is not the active source (the controller folded the old
   * `source !== 'free'` guards into this lookup). Null means: ignore
   * audio-element errors; there is nothing to recover.
   */
  activeFreeTrack(): SpotifyTrack | null;
  /** Synchronous notification of engine state changes. */
  notify(event: FreeEngineEvent): void;
}

export type FreeEngineEvent =
  | { kind: 'resolving'; track: SpotifyTrack }
  /** The first resolve failed; one cache-busted retry is in flight. */
  | { kind: 'retrying' }
  /** A full stream resolved and is about to load. */
  | { kind: 'stream'; track: SpotifyTrack }
  /** Falling back to the public 30-second preview. */
  | { kind: 'preview'; track: SpotifyTrack; message: string }
  /** Neither stream nor preview is available. */
  | { kind: 'unavailable'; message: string }
  /** The audio element started or stopped playing. */
  | { kind: 'playback'; playing: boolean }
  | { kind: 'time' }
  | { kind: 'metadata' }
  | { kind: 'ended' }
  /** The browser blocked autoplay; the user must tap play. */
  | { kind: 'autoplay-blocked' };

export class FreeEngine {
  private audio: HTMLAudioElement | null = null;
  private engineMode: FreeEngineMode = 'resolve';
  /** Guards against a stale resolve overwriting a newer track. */
  private resolveToken = 0;
  private retriedCurrentTrack = false;

  constructor(private readonly host: FreeEngineHost) {}

  // ---- facts for the controller (the player bar reads these) ----

  get mode(): FreeEngineMode {
    return this.engineMode;
  }

  get isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  get hasSource(): boolean {
    return this.audio !== null && this.audio.src !== '';
  }

  /** True once any resolve started this session (the prev-button guard). */
  get hasResolved(): boolean {
    return this.resolveToken > 0;
  }

  get positionMs(): number {
    const audio = this.audio;
    if (audio && audio.src) return audio.currentTime * 1000;
    return 0;
  }

  /** The element's own duration, or null when it has nothing useful. */
  get audioDurationMs(): number | null {
    const audio = this.audio;
    if (audio && audio.src && Number.isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration * 1000;
    }
    return null;
  }

  // ---- transport ----

  /** Starts the play flow for a track (the free source's play path). */
  async playTrack(track: SpotifyTrack): Promise<void> {
    this.retriedCurrentTrack = false;
    this.engineMode = 'resolve';
    const token = ++this.resolveToken;

    this.host.notify({ kind: 'resolving', track });

    // Bundled ambience: play the local file directly and loop it — a
    // 15-second ceiling-fan clip must not "end" and go quiet. Looping also
    // keeps 'ended' (and thus auto-advance) from firing, by design.
    if (isAmbientTrack(track)) {
      const audio = this.ensureAudio();
      this.host.notify({ kind: 'stream', track });
      audio.loop = true;
      audio.src = track.local_url ?? '';
      await audio.play().catch(() => {
        this.host.notify({ kind: 'autoplay-blocked' });
      });
      return;
    }

    if (!(await this.host.canResolve())) {
      this.tryPreviewFallback(track, 'Free playback is not available on this deployment.');
      return;
    }

    try {
      const stream = await resolveTrackStream(this.resolveInput(track));
      if (token !== this.resolveToken) return; // a newer track took over
      const audio = this.linearAudio();
      this.host.notify({ kind: 'stream', track });
      audio.src = stream.url;
      await audio.play().catch(() => {
        this.host.notify({ kind: 'autoplay-blocked' });
      });
    } catch (err) {
      if (token !== this.resolveToken) return;
      this.handleResolveFailure(track, token, err);
    }
  }

  /** Play/pause toggle for the audio element (the bar's play button). */
  toggle(): void {
    const audio = this.ensureAudio();
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }

  /** Pauses only when actually playing (the SDK takeover path). */
  pauseIfPlaying(): void {
    if (this.audio && !this.audio.paused) this.audio.pause();
  }

  /** Full stop: invalidate in-flight resolves, drop the source, reset. */
  stop(): void {
    this.resolveToken++;
    const audio = this.audio;
    if (audio) {
      audio.removeAttribute('src');
      audio.load();
    }
  }

  /** Arrow-key seeking: a relative nudge in seconds, uncapped. */
  nudgeSeconds(delta: number): void {
    const audio = this.audio;
    if (audio && audio.src) audio.currentTime = Math.max(0, audio.currentTime + delta);
  }

  setVolume(volume: number): void {
    if (this.audio) this.audio.volume = volume;
  }

  /** Seeks, capping preview playback to its 30-second window. */
  seekToMs(posMs: number): void {
    const audio = this.audio;
    if (audio && audio.src) {
      const max = this.engineMode === 'preview' ? 29.5 : Number.MAX_SAFE_INTEGER;
      audio.currentTime = Math.min(posMs / 1000, max);
    }
  }

  /**
   * The prev-button rule: a track more than 3 seconds in restarts instead
   * of skipping back. Returns whether it restarted.
   */
  restartIfActive(): boolean {
    const audio = this.audio;
    if (audio && audio.src && !audio.paused && audio.currentTime > 3 && this.resolveToken > 0) {
      audio.currentTime = 0;
      return true;
    }
    return false;
  }

  /** Restores the display mode after a reload (paused, no audio created). */
  resetMode(): void {
    this.engineMode = 'resolve';
  }

  // ---- internals -----------------------------------------------------------

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = 'none';
    audio.volume = this.host.volume();
    audio.addEventListener('timeupdate', () => this.host.notify({ kind: 'time' }));
    audio.addEventListener('loadedmetadata', () => this.host.notify({ kind: 'metadata' }));
    audio.addEventListener('play', () => this.host.notify({ kind: 'playback', playing: true }));
    audio.addEventListener('playing', () => this.host.notify({ kind: 'playback', playing: true }));
    audio.addEventListener('pause', () => this.host.notify({ kind: 'playback', playing: false }));
    audio.addEventListener('ended', () => this.host.notify({ kind: 'ended' }));
    audio.addEventListener('error', () => this.handleAudioError());
    this.audio = audio;
    return audio;
  }

  /** The element as a normal (non-looping) track wants it. */
  private linearAudio(): HTMLAudioElement {
    const audio = this.ensureAudio();
    audio.loop = false; // a previous ambience track may have left it on
    return audio;
  }

  private resolveInput(track: SpotifyTrack): {
    trackId: string;
    title: string;
    artist: string;
    durationMs: number | null;
  } {
    return {
      trackId: track.id,
      title: track.name,
      artist: trackArtistNames(track),
      durationMs: track.duration_ms > 0 ? track.duration_ms : null,
    };
  }

  private handleResolveFailure(track: SpotifyTrack, token: number, err: unknown): void {
    // Bundled ambience never resolves through the API — a local file that
    // fails to play is simply unavailable (missing/corrupt file).
    if (isAmbientTrack(track)) {
      this.host.notify({ kind: 'unavailable', message: 'This ambience sound could not play.' });
      return;
    }
    if (this.retriedCurrentTrack) {
      this.tryPreviewFallback(track, this.describeError(err));
      return;
    }
    // One retry with a fresh (cache-busting) resolution before giving up.
    this.retriedCurrentTrack = true;
    this.host.notify({ kind: 'retrying' });
    resolveTrackStream(this.resolveInput(track), true)
      .then((stream) => {
        if (token !== this.resolveToken) return;
        const audio = this.linearAudio();
        this.host.notify({ kind: 'stream', track });
        audio.src = stream.url;
        void audio.play().catch(() => undefined);
      })
      .catch((retryErr: unknown) => {
        if (token !== this.resolveToken) return;
        this.tryPreviewFallback(track, this.describeError(retryErr));
      });
  }

  /** Last resort: the public 30-second preview, when one exists. */
  private tryPreviewFallback(track: SpotifyTrack, message: string): void {
    if (track.preview_url) {
      this.engineMode = 'preview';
      this.host.notify({ kind: 'preview', track, message });
      const audio = this.linearAudio();
      audio.src = track.preview_url;
      void audio.play().catch(() => undefined);
      return;
    }
    this.host.notify({ kind: 'unavailable', message });
  }

  private describeError(err: unknown): string {
    if (err instanceof FreeMusicError) return err.message;
    if (err instanceof Error && err.message) return err.message;
    return 'Could not play this song.';
  }

  private handleAudioError(): void {
    const track = this.host.activeFreeTrack();
    if (!track) return;
    const token = this.resolveToken;
    // The audio element failed on a URL we handed it — re-resolve (fresh)
    // or fall back to the preview.
    this.handleResolveFailure(track, token, new Error('That stream expired — refreshing.'));
  }
}
