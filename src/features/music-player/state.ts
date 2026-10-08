/**
 * The music player's persisted state — what survives a reload.
 *
 * Everything here is pure (or injected-storage pure): the sanitizing loader,
 * the writer, and the shape itself. The controller owns an instance and
 * delegates; the tests pin the sanitization so a corrupted or hostile
 * storage payload can never brick the player.
 */

import { stateGet, stateSet } from '../../storage';
import type { SpotifyTrack } from './types';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type RepeatMode = 'off' | 'all' | 'one';
/** The sidebar destinations. Legacy 'music' (the old tab layout) → 'search'. */
export type ViewId = 'search' | 'favorites' | 'playlist' | 'ambience' | 'queue';

export interface MusicPlayerState {
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  view: ViewId;
  /** The anonymous/free queue (track snapshots), restored across reloads. */
  freeQueue: SpotifyTrack[];
  freeIndex: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'padify-music-state';
export const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];
const VIEW_IDS: ViewId[] = ['search', 'favorites', 'playlist', 'ambience', 'queue'];
/** The pre-revamp tab ids, mapped forward so a reload lands somewhere sane. */
const LEGACY_VIEWS: Record<string, ViewId> = {
  music: 'search',
  queue: 'queue',
  ambience: 'ambience',
};

export const DEFAULT_STATE: Omit<MusicPlayerState, 'freeQueue'> & { freeQueue: never[] } = {
  volume: 0.7,
  shuffle: false,
  repeat: 'off',
  view: 'search',
  freeQueue: [],
  freeIndex: -1,
};

/**
 * Fresh defaults, deep enough that the caller can never mutate
 * DEFAULT_STATE through them. (The old controller returned a shallow
 * spread, so a cold-started queue pushed its rows straight into the
 * shared default array — harmless until storage was cleared mid-session,
 * then the discarded queue resurrected. Fixed in the extraction.)
 */
function freshDefaults(): MusicPlayerState {
  return { ...DEFAULT_STATE, freeQueue: [] };
}

/** Free-queue rows kept across reloads — large queues bloat localStorage. */
export const FREE_QUEUE_CAP = 200;

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/** Reads a persisted view id, mapping legacy tab ids forward. */
function sanitizeView(value: unknown): ViewId {
  if (typeof value !== 'string') return DEFAULT_STATE.view;
  const legacy = LEGACY_VIEWS[value];
  const candidate = (legacy ?? value) as ViewId;
  return VIEW_IDS.includes(candidate) ? candidate : DEFAULT_STATE.view;
}

/**
 * Reads and sanitizes the persisted state. Every field falls back to its
 * default when missing, wrong-typed, or out of range; the queue keeps only
 * entries that still look like tracks. Storage access is injectable so the
 * tests can drive corrupted payloads without touching the real backend.
 */
export function loadPlayerState(get: (key: string) => string | null = stateGet): MusicPlayerState {
  try {
    const raw = get(STORAGE_KEY);
    if (!raw) return freshDefaults();
    const parsed = JSON.parse(raw) as Partial<MusicPlayerState>;
    const freeQueue = Array.isArray(parsed.freeQueue)
      ? parsed.freeQueue
          .filter(
            (track): track is SpotifyTrack =>
              Boolean(track) && typeof track.id === 'string' && typeof track.name === 'string',
          )
          .slice(0, FREE_QUEUE_CAP)
      : [];
    return {
      volume:
        typeof parsed.volume === 'number' && !Number.isNaN(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_STATE.volume,
      shuffle: Boolean(parsed.shuffle),
      repeat: REPEAT_MODES.includes(parsed.repeat as RepeatMode)
        ? (parsed.repeat as RepeatMode)
        : DEFAULT_STATE.repeat,
      view: sanitizeView(parsed.view),
      freeQueue,
      freeIndex:
        typeof parsed.freeIndex === 'number'
          ? Math.min(Math.max(-1, Math.round(parsed.freeIndex)), freeQueue.length - 1)
          : -1,
    };
  } catch {
    return freshDefaults();
  }
}

/**
 * Persists the state. Storage failures are swallowed on purpose: playback
 * must keep working even when the disk quota is gone — the cost is only that
 * the session does not survive a reload.
 */
export function savePlayerState(
  state: MusicPlayerState,
  set: (key: string, value: string) => void = stateSet,
): void {
  try {
    set(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — playback still works, just not restored */
  }
}
