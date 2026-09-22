/**
 * Padify music player — v2.
 *
 * A full player with three sources behind one transport bar:
 *
 *   • Radio    — the offline generative engine (src/music/*)
 *   • Ambience — the soundscape mixer (src/white-noise-player.ts)
 *   • Spotify  — OAuth 2.0 login → Web API library + search → Web Playback
 *               SDK streaming (Premium) with 30-second previews for free
 *               accounts.
 *
 * The modal is appended at module evaluation (same pattern as timer.ts).
 * The Ambience tab keeps the exact ids/classes/data attributes that
 * WhiteNoisePlayer binds to. A mini-player bar lives on the page and mirrors
 * whatever is playing when the modal is closed.
 *
 * Persistence: `padify-music-state` (volume/shuffle/repeat/favorites/…) and
 * `padify-spotify-*` keys (see src/spotify/auth.ts).
 */

import $ from 'jquery';
import { showToast } from './utils';
import { MusicEngine } from './music/engine';
import { drawTrackArt } from './music/art';
import { TRACKS, getTrackById, PLAYLIST_LABELS, formatTime, type Track } from './music/tracks';
import {
  beginLogin,
  completeLogin,
  consumedReturnFlag,
  disconnect as spotifyDisconnect,
  getClientId,
  getRedirectUri,
  isAuthenticated,
  saveClientId,
  SpotifyAuthError,
} from './spotify/auth';
import * as spotify from './spotify/api';
import type {
  SpotifyAlbum,
  SpotifyPlaylist,
  SpotifyProfile,
  SpotifySimpleArtist,
  SpotifyTrack,
} from './spotify/api';
import { SpotifySdkController } from './spotify/sdk';
import type { WebPlaybackPlayerState } from './spotify/sdk';

declare global {
  interface JQuery {
    modal(action: string | { [key: string]: unknown }): JQuery;
  }
}

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type RepeatMode = 'off' | 'all' | 'one';
type TrackFilter = 'all' | 'focus' | 'calm' | 'sleep' | 'uplift' | 'favorites';
type PlayerSource = 'none' | 'radio' | 'spotify';
type SpotifyMode = 'sdk' | 'preview';
type ViewId = 'radio' | 'ambience' | 'spotify';

interface MusicPlayerState {
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  lastTrackId: string | null;
  favorites: string[];
  view: ViewId;
}

const STORAGE_KEY = 'padify-music-state';
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];
const PROGRESS_INTERVAL_MS = 250;
const SDK_POLL_INTERVAL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 350;
const PREVIEW_LABEL = '30s preview';

const DEFAULT_STATE: MusicPlayerState = {
  volume: 0.7,
  shuffle: false,
  repeat: 'off',
  lastTrackId: null,
  favorites: [],
  view: 'radio',
};

const FILTERS: { id: TrackFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'focus', label: 'Focus' },
  { id: 'calm', label: 'Calm' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'uplift', label: 'Uplift' },
  { id: 'favorites', label: 'Favorites' },
];

// ---------------------------------------------------------------------------
// Icons (inline, currentColor)
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  note: icon(
    '<path d="M9 18V5l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/>',
    18,
  ),
  musicTab: icon(
    '<path d="M9 18V5l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/>',
    16,
  ),
  ambienceTab: icon('<path d="M4 9.5v5M8 6.5v11M12 3.5v17M16 6.5v11M20 9.5v5"/>', 16),
  spotifyTab:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.28c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.24-1.98-8.16-2.58-11.94-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.8 15 10.44 18.72 12.72c.361.181.54.78.24 1.26zm.12-3.36C15.24 8.4 8.82 8.16 5.1 9.34c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381C8.76 5.86 15.9 6.14 20.64 8.82c.54.3.72 1.021.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
  shuffle: icon(
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  ),
  prev: icon('<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>'),
  next: icon('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
  repeat: icon(
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  ),
  star: icon(
    '<path d="M12 3.3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.7l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"/>',
    17,
  ),
  volHigh: icon(
    '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    19,
  ),
  volLow: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>', 19),
  volMute: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/>', 19),
  speaker:
    '<path d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/>',
  speakerMuted:
    '<path d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/>',
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 16),
  back: icon('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>', 16),
  refresh: icon('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 16),
  power: icon('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>', 16),
  device: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 15),
  chevron:
    '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5.25 7 9l4-3.75" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 14),
  copy: icon(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    13,
  ),
  play: icon('<polygon points="6 3 20 12 6 21 6 3"/>', 14),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>', 16),
  playlist: icon(
    '<path d="M21 15V6"/><path d="M21 15a3 3 0 1 1-3-3h3z" fill="currentColor" stroke="none"/><path d="M3 12V5"/><path d="M3 12a2.5 2.5 0 0 1 2.5-2.5L9 9.5"/><path d="M3 12a2.5 2.5 0 0 0 2.5 2.5L9 14.5"/><path d="M9 9.5v5"/><path d="M9 12h12"/>',
    18,
  ),
  heart: icon(
    '<path d="M12 20.5c-5.2-3.4-8.5-6.3-8.5-10A4.6 4.6 0 0 1 8 6c1.6 0 3.1.8 4 2.1A4.9 4.9 0 0 1 16 6a4.6 4.6 0 0 1 4.5 4.5c0 3.7-3.3 6.6-8.5 10z"/>',
    18,
  ),
  spark: icon(
    '<path d="M12 3v3M12 18v3M4.2 7.2l2.1 2.1M17.7 14.7l2.1 2.1M3 12h3M18 12h3M4.2 16.8l2.1-2.1M17.7 9.3l2.1-2.1"/>',
    16,
  ),
};

const playIconSvg = (size: number): string =>
  `<svg id="mpPlayIcon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11-6.86a1.05 1.05 0 0 0 0-1.8l-11-6.86A1.05 1.05 0 0 0 8 5.14z"/></svg>`;

const pauseIconSvg = (size: number): string =>
  `<svg id="mpPauseIcon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style="display:none;"><rect x="6" y="4" width="4.4" height="16" rx="1.4"/><rect x="13.6" y="4" width="4.4" height="16" rx="1.4"/></svg>`;

const eqMarkup = (cls: string): string =>
  `<span class="mp-eq ${cls}" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;

const spotifyLogo = (size: number): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.28c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.24-1.98-8.16-2.58-11.94-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.8 15 10.44 18.72 12.72c.361.181.54.78.24 1.26zm.12-3.36C15.24 8.4 8.82 8.16 5.1 9.34c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381C8.76 5.86 15.9 6.14 20.64 8.82c.54.3.72 1.021.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>`;

// ---------------------------------------------------------------------------
// Ambient sound definitions (12 sounds — keys/names/defaults must match
// src/white-noise-player.ts exactly).
// ---------------------------------------------------------------------------

interface AmbientSoundDef {
  key: string;
  name: string;
  volume: number;
  icon: string;
}

const AMBIENT_SOUNDS: AmbientSoundDef[] = [
  {
    key: 'winter-morning',
    name: 'Winter Morning',
    volume: 60,
    icon: icon(
      '<path d="M12 3v18M5.5 6.8l13 10.4M18.5 6.8l-13 10.4"/><path d="M12 6.5 10 4.7M12 6.5 14 4.7M12 17.5l-2 1.8M12 17.5l2 1.8"/>',
    ),
  },
  {
    key: 'suburban-street',
    name: 'Suburban Street',
    volume: 70,
    icon: icon('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>'),
  },
  {
    key: 'rain',
    name: 'Rain',
    volume: 15,
    icon: icon(
      '<path d="M7 15a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 15H7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
    ),
  },
  {
    key: 'rain-on-leaves',
    name: 'Rain on Leaves',
    volume: 70,
    icon: icon(
      '<path d="M4.5 19.5C4.5 10.5 11 5 20 4.5c0 9.5-6 15-15.5 15z"/><path d="M4.5 19.5C8 14.5 12 10.5 17 8"/><path d="M10.8 6.3 9.8 8.4M14.3 8.8l-1 2.1"/>',
    ),
  },
  {
    key: 'rain-on-umbrella',
    name: 'Rain on Umbrella',
    volume: 70,
    icon: icon(
      '<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9z"/><path d="M12 12v6a2 2 0 0 0 4 0"/>',
    ),
  },
  {
    key: 'thunder',
    name: 'Thunder',
    volume: 70,
    icon: icon(
      '<path d="M7 13a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 13H7z"/><path d="m12.5 13-2 4h3l-2 4"/>',
    ),
  },
  {
    key: 'fireside',
    name: 'Fireside',
    volume: 60,
    icon: icon(
      '<path d="M12 2.5c.8 3.8 4.8 4.8 4.8 9.3a4.8 4.8 0 0 1-9.6 0c0-1.8.7-3.2 1.9-4.3.3 1.3 1.1 1.9 1.9 1.9-1-2.8.3-5.4 1-6.9z"/><path d="M8 21.5h8"/>',
    ),
  },
  {
    key: 'crickets',
    name: 'Crickets',
    volume: 70,
    icon: icon(
      '<path d="M20 14.5A8.3 8.3 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5z"/><path d="M15.5 4.5 17 3M18.2 7.8 20 6"/>',
    ),
  },
  {
    key: 'wind-chimes',
    name: 'Wind Chimes',
    volume: 20,
    icon: icon(
      '<path d="M12 3.5v2.5"/><path d="M7 6h10"/><path d="M7.5 6v6.5M10.5 6v9.5M13.5 6v9.5M16.5 6v6.5"/><path d="M7.5 15.5h.01M10.5 18.5h.01M13.5 18.5h.01M16.5 15.5h.01"/>',
    ),
  },
  {
    key: 'clock',
    name: 'Clock',
    volume: 30,
    icon: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2.1"/>'),
  },
  {
    key: 'ceiling-fan',
    name: 'Ceiling Fan',
    volume: 80,
    icon: icon(
      '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 3-6.2 6-5.2C17 7.8 14.8 10 12 10zM14 12c4 0 6.2 3 5.2 6-3-1-5-3.2-5.2-6zM12 14c0 4-3 6.2-6 5.2C7 16.2 9.2 14 12 14zM10 12c-4 0-6.2-3-5.2-6 3 1 5 3.2 5.2 6z"/>',
    ),
  },
  {
    key: 'underwater',
    name: 'Underwater',
    volume: 60,
    icon: icon(
      '<circle cx="9.5" cy="14.5" r="4.5"/><circle cx="17" cy="8" r="2.6"/><circle cx="17.5" cy="15.5" r="1.4"/><path d="M7.5 13h4"/>',
    ),
  },
];

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

const buildChips = (): string =>
  FILTERS.map(
    (filter) =>
      `<button type="button" class="mp-chip${filter.id === 'all' ? ' is-active' : ''}" data-filter="${filter.id}" aria-pressed="${filter.id === 'all'}">${filter.label}<span class="mp-chip-count" data-count-for="${filter.id}"></span></button>`,
  ).join('');

const buildSoundButtons = (): string =>
  AMBIENT_SOUNDS.map(
    (sound) => `
        <div class="sound-button" data-sound="${sound.key}">
            <div class="sound-button-main">
                ${sound.icon}
                <span>${sound.name}</span>
            </div>
            <div class="volume-control">
                <input type="range" min="0" max="100" value="${sound.volume}" class="volume-slider" id="${sound.key}-volume" aria-label="${sound.name} volume">
            </div>
            ${eqMarkup('mp-card-eq')}
        </div>`,
  ).join('\n');

const buildRadioRows = (): string =>
  TRACKS.map((track) => {
    const label = PLAYLIST_LABELS[track.playlist];
    const isFav = ''; // favorites state applied after state loads
    return `
        <div class="mp-row" data-track-id="${track.id}" data-playlist="${track.playlist}" role="listitem">
            <button type="button" class="mp-row-main" aria-label="Play ${track.title} (${label})">
                <canvas class="mp-row-art" width="512" height="512" aria-hidden="true"></canvas>
                <span class="mp-row-title">${track.title}</span>
                <span class="mp-row-tag">${label}</span>
                ${eqMarkup('mp-row-eq')}
                <span class="mp-row-dur">${formatTime(track.durationSec)}</span>
            </button>
            <button type="button" class="mp-row-star${isFav}" aria-pressed="false" title="Favorite" aria-label="Add ${track.title} to favorites">${ICONS.star}</button>
        </div>`;
  }).join('\n');

const musicPlayerModalHtml = `
<div class="modal fade mp-modal" id="musicPlayerModal" tabindex="-1" role="dialog" aria-labelledby="musicPlayerTitle">
    <div class="modal-dialog modal-lg" role="document">
        <div class="modal-content">
            <div class="modal-header mp-header">
                <h4 class="modal-title mp-title" id="musicPlayerTitle">
                    ${ICONS.note}
                    <span>Music</span>
                </h4>
                <button type="button" class="mp-status-chip" id="mpSpotifyChip" title="Spotify" aria-label="Spotify connection status">
                    ${spotifyLogo(14)}
                    <span id="mpSpotifyChipText">Connect Spotify</span>
                </button>
                <button type="button" class="close" data-dismiss="modal" aria-label="Close">&times;</button>
            </div>

            <div class="modal-body mp-body">
                <div class="mp-playerbar" id="mpPlayerBar">
                    <div class="mp-pb-main">
                        <div class="mp-pb-art-wrap">
                            <span class="mp-pb-placeholder">${ICONS.note}</span>
                            <canvas class="mp-pb-art" id="mpPbArt" width="512" height="512" aria-hidden="true" hidden></canvas>
                            <img class="mp-pb-img" id="mpPbImg" alt="" hidden />
                            ${eqMarkup('mp-pb-eq')}
                        </div>
                        <div class="mp-pb-meta">
                            <div class="mp-pb-title" id="mpPbTitle">Nothing playing</div>
                            <div class="mp-pb-sub" id="mpPbSub">Pick a radio track or connect Spotify</div>
                        </div>
                        <span class="mp-pb-source" id="mpPbSource" hidden></span>
                    </div>
                    <div class="mp-pb-center">
                        <div class="mp-pb-controls">
                            <button type="button" class="mp-ctl" id="mpShuffle" aria-pressed="false" title="Shuffle" aria-label="Shuffle off">${ICONS.shuffle}</button>
                            <button type="button" class="mp-ctl" id="mpPrev" title="Previous track" aria-label="Previous track">${ICONS.prev}</button>
                            <button type="button" class="mp-play" id="mpPlay" title="Play" aria-label="Play">${playIconSvg(20)}${pauseIconSvg(20)}</button>
                            <button type="button" class="mp-ctl" id="mpNext" title="Next track" aria-label="Next track">${ICONS.next}</button>
                            <button type="button" class="mp-ctl mp-repeat" id="mpRepeat" title="Repeat" aria-label="Repeat off" aria-pressed="false">${ICONS.repeat}<span class="mp-repeat-one" aria-hidden="true">1</span></button>
                        </div>
                        <div class="mp-pb-seek-row">
                            <span class="mp-time" id="mpTimeCurrent">0:00</span>
                            <input type="range" class="mp-range mp-seek" id="mpSeek" min="0" max="1000" step="1" value="0" aria-label="Seek position" aria-valuetext="0:00">
                            <span class="mp-time" id="mpTimeTotal">0:00</span>
                        </div>
                    </div>
                    <div class="mp-pb-side">
                        <div class="mp-volume">
                            <button type="button" class="mp-ctl mp-vol-btn" id="mpVolumeIcon" title="Mute" aria-label="Mute">
                                <span id="mpVolIconHigh">${ICONS.volHigh}</span>
                                <span id="mpVolIconLow" style="display:none;">${ICONS.volLow}</span>
                                <span id="mpVolIconMute" style="display:none;">${ICONS.volMute}</span>
                            </button>
                            <input type="range" class="mp-range mp-volume-slider" id="mpVolume" min="0" max="100" step="1" value="70" aria-label="Volume">
                        </div>
                        <div class="mp-device" id="mpDeviceWrap" hidden>
                            <button type="button" class="mp-device-pill" id="mpDevicePill" aria-haspopup="true" aria-expanded="false">
                                ${ICONS.device}
                                <span class="mp-device-name" id="mpDeviceName">This browser</span>
                                ${ICONS.chevron}
                            </button>
                            <div class="mp-device-menu" id="mpDeviceMenu" hidden></div>
                        </div>
                    </div>
                </div>

                <div class="mp-tabs" role="tablist" aria-label="Music player sources">
                    <button type="button" class="mp-tab is-active" id="mpTabRadio" role="tab" aria-selected="true" aria-controls="mpRadioView">
                        ${ICONS.musicTab}<span>Radio</span>
                    </button>
                    <button type="button" class="mp-tab" id="mpTabAmbience" role="tab" aria-selected="false" aria-controls="mpAmbienceView" tabindex="-1">
                        ${ICONS.ambienceTab}<span>Ambience</span>
                    </button>
                    <button type="button" class="mp-tab" id="mpTabSpotify" role="tab" aria-selected="false" aria-controls="mpSpotifyView" tabindex="-1">
                        ${ICONS.spotifyTab}<span>Spotify</span>
                    </button>
                </div>

                <div class="mp-view" id="mpRadioView" role="tabpanel" aria-labelledby="mpTabRadio">
                    <div class="mp-lib-toolbar">
                        <div class="mp-search">
                            ${ICONS.search}
                            <input type="search" id="mpRadioSearchInput" class="mp-search-input" placeholder="Search radio tracks…" autocomplete="off" spellcheck="false" aria-label="Search radio tracks">
                            <button type="button" class="mp-search-clear" id="mpRadioSearchClear" aria-label="Clear search" hidden>&times;</button>
                        </div>
                        <div class="mp-chips" role="group" aria-label="Filter tracks">
                            ${buildChips()}
                        </div>
                    </div>
                    <div class="mp-tracklist" id="mpTrackList" role="list" aria-label="Tracks">
                        ${buildRadioRows()}
                    </div>
                    <div class="mp-empty" id="mpFavoritesEmpty" hidden>
                        ${ICONS.star}
                        <p>No favorites yet. Tap the star on any track to keep it close.</p>
                    </div>
                </div>

                <div class="mp-view" id="mpAmbienceView" role="tabpanel" aria-labelledby="mpTabAmbience" hidden>
                    <div class="mp-ambience-toolbar">
                        <p class="mp-ambience-hint">Mix ambient sounds to build your own soundscape</p>
                        <div class="mp-ambience-actions">
                            <div class="sound-controls">
                                <button type="button" class="global-mute-button" id="globalMuteButton" title="Mute all sounds">
                                    <svg id="globalPlayingIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS.speaker}"/></svg>
                                    <svg id="globalMuteIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display: none;"><path d="${ICONS.speakerMuted}"/></svg>
                                </button>
                                <button type="button" class="global-stop-button" id="globalStopButton" title="Stop all sounds" aria-label="Stop all sounds">
                                    <svg id="globalStopIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1.2"/></svg>
                                </button>
                            </div>
                            <span class="ambient-noise-header-actions">
                                <span class="ambient-noise-presets-dropdown">
                                    <button type="button" class="ambient-noise-preset-trigger" id="ambientNoisePresetToggle" title="Ambient noise presets" aria-expanded="false" aria-haspopup="true">
                                        <span id="ambientNoisePresetLabel">Custom</span>
                                        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5.25 7 9l4-3.75" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                    </button>
                                    <div class="ambient-noise-preset-menu" id="ambientNoisePresetMenu" hidden>
                                        <div class="ambient-noise-preset-list" id="ambientNoisePresetList"></div>
                                        <div class="ambient-noise-preset-empty" id="ambientNoisePresetEmpty">No presets yet</div>
                                        <button type="button" class="ambient-noise-preset-create" id="createAmbientNoisePreset">
                                            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3v12M3 9h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                                            <span>New Preset</span>
                                        </button>
                                    </div>
                                </span>
                            </span>
                        </div>
                    </div>
                    <div class="sound-buttons">
                        ${buildSoundButtons()}
                    </div>
                </div>

                <div class="mp-view" id="mpSpotifyView" role="tabpanel" aria-labelledby="mpTabSpotify" hidden>
                    <div class="sp-connect" id="spConnect">
                        <div class="sp-connect-card">
                            <div class="sp-connect-logo">${spotifyLogo(44)}</div>
                            <h3 class="sp-connect-title">Connect Spotify</h3>
                            <p class="sp-connect-copy">Your Liked Songs, playlists and search across 100M+ tracks — playable right here while you write.</p>
                            <button type="button" class="mp-btn mp-btn-primary sp-connect-btn" id="spConnectBtn">
                                ${spotifyLogo(18)}
                                <span>Connect Spotify</span>
                            </button>
                            <div class="sp-setup">
                                <p class="sp-setup-title">${ICONS.spark} One-time setup — your own Spotify app</p>
                                <ol class="sp-setup-steps">
                                    <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">developer.spotify.com/dashboard</a> and choose <strong>Create app</strong>.</li>
                                    <li>Add <code class="sp-redirect-uri" id="spRedirectUri">https://padify.netlify.app/</code><button type="button" class="sp-copy-btn" id="spCopyRedirect" title="Copy redirect URI">${ICONS.copy}</button> as the app's <strong>Redirect URI</strong>.</li>
                                    <li>Copy the app's <strong>Client ID</strong> and save it below.</li>
                                </ol>
                                <div class="sp-setup-input-row">
                                    <input type="text" id="spClientIdInput" placeholder="Paste your Spotify Client ID" autocomplete="off" spellcheck="false" aria-label="Spotify Client ID">
                                    <button type="button" class="mp-btn" id="spClientIdSave">Save</button>
                                </div>
                            </div>
                            <p class="sp-premium-note">${ICONS.info}<span>Spotify <strong>Premium is required for full playback</strong> — free accounts play 30-second previews.</span></p>
                            <p class="sp-error" id="spConnectError" hidden></p>
                        </div>
                    </div>

                    <div class="sp-app" id="spApp" hidden>
                        <div class="sp-profile">
                            <img class="sp-avatar" id="spAvatar" alt="" />
                            <div class="sp-profile-meta">
                                <span class="sp-name" id="spName"></span>
                                <span class="sp-product" id="spProduct"></span>
                            </div>
                            <div class="sp-profile-actions">
                                <button type="button" class="sp-icon-btn" id="spRefresh" title="Refresh library" aria-label="Refresh library">${ICONS.refresh}</button>
                                <button type="button" class="sp-icon-btn" id="spDisconnect" title="Disconnect Spotify" aria-label="Disconnect Spotify">${ICONS.power}</button>
                            </div>
                        </div>
                        <div class="mp-search sp-search">
                            ${ICONS.search}
                            <input type="search" id="spSearchInput" class="mp-search-input" placeholder="Search Spotify — songs, albums, artists, playlists…" autocomplete="off" spellcheck="false" aria-label="Search Spotify">
                            <button type="button" class="mp-search-clear" id="spSearchClear" aria-label="Clear search" hidden>&times;</button>
                        </div>
                        <div class="sp-skeleton" id="spSkeleton" hidden>
                            <div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div>
                        </div>
                        <div class="sp-library" id="spLibrary" hidden>
                            <section class="sp-section" id="spLikedSection">
                                <header class="sp-section-head">
                                    <h4>${ICONS.heart} Liked Songs</h4>
                                    <button type="button" class="sp-more-btn" id="spLikedMore" hidden>Load more</button>
                                </header>
                                <div class="sp-tracks" id="spLikedList" role="list" aria-label="Liked songs"></div>
                                <div class="sp-empty" id="spLikedEmpty" hidden><p>No liked songs yet — heart a track in Spotify and it shows up here.</p></div>
                            </section>
                            <section class="sp-section" id="spTopSection">
                                <header class="sp-section-head"><h4>${ICONS.spark} Top Tracks</h4></header>
                                <div class="sp-tracks" id="spTopList" role="list" aria-label="Top tracks"></div>
                            </section>
                            <section class="sp-section" id="spPlaylistsSection">
                                <header class="sp-section-head"><h4>${ICONS.playlist} Your Playlists</h4></header>
                                <div class="sp-card-row" id="spPlaylistsRow"></div>
                                <div class="sp-empty" id="spPlaylistsEmpty" hidden><p>No playlists yet.</p></div>
                            </section>
                            <p class="sp-premium-note sp-free-note" id="spFreeNote" hidden>${ICONS.info}<span>You're on a free account — tracks play as 30-second previews. <strong>Spotify Premium is required for full playback.</strong></span></p>
                        </div>
                        <div class="sp-results" id="spResults" hidden>
                            <button type="button" class="sp-back" id="spResultsBack">${ICONS.back}<span>Back to library</span></button>
                            <section class="sp-section" id="spSearchTracksSection" hidden>
                                <header class="sp-section-head"><h4>Tracks</h4></header>
                                <div class="sp-tracks" id="spSearchTracks" role="list" aria-label="Track results"></div>
                            </section>
                            <section class="sp-section" id="spSearchPlaylistsSection" hidden>
                                <header class="sp-section-head"><h4>Playlists</h4></header>
                                <div class="sp-card-row" id="spSearchPlaylists"></div>
                            </section>
                            <section class="sp-section" id="spSearchAlbumsSection" hidden>
                                <header class="sp-section-head"><h4>Albums</h4></header>
                                <div class="sp-card-row" id="spSearchAlbums"></div>
                            </section>
                            <section class="sp-section" id="spSearchArtistsSection" hidden>
                                <header class="sp-section-head"><h4>Artists</h4></header>
                                <div class="sp-card-row sp-card-row-artists" id="spSearchArtists"></div>
                            </section>
                            <div class="sp-empty" id="spSearchEmpty" hidden><p>Nothing found — try a different search.</p></div>
                        </div>
                        <div class="sp-detail" id="spDetail" hidden>
                            <button type="button" class="sp-back" id="spDetailBack">${ICONS.back}<span id="spDetailBackLabel">Back</span></button>
                            <div class="sp-detail-header">
                                <img class="sp-detail-art" id="spDetailArt" alt="" />
                                <div class="sp-detail-copy">
                                    <span class="sp-detail-type" id="spDetailType"></span>
                                    <h3 class="sp-detail-name" id="spDetailName"></h3>
                                    <p class="sp-detail-meta" id="spDetailMeta"></p>
                                    <button type="button" class="mp-btn mp-btn-primary sp-detail-play" id="spDetailPlay">${ICONS.play}<span>Play</span></button>
                                </div>
                            </div>
                            <div class="sp-tracks" id="spDetailTracks" role="list" aria-label="Tracks"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer mp-footer">
                <span class="mp-footer-hint">Playback continues after closing</span>
                <button type="button" class="mp-btn mp-btn-primary" data-dismiss="modal">Close</button>
            </div>
        </div>
    </div>
</div>`;

const miniPlayerHtml = `
<div class="mp-mini" id="mpMiniPlayer" hidden>
    <button type="button" class="mp-mini-open" id="mpMiniOpen" title="Open music player" aria-label="Open music player">
        <span class="mp-mini-art-wrap">
            <span class="mp-mini-placeholder">${ICONS.note}</span>
            <canvas class="mp-mini-canvas" id="mpMiniCanvas" width="512" height="512" aria-hidden="true" hidden></canvas>
            <img class="mp-mini-img" id="mpMiniImg" alt="" hidden />
        </span>
        <span class="mp-mini-meta">
            <span class="mp-mini-title" id="mpMiniTitle"></span>
            <span class="mp-mini-sub" id="mpMiniSub"></span>
        </span>
        ${eqMarkup('mp-mini-eq')}
    </button>
    <button type="button" class="mp-mini-btn" id="mpMiniPlay" title="Play" aria-label="Play">${playIconSvg(16)}${pauseIconSvg(16)}</button>
    <button type="button" class="mp-mini-btn" id="mpMiniNext" title="Next track" aria-label="Next track">${ICONS.next}</button>
    <button type="button" class="mp-mini-close" id="mpMiniClose" title="Stop and hide player" aria-label="Stop and hide player">${ICONS.close}</button>
</div>`;

$(document.body).append(musicPlayerModalHtml + miniPlayerHtml);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Music player markup missing #${id}`);
  return el as T;
}

function formatMs(ms: number): string {
  return formatTime(Math.floor(ms / 1000));
}

function trackArtistNames(track: SpotifyTrack): string {
  return track.artists.map((artist) => artist.name).join(', ');
}

function pickImage(images: { url: string }[] | undefined, preferred = 2): string | null {
  if (!images || images.length === 0) return null;
  return (images[Math.min(preferred, images.length - 1)] ?? images[0]).url;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// The application controller
// ---------------------------------------------------------------------------

class MusicPlayerApp {
  // ---- shared player state ----
  private state: MusicPlayerState;
  private source: PlayerSource = 'none';
  private seekDragging = false;
  private seekDebounce: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private sdkPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastVolumeBeforeMute: number | null = null;
  private navbarIconObserver: MutationObserver | null = null;
  private navbarIconWatchedEl: Element | null = null;

  // ---- radio ----
  private engine = new MusicEngine();
  private currentRadioId: string;
  private filter: TrackFilter = 'all';
  private radioSearch = '';
  private radioRows = new Map<string, HTMLDivElement>();

  // ---- spotify ----
  private sdk = new SpotifySdkController();
  private profile: SpotifyProfile | null = null;
  private previewAudio: HTMLAudioElement | null = null;
  private spotifyMode: SpotifyMode = 'preview';
  private spQueue: SpotifyTrack[] = [];
  private spIndex = -1;
  private sdkState: WebPlaybackPlayerState | null = null;
  private sdkStateAt = 0;
  private likedOffset = 0;
  private likedTotal = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDeviceId: string | null = null; // non-null = other device
  private detailContextUri: string | null = null;
  private detailQueue: SpotifyTrack[] = [];
  private spotifyBusy = false;

  // ---- DOM refs ----
  private readonly root: HTMLElement;
  private readonly playerBar: HTMLElement;
  private readonly pbArt: HTMLCanvasElement;
  private readonly pbImg: HTMLImageElement;
  private readonly pbPlaceholder: HTMLElement;
  private readonly pbTitle: HTMLElement;
  private readonly pbSub: HTMLElement;
  private readonly pbSource: HTMLElement;
  private readonly pbEq: HTMLElement;
  private readonly seek: HTMLInputElement;
  private readonly timeCurrent: HTMLElement;
  private readonly timeTotal: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly shuffleBtn: HTMLButtonElement;
  private readonly repeatBtn: HTMLButtonElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly volIconHigh: HTMLElement;
  private readonly volIconLow: HTMLElement;
  private readonly volIconMute: HTMLElement;
  private readonly deviceWrap: HTMLElement;
  private readonly devicePill: HTMLButtonElement;
  private readonly deviceName: HTMLElement;
  private readonly deviceMenu: HTMLElement;

  private readonly tabRadio: HTMLButtonElement;
  private readonly tabAmbience: HTMLButtonElement;
  private readonly tabSpotify: HTMLButtonElement;
  private readonly radioView: HTMLElement;
  private readonly ambienceView: HTMLElement;
  private readonly spotifyView: HTMLElement;
  private readonly trackList: HTMLElement;
  private readonly favoritesEmpty: HTMLElement;
  private readonly radioSearchInput: HTMLInputElement;

  private readonly spChip: HTMLButtonElement;
  private readonly spChipText: HTMLElement;
  private readonly connectView: HTMLElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly connectError: HTMLElement;
  private readonly clientIdInput: HTMLInputElement;
  private readonly appView: HTMLElement;
  private readonly avatar: HTMLImageElement;
  private readonly spNameEl: HTMLElement;
  private readonly spProductEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly skeleton: HTMLElement;
  private readonly libraryView: HTMLElement;
  private readonly likedList: HTMLElement;
  private readonly likedEmpty: HTMLElement;
  private readonly likedMore: HTMLButtonElement;
  private readonly topList: HTMLElement;
  private readonly playlistsRow: HTMLElement;
  private readonly playlistsEmpty: HTMLElement;
  private readonly freeNote: HTMLElement;
  private readonly resultsView: HTMLElement;
  private readonly detailView: HTMLElement;

  private readonly mini: HTMLElement;
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly miniImg: HTMLImageElement;
  private readonly miniTitle: HTMLElement;
  private readonly miniSub: HTMLElement;
  private readonly miniPlay: HTMLButtonElement;

  constructor() {
    this.state = this.loadState();

    this.root = byId('musicPlayerModal');
    this.playerBar = byId('mpPlayerBar');
    this.pbArt = byId('mpPbArt');
    this.pbImg = byId('mpPbImg');
    this.pbPlaceholder = this.playerBar.querySelector('.mp-pb-placeholder') as HTMLElement;
    this.pbTitle = byId('mpPbTitle');
    this.pbSub = byId('mpPbSub');
    this.pbSource = byId('mpPbSource');
    this.pbEq = this.playerBar.querySelector('.mp-pb-eq') as HTMLElement;
    this.seek = byId('mpSeek');
    this.timeCurrent = byId('mpTimeCurrent');
    this.timeTotal = byId('mpTimeTotal');
    this.playBtn = byId('mpPlay');
    this.shuffleBtn = byId('mpShuffle');
    this.repeatBtn = byId('mpRepeat');
    this.volumeInput = byId('mpVolume');
    this.volIconHigh = byId('mpVolIconHigh');
    this.volIconLow = byId('mpVolIconLow');
    this.volIconMute = byId('mpVolIconMute');
    this.deviceWrap = byId('mpDeviceWrap');
    this.devicePill = byId('mpDevicePill');
    this.deviceName = byId('mpDeviceName');
    this.deviceMenu = byId('mpDeviceMenu');

    this.tabRadio = byId('mpTabRadio');
    this.tabAmbience = byId('mpTabAmbience');
    this.tabSpotify = byId('mpTabSpotify');
    this.radioView = byId('mpRadioView');
    this.ambienceView = byId('mpAmbienceView');
    this.spotifyView = byId('mpSpotifyView');
    this.trackList = byId('mpTrackList');
    this.favoritesEmpty = byId('mpFavoritesEmpty');
    this.radioSearchInput = byId('mpRadioSearchInput');

    this.spChip = byId('mpSpotifyChip');
    this.spChipText = byId('mpSpotifyChipText');
    this.connectView = byId('spConnect');
    this.connectBtn = byId('spConnectBtn');
    this.connectError = byId('spConnectError');
    this.clientIdInput = byId('spClientIdInput');
    this.appView = byId('spApp');
    this.avatar = byId('spAvatar');
    this.spNameEl = byId('spName');
    this.spProductEl = byId('spProduct');
    this.searchInput = byId('spSearchInput');
    this.skeleton = byId('spSkeleton');
    this.libraryView = byId('spLibrary');
    this.likedList = byId('spLikedList');
    this.likedEmpty = byId('spLikedEmpty');
    this.likedMore = byId('spLikedMore');
    this.topList = byId('spTopList');
    this.playlistsRow = byId('spPlaylistsRow');
    this.playlistsEmpty = byId('spPlaylistsEmpty');
    this.freeNote = byId('spFreeNote');
    this.resultsView = byId('spResults');
    this.detailView = byId('spDetail');

    this.mini = byId('mpMiniPlayer');
    this.miniCanvas = byId('mpMiniCanvas');
    this.miniImg = byId('mpMiniImg');
    this.miniTitle = byId('mpMiniTitle');
    this.miniSub = byId('mpMiniSub');
    this.miniPlay = byId('mpMiniPlay');

    // Radio art for every row.
    this.trackList.querySelectorAll<HTMLCanvasElement>('.mp-row-art').forEach((canvas) => {
      const row = canvas.closest('.mp-row') as HTMLDivElement | null;
      const track = row ? getTrackById(row.dataset.trackId ?? '') : null;
      if (track) drawTrackArt(canvas, track);
    });

    // Engine wiring.
    this.engine.onStateChange = () => this.handleEngineState();
    this.engine.onEnd = () => this.handleRadioEnd();
    this.engine.setVolume(this.state.volume);

    // Restore persisted UI state.
    this.volumeInput.value = String(Math.round(this.state.volume * 100));
    this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
    this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
    this.applyRepeatVisuals();
    this.updateVolumeIcon();

    const restored = (this.state.lastTrackId && getTrackById(this.state.lastTrackId)) || TRACKS[0];
    this.currentRadioId = restored.id;
    this.engine.load(restored);
    this.updateChips();
    this.updateRadioRows();

    this.bindEvents();
    this.setupMediaSession();
    this.watchNavbarIcon();
    this.switchView(this.state.view || 'radio');

    // Initial slider fills.
    this.setRangeFill(this.seek);
    this.setRangeFill(this.volumeInput);
    this.root.querySelectorAll<HTMLInputElement>('.volume-slider').forEach((slider) => {
      this.setRangeFill(slider);
    });

    // Spotify bootstrap.
    void this.bootstrapSpotify();
  }

  // ---- persistence ---------------------------------------------------------

  private loadState(): MusicPlayerState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw) as Partial<MusicPlayerState>;
      const favorites = Array.isArray(parsed.favorites)
        ? parsed.favorites.filter(
            (id): id is string => typeof id === 'string' && getTrackById(id) !== undefined,
          )
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
        lastTrackId:
          typeof parsed.lastTrackId === 'string' && getTrackById(parsed.lastTrackId) !== undefined
            ? parsed.lastTrackId
            : null,
        favorites,
        view: ['radio', 'ambience', 'spotify'].includes(parsed.view as ViewId)
          ? (parsed.view as ViewId)
          : DEFAULT_STATE.view,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable — playback still works, just not restored */
    }
  }

  // ========================================================================
  // Radio source
  // ========================================================================

  private currentRadioTrack(): Track | null {
    return getTrackById(this.currentRadioId) ?? null;
  }

  private visibleRadioTracks(): Track[] {
    const query = this.radioSearch.trim().toLowerCase();
    return TRACKS.filter((track) => {
      const matchesFilter =
        this.filter === 'all' ||
        track.playlist === this.filter ||
        (this.filter === 'favorites' && this.state.favorites.includes(track.id));
      const matchesSearch =
        !query ||
        track.title.toLowerCase().includes(query) ||
        PLAYLIST_LABELS[track.playlist].toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
  }

  playRadioTrack(id: string): void {
    const track = getTrackById(id);
    if (!track) return;
    this.stopSpotifyPlayback();
    this.miniDismissed = false;
    this.currentRadioId = id;
    this.state.lastTrackId = id;
    this.persist();
    this.source = 'radio';
    this.engine.play(track, 0);
    this.updateRadioRows();
    this.syncPlayerBarRadio();
    this.updateMini();
  }

  private radioNext(auto = false): void {
    const list = this.visibleRadioTracks().length > 0 ? this.visibleRadioTracks() : TRACKS;
    const idx = list.findIndex((t) => t.id === this.currentRadioId);
    let nextIdx: number;

    if (this.state.shuffle) {
      if (list.length <= 1) return;
      do {
        nextIdx = Math.floor(Math.random() * list.length);
      } while (nextIdx === idx);
    } else {
      nextIdx = idx + 1;
    }

    if (nextIdx >= list.length) {
      if (auto && this.state.repeat === 'off') {
        this.engine.stop();
        return;
      }
      nextIdx = 0;
    }
    this.playRadioTrack(list[nextIdx].id);
  }

  private radioPrev(): void {
    const track = this.currentRadioTrack();
    if (track && this.engine.currentTrack?.id === track.id && this.engine.getPosition() > 3) {
      this.engine.seek(0);
      return;
    }
    const list = this.visibleRadioTracks().length > 0 ? this.visibleRadioTracks() : TRACKS;
    const idx = list.findIndex((t) => t.id === this.currentRadioId);
    let prevIdx: number;
    if (this.state.shuffle) {
      if (list.length <= 1) return;
      do {
        prevIdx = Math.floor(Math.random() * list.length);
      } while (prevIdx === idx);
    } else {
      prevIdx = idx - 1;
    }
    if (prevIdx < 0) prevIdx = list.length - 1;
    this.playRadioTrack(list[prevIdx].id);
  }

  private handleRadioEnd(): void {
    if (this.state.repeat === 'one') {
      const track = this.currentRadioTrack();
      if (track) this.engine.play(track, 0);
      return;
    }
    this.radioNext(true);
  }

  private handleEngineState(): void {
    if (this.source !== 'radio') return;
    this.syncPlayerBarRadio();
    this.updateRadioRows();
    if (this.engine.isPlaying) {
      this.startProgressTimer();
    } else {
      this.stopProgressTimer();
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.engine.isPlaying ? 'playing' : 'paused';
    }
    this.updateMini();
    this.syncNavbarIcon();
  }

  private updateRadioRows(): void {
    const playingId =
      this.source === 'radio' && this.engine.isPlaying ? this.engine.currentTrack?.id : null;
    const favorites = this.state.favorites;
    let visibleCount = 0;

    for (const track of TRACKS) {
      const row = this.trackList.querySelector<HTMLDivElement>(
        `.mp-row[data-track-id="${track.id}"]`,
      );
      if (!row) continue;

      const matches =
        this.filter === 'all' ||
        track.playlist === this.filter ||
        (this.filter === 'favorites' && favorites.includes(track.id));
      const query = this.radioSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        track.title.toLowerCase().includes(query) ||
        PLAYLIST_LABELS[track.playlist].toLowerCase().includes(query);
      const visible = matches && matchesSearch;
      row.hidden = !visible;
      if (visible) visibleCount++;

      const isCurrent = this.source === 'radio' && track.id === this.currentRadioId;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && playingId === track.id);

      const star = row.querySelector<HTMLButtonElement>('.mp-row-star');
      const isFav = favorites.includes(track.id);
      if (star) {
        star.classList.toggle('is-fav', isFav);
        star.setAttribute('aria-pressed', String(isFav));
      }
    }

    const showEmpty =
      visibleCount === 0 && (this.filter === 'favorites' || this.radioSearch.trim() !== '');
    this.favoritesEmpty.hidden = !showEmpty;
    if (showEmpty && this.radioSearch.trim() !== '') {
      const copy = this.favoritesEmpty.querySelector('p');
      if (copy) copy.textContent = 'No tracks match your search.';
    } else {
      const copy = this.favoritesEmpty.querySelector('p');
      if (copy) copy.textContent = 'No favorites yet. Tap the star on any track to keep it close.';
    }
    this.trackList.style.display = showEmpty ? 'none' : '';
  }

  private updateChips(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.mp-chip').forEach((chip) => {
      const chipFilter = chip.dataset.filter as TrackFilter;
      const active = chipFilter === this.filter;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    this.root.querySelectorAll<HTMLElement>('.mp-chip-count').forEach((count) => {
      const forFilter = count.dataset.countFor as TrackFilter;
      let n: number;
      if (forFilter === 'all') n = TRACKS.length;
      else if (forFilter === 'favorites') n = this.state.favorites.length;
      else n = TRACKS.filter((t) => t.playlist === forFilter).length;
      count.textContent = String(n);
    });
  }

  private toggleRadioFavorite(id: string): void {
    const track = getTrackById(id);
    if (!track) return;
    const idx = this.state.favorites.indexOf(id);
    const isFav = idx === -1;
    if (isFav) {
      this.state.favorites.push(id);
    } else {
      this.state.favorites.splice(idx, 1);
    }
    this.persist();
    this.updateChips();
    this.updateRadioRows();
  }

  // ========================================================================
  // Player bar (all sources)
  // ========================================================================

  private isPlaying(): boolean {
    if (this.source === 'radio') return this.engine.isPlaying;
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview')
        return this.previewAudio !== null && !this.previewAudio.paused;
      if (this.activeDeviceId) return this.sdkRestPlaying;
      return this.sdkState ? !this.sdkState.paused : false;
    }
    return false;
  }

  private currentDurationMs(): number {
    if (this.source === 'radio') {
      const track = this.currentRadioTrack();
      return track ? track.durationSec * 1000 : 0;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        return 30_000;
      }
      return this.sdkState?.duration ?? 0;
    }
    return 0;
  }

  private currentPositionMs(): number {
    if (this.source === 'radio') {
      const track = this.currentRadioTrack();
      if (!track) return 0;
      const pos = this.engine.currentTrack?.id === track.id ? this.engine.getPosition() : 0;
      return pos * 1000;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        return this.previewAudio ? this.previewAudio.currentTime * 1000 : 0;
      }
      if (this.sdkState) {
        if (this.sdkState.paused) return this.sdkState.position;
        const elapsed = Date.now() - this.sdkStateAt;
        return Math.min(this.sdkState.duration, this.sdkState.position + elapsed);
      }
      return this.sdkRestProgressMs;
    }
    return 0;
  }

  private syncPlayerBarRadio(): void {
    const track = this.currentRadioTrack();
    if (!track) return;
    this.pbImg.hidden = true;
    this.pbArt.hidden = false;
    this.pbPlaceholder.hidden = true;
    drawTrackArt(this.pbArt, track);
    this.pbTitle.textContent = track.title;
    this.pbSub.textContent = 'Padify Studio';
    this.pbSource.hidden = false;
    this.pbSource.textContent = 'Radio';
    this.timeTotal.textContent = formatTime(track.durationSec);
    this.playerBar.classList.toggle('is-playing', this.engine.isPlaying);
    this.updatePlayIcon();
    this.updateProgress();
    this.updateMediaSessionRadio(track);
    this.deviceWrap.hidden = true;
  }

  private syncPlayerBarSpotify(
    track: SpotifyTrack,
    sub: string,
    playing: boolean,
    mode: SpotifyMode,
  ): void {
    this.pbArt.hidden = true;
    this.pbPlaceholder.hidden = true;
    const art = pickImage(track.album?.images, 1) ?? pickImage(track.album?.images, 0);
    if (art) {
      this.pbImg.src = art;
      this.pbImg.alt = `${track.album?.name ?? 'Album'} art`;
      this.pbImg.hidden = false;
    } else {
      this.pbImg.hidden = true;
      this.pbPlaceholder.hidden = false;
    }
    this.pbTitle.textContent = track.name;
    this.pbSub.textContent = sub || trackArtistNames(track);
    this.pbSource.hidden = false;
    this.pbSource.textContent = mode === 'sdk' ? 'Spotify' : PREVIEW_LABEL;
    this.timeTotal.textContent = formatMs(
      mode === 'preview' ? 30_000 : (this.sdkState?.duration ?? track.duration_ms),
    );
    this.playerBar.classList.toggle('is-playing', playing);
    this.updatePlayIcon();
    this.updateProgress();
    this.updateMediaSessionSpotify(track);
    this.deviceWrap.hidden = !(mode === 'sdk' && this.profile?.product === 'premium');
    this.updateMini();
  }

  private updatePlayIcon(): void {
    const playing = this.isPlaying();
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playBtn.setAttribute('title', playing ? 'Pause' : 'Play');
    const playIcon = this.playBtn.querySelector<HTMLElement>('#mpPlayIcon');
    const pauseIcon = this.playBtn.querySelector<HTMLElement>('#mpPauseIcon');
    if (playIcon) playIcon.style.display = playing ? 'none' : 'block';
    if (pauseIcon) pauseIcon.style.display = playing ? 'block' : 'none';

    const miniPlayIcon = this.miniPlay.querySelector<HTMLElement>('#mpPlayIcon');
    const miniPauseIcon = this.miniPlay.querySelector<HTMLElement>('#mpPauseIcon');
    if (miniPlayIcon) miniPlayIcon.style.display = playing ? 'none' : 'block';
    if (miniPauseIcon) miniPauseIcon.style.display = playing ? 'block' : 'none';
    this.miniPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  private updateProgress(): void {
    const posMs = this.currentPositionMs();
    const totalMs = this.currentDurationMs();
    this.timeCurrent.textContent = formatMs(posMs);
    if (!this.seekDragging) {
      const ratio = totalMs > 0 ? Math.min(1, posMs / totalMs) : 0;
      this.seek.value = String(Math.round(ratio * 1000));
      this.seek.setAttribute('aria-valuetext', formatMs(posMs));
    }
    this.setRangeFill(this.seek);
  }

  private updatePlayerBarEmpty(): void {
    this.pbTitle.textContent = 'Nothing playing';
    this.pbSub.textContent = 'Pick a radio track or connect Spotify';
    this.pbSource.hidden = true;
    this.pbArt.hidden = true;
    this.pbImg.hidden = true;
    this.pbPlaceholder.hidden = false;
    this.timeCurrent.textContent = '0:00';
    this.timeTotal.textContent = '0:00';
    this.seek.value = '0';
    this.setRangeFill(this.seek);
    this.playerBar.classList.remove('is-playing');
    this.updatePlayIcon();
    this.deviceWrap.hidden = true;
    this.updateMini();
  }

  private startProgressTimer(): void {
    if (this.progressTimer !== null) return;
    this.progressTimer = setInterval(() => this.updateProgress(), PROGRESS_INTERVAL_MS);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // ---- transport ---------------------------------------------------------

  togglePlay(): void {
    if (this.source === 'radio') {
      if (!this.engine.currentTrack) {
        this.playRadioTrack(this.currentRadioId);
        return;
      }
      if (this.engine.isPlaying) this.engine.pause();
      else this.engine.resume();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview' && this.previewAudio) {
        if (this.previewAudio.paused) void this.previewAudio.play().catch(() => undefined);
        else this.previewAudio.pause();
        return;
      }
      if (this.spotifyMode === 'sdk') {
        if (this.activeDeviceId) {
          // Playback lives on another device — control it via REST.
          if (this.isPlaying()) {
            void spotify.pausePlayback().catch(() => this.toastSpotifyError());
            this.sdkRestPlaying = false;
          } else {
            void spotify
              .playOnDevice(this.activeDeviceId, {})
              .catch(() => this.toastSpotifyError());
            this.sdkRestPlaying = true;
          }
          this.updatePlayIcon();
          return;
        }
        void this.sdk.togglePlay().catch(() => this.toastSpotifyError());
      }
    }
  }

  next(): void {
    if (this.source === 'radio') {
      this.radioNext();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        this.playSpotifyPreviewAt(this.spIndex + 1);
        return;
      }
      if (this.spotifyMode === 'sdk') {
        void this.skipSdk('next');
      }
    }
  }

  prev(): void {
    if (this.source === 'radio') {
      this.radioPrev();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        this.playSpotifyPreviewAt(this.spIndex - 1);
        return;
      }
      if (this.spotifyMode === 'sdk') {
        void this.skipSdk('previous');
      }
    }
  }

  // ---- volume ------------------------------------------------------------

  private setVolume(value: number, fromUser: boolean): void {
    const vol = Math.max(0, Math.min(1, value));
    this.engine.setVolume(vol);
    if (this.previewAudio) this.previewAudio.volume = vol;
    void this.sdk.setVolume(vol).catch(() => undefined);
    if (fromUser) {
      this.state.volume = vol;
      this.persist();
      if (vol > 0) this.lastVolumeBeforeMute = vol;
    }
    this.volumeInput.value = String(Math.round(vol * 100));
    this.setRangeFill(this.volumeInput);
    this.updateVolumeIcon();
  }

  private toggleMute(): void {
    const current = this.state.volume;
    if (current > 0) {
      this.lastVolumeBeforeMute = current;
      this.setVolume(0, false);
    } else {
      const restore =
        this.lastVolumeBeforeMute ?? (this.state.volume > 0 ? this.state.volume : 0.7);
      this.setVolume(restore, true);
    }
  }

  private updateVolumeIcon(): void {
    const vol = this.state.volume;
    this.volIconHigh.style.display = vol >= 0.5 ? 'inline' : 'none';
    this.volIconLow.style.display = vol > 0 && vol < 0.5 ? 'inline' : 'none';
    this.volIconMute.style.display = vol <= 0 ? 'inline' : 'none';
    const muted = vol <= 0;
    this.volIconHigh.parentElement?.setAttribute('title', muted ? 'Unmute' : 'Mute');
    this.volIconHigh.parentElement?.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  // ---- repeat / shuffle ----------------------------------------------------

  private applyRepeatVisuals(): void {
    const mode = this.state.repeat;
    this.repeatBtn.classList.toggle('is-on', mode !== 'off');
    this.repeatBtn.classList.toggle('is-one', mode === 'one');
    this.repeatBtn.setAttribute('aria-pressed', String(mode !== 'off'));
    this.repeatBtn.setAttribute('aria-label', `Repeat: ${mode}`);
    this.repeatBtn.title = `Repeat: ${mode}`;
  }

  private cycleRepeat(): void {
    const idx = REPEAT_MODES.indexOf(this.state.repeat);
    this.state.repeat = REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
    this.persist();
    this.applyRepeatVisuals();
    if (
      this.source === 'spotify' &&
      this.spotifyMode === 'sdk' &&
      this.profile?.product === 'premium'
    ) {
      const mapped =
        this.state.repeat === 'one' ? 'track' : this.state.repeat === 'all' ? 'context' : 'off';
      void spotify.setPlaybackRepeat(mapped).catch(() => undefined);
    }
  }

  private toggleShuffle(): void {
    this.state.shuffle = !this.state.shuffle;
    this.persist();
    this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
    this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
    this.shuffleBtn.setAttribute('aria-label', this.state.shuffle ? 'Shuffle on' : 'Shuffle off');
    if (
      this.source === 'spotify' &&
      this.spotifyMode === 'sdk' &&
      this.profile?.product === 'premium'
    ) {
      void spotify.setPlaybackShuffle(this.state.shuffle).catch(() => undefined);
    }
  }

  // ---- seek ----------------------------------------------------------------

  private previewSeek(): void {
    const totalMs = this.currentDurationMs();
    const ratio = Number(this.seek.value) / 1000;
    const posMs = ratio * totalMs;
    this.timeCurrent.textContent = formatMs(posMs);
    this.seek.setAttribute('aria-valuetext', formatMs(posMs));
    this.setRangeFill(this.seek);
    if (!this.seekDragging) {
      if (this.seekDebounce !== null) clearTimeout(this.seekDebounce);
      this.seekDebounce = setTimeout(() => {
        this.seekDebounce = null;
        this.commitSeekTo(posMs);
      }, 180);
    }
  }

  private commitSeek(): void {
    if (this.seekDebounce !== null) {
      clearTimeout(this.seekDebounce);
      this.seekDebounce = null;
    }
    const totalMs = this.currentDurationMs();
    const posMs = (Number(this.seek.value) / 1000) * totalMs;
    this.commitSeekTo(posMs);
    this.seekDragging = false;
    this.updateProgress();
  }

  private commitSeekTo(posMs: number): void {
    if (this.source === 'radio') {
      this.engine.seek(posMs / 1000);
    } else if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview' && this.previewAudio) {
        this.previewAudio.currentTime = Math.min(posMs / 1000, 29.5);
      } else if (this.spotifyMode === 'sdk') {
        if (this.activeDeviceId) {
          void spotify
            .playOnDevice(this.activeDeviceId, { positionMs: Math.round(posMs) })
            .catch(() => this.toastSpotifyError());
        } else {
          void this.sdk.seek(Math.round(posMs)).catch(() => this.toastSpotifyError());
        }
      }
    }
  }

  // ========================================================================
  // Spotify: preview playback (free accounts)
  // ========================================================================

  private ensurePreviewAudio(): HTMLAudioElement {
    if (this.previewAudio) return this.previewAudio;
    const audio = new Audio();
    audio.preload = 'none';
    audio.volume = this.state.volume;
    audio.addEventListener('timeupdate', () => {
      if (this.source === 'spotify' && this.spotifyMode === 'preview') {
        this.updateProgress();
      }
    });
    audio.addEventListener('play', () => this.updatePlayIcon());
    audio.addEventListener('pause', () => this.updatePlayIcon());
    audio.addEventListener('ended', () => this.handlePreviewEnded());
    audio.addEventListener('error', () => {
      if (this.source === 'spotify' && this.spotifyMode === 'preview') {
        showToast('Preview unavailable for this track.');
        this.updatePlayerBarEmpty();
        this.updateSpotifyRows();
      }
    });
    this.previewAudio = audio;
    return audio;
  }

  private handlePreviewEnded(): void {
    if (this.source !== 'spotify' || this.spotifyMode !== 'preview') return;
    if (this.state.repeat === 'one') {
      this.playSpotifyPreviewAt(this.spIndex);
      return;
    }
    const nextIdx = this.spIndex + 1;
    if (nextIdx < this.spQueue.length || this.state.repeat === 'all') {
      this.playSpotifyPreviewAt(nextIdx);
    } else {
      this.updatePlayerBarEmpty();
      this.updateSpotifyRows();
    }
  }

  playSpotifyPreviewAt(index: number): void {
    if (this.spQueue.length === 0) return;
    let idx = index;
    if (idx >= this.spQueue.length) {
      if (this.state.repeat === 'all') idx = 0;
      else return;
    }
    if (idx < 0) idx = this.spQueue.length - 1;

    if (this.state.shuffle && this.spQueue.length > 1) {
      let randomIdx = idx;
      while (randomIdx === idx) randomIdx = Math.floor(Math.random() * this.spQueue.length);
      idx = randomIdx;
    }

    const track = this.spQueue[idx];
    if (!track) return;
    this.spIndex = idx;

    if (!track.preview_url) {
      showToast('No preview available for this track.');
      return;
    }

    this.pauseRadioForSpotify();
    this.miniDismissed = false;
    const audio = this.ensurePreviewAudio();
    audio.src = track.preview_url;
    this.source = 'spotify';
    this.spotifyMode = 'preview';
    this.startProgressTimer();
    this.syncPlayerBarSpotify(track, trackArtistNames(track), true, 'preview');
    this.updateSpotifyRows();
    this.syncNavbarIcon();
    audio.play().catch(() => {
      showToast('Tap play to start the preview.');
    });
  }

  // ========================================================================
  // Spotify: SDK playback (Premium)
  // ========================================================================

  private pauseRadioForSpotify(): void {
    if (this.engine.isPlaying) this.engine.pause();
  }

  private stopSpotifyPlayback(): void {
    if (this.previewAudio && !this.previewAudio.paused) this.previewAudio.pause();
    if (this.source === 'spotify' && this.spotifyMode === 'sdk') {
      if (this.activeDeviceId) {
        void spotify.pausePlayback(this.activeDeviceId).catch(() => undefined);
      } else {
        void this.sdk.pause().catch(() => undefined);
      }
    }
    this.sdkState = null;
    this.sdkRestPlaying = false;
    this.sdkRestProgressMs = 0;
  }

  private sdkRestPlaying = false;
  private sdkRestProgressMs = 0;
  private sdkRestTrack: SpotifyTrack | null = null;

  private async ensureSdkReady(): Promise<string> {
    if (!this.sdk.deviceId) {
      showToast('Connecting the Spotify player…');
      const deviceId = await this.sdk.init();
      this.sdk.onState((state) => this.handleSdkState(state));
      this.sdk.onError((message) => {
        if (message.toLowerCase().includes('premium')) {
          this.handleFreeAccountFallback();
        } else {
          showToast(`Spotify player: ${message}`);
        }
      });
      return deviceId;
    }
    return this.sdk.deviceId;
  }

  private handleSdkState(state: WebPlaybackPlayerState): void {
    this.sdkState = state;
    this.sdkStateAt = Date.now();
    this.activeDeviceId = null; // our device is active
    this.source = 'spotify';
    this.spotifyMode = 'sdk';
    const track = state.track_window.current_track;
    this.syncPlayerBarSpotify(track, trackArtistNames(track), !state.paused, 'sdk');
    this.updateSpotifyRows();
    this.startProgressTimer();
    this.syncNavbarIcon();
  }

  private handleFreeAccountFallback(): void {
    if (this.profile) this.profile = { ...this.profile, product: 'free' };
    this.freeNote.hidden = false;
    this.deviceWrap.hidden = true;
    showToast('Spotify Premium is required for full playback — playing 30-second previews.');
  }

  /**
   * Plays a list of Spotify tracks starting at `index`.
   * Premium → Web Playback SDK (full songs); Free → 30s previews.
   */
  async playSpotifyList(
    tracks: SpotifyTrack[],
    index: number,
    contextUri?: string | null,
  ): Promise<void> {
    if (tracks.length === 0) return;
    const startIndex = Math.max(0, Math.min(index, tracks.length - 1));
    this.spQueue = tracks;
    this.spIndex = startIndex;

    const isPremium = this.profile?.product === 'premium';
    if (!isPremium) {
      this.playSpotifyPreviewAt(startIndex);
      return;
    }

    this.pauseRadioForSpotify();
    this.source = 'spotify';
    this.spotifyMode = 'sdk';

    try {
      const deviceId = await this.ensureSdkReady();
      const body: spotify.PlayRequest = contextUri
        ? { contextUri, offsetTrackUri: tracks[startIndex]?.uri }
        : {
            uris: tracks.slice(0, 100).map((track) => track.uri),
            offsetTrackUri: tracks[startIndex]?.uri,
          };
      try {
        await spotify.playOnDevice(deviceId, body);
      } catch (err) {
        // Device may have gone away (SDK reconnect needed) — retry once.
        if (err instanceof spotify.SpotifyApiError && (err.status === 404 || err.status === 500)) {
          this.sdk.disconnect();
          const freshDevice = await this.ensureSdkReady();
          await spotify.playOnDevice(freshDevice, body);
        } else {
          throw err;
        }
      }
      this.syncPlayerBarSpotify(
        tracks[startIndex],
        trackArtistNames(tracks[startIndex]),
        true,
        'sdk',
      );
      this.updateSpotifyRows();
    } catch (err) {
      this.toastSpotifyError(err);
    }
  }

  private async skipSdk(direction: 'next' | 'previous'): Promise<void> {
    try {
      if (direction === 'next') {
        await spotify.skipToNext();
      } else {
        await spotify.skipToPrevious();
      }
    } catch {
      this.toastSpotifyError();
    }
  }

  // ---- devices -------------------------------------------------------------

  private async openDeviceMenu(): Promise<void> {
    this.deviceMenu.hidden = !this.deviceMenu.hidden;
    this.devicePill.setAttribute('aria-expanded', String(!this.deviceMenu.hidden));
    if (this.deviceMenu.hidden) return;

    this.deviceMenu.innerHTML = '<div class="mp-device-loading">Loading devices…</div>';
    try {
      const { devices } = await spotify.getDevices();
      const ours = this.sdk.deviceId;
      const items: string[] = [];
      for (const device of devices) {
        if (!device.id) continue;
        const isOurs = device.id === ours;
        const isOtherActive = device.is_active && !isOurs;
        items.push(
          `<button type="button" class="mp-device-item${isOtherActive ? ' is-active' : ''}" data-device-id="${device.id}" data-device-name="${escapeHtml(device.name)}">
                        ${ICONS.device}
                        <span>${escapeHtml(device.name)}${isOurs ? ' · this browser' : ''}</span>
                        ${device.is_active ? '<span class="mp-device-live">live</span>' : ''}
                    </button>`,
        );
      }
      this.deviceMenu.innerHTML =
        items.length > 0
          ? items.join('')
          : '<div class="mp-device-loading">No other devices found.</div>';
    } catch (err) {
      this.deviceMenu.innerHTML = '<div class="mp-device-loading">Could not load devices.</div>';
      this.toastSpotifyError(err);
    }
  }

  private async transferToDevice(deviceId: string, name: string): Promise<void> {
    try {
      await spotify.transferPlayback(deviceId, true);
      this.activeDeviceId = deviceId;
      this.deviceName.textContent = name;
      this.deviceMenu.hidden = true;
      showToast(`Playback moved to ${name}.`);
      this.startSdkPolling();
    } catch (err) {
      this.toastSpotifyError(err);
    }
  }

  private startSdkPolling(): void {
    this.stopSdkPolling();
    if (this.profile?.product !== 'premium') return;
    this.sdkPollTimer = setInterval(() => {
      if (this.source !== 'spotify' || this.spotifyMode !== 'sdk') return;
      void this.pollSdkState();
    }, SDK_POLL_INTERVAL_MS);
  }

  private stopSdkPolling(): void {
    if (this.sdkPollTimer !== null) {
      clearInterval(this.sdkPollTimer);
      this.sdkPollTimer = null;
    }
  }

  private async pollSdkState(): Promise<void> {
    try {
      const state = await spotify.getPlaybackState();
      if (!state) return;
      if (state.device?.id && state.device.id !== this.sdk.deviceId) {
        this.activeDeviceId = state.device.id;
        this.deviceName.textContent = state.device.name;
      } else if (!state.device?.id || state.device.id === this.sdk.deviceId) {
        this.activeDeviceId = null;
      }
      if (state.item) {
        this.sdkRestTrack = state.item;
        this.sdkRestPlaying = state.is_playing;
        this.sdkRestProgressMs = state.progress_ms ?? 0;
        if (this.activeDeviceId) {
          // Away-device playback — reflect REST state in the bar.
          this.syncPlayerBarSpotify(
            state.item,
            trackArtistNames(state.item),
            state.is_playing,
            'sdk',
          );
          this.timeTotal.textContent = formatMs(state.item.duration_ms);
          this.timeCurrent.textContent = formatMs(state.progress_ms ?? 0);
          const ratio =
            state.item.duration_ms > 0
              ? Math.min(1, (state.progress_ms ?? 0) / state.item.duration_ms)
              : 0;
          this.seek.value = String(Math.round(ratio * 1000));
          this.setRangeFill(this.seek);
          this.updatePlayIcon();
        }
      }
    } catch {
      /* transient polling failure — silently retry next tick */
    }
  }

  // ========================================================================
  // Spotify: auth + library
  // ========================================================================

  private async bootstrapSpotify(): Promise<void> {
    const returning = consumedReturnFlag();
    const result = await completeLogin();
    if (result && !result.ok && result.error) {
      this.showConnectError(result.error);
    }

    if (isAuthenticated()) {
      await this.loadSpotifyProfile();
      if (returning && result?.ok) {
        this.switchView('spotify');
        $('#musicPlayerModal').modal('show');
        showToast('Spotify connected.');
      }
    } else {
      this.renderConnectScreen();
    }
  }

  private async loadSpotifyProfile(): Promise<void> {
    if (this.spotifyBusy) return;
    this.spotifyBusy = true;
    try {
      this.profile = await spotify.getMe();
      this.renderConnectedState();
      await this.loadLibrary();
      if (this.profile.product === 'premium') {
        // Warm the SDK up in the background so the first play is fast.
        this.ensureSdkReady()
          .then(() => {
            this.startSdkPolling();
            this.updateDevicePill();
          })
          .catch(() => {
            this.handleFreeAccountFallback();
          });
      } else {
        this.freeNote.hidden = false;
      }
    } catch (err) {
      if (err instanceof SpotifyAuthError) {
        this.showConnectError(err.message);
        this.renderConnectScreen();
      } else {
        this.toastSpotifyError(err);
      }
    } finally {
      this.spotifyBusy = false;
    }
  }

  private renderConnectScreen(): void {
    this.connectView.hidden = false;
    this.appView.hidden = true;
    this.spChipText.textContent = 'Connect Spotify';
    this.spChip.classList.remove('is-connected');
    const redirectEl = byId('spRedirectUri');
    redirectEl.textContent = getRedirectUri();
    const savedId = getClientId();
    if (savedId) this.clientIdInput.value = savedId;
  }

  private renderConnectedState(): void {
    if (!this.profile) return;
    this.connectView.hidden = true;
    this.appView.hidden = false;
    this.spChipText.textContent = this.profile.display_name ?? 'Spotify';
    this.spChip.classList.add('is-connected');

    this.spNameEl.textContent = this.profile.display_name ?? 'Spotify user';
    const product = this.profile.product === 'premium' ? 'Premium' : 'Free';
    this.spProductEl.textContent = product;
    this.spProductEl.classList.toggle('is-premium', this.profile.product === 'premium');

    const avatarUrl = pickImage(this.profile.images, 0);
    if (avatarUrl) {
      this.avatar.src = avatarUrl;
      this.avatar.hidden = false;
    } else {
      this.avatar.hidden = true;
    }
  }

  private showConnectError(message: string): void {
    this.connectError.textContent = message;
    this.connectError.hidden = false;
  }

  private async loadLibrary(): Promise<void> {
    this.skeleton.hidden = false;
    this.libraryView.hidden = true;
    try {
      const [liked, top, playlists] = await Promise.all([
        spotify.getSavedTracks(30, 0).catch(() => null),
        spotify.getTopTracks('short_term', 10).catch(() => null),
        spotify.getPlaylists(24).catch(() => null),
      ]);

      this.likedOffset = liked ? liked.items.length : 0;
      this.likedTotal = liked?.total ?? 0;

      this.renderSpotifyTrackRows(
        this.likedList,
        (liked?.items ?? []).map((item) => item.track).filter((t): t is SpotifyTrack => t !== null),
      );
      this.likedEmpty.hidden = (liked?.items?.length ?? 0) > 0;
      this.likedMore.hidden = liked ? this.likedOffset >= (liked.total ?? 0) : true;

      this.renderSpotifyTrackRows(this.topList, top?.items ?? []);

      const playlistItems = playlists?.items ?? [];
      this.playlistsRow.innerHTML = playlistItems
        .map((playlist) => this.playlistCardMarkup(playlist))
        .join('');
      this.playlistsEmpty.hidden = playlistItems.length > 0;

      this.libraryView.hidden = false;
    } catch (err) {
      this.toastSpotifyError(err);
    } finally {
      this.skeleton.hidden = true;
    }
  }

  private playlistCardMarkup(playlist: SpotifyPlaylist): string {
    const art = pickImage(playlist.images, 0);
    return `
        <button type="button" class="sp-card" data-playlist-id="${playlist.id}" data-playlist-uri="${playlist.uri}" title="${escapeHtml(playlist.name)}">
            <span class="sp-card-art">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(playlist.name)}</span>
            <span class="sp-card-meta">${playlist.tracks.total} songs</span>
        </button>`;
  }

  private albumCardMarkup(album: SpotifyAlbum): string {
    const art = pickImage(album.images, 0);
    return `
        <button type="button" class="sp-card" data-album-id="${album.id}" data-album-uri="${album.uri}" title="${escapeHtml(album.name)}">
            <span class="sp-card-art">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(album.name)}</span>
            <span class="sp-card-meta">${escapeHtml(album.artists.map((a) => a.name).join(', '))}</span>
        </button>`;
  }

  private artistCardMarkup(artist: SpotifySimpleArtist): string {
    const art = pickImage(artist.images, 0);
    return `
        <button type="button" class="sp-card sp-card-artist" data-artist-id="${artist.id}" data-artist-name="${escapeHtml(artist.name)}" title="${escapeHtml(artist.name)}">
            <span class="sp-card-art sp-card-art-round">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(artist.name)}</span>
            <span class="sp-card-meta">Artist</span>
        </button>`;
  }

  private trackRowMarkup(track: SpotifyTrack, queueId: string): string {
    const isPremium = this.profile?.product === 'premium';
    const playable = isPremium || track.preview_url !== null;
    const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
    const artists = escapeHtml(trackArtistNames(track));
    return `
        <div class="sp-row${playable ? '' : ' is-disabled'}" role="listitem" data-queue-id="${queueId}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" ${playable ? '' : 'disabled'} aria-label="Play ${escapeHtml(track.name)} by ${artists}">
                <span class="sp-row-art">${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.note}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${escapeHtml(track.name)}</span>
                    <span class="sp-row-sub">${artists}${track.explicit ? ' · E' : ''}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
        </div>`;
  }

  private renderSpotifyTrackRows(
    container: HTMLElement,
    tracks: SpotifyTrack[],
    queueId = `q-${Math.random().toString(36).slice(2, 8)}`,
  ): void {
    const withArt: SpotifyTrack[] = tracks.filter((t) => t && t.uri);
    this.queues.set(queueId, withArt);
    container.dataset.queueId = queueId;
    container.innerHTML = withArt.map((track) => this.trackRowMarkup(track, queueId)).join('');
    this.updateSpotifyRows();
  }

  private queues = new Map<string, SpotifyTrack[]>();

  private updateSpotifyRows(): void {
    const currentUri =
      this.source === 'spotify'
        ? this.spotifyMode === 'preview'
          ? this.spQueue[this.spIndex]?.uri
          : (this.sdkState?.track_window.current_track?.uri ?? this.sdkRestTrack?.uri)
        : null;
    const playing = this.isPlaying();
    this.root.querySelectorAll<HTMLElement>('.sp-row').forEach((row) => {
      const uri = row.dataset.trackUri;
      const isCurrent = uri === currentUri;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && playing);
    });
  }

  private async loadMoreLiked(): Promise<void> {
    try {
      this.likedMore.disabled = true;
      const page = await spotify.getSavedTracks(30, this.likedOffset);
      const tracks = page.items
        .map((item) => item.track)
        .filter((t): t is SpotifyTrack => t !== null);
      const queueId = this.likedList.dataset.queueId ?? 'liked';
      const existing = this.queues.get(queueId) ?? [];
      this.queues.set(queueId, [...existing, ...tracks]);
      this.likedList.insertAdjacentHTML(
        'beforeend',
        tracks.map((track) => this.trackRowMarkup(track, queueId)).join(''),
      );
      this.likedOffset += page.items.length;
      this.likedTotal = page.total;
      this.likedMore.hidden = this.likedOffset >= page.total;
      this.updateSpotifyRows();
    } catch (err) {
      this.toastSpotifyError(err);
    } finally {
      this.likedMore.disabled = false;
    }
  }

  // ---- search ---------------------------------------------------------------

  private async runSpotifySearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      this.showLibrary();
      return;
    }
    try {
      const results = await spotify.search(trimmed, 'track,album,playlist,artist', 10);
      const hasAnything =
        (results.tracks?.items.length ?? 0) > 0 ||
        (results.playlists?.items.length ?? 0) > 0 ||
        (results.albums?.items.length ?? 0) > 0 ||
        (results.artists?.items.length ?? 0) > 0;

      this.libraryView.hidden = true;
      this.detailView.hidden = true;
      this.resultsView.hidden = false;

      const tracks = (results.tracks?.items ?? []).filter((t): t is SpotifyTrack => t !== null);
      byId('spSearchTracksSection').hidden = tracks.length === 0;
      this.renderSpotifyTrackRows(byId('spSearchTracks'), tracks, 'search-tracks');

      const playlists = results.playlists?.items ?? [];
      byId('spSearchPlaylistsSection').hidden = playlists.length === 0;
      byId('spSearchPlaylists').innerHTML = playlists
        .map((playlist) => this.playlistCardMarkup(playlist))
        .join('');

      const albums = results.albums?.items ?? [];
      byId('spSearchAlbumsSection').hidden = albums.length === 0;
      byId('spSearchAlbums').innerHTML = albums
        .map((album) => this.albumCardMarkup(album))
        .join('');

      const artists = results.artists?.items ?? [];
      byId('spSearchArtistsSection').hidden = artists.length === 0;
      byId('spSearchArtists').innerHTML = artists
        .map((artist) => this.artistCardMarkup(artist))
        .join('');

      byId('spSearchEmpty').hidden = hasAnything;
    } catch (err) {
      this.toastSpotifyError(err);
    }
  }

  private showLibrary(): void {
    this.resultsView.hidden = true;
    this.detailView.hidden = true;
    if (this.appView.hidden === false) this.libraryView.hidden = false;
  }

  // ---- detail (playlist / album / artist) ------------------------------------

  private async openDetail(
    kind: 'playlist' | 'album' | 'artist',
    payload: {
      id: string;
      uri?: string;
      name: string;
      image?: string | null;
    },
  ): Promise<void> {
    this.libraryView.hidden = true;
    this.resultsView.hidden = true;
    this.detailView.hidden = false;
    byId('spDetailBackLabel').textContent =
      this.searchInput.value.trim().length >= 2 ? 'Back to results' : 'Back to library';
    byId('spDetailType').textContent =
      kind === 'playlist' ? 'Playlist' : kind === 'album' ? 'Album' : 'Artist';
    byId('spDetailName').textContent = payload.name;
    byId('spDetailMeta').textContent = 'Loading…';
    const art = byId<HTMLImageElement>('spDetailArt');
    if (payload.image) {
      art.src = payload.image;
      art.hidden = false;
    } else {
      art.hidden = true;
    }
    const tracksEl = byId('spDetailTracks');
    tracksEl.innerHTML =
      '<div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div>';

    try {
      let tracks: SpotifyTrack[] = [];
      let contextUri: string | null = null;
      let meta = '';

      if (kind === 'playlist') {
        const page = await spotify.getPlaylistTracks(payload.id, 100);
        tracks = page.items.map((item) => item.track).filter((t): t is SpotifyTrack => t !== null);
        contextUri = payload.uri ?? null;
        meta = `${page.total} songs`;
      } else if (kind === 'album') {
        tracks = await spotify.getAlbumTracks(payload.id, 50);
        contextUri = payload.uri ?? null;
        meta = `${tracks.length} songs`;
      } else {
        const result = await spotify.getArtistTopTracks(payload.id);
        tracks = result.tracks;
        meta = `Top ${tracks.length} tracks`;
      }

      byId('spDetailMeta').textContent = meta;
      this.detailContextUri = contextUri;
      this.detailQueue = tracks;
      this.renderSpotifyTrackRows(tracksEl, tracks, 'detail');
    } catch (err) {
      byId('spDetailMeta').textContent = 'Could not load tracks.';
      this.toastSpotifyError(err);
    }
  }

  // ========================================================================
  // Views / tabs
  // ========================================================================

  private switchView(view: ViewId): void {
    this.state.view = view;
    this.persist();
    this.radioView.hidden = view !== 'radio';
    this.ambienceView.hidden = view !== 'ambience';
    this.spotifyView.hidden = view !== 'spotify';
    this.tabRadio.classList.toggle('is-active', view === 'radio');
    this.tabAmbience.classList.toggle('is-active', view === 'ambience');
    this.tabSpotify.classList.toggle('is-active', view === 'spotify');
    this.tabRadio.setAttribute('aria-selected', String(view === 'radio'));
    this.tabAmbience.setAttribute('aria-selected', String(view === 'ambience'));
    this.tabSpotify.setAttribute('aria-selected', String(view === 'spotify'));
    this.tabRadio.tabIndex = view === 'radio' ? 0 : -1;
    this.tabAmbience.tabIndex = view === 'ambience' ? 0 : -1;
    this.tabSpotify.tabIndex = view === 'spotify' ? 0 : -1;
    if (view === 'spotify' && isAuthenticated() && !this.profile && !this.spotifyBusy) {
      void this.loadSpotifyProfile();
    }
  }

  private updateDevicePill(): void {
    if (this.activeDeviceId) return; // keep the remote device label
    this.deviceName.textContent = 'This browser';
    this.deviceWrap.hidden = !(this.spotifyMode === 'sdk' && this.source === 'spotify');
  }

  private toastSpotifyError(err?: unknown): void {
    if (err instanceof SpotifyAuthError) {
      showToast(err.message);
      return;
    }
    const message = err instanceof Error ? err.message : 'Spotify request failed.';
    showToast(message);
  }

  // ========================================================================
  // Mini player
  // ========================================================================

  /** Hides the mini player until the next track starts. */
  private miniDismissed = false;

  private updateMini(): void {
    const hasContent =
      (this.source === 'radio' && this.currentRadioTrack() !== null) ||
      (this.source === 'spotify' &&
        (this.spotifyMode === 'preview'
          ? this.spQueue[this.spIndex] !== undefined
          : this.sdkState?.track_window.current_track !== null));
    const modalOpen = this.root.classList.contains('in');
    this.mini.hidden = !hasContent || modalOpen || this.miniDismissed;
    if (!hasContent) return;

    let title = '';
    let sub = '';
    let artUrl: string | null = null;
    let radioTrack: Track | null = null;

    if (this.source === 'radio') {
      radioTrack = this.currentRadioTrack();
      title = radioTrack?.title ?? '';
      sub = 'Padify Studio';
    } else if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        const track = this.spQueue[this.spIndex];
        if (track) {
          title = track.name;
          sub = trackArtistNames(track);
          artUrl = pickImage(track.album?.images, 1);
        }
      } else {
        const track = this.sdkState?.track_window.current_track ?? this.sdkRestTrack;
        if (track) {
          title = track.name;
          sub = trackArtistNames(track);
          artUrl = pickImage(track.album?.images, 1);
        }
      }
    }

    this.miniTitle.textContent = title;
    this.miniSub.textContent = sub;
    if (artUrl) {
      this.miniImg.src = artUrl;
      this.miniImg.hidden = false;
      this.miniCanvas.hidden = true;
      (this.mini.querySelector('.mp-mini-placeholder') as HTMLElement).hidden = true;
    } else if (radioTrack) {
      drawTrackArt(this.miniCanvas, radioTrack);
      this.miniCanvas.hidden = false;
      this.miniImg.hidden = true;
      (this.mini.querySelector('.mp-mini-placeholder') as HTMLElement).hidden = true;
    } else {
      this.miniCanvas.hidden = true;
      this.miniImg.hidden = true;
      (this.mini.querySelector('.mp-mini-placeholder') as HTMLElement).hidden = false;
    }
    this.updatePlayIcon();
    this.mini.classList.toggle('is-playing', this.isPlaying());
  }

  private stopAndHideMini(): void {
    if (this.source === 'radio') this.engine.stop();
    if (this.source === 'spotify') {
      this.stopSpotifyPlayback();
      if (this.previewAudio) this.previewAudio.pause();
    }
    this.miniDismissed = true;
    this.updatePlayerBarEmpty();
    this.updateRadioRows();
    this.updateSpotifyRows();
    this.syncNavbarIcon();
  }

  // ---- MediaSession ---------------------------------------------------------

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const actions: [MediaSessionAction, () => void][] = [
      ['play', () => this.togglePlay()],
      ['pause', () => this.togglePlay()],
      ['nexttrack', () => this.next()],
      ['previoustrack', () => this.prev()],
    ];
    for (const [action, handler] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* action unsupported in this browser */
      }
    }
  }

  private updateMediaSessionRadio(track: Track): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: 'Padify Studio',
        album: PLAYLIST_LABELS[track.playlist],
        artwork: [{ src: this.pbArt.toDataURL('image/png'), sizes: '512x512', type: 'image/png' }],
      });
    } catch {
      /* metadata/artwork unsupported — non-fatal */
    }
  }

  private updateMediaSessionSpotify(track: SpotifyTrack): void {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = pickImage(track.album?.images, 0);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: trackArtistNames(track),
        album: track.album?.name ?? 'Spotify',
        artwork: art ? [{ src: art, sizes: '640x640', type: 'image/jpeg' }] : [],
      });
    } catch {
      /* metadata/artwork unsupported — non-fatal */
    }
  }

  // ---- Navbar icon sync -------------------------------------------------------

  private syncNavbarIcon(): void {
    const iconEl = document.querySelector('.ambient-noise-icon');
    if (!iconEl) return;
    this.ensureNavbarIconObserver(iconEl);
    const ambientOn = window.whiteNoisePlayer ? window.whiteNoisePlayer.isAnySoundPlaying() : false;
    const playerOn = this.isPlaying() || (this.source === 'radio' && this.engine.isPlaying);
    const should = playerOn || ambientOn;
    const has = iconEl.classList.contains('is-playing');
    if (has !== should) {
      iconEl.classList.toggle('is-playing', should);
    }
  }

  private ensureNavbarIconObserver(iconEl: Element): void {
    if (typeof MutationObserver === 'undefined') return;
    if (this.navbarIconWatchedEl === iconEl) return;
    if (this.navbarIconObserver) {
      this.navbarIconObserver.disconnect();
    }
    this.navbarIconWatchedEl = iconEl;
    this.navbarIconObserver = new MutationObserver(() => this.syncNavbarIcon());
    this.navbarIconObserver.observe(iconEl, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private watchNavbarIcon(): void {
    const iconEl = document.querySelector('.ambient-noise-icon');
    if (iconEl) this.ensureNavbarIconObserver(iconEl);
  }

  // ---- Range fill helper --------------------------------------------------------

  private setRangeFill(input: HTMLInputElement): void {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    input.style.setProperty('--mp-fill', `${pct.toFixed(1)}%`);
  }

  // ========================================================================
  // Events
  // ========================================================================

  private bindEvents(): void {
    // Tabs.
    this.tabRadio.addEventListener('click', () => this.switchView('radio'));
    this.tabAmbience.addEventListener('click', () => this.switchView('ambience'));
    this.tabSpotify.addEventListener('click', () => this.switchView('spotify'));
    this.spChip.addEventListener('click', () => this.switchView('spotify'));

    // Transport.
    this.playBtn.addEventListener('click', () => this.togglePlay());
    byId('mpNext').addEventListener('click', () => this.next());
    byId('mpPrev').addEventListener('click', () => this.prev());
    this.shuffleBtn.addEventListener('click', () => this.toggleShuffle());
    this.repeatBtn.addEventListener('click', () => this.cycleRepeat());

    // Volume.
    this.volumeInput.addEventListener('input', () => {
      this.setVolume(Number(this.volumeInput.value) / 100, true);
    });
    byId('mpVolumeIcon').addEventListener('click', () => this.toggleMute());

    // Seek.
    this.seek.addEventListener('pointerdown', () => {
      this.seekDragging = true;
    });
    this.seek.addEventListener('input', () => this.previewSeek());
    this.seek.addEventListener('change', () => this.commitSeek());

    // Radio library interactions (delegated — rows are static markup).
    this.trackList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest('.mp-row') as HTMLDivElement | null;
      if (!row) return;
      const id = row.dataset.trackId;
      if (!id) return;
      if (target.closest('.mp-row-star')) {
        this.toggleRadioFavorite(id);
        return;
      }
      this.playRadioTrack(id);
    });

    // Radio search + filter chips.
    this.radioSearchInput.addEventListener('input', () => {
      this.radioSearch = this.radioSearchInput.value;
      byId('mpRadioSearchClear').hidden = this.radioSearch === '';
      this.updateRadioRows();
    });
    byId('mpRadioSearchClear').addEventListener('click', () => {
      this.radioSearchInput.value = '';
      this.radioSearch = '';
      byId('mpRadioSearchClear').hidden = true;
      this.updateRadioRows();
      this.radioSearchInput.focus();
    });
    this.root.querySelectorAll<HTMLButtonElement>('.mp-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const filter = chip.dataset.filter as TrackFilter;
        if (filter) {
          this.filter = filter;
          this.updateChips();
          this.updateRadioRows();
        }
      });
    });

    // Ambient volume sliders: keep the gradient fill in sync (cosmetic).
    this.root.addEventListener('input', (event) => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement && target.classList.contains('volume-slider')) {
        this.setRangeFill(target);
      }
    });

    // Device pill + menu.
    this.devicePill.addEventListener('click', () => {
      void this.openDeviceMenu();
    });
    this.deviceMenu.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest(
        '.mp-device-item',
      ) as HTMLButtonElement | null;
      if (!item) return;
      void this.transferToDevice(
        item.dataset.deviceId as string,
        item.dataset.deviceName as string,
      );
    });
    document.addEventListener('click', (event) => {
      if (this.deviceMenu.hidden) return;
      if (!(event.target as HTMLElement).closest('.mp-device')) {
        this.deviceMenu.hidden = true;
        this.devicePill.setAttribute('aria-expanded', 'false');
      }
    });

    // ---- Spotify events ----
    this.connectBtn.addEventListener('click', async () => {
      const clientId = getClientId();
      if (!clientId) {
        this.clientIdInput.classList.add('is-invalid');
        this.clientIdInput.focus();
        showToast('Save your Spotify Client ID first (see setup below).');
        return;
      }
      try {
        await beginLogin();
      } catch (err) {
        this.showConnectError(err instanceof Error ? err.message : 'Could not start login.');
      }
    });

    byId('spClientIdSave').addEventListener('click', () => {
      const value = this.clientIdInput.value.trim();
      if (!value) {
        showToast('Paste your Spotify app Client ID first.');
        this.clientIdInput.classList.add('is-invalid');
        return;
      }
      saveClientId(value);
      this.clientIdInput.classList.remove('is-invalid');
      this.clientIdInput.classList.add('is-valid');
      showToast('Client ID saved — you can connect now.');
    });
    this.clientIdInput.addEventListener('input', () => {
      this.clientIdInput.classList.remove('is-invalid', 'is-valid');
    });

    byId('spCopyRedirect').addEventListener('click', async () => {
      const uri = getRedirectUri();
      try {
        await navigator.clipboard.writeText(uri);
        showToast('Redirect URI copied.');
      } catch {
        showToast(uri);
      }
    });

    byId('spRefresh').addEventListener('click', () => {
      if (!this.profile) {
        void this.loadSpotifyProfile();
      } else {
        void this.loadLibrary();
      }
    });

    byId('spDisconnect').addEventListener('click', () => {
      this.stopSpotifyPlayback();
      this.sdk.disconnect();
      spotifyDisconnect();
      this.profile = null;
      this.stopSdkPolling();
      this.freeNote.hidden = true;
      if (this.source === 'spotify') {
        this.source = 'none';
        this.updatePlayerBarEmpty();
      }
      this.searchInput.value = '';
      this.showLibrary();
      this.renderConnectScreen();
      this.updateSpotifyRows();
      this.syncNavbarIcon();
      showToast('Spotify disconnected.');
    });

    // Spotify search.
    this.searchInput.addEventListener('input', () => {
      byId('spSearchClear').hidden = this.searchInput.value === '';
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        void this.runSpotifySearch(this.searchInput.value);
      }, SEARCH_DEBOUNCE_MS);
    });
    byId('spSearchClear').addEventListener('click', () => {
      this.searchInput.value = '';
      byId('spSearchClear').hidden = true;
      this.showLibrary();
      this.searchInput.focus();
    });
    byId('spResultsBack').addEventListener('click', () => {
      this.searchInput.value = '';
      byId('spSearchClear').hidden = true;
      this.showLibrary();
    });
    byId('spDetailBack').addEventListener('click', () => {
      this.detailView.hidden = true;
      if (this.searchInput.value.trim().length >= 2) {
        this.resultsView.hidden = false;
      } else {
        this.showLibrary();
      }
    });

    this.likedMore.addEventListener('click', () => {
      void this.loadMoreLiked();
    });

    // Spotify rows (delegated across all track lists).
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const rowMain = target.closest('.sp-row-main') as HTMLButtonElement | null;
      if (rowMain) {
        const row = rowMain.closest('.sp-row') as HTMLElement | null;
        const queueId = row?.dataset.queueId;
        const trackUri = row?.dataset.trackUri;
        const queue = queueId ? this.queues.get(queueId) : undefined;
        if (queue && trackUri) {
          const index = queue.findIndex((track) => track.uri === trackUri);
          const contextUri = queueId === 'detail' ? this.detailContextUri : null;
          void this.playSpotifyList(queue, Math.max(0, index), contextUri);
        }
        return;
      }

      const card = target.closest('.sp-card') as HTMLButtonElement | null;
      if (card) {
        if (card.dataset.playlistId) {
          void this.openDetail('playlist', {
            id: card.dataset.playlistId,
            uri: card.dataset.playlistUri,
            name: card.title || 'Playlist',
            image: card.querySelector('img')?.src ?? null,
          });
        } else if (card.dataset.albumId) {
          void this.openDetail('album', {
            id: card.dataset.albumId,
            uri: card.dataset.albumUri,
            name: card.title || 'Album',
            image: card.querySelector('img')?.src ?? null,
          });
        } else if (card.dataset.artistId) {
          void this.openDetail('artist', {
            id: card.dataset.artistId,
            name: card.dataset.artistName || 'Artist',
            image: card.querySelector('img')?.src ?? null,
          });
        }
      }
    });

    // Detail "Play" button — plays the loaded detail list.
    byId('spDetailPlay').addEventListener('click', () => {
      if (this.detailQueue.length === 0) return;
      void this.playSpotifyList(this.detailQueue, 0, this.detailContextUri);
    });

    // ---- Mini player ----
    byId('mpMiniOpen').addEventListener('click', () => {
      $('#musicPlayerModal').modal('show');
    });
    this.miniPlay.addEventListener('click', () => this.togglePlay());
    byId('mpMiniNext').addEventListener('click', () => this.next());
    byId('mpMiniClose').addEventListener('click', () => this.stopAndHideMini());

    // ---- Modal visibility: mini player + progress refresh + SDK polling ----
    $(this.root)
      .on('shown.bs.modal', () => {
        this.updateProgress();
        this.updateMini();
        this.startSdkPolling();
        this.syncNavbarIcon();
      })
      .on('hidden.bs.modal', () => {
        this.updateMini();
        this.stopSdkPolling();
      });

    // Arrow-key seeking inside the modal (not on form controls).
    $(this.root).on('keydown', (event: JQuery.KeyDownEvent<HTMLElement>) => {
      const key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
      const target = event.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (this.source !== 'radio') return;
      const track = this.engine.currentTrack;
      if (!track) return;
      event.preventDefault();
      const pos = this.engine.getPosition();
      this.engine.seek(key === 'ArrowLeft' ? pos - 5 : pos + 5);
    });
  }

  // ---- Debug / E2E hooks ------------------------------------------------------

  debugSnapshot(): Record<string, unknown> {
    return {
      source: this.source,
      engine: this.engine.debugSnapshot(),
      currentRadioId: this.currentRadioId,
      filter: this.filter,
      favorites: this.state.favorites,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      spotify: {
        connected: isAuthenticated(),
        product: this.profile?.product ?? null,
        mode: this.source === 'spotify' ? this.spotifyMode : null,
        sdkReady: this.sdk.deviceId !== null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Module singletons + public API
// ---------------------------------------------------------------------------

const player = new MusicPlayerApp();

export const musicPlayerAPI: {
  open(): void;
  close(): void;
  togglePlay(): void;
  playTrack(id: string): void;
  next(): void;
  prev(): void;
} = {
  open: () => {
    $('#musicPlayerModal').modal('show');
  },
  close: () => {
    $('#musicPlayerModal').modal('hide');
  },
  togglePlay: () => player.togglePlay(),
  playTrack: (id: string) => player.playRadioTrack(id),
  next: () => player.next(),
  prev: () => player.prev(),
};

// Debug/E2E probes (harmless in production, typed via a local interface).
interface MusicDebugWindow {
  __musicEngine?: MusicEngine;
  __musicPlayer?: typeof musicPlayerAPI;
  __musicProbe?: () => Record<string, unknown>;
}
const debugWindow = window as unknown as MusicDebugWindow;
debugWindow.__musicEngine = (player as unknown as { engine: MusicEngine }).engine;
debugWindow.__musicPlayer = musicPlayerAPI;
debugWindow.__musicProbe = () => player.debugSnapshot();
