/**
 * Ambience as tracks — the twelve bundled soundscape loops, expressed in
 * the same track shape the music catalog uses so they ride the regular
 * player: rows, queue, shuffle, mini player, media keys, the works.
 *
 * The old dedicated mixer tab (per-sound volume sliders, layered mixes,
 * presets) is gone by design: a sound is just a track you click. Each one
 * loops while it plays (a 15-second ceiling-fan clip should not "end" and
 * silence the room), and skipping works exactly like any other track.
 *
 * ids are "ambient:<key>" — never a YouTube video id (11 chars, no colon)
 * nor a Spotify id (22 chars) — and `local_url` points the engine at the
 * bundled file, so no stream resolution ever runs for these.
 */

import type { SpotifyTrack } from './types';

// ---------------------------------------------------------------------------
// Icon builder (same shape as markup.ts's, kept local so this module stays
// import-order independent)
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

// ---------------------------------------------------------------------------
// The sound definitions — keys/names/files must match public/sounds/
// ---------------------------------------------------------------------------

export interface AmbientSound {
  key: string;
  name: string;
  /** App-relative URL of the bundled loop (served with the app itself). */
  url: string;
  /** The loop's real length, for the row's duration column. */
  durationMs: number;
  icon: string;
}

export const AMBIENT_SOUNDS: AmbientSound[] = [
  {
    key: 'rain',
    name: 'Rain',
    url: 'sounds/rain.mp3',
    durationMs: 91_000,
    icon: icon(
      '<path d="M7 15a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 15H7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
    ),
  },
  {
    key: 'thunder',
    name: 'Thunder',
    url: 'sounds/thunder.mp3',
    durationMs: 68_000,
    icon: icon(
      '<path d="M7 13a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 13H7z"/><path d="m12.5 13-2 4h3l-2 4"/>',
    ),
  },
  {
    key: 'rain-on-leaves',
    name: 'Rain on Leaves',
    url: 'sounds/rain-on-leaves.mp3',
    durationMs: 42_000,
    icon: icon(
      '<path d="M4.5 19.5C4.5 10.5 11 5 20 4.5c0 9.5-6 15-15.5 15z"/><path d="M4.5 19.5C8 14.5 12 10.5 17 8"/><path d="M10.8 6.3 9.8 8.4M14.3 8.8l-1 2.1"/>',
    ),
  },
  {
    key: 'rain-on-umbrella',
    name: 'Rain on Umbrella',
    url: 'sounds/rain-on-umbrella.mp3',
    durationMs: 26_000,
    icon: icon(
      '<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9z"/><path d="M12 12v6a2 2 0 0 0 4 0"/>',
    ),
  },
  {
    key: 'fireside',
    name: 'Fireside',
    url: 'sounds/fireside.mp3',
    durationMs: 150_000,
    icon: icon(
      '<path d="M12 2.5c.8 3.8 4.8 4.8 4.8 9.3a4.8 4.8 0 0 1-9.6 0c0-1.8.7-3.2 1.9-4.3.3 1.3 1.1 1.9 1.9 1.9-1-2.8.3-5.4 1-6.9z"/><path d="M8 21.5h8"/>',
    ),
  },
  {
    key: 'winter-morning',
    name: 'Winter Morning',
    url: 'sounds/winter-morning.mp3',
    durationMs: 25_000,
    icon: icon(
      '<path d="M12 3v18M5.5 6.8l13 10.4M18.5 6.8l-13 10.4"/><path d="M12 6.5 10 4.7M12 6.5 14 4.7M12 17.5l-2 1.8M12 17.5l2 1.8"/>',
    ),
  },
  {
    key: 'suburban-street',
    name: 'Suburban Street',
    url: 'sounds/suburban-street.mp3',
    durationMs: 162_000,
    icon: icon('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>'),
  },
  {
    key: 'crickets',
    name: 'Crickets',
    url: 'sounds/crickets.mp3',
    durationMs: 172_000,
    icon: icon(
      '<path d="M20 14.5A8.3 8.3 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5z"/><path d="M15.5 4.5 17 3M18.2 7.8 20 6"/>',
    ),
  },
  {
    key: 'wind-chimes',
    name: 'Wind Chimes',
    url: 'sounds/wind-chimes.mp3',
    durationMs: 83_000,
    icon: icon(
      '<path d="M12 3.5v2.5"/><path d="M7 6h10"/><path d="M7.5 6v6.5M10.5 6v9.5M13.5 6v9.5M16.5 6v6.5"/><path d="M7.5 15.5h.01M10.5 18.5h.01M13.5 18.5h.01M16.5 15.5h.01"/>',
    ),
  },
  {
    key: 'clock',
    name: 'Clock',
    url: 'sounds/clock.mp3',
    durationMs: 15_000,
    icon: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2.1"/>'),
  },
  {
    key: 'ceiling-fan',
    name: 'Ceiling Fan',
    url: 'sounds/ceiling-fan.mp3',
    durationMs: 15_000,
    icon: icon(
      '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 3-6.2 6-5.2C17 7.8 14.8 10 12 10zM14 12c4 0 6.2 3 5.2 6-3-1-5-3.2-5.2-6zM12 14c0 4-3 6.2-6 5.2C7 16.2 9.2 14 12 14zM10 12c-4 0-6.2-3-5.2-6 3 1 5 3.2 5.2 6z"/>',
    ),
  },
  {
    key: 'underwater',
    name: 'Underwater',
    url: 'sounds/underwater.mp3',
    durationMs: 43_000,
    icon: icon(
      '<circle cx="9.5" cy="14.5" r="4.5"/><circle cx="17" cy="8" r="2.6"/><circle cx="17.5" cy="15.5" r="1.4"/><path d="M7.5 13h4"/>',
    ),
  },
];

/** The queue id the player registers the ambience list under. */
export const AMBIENCE_QUEUE_ID = 'ambience';

function soundToTrack(sound: AmbientSound): SpotifyTrack {
  return {
    id: `ambient:${sound.key}`,
    uri: `padify:ambient:${sound.key}`,
    name: sound.name,
    artists: [{ name: 'Ambience', uri: '' }],
    album: {
      id: 'ambience',
      uri: '',
      name: 'Ambience',
      images: [],
      artists: [],
    },
    duration_ms: sound.durationMs,
    preview_url: null,
    explicit: false,
    is_local: true,
    is_playable: true,
    local_url: sound.url,
  };
}

/** The ambience "playlist" — the same twelve tracks, in display order. */
export function ambientTracks(): SpotifyTrack[] {
  return AMBIENT_SOUNDS.map(soundToTrack);
}

/**
 * True for tracks the engine plays straight from a bundled file — no API
 * resolve, no preview fallback, and (ambience being a loop) no "ended".
 */
export function isAmbientTrack(track: SpotifyTrack): boolean {
  return typeof track.local_url === 'string' && track.local_url !== '';
}

/** The row icon for an ambience track (by key), or null for catalog tracks. */
export function ambientIconFor(track: SpotifyTrack): string | null {
  if (!track.id.startsWith('ambient:')) return null;
  const key = track.id.slice('ambient:'.length);
  return AMBIENT_SOUNDS.find((sound) => sound.key === key)?.icon ?? null;
}
