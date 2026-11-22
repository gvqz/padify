/**
 * Voice notes — the recording card on the rich note surface.
 *
 * THE SHAPE. A voice note is not a note type: the audio is an attachment
 * (the store the image pipeline built — storage/attachments.ts, the cloud
 * flush, the server's blob table), and the note carries the same tiny
 * reference every other tenant does. The stored card is exactly
 *
 *   <audio src="padify-att:<id>" data-duration="<ms>"></audio>
 *
 * admitted by the storage subset's voice vocabulary (storage-subset.ts),
 * collected by the shared ref grammar (shared/att-refs.ts — both garbage
 * collectors, the single-note envelope and the workspace envelope ride
 * it), and styled/wired by this module. THE SCOPE is the owner's call
 * (2026-11-22): capture lives on the RICH surface alone — the toolbar's
 * mic row; plain and markdown notes stay text/image as they are.
 *
 * THE LIVE ELEMENT NEVER CARRIES BYTES. The DOM's src stays the literal
 * `padify-att:` ref for the surface's whole lifetime — a blob URL would
 * fail the subset's src gate at the next absorb and silently delete the
 * card (the one catastrophic path this design closes). Playback runs on
 * a JS-owned Audio element fed from a bounded blob-URL cache; the DOM
 * element is a styled card the player drives through CSS variables.
 *
 * THE DISCIPLINES IT INHERITS:
 *  • note-images' capture contract — over-cap and degraded-store failures
 *    refuse HERE with an honest message, never poisoning the upload flush;
 *  • voice typing's session rules (voice.ts) — the mic is released the
 *    moment a session ends, switching notes ends the session, and every
 *    failure path says what happened;
 *  • math's shell pattern — decoration is a post-paint pass, idempotent,
 *    and the wrapper it builds is a tag outside the subset, so every
 *    absorb unwraps the chrome away (the sanitizer owns the vocabulary).
 */

import { $, type Q } from '../lib/q';
import { showToast } from '../ui/toast';
import { getEditorPort } from './port';
import { isRichNote } from './note-types';
import { getTabManager } from '../tabs';
import {
  getAttachmentBlob,
  newAttachmentId,
  putAttachment,
  type AttachmentMeta,
} from '../storage/attachments';
import { fetchAttachment, notifyAttachmentLedgerChanged } from '../cloud/attachments';
import { MAX_ATTACHMENT_BYTES } from '../../shared/wire';
import { padifyAttRef } from '../../shared/att-refs';

// ---------------------------------------------------------------------------
// Capture — the recorder session
// ---------------------------------------------------------------------------

/** The mime ladder, best first: Opus/WebM everywhere it exists, MP4 for Safari. */
const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

/** The capture-side byte ceiling — the wire contract's one number. */
export const MAX_RECORDING_BYTES = MAX_ATTACHMENT_BYTES;

/**
 * The auto-stop guard. Opus voice at typical bitrates leaves minutes of
 * headroom below the 5 MB cap, but a user should never record twenty
 * minutes of talk into a discard. The stop path's own cap check stays —
 * this guard is the seatbelt in front of it.
 */
export const MAX_RECORDING_MS = 20 * 60 * 1000;

/** The minimum worth keeping — a stray click is not a recording. */
const MIN_RECORDING_MS = 300;

/** Why a recording didn't land — the toast's vocabulary. */
export type VoiceCaptureFailure =
  'unsupported' | 'no-mic' | 'mic-blocked' | 'empty' | 'too-large' | 'no-storage' | 'failed';

export type VoiceCaptureResult =
  | { ok: true; id: string; mime: string; durationMs: number }
  | { ok: false; reason: VoiceCaptureFailure };

/**
 * The pluggable recorder seam (tests inject; production wraps
 * MediaRecorder). The adapter owns the native event wiring so handlers
 * here never touch browser event types. `stop()` resolves after the
 * encoder has delivered its final chunk — without a timeslice, everything
 * arrives at stop, so assembling before that resolution reads an empty
 * take.
 */
export interface VoiceRecorderLike {
  start(): void;
  stop(): Promise<void>;
  onData(handler: (chunk: Blob) => void): void;
  onError(handler: () => void): void;
}

export type VoiceRecorderFactory = (mime: string, stream: MediaStream) => VoiceRecorderLike;

/** The pluggable mic (tests inject; production is getUserMedia). */
export type MicOpener = () => Promise<MediaStream>;

/** The pluggable store write (tests inject a spy). */
export type AttachmentStore = (
  meta: Omit<AttachmentMeta, 'uploaded' | 'createdAt'>,
  blob: Blob,
) => Promise<boolean>;

export interface VoiceCaptureDeps {
  openMic?: MicOpener;
  createRecorder?: VoiceRecorderFactory;
  store?: AttachmentStore;
  now?: () => number;
}

/** The first mime this browser can actually encode, or null. */
export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const mime of RECORDER_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      // A browser that throws on isTypeSupported simply loses this rung.
    }
  }
  return null;
}

/** The store meta's mime: the base type only — parameters (`;codecs=…`)
 *  fail the wire's mime pattern and would land as octet-stream lies. */
function baseMime(mime: string): string {
  return (mime.split(';', 1)[0] ?? '').trim().toLowerCase() || 'audio/webm';
}

/**
 * One recording session. `stop()` assembles, caps and stores the take
 * (resolving with the stored card's coordinates), `cancel()` throws the
 * take away, `onLevel` drives the live wave. The mic stream is torn down
 * on every exit — recording-per-session teardown is privacy-correct
 * behavior the old app got right.
 */
export interface VoiceCaptureSession {
  /** Elapsed recording time in ms (the timer and the auto-stop read it). */
  elapsedMs(): number;
  /** Fires a few times a second with the mic's instantaneous level, 0..1.
   *  Never fires when the platform gives no analyser — the wave rests. */
  onLevel(callback: ((level: number) => void) | null): void;
  stop(): Promise<VoiceCaptureResult>;
  cancel(): void;
}

/**
 * A capture start: the session, or the reason the mic never opened.
 * Result-object, not an exception — every caller renders the reason.
 */
export type VoiceCaptureStart =
  { started: true; session: VoiceCaptureSession } | { started: false; reason: VoiceCaptureFailure };

/**
 * Opens the mic and starts recording. Every failure path releases the
 * stream before returning, so a blocked mic never leaks a capture track.
 */
export async function startVoiceCapture(deps: VoiceCaptureDeps = {}): Promise<VoiceCaptureStart> {
  const picked = pickRecorderMime();
  if (picked === null) {
    return { started: false, reason: 'unsupported' };
  }
  // The narrowed alias — closures below (endSession) run after this line,
  // but the type checker wants the non-null fact spelled out for them.
  const mime: string = picked;
  const openMic = deps.openMic ?? (() => navigator.mediaDevices.getUserMedia({ audio: true }));
  const now = deps.now ?? (() => performance.now());

  let stream: MediaStream;
  try {
    stream = await openMic();
  } catch (error) {
    return { started: false, reason: fromMicError(error) };
  }

  let recorder: VoiceRecorderLike;
  try {
    recorder = (deps.createRecorder ?? defaultRecorderFactory)(mime, stream);
  } catch {
    releaseStream(stream);
    return { started: false, reason: 'failed' };
  }

  const chunks: Blob[] = [];
  const startedAt = now();
  let levelCallback: ((level: number) => void) | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let levelRelease: (() => void) | null = null;

  recorder.onData((chunk) => {
    if (chunk && chunk.size > 0) {
      chunks.push(chunk);
    }
  });
  // A mid-take device error (the track ended — mic yanked by the OS or
  // another app): end the session honestly rather than sit on a dead mic.
  recorder.onError(() => {
    void endSession('failed');
  });

  try {
    recorder.start();
  } catch {
    releaseStream(stream);
    return { started: false, reason: 'failed' };
  }

  // The live wave: sample the track through an analyser when the platform
  // offers one (AudioContext is absent in jsdom — the wave rests there).
  const levelReader = createLevelReader(stream);
  if (levelReader) {
    levelRelease = levelReader.release;
    levelTimer = setInterval(() => {
      if (levelCallback && !stopped) {
        levelCallback(levelReader.read());
      }
    }, 100);
  }

  function releaseStream(live: MediaStream): void {
    for (const track of live.getTracks()) {
      track.stop();
    }
  }

  function cleanup(): void {
    stopped = true;
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    levelRelease?.();
    releaseStream(stream);
  }

  /**
   * The one exit: the encoder's final chunk, then teardown, then either
   * the override verdict (a device error) or the full assemble → cap →
   * store path.
   */
  async function endSession(override?: VoiceCaptureFailure): Promise<VoiceCaptureResult> {
    if (stopped) {
      return { ok: false, reason: override ?? 'failed' };
    }
    const durationMs = now() - startedAt;

    if (override) {
      cleanup();
      return { ok: false, reason: override };
    }
    // Everything the take holds arrives with the stop — ask first, tear
    // down second (a released stream mid-encode could truncate the tail).
    try {
      await recorder.stop();
    } catch {
      // keep whatever already arrived
    }
    cleanup();

    if (durationMs < MIN_RECORDING_MS || chunks.length === 0) {
      return { ok: false, reason: 'empty' };
    }

    const blob = new Blob(chunks, { type: mime });
    if (blob.size > MAX_RECORDING_BYTES) {
      return { ok: false, reason: 'too-large' };
    }

    const store = deps.store ?? putAttachment;
    const id = newAttachmentId();
    const stored = await store(
      { id, name: voiceRecordingName(), mime: baseMime(mime), size: blob.size },
      blob,
    );
    if (!stored) {
      return { ok: false, reason: 'no-storage' };
    }
    // The pending upload joins the ledger's picture immediately — the
    // chip's count is honest even offline, exactly like a captured image.
    notifyAttachmentLedgerChanged();
    return { ok: true, id, mime: baseMime(mime), durationMs: Math.round(durationMs) };
  }

  function fromMicError(error: unknown): VoiceCaptureFailure {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'mic-blocked';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'no-mic';
    }
    return 'failed';
  }

  return {
    started: true,
    session: {
      elapsedMs: () => (stopped ? 0 : now() - startedAt),
      onLevel(callback) {
        levelCallback = callback;
      },
      stop: () => endSession(),
      cancel: () => {
        // The take is thrown away — the encoder's stop runs unawaited (its
        // chunk lands in the discarded buffer) and the mic goes now.
        try {
          void recorder.stop();
        } catch {
          /* already stopped — harmless */
        }
        cleanup();
        chunks.length = 0;
      },
    },
  };
}

function defaultRecorderFactory(mime: string, stream: MediaStream): VoiceRecorderLike {
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  return {
    start: () => recorder.start(),
    stop: () =>
      new Promise<void>((resolve) => {
        // The spec's order: stop() → dataavailable (the tail chunk) →
        // stop event. Resolving on the stop event means the chunk the
        // handler collected is already in.
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve(); // already stopped — keep whatever arrived
        }
      }),
    onData: (handler) => {
      recorder.ondataavailable = (event) => handler(event.data);
    },
    onError: (handler) => {
      recorder.onerror = () => handler();
    },
  };
}

/** The live mic level, sampled through an analyser (null when none). */
function createLevelReader(stream: MediaStream): { read(): number; release(): void } | null {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      return null;
    }
    const context = new Ctx();
    const source = context.createMediaStreamSource(stream);
    const node = context.createAnalyser();
    node.fftSize = 256;
    source.connect(node);
    const buffer = new Uint8Array(node.fftSize);
    return {
      read: () => {
        node.getByteTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          peak = Math.max(peak, Math.abs(buffer[i]! - 128));
        }
        return Math.min(1, (peak / 128) * 2.4);
      },
      release: () => {
        try {
          source.disconnect();
          void context.close();
        } catch {
          /* already closed — harmless */
        }
      },
    };
  } catch {
    return null;
  }
}

/** The stored attachment's name — the one a download or the store UI shows. */
export function voiceRecordingName(at: Date = new Date()): string {
  const when = at
    .toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/\s+/g, ' ')
    .trim();
  return `Voice recording — ${when}`;
}

/** The toast copy for a capture refusal — honest about the why. */
export function voiceFailureMessage(reason: VoiceCaptureFailure): string {
  switch (reason) {
    case 'unsupported':
      return "Voice recording isn't supported in this browser.";
    case 'mic-blocked':
      return 'Microphone access is blocked. Allow it in your browser settings and try again.';
    case 'no-mic':
      return 'No microphone was found on this device.';
    case 'empty':
      return 'Nothing was recorded — the take was too short to keep.';
    case 'too-large':
      return `That recording is too long — voice notes are capped at ${Math.round(MAX_RECORDING_BYTES / 1_000_000)} MB.`;
    case 'no-storage':
      return "This device can't store recordings (no IndexedDB) — the take was not kept.";
    case 'failed':
      return 'The recording failed. Try again.';
  }
}

// ---------------------------------------------------------------------------
// Playback — the bounded blob-URL cache and the one-at-a-time player
// ---------------------------------------------------------------------------

/** The loader seams (tests inject; production reads store then cloud). */
export interface VoicePlaybackDeps {
  loadLocal?: (id: string) => Promise<Blob | null>;
  loadRemote?: (id: string) => Promise<Blob | null>;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/**
 * How many recordings' bytes may sit in blob URLs at once. Recordings are
 * megabytes, the rich surface is one element that repaints freely, and
 * nothing here revokes per paint — an LRU keeps the worst case bounded.
 */
export const VOICE_URL_CACHE_LIMIT = 8;

/**
 * The bounded blob-URL store behind the player: get() refreshes recency,
 * put() revokes the evicted, drop() forgets one. Exported for the test
 * suite; the app reaches it only through the module's resolve path.
 */
export class VoiceUrlCache {
  private entries = new Map<string, string>();

  constructor(
    private readonly createUrl: (blob: Blob) => string,
    private readonly revokeUrl: (url: string) => void,
  ) {}

  get(id: string): string | undefined {
    const url = this.entries.get(id);
    if (url !== undefined) {
      // Refresh recency: re-inserting moves the key to the Map's tail.
      this.entries.delete(id);
      this.entries.set(id, url);
    }
    return url;
  }

  put(id: string, blob: Blob): string {
    this.drop(id);
    const url = this.createUrl(blob);
    this.entries.set(id, url);
    while (this.entries.size > VOICE_URL_CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === id) {
        break;
      }
      this.drop(oldest);
    }
    return url;
  }

  drop(id: string): void {
    const url = this.entries.get(id);
    if (url !== undefined) {
      this.entries.delete(id);
      this.revokeUrl(url);
    }
  }
}

interface ActiveVoicePlayer {
  /** The live wrapper (figure.padify-voice) — the chrome's parent. */
  wrapper: HTMLElement;
  audio: HTMLAudioElement;
  durationMs: number;
  wave: HTMLElement | null;
  time: HTMLElement | null;
}

/** The DI seams and the caches they feed — module state by design: the
 *  rich surface is a single element that outlives every note. */
let playbackDeps: VoicePlaybackDeps = {};
let urlCache: VoiceUrlCache | null = null;
let activeVoicePlayer: ActiveVoicePlayer | null = null;

function cache(): VoiceUrlCache {
  if (!urlCache) {
    urlCache = new VoiceUrlCache(
      (blob) => playbackDeps.createUrl?.(blob) ?? URL.createObjectURL(blob),
      (url) => playbackDeps.revokeUrl?.(url) ?? URL.revokeObjectURL(url),
    );
  }
  return urlCache;
}

/** The ms → m:ss clock the card and the recording bar share. */
export function formatVoiceClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The card's stored duration (the capture wrote it; 0 when absent). */
function readCardDurationMs(element: HTMLElement): number {
  const raw = Number(element.getAttribute('data-duration'));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Stops the playing recording, if any. The chrome's visual state resets
 *  only while it is still connected (a repaint may have replaced it). */
export function stopVoicePlayback(): void {
  if (!activeVoicePlayer) {
    return;
  }
  const { wrapper, audio, wave } = activeVoicePlayer;
  activeVoicePlayer = null;
  audio.pause();
  audio.src = '';
  if (wrapper.isConnected) {
    wrapper.classList.remove('voice-playing');
    wave?.style.setProperty('--p', '0');
  }
}

async function resolveVoiceUrl(id: string): Promise<string | null> {
  const cached = cache().get(id);
  if (cached !== undefined) {
    return cached;
  }
  const loadLocal = playbackDeps.loadLocal ?? getAttachmentBlob;
  const loadRemote = playbackDeps.loadRemote ?? fetchAttachment;
  const local = await loadLocal(id);
  const blob = local ?? (await loadRemote(id));
  if (!blob) {
    return null;
  }
  if (!local) {
    // Another device's bytes: cache them locally for offline, best-effort,
    // exactly like the image resolver's lazy pull.
    try {
      await putAttachment(
        {
          id,
          name: `${id}.audio`,
          mime: blob.type || 'application/octet-stream',
          size: blob.size,
        },
        blob,
      );
    } catch {
      // A degraded store still gets this session's playback.
    }
  }
  return cache().put(id, blob);
}

/**
 * Starts (or resumes) playback for one card. Only one recording plays at
 * a time — starting one stops the previous, like every music player.
 */
async function toggleVoiceCardPlayback(wrapper: HTMLElement): Promise<void> {
  const card = wrapper.querySelector('audio[src^="padify-att:"]');
  const ref = card?.getAttribute('src') ?? '';
  const id = ref.startsWith('padify-att:') ? ref.slice('padify-att:'.length) : '';
  if (!id) {
    return;
  }
  if (activeVoicePlayer?.wrapper === wrapper) {
    stopVoicePlayback();
    return;
  }
  stopVoicePlayback();

  let url: string | null;
  try {
    url = await resolveVoiceUrl(id);
  } catch {
    url = null;
  }
  // The surface may have repainted during the fetch — the card the user
  // clicked is gone; the next paint re-resolves from scratch.
  if (!wrapper.isConnected) {
    return;
  }
  if (!url) {
    wrapper.setAttribute('data-padify-missing', '');
    const time = wrapper.querySelector<HTMLElement>('.padify-voice-time');
    if (time) {
      time.textContent = 'unavailable';
    }
    return;
  }

  const playerAudio = new Audio(url);
  const wave = wrapper.querySelector<HTMLElement>('.padify-voice-wave');
  const time = wrapper.querySelector<HTMLElement>('.padify-voice-time');
  const player: ActiveVoicePlayer = {
    wrapper,
    audio: playerAudio,
    durationMs: readCardDurationMs(card as HTMLElement),
    wave,
    time,
  };
  activeVoicePlayer = player;

  const paint = (): void => {
    if (activeVoicePlayer !== player) {
      return;
    }
    const total = player.durationMs > 0 ? player.durationMs : (playerAudio.duration * 1000) | 0;
    const played = playerAudio.currentTime * 1000;
    const fraction = total > 0 ? Math.min(1, played / total) : 0;
    wave?.style.setProperty('--p', String(fraction));
    if (time) {
      time.textContent = `${formatVoiceClock(played)} / ${total > 0 ? formatVoiceClock(total) : '…'}`;
    }
    if (!wrapper.isConnected) {
      // The card was repainted away mid-play — silence beats a ghost.
      stopVoicePlayback();
    }
  };

  playerAudio.addEventListener('timeupdate', paint);
  playerAudio.addEventListener('ended', () => {
    if (activeVoicePlayer !== player) {
      return;
    }
    activeVoicePlayer = null;
    wrapper.classList.remove('voice-playing');
    wave?.style.setProperty('--p', '0');
    if (time) {
      const total = player.durationMs > 0 ? formatVoiceClock(player.durationMs) : '…';
      time.textContent = `0:00 / ${total}`;
    }
  });

  wrapper.classList.add('voice-playing');
  try {
    await playerAudio.play();
  } catch {
    if (activeVoicePlayer === player) {
      stopVoicePlayback();
    }
    showToast('The recording could not play. Try again.');
  }
}

// ---------------------------------------------------------------------------
// Decoration — the post-paint pass (math's renderMathIn pattern)
// ---------------------------------------------------------------------------

/**
 * The live card. Chromium's UA stylesheet answers `audio:not([controls])`
 * with `display: none !important` — and under CSS's cascade, UA-important
 * beats author-important, so the bare element can never be shown. The
 * math-shell pattern solves it the same way it solves KaTeX: the paint
 * pass WRAPS the stored element in live-only chrome, and the sanitizer
 * dissolves the wrapper on every absorb — the wrapper is a FIGURE, a tag
 * OUTSIDE the subset, so the walk unwraps it to its children and the bare
 * audio is what the model keeps. The wrapper carries the visuals:
 *
 *   <figure class="padify-voice" contenteditable="false">
 *     <audio src="padify-att:…" data-duration="…"></audio>   ← the hook
 *     <span class="padify-voice-btn"></span>                 ← play/pause
 *     <span class="padify-voice-wave"></span>                ← the bars
 *     <span class="padify-voice-time">0:00 / 0:42</span>
 *   </figure>
 *
 * Idempotent: a card whose parent is already the wrapper is skipped.
 */
export function decorateVoiceNotes(root: HTMLElement): void {
  const cards = root.querySelectorAll<HTMLElement>('audio[src^="padify-att:"]');
  cards.forEach((card) => {
    const parent = card.parentElement;
    if (parent?.classList.contains('padify-voice')) {
      return;
    }

    const durationMs = readCardDurationMs(card);
    const wrapper = document.createElement('figure');
    wrapper.className = 'padify-voice';
    wrapper.setAttribute('contenteditable', 'false');

    const button = document.createElement('span');
    button.className = 'padify-voice-btn';
    const wave = document.createElement('span');
    wave.className = 'padify-voice-wave';
    const time = document.createElement('span');
    time.className = 'padify-voice-time';
    // The stored duration paints before any bytes load — the card is
    // honest about its length even fully offline.
    time.textContent = durationMs > 0 ? `0:00 / ${formatVoiceClock(durationMs)}` : 'voice note';

    // The wrapper takes the card's place; the card rides inside as the
    // first child (the browser hides it — no controls attribute).
    parent?.insertBefore(wrapper, card);
    wrapper.append(card, button, wave, time);

    wrapper.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleVoiceCardPlayback(wrapper);
    });
  });
}

// ---------------------------------------------------------------------------
// The recording bar — the session UI (the voice-typing bar's sibling)
// ---------------------------------------------------------------------------

let activeSession: VoiceCaptureSession | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function recordBar(): Q {
  return $('#voiceRecordBar');
}

/** The bar's live wave bars, back to rest — every exit, success or not. */
function resetWaveBars(): void {
  recordBar()
    .get(0)
    ?.querySelectorAll<HTMLElement>('.voice-bar-wave i')
    .forEach((bar: HTMLElement) => {
      bar.style.removeProperty('height');
    });
}

function hideRecordBar(): void {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  resetWaveBars();
  activeSession = null;
  recordBar().attr('hidden', 'hidden');
}

/** The elapsed MM:SS on the bar, refreshed twice a second. */
function startClock(session: VoiceCaptureSession): void {
  const paint = (): void => {
    const elapsed = session.elapsedMs();
    $('#voiceRecordTime').text(formatVoiceClock(elapsed));
    // The seatbelt: past the guard the take is in discard territory —
    // stop through the normal path (it stores what arrived; the cap
    // check still rules).
    if (elapsed >= MAX_RECORDING_MS) {
      void finishVoiceRecording();
    }
  };
  paint();
  clockTimer = setInterval(paint, 500);
}

function startWave(session: VoiceCaptureSession): void {
  const bars = recordBar().get(0)?.querySelectorAll<HTMLElement>('.voice-bar-wave i') ?? [];
  if (bars.length === 0) {
    return;
  }
  session.onLevel((level) => {
    // Staggered peaks: the live bar breathes like the dictation wave,
    // driven by the actual mic level instead of a CSS loop.
    for (let i = 0; i < bars.length; i += 1) {
      const falloff = 1 - Math.abs(i - (bars.length - 1) / 2) / bars.length;
      const height = Math.max(12, Math.min(100, level * 100 * (0.6 + 0.8 * falloff)));
      bars[i]!.style.height = `${Math.round(height)}%`;
    }
  });
}

/**
 * Ends the session through the keep path: assemble → cap → store →
 * insert the card at the caret. The bar closes before the async tail so
 * the UI never waits on storage.
 */
async function finishVoiceRecording(): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  hideRecordBar();
  const result = await session.stop();
  if (!result.ok) {
    // An empty take is a user shrug (clicked stop twice, said nothing) —
    // the other reasons deserve their honest copy.
    if (result.reason !== 'empty') {
      showToast(voiceFailureMessage(result.reason));
    }
    return;
  }

  const port = getEditorPort();
  if (!port) {
    showToast(voiceFailureMessage('failed'));
    return;
  }
  // The caret may have drifted (the bar's buttons took focus) — dictation
  // parks it first; so does the recording insert.
  port.focus();
  if (!port.insertVoiceCard(padifyAttRef(result.id), result.durationMs)) {
    showToast('The recording could not be inserted into the note.');
    return;
  }
  // The typed op repaints the model — and paint runs the decoration pass,
  // so the card is wired the moment it lands.
}

/**
 * Starts a recording session for the ACTIVE rich note. Every guard says
 * no in a toast instead of failing silently — the same contract voice
 * typing keeps.
 */
async function startVoiceRecordingFromToolbar(): Promise<void> {
  if (activeSession) {
    return;
  }
  const active = getTabManager()?.getActive();
  if (active && !isRichNote(active)) {
    showToast('Voice recording works in rich text notes.');
    return;
  }
  if (!getEditorPort()) {
    showToast("The editor isn't ready yet — try again in a moment.");
    return;
  }

  const start = await startVoiceCapture();
  if (!start.started) {
    showToast(voiceFailureMessage(start.reason));
    return;
  }
  const session = start.session;

  activeSession = session;
  $('#voiceRecordTime').text('0:00');
  recordBar().removeAttr('hidden');
  startWave(session);
  startClock(session);
}

/**
 * Toggled by the rich toolbar's mic button; Escape cancels while a
 * session is open.
 */
export function toggleVoiceRecording(): void {
  if (activeSession) {
    void finishVoiceRecording();
  } else {
    void startVoiceRecordingFromToolbar();
  }
}

/** Abandons the open take — the Cancel button and the Escape key. */
export function cancelVoiceRecording(saySo = false): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  hideRecordBar();
  session.cancel();
  if (saySo) {
    showToast('Recording cancelled — nothing was kept.');
  }
}

/**
 * The tab-switch hook: an open session or a playing recording must never
 * spill across notes. Cancels quietly (the take was for the note the
 * user just left) and silences playback.
 */
export function handleTabSwitchedWhileVoiceActive(): void {
  stopVoicePlayback();
  if (activeSession) {
    cancelVoiceRecording();
    showToast('Voice recording stopped — you switched notes.');
  }
}

/**
 * Wires the bar's buttons and the Escape path (the session starts from
 * the rich toolbar's mic; the card lands through the engine's typed op).
 */
export function initVoiceRecording(): void {
  $('#voiceRecordStop').on('click', (event) => {
    event.preventDefault();
    void finishVoiceRecording();
  });
  $('#voiceRecordCancel').on('click', (event) => {
    event.preventDefault();
    cancelVoiceRecording(true);
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && activeSession) {
        event.preventDefault();
        event.stopPropagation();
        cancelVoiceRecording(true);
      }
    },
    true,
  );
}

/** The test seam — resets every module handle (sessions, caches, players). */
export function resetVoiceNotesForTests(deps: VoicePlaybackDeps = {}): void {
  stopVoicePlayback();
  cancelVoiceRecording();
  playbackDeps = deps;
  urlCache = null;
}
