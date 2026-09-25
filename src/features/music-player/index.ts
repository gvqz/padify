/**
 * Padify music player — v3.
 *
 * One player, two ways to listen:
 *
 *   • Free search (default, zero login) — search Spotify's catalog through
 *     the Padify API (metadata only), then play full tracks in a plain
 *     HTML5 <audio> element using stream URLs the API resolves with
 *     yt-dlp. Anonymous users get local favorites, a local queue and
 *     exactly one local playlist, all on-device.
 *
 *   • Connect Spotify (Premium) — OAuth login brings your playlists, Liked
 *     Songs and search with the full Web API, likes/queue/playlist actions
 *     against your real Spotify library, and native playback through the
 *     Web Playback SDK (with Spotify device handoff). Connected free
 *     accounts keep the Web API surface but play through the free engine.
 *
 *   • Ambience — the soundscape mixer (src/white-noise-player.ts) rides
 *     along in its own tab, unchanged.
 *
 * The radio/generative engine is gone; the modal markup is injected at
 * module evaluation (same pattern as timer.ts) and the app is constructed
 * by initMusicPlayer() AFTER storage hydration (app.ts).
 *
 * Persistence (storage layer → IndexedDB + localStorage mirror):
 *   padify-music-state   volume / shuffle / repeat / view / free queue
 *   padify-music-library local favorites + the single local playlist
 *   padify-spotify-*     the OAuth session (src/spotify/auth.ts)
 */

import { $ } from '../../lib/q';
import Swal from 'sweetalert2';
import type { SweetAlertResult } from 'sweetalert2';
import { showToast } from '../../utils';
import { stateGet, stateSet } from '../../storage';
import { LocalMusicLibrary } from './music/library';
import {
  fetchMusicCapabilities,
  freeSearchTracks,
  resolveTrackStream,
  FreeMusicError,
  type MusicCapabilities,
} from './music/client';
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

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type RepeatMode = 'off' | 'all' | 'one';
type ViewId = 'music' | 'queue' | 'ambience';
type PlayerSource = 'none' | 'free' | 'spotify';
/** How the *current* sound is actually being produced. */
type SpotifyMode = 'sdk' | 'resolve' | 'preview';

interface MusicPlayerState {
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  view: ViewId;
  /** The anonymous/free queue (track snapshots), restored across reloads. */
  freeQueue: SpotifyTrack[];
  freeIndex: number;
}

const STORAGE_KEY = 'padify-music-state';
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];
const PROGRESS_INTERVAL_MS = 250;
const SDK_POLL_INTERVAL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 350;
const PREVIEW_LABEL = '30s preview';
const FREE_LABEL = 'Free';
const FREE_SEARCH_LIMIT = 24;
const PLAYLIST_MENU_ITEMS = 8;

const DEFAULT_STATE: MusicPlayerState = {
  volume: 0.7,
  shuffle: false,
  repeat: 'off',
  view: 'music',
  freeQueue: [],
  freeIndex: -1,
};

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
  queueTab: icon(
    '<path d="M4 6h16M4 12h16"/><circle cx="9" cy="18" r="3"/><path d="M13 18h7"/>',
    16,
  ),
  ambienceTab: icon('<path d="M4 9.5v5M8 6.5v11M12 3.5v17M16 6.5v11M20 9.5v5"/>', 16),
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
    17,
  ),
  heartFilled: icon(
    '<path fill="currentColor" stroke="none" d="M12 20.5c-5.2-3.4-8.5-6.3-8.5-10A4.6 4.6 0 0 1 8 6c1.6 0 3.1.8 4 2.1A4.9 4.9 0 0 1 16 6a4.6 4.6 0 0 1 4.5 4.5c0 3.7-3.3 6.6-8.5 10z"/>',
    17,
  ),
  spark: icon(
    '<path d="M12 3v3M12 18v3M4.2 7.2l2.1 2.1M17.7 14.7l2.1 2.1M3 12h3M18 12h3M4.2 16.8l2.1-2.1M17.7 9.3l2.1-2.1"/>',
    16,
  ),
  plus: icon('<path d="M12 5v14M5 12h14"/>', 16),
  remove: icon('<path d="M18 6 6 18M6 6l12 12"/>', 14),
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

const musicPlayerModalHtml = `
<div class="modal fade mp-modal" id="musicPlayerModal" tabindex="-1" role="dialog" aria-labelledby="musicPlayerTitle">
    <div class="modal-dialog modal-lg" role="document">
        <div class="modal-content">
            <div class="modal-header mp-header">
                <h4 class="modal-title mp-title" id="musicPlayerTitle">
                    ${ICONS.note}
                    <span>Music</span>
                </h4>
                <button type="button" class="mp-status-chip" id="mpAccountChip" title="Spotify" aria-label="Spotify connection status">
                    ${spotifyLogo(14)}
                    <span id="mpAccountChipText">Connect Spotify</span>
                </button>
                <button type="button" class="close" data-dismiss="modal" aria-label="Close">&times;</button>
            </div>

            <div class="modal-body mp-body">
                <div class="mp-playerbar" id="mpPlayerBar">
                    <div class="mp-pb-main">
                        <div class="mp-pb-art-wrap">
                            <span class="mp-pb-placeholder">${ICONS.note}</span>
                            <img class="mp-pb-img" id="mpPbImg" alt="" hidden />
                            ${eqMarkup('mp-pb-eq')}
                        </div>
                        <div class="mp-pb-meta">
                            <div class="mp-pb-title" id="mpPbTitle">Nothing playing</div>
                            <div class="mp-pb-sub" id="mpPbSub">Search a song or connect Spotify</div>
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

                <div class="mp-tabs" role="tablist" aria-label="Music player views">
                    <button type="button" class="mp-tab is-active" id="mpTabMusic" role="tab" aria-selected="true" aria-controls="mpMusicView">
                        ${ICONS.musicTab}<span>Music</span>
                    </button>
                    <button type="button" class="mp-tab" id="mpTabQueue" role="tab" aria-selected="false" aria-controls="mpQueueView" tabindex="-1">
                        ${ICONS.queueTab}<span>Queue</span><span class="mp-tab-count" id="mpQueueCount" hidden></span>
                    </button>
                    <button type="button" class="mp-tab" id="mpTabAmbience" role="tab" aria-selected="false" aria-controls="mpAmbienceView" tabindex="-1">
                        ${ICONS.ambienceTab}<span>Ambience</span>
                    </button>
                </div>

                <div class="mp-view" id="mpMusicView" role="tabpanel" aria-labelledby="mpTabMusic">
                    <div class="mp-search mp-music-search">
                        ${ICONS.search}
                        <input type="search" id="mpSearchInput" class="mp-search-input" placeholder="Search songs, artists, albums…" autocomplete="off" spellcheck="false" aria-label="Search music">
                        <button type="button" class="mp-search-clear" id="mpSearchClear" aria-label="Clear search" hidden>&times;</button>
                    </div>
                    <div class="mp-search-notice" id="mpSearchNotice" role="status" hidden></div>

                    <div class="mp-free-home" id="mpFreeHome">
                        <div class="mp-hero" id="mpHero">
                            <div class="mp-hero-copy">
                                <h3>${ICONS.spark} Free music, no account</h3>
                                <p>Search millions of songs and play them free — no login, no ads. Favorites, your queue and one local playlist live on this device.</p>
                            </div>
                            <button type="button" class="mp-btn mp-btn-primary mp-hero-connect" id="mpHeroConnect">
                                ${spotifyLogo(16)}
                                <span>Connect Spotify</span>
                            </button>
                        </div>
                        <section class="sp-section" id="mpFavoritesSection">
                            <header class="sp-section-head">
                                <h4>${ICONS.heart} Favorites</h4>
                                <span class="mp-section-count" id="mpFavCount"></span>
                            </header>
                            <div class="sp-tracks" id="mpFavoritesList" role="list" aria-label="Favorite tracks"></div>
                            <div class="mp-empty" id="mpFavoritesEmpty">
                                ${ICONS.heart}
                                <p>Tap the heart on any song to keep it here — no account needed.</p>
                            </div>
                        </section>
                        <section class="sp-section" id="mpLocalPlaylistSection">
                            <header class="sp-section-head">
                                <h4>${ICONS.playlist} <span id="mpPlaylistName">My Playlist</span></h4>
                                <span class="mp-section-count" id="mpPlaylistCount"></span>
                                <button type="button" class="sp-more-btn" id="mpPlaylistRename" hidden>Rename</button>
                                <button type="button" class="sp-more-btn" id="mpPlaylistClear" hidden>Remove all</button>
                            </header>
                            <div class="sp-tracks" id="mpLocalPlaylistList" role="list" aria-label="Local playlist tracks"></div>
                            <div class="mp-empty" id="mpLocalPlaylistEmpty">
                                ${ICONS.playlist}
                                <p>Use the + button on any song to start your playlist. You get one — it stays on this device.</p>
                            </div>
                        </section>
                    </div>

                    <div class="sp-connect" id="spConnect" hidden>
                        <div class="sp-connect-card">
                            <button type="button" class="sp-connect-back" id="spConnectBack">${ICONS.back}<span>Continue without an account</span></button>
                            <div class="sp-connect-logo">${spotifyLogo(44)}</div>
                            <h3 class="sp-connect-title">Connect Spotify</h3>
                            <p class="sp-connect-copy">Your Liked Songs, playlists and search across 100M+ tracks — plus likes, queues and playlist adds straight to your Spotify account. Premium streams natively in the app.</p>
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
                            <p class="sp-premium-note">${ICONS.info}<span>Spotify <strong>Premium unlocks native streaming</strong>, device handoff and the full player. Free accounts still play everything through Padify's free streams.</span></p>
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
                            <p class="sp-premium-note sp-free-note" id="spFreeNote" hidden>${ICONS.info}<span>Free account — everything still plays through Padify's ad-free streams. Premium adds native Spotify playback and device handoff.</span></p>
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

                    <div class="mp-results" id="mpResults" hidden>
                        <button type="button" class="sp-back" id="mpResultsBack">${ICONS.back}<span>Back</span></button>
                        <section class="sp-section" id="mpResultsSection">
                            <header class="sp-section-head"><h4>Tracks</h4></header>
                            <div class="sp-tracks" id="mpResultsList" role="list" aria-label="Search results"></div>
                            <div class="sp-empty" id="mpResultsEmpty" hidden><p>Nothing found — try a different search.</p></div>
                        </section>
                    </div>
                </div>

                <div class="mp-view" id="mpQueueView" role="tabpanel" aria-labelledby="mpTabQueue" hidden>
                    <div class="mp-queue-toolbar">
                        <p class="mp-ambience-hint" id="mpQueueHint">Up next on this device</p>
                        <button type="button" class="sp-more-btn" id="mpQueueClear" hidden>Clear queue</button>
                    </div>
                    <div class="sp-tracks" id="mpQueueList" role="list" aria-label="Play queue"></div>
                    <div class="mp-empty" id="mpQueueEmpty">
                        ${ICONS.queueTab}
                        <p>Nothing queued. Play a song or use the + button to line one up.</p>
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

                <div class="mp-row-menu" id="mpRowMenu" hidden></div>
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

/**
 * Mounts the music player + mini player modal markup. Called by boot.ts
 * before initMusicPlayer(); used to run at module evaluation.
 */
export function mountMusicPlayer(): void {
  $(document.body).append(musicPlayerModalHtml + miniPlayerHtml);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Music player markup missing #${id}`);
  return el as T;
}

function formatTime(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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

  // ---- free engine (no login): <audio> + resolved stream URLs ----
  private freeAudio: HTMLAudioElement | null = null;
  private freeMode: 'resolve' | 'preview' = 'resolve';
  /** Guards against a stale resolve overwriting a newer track. */
  private freeResolveToken = 0;
  private retriedCurrentTrack = false;

  // ---- local (on-device) library ----
  private library = new LocalMusicLibrary();

  // ---- capabilities of this deployment's API ----
  private caps: MusicCapabilities = { search: false, resolve: false };
  private capsChecked = false;

  // ---- spotify ----
  private sdk = new SpotifySdkController();
  private profile: SpotifyProfile | null = null;
  private spotifyMode: SpotifyMode = 'resolve';
  private sdkState: WebPlaybackPlayerState | null = null;
  private sdkStateAt = 0;
  private likedOffset = 0;
  private likedTotal = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDeviceId: string | null = null; // non-null = other device
  private detailContextUri: string | null = null;
  private detailQueue: SpotifyTrack[] = [];
  private spotifyBusy = false;
  private playlistsCache: SpotifyPlaylist[] = [];
  /** Session cache of "is this track saved in the user's Spotify library". */
  private savedIds = new Set<string>();
  private savedIdsPending = new Set<string>();

  // ---- rendered lists (queueId → tracks) ----
  private queues = new Map<string, SpotifyTrack[]>();

  // ---- DOM refs ----
  private readonly root: HTMLElement;
  private readonly playerBar: HTMLElement;
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

  private readonly tabMusic: HTMLButtonElement;
  private readonly tabQueue: HTMLButtonElement;
  private readonly tabAmbience: HTMLButtonElement;
  private readonly musicView: HTMLElement;
  private readonly queueView: HTMLElement;
  private readonly ambienceView: HTMLElement;
  private readonly queueCount: HTMLElement;
  private readonly queueList: HTMLElement;
  private readonly queueEmpty: HTMLElement;
  private readonly queueHint: HTMLElement;
  private readonly queueClear: HTMLButtonElement;

  private readonly searchInput: HTMLInputElement;
  private readonly searchNotice: HTMLElement;

  private readonly freeHome: HTMLElement;
  private readonly hero: HTMLElement;
  private readonly heroConnect: HTMLButtonElement;
  private readonly favoritesList: HTMLElement;
  private readonly favoritesEmpty: HTMLElement;
  private readonly favCount: HTMLElement;
  private readonly localPlaylistList: HTMLElement;
  private readonly localPlaylistEmpty: HTMLElement;
  private readonly playlistName: HTMLElement;
  private readonly playlistCount: HTMLElement;
  private readonly playlistRename: HTMLButtonElement;
  private readonly playlistClear: HTMLButtonElement;

  private readonly resultsView: HTMLElement;
  private readonly resultsList: HTMLElement;
  private readonly resultsEmpty: HTMLElement;

  private readonly accountChip: HTMLButtonElement;
  private readonly accountChipText: HTMLElement;
  private readonly connectView: HTMLElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly connectBack: HTMLButtonElement;
  private readonly connectError: HTMLElement;
  private readonly clientIdInput: HTMLInputElement;
  private readonly appView: HTMLElement;
  private readonly avatar: HTMLImageElement;
  private readonly spNameEl: HTMLElement;
  private readonly spProductEl: HTMLElement;
  private readonly skeleton: HTMLElement;
  private readonly libraryView: HTMLElement;
  private readonly likedList: HTMLElement;
  private readonly likedEmpty: HTMLElement;
  private readonly likedMore: HTMLButtonElement;
  private readonly topList: HTMLElement;
  private readonly playlistsRow: HTMLElement;
  private readonly playlistsEmpty: HTMLElement;
  private readonly freeNote: HTMLElement;
  private readonly spResultsView: HTMLElement;
  private readonly spDetailView: HTMLElement;

  private readonly rowMenu: HTMLElement;

  private readonly mini: HTMLElement;
  private readonly miniImg: HTMLImageElement;
  private readonly miniTitle: HTMLElement;
  private readonly miniSub: HTMLElement;
  private readonly miniPlay: HTMLButtonElement;

  constructor() {
    this.state = this.loadState();

    this.root = byId('musicPlayerModal');
    this.playerBar = byId('mpPlayerBar');
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

    this.tabMusic = byId('mpTabMusic');
    this.tabQueue = byId('mpTabQueue');
    this.tabAmbience = byId('mpTabAmbience');
    this.musicView = byId('mpMusicView');
    this.queueView = byId('mpQueueView');
    this.ambienceView = byId('mpAmbienceView');
    this.queueCount = byId('mpQueueCount');
    this.queueList = byId('mpQueueList');
    this.queueEmpty = byId('mpQueueEmpty');
    this.queueHint = byId('mpQueueHint');
    this.queueClear = byId('mpQueueClear');

    this.searchInput = byId('mpSearchInput');
    this.searchNotice = byId('mpSearchNotice');

    this.freeHome = byId('mpFreeHome');
    this.hero = byId('mpHero');
    this.heroConnect = byId('mpHeroConnect');
    this.favoritesList = byId('mpFavoritesList');
    this.favoritesEmpty = byId('mpFavoritesEmpty');
    this.favCount = byId('mpFavCount');
    this.localPlaylistList = byId('mpLocalPlaylistList');
    this.localPlaylistEmpty = byId('mpLocalPlaylistEmpty');
    this.playlistName = byId('mpPlaylistName');
    this.playlistCount = byId('mpPlaylistCount');
    this.playlistRename = byId('mpPlaylistRename');
    this.playlistClear = byId('mpPlaylistClear');

    this.resultsView = byId('mpResults');
    this.resultsList = byId('mpResultsList');
    this.resultsEmpty = byId('mpResultsEmpty');

    this.accountChip = byId('mpAccountChip');
    this.accountChipText = byId('mpAccountChipText');
    this.connectView = byId('spConnect');
    this.connectBtn = byId('spConnectBtn');
    this.connectBack = byId('spConnectBack');
    this.connectError = byId('spConnectError');
    this.clientIdInput = byId('spClientIdInput');
    this.appView = byId('spApp');
    this.avatar = byId('spAvatar');
    this.spNameEl = byId('spName');
    this.spProductEl = byId('spProduct');
    this.skeleton = byId('spSkeleton');
    this.libraryView = byId('spLibrary');
    this.likedList = byId('spLikedList');
    this.likedEmpty = byId('spLikedEmpty');
    this.likedMore = byId('spLikedMore');
    this.topList = byId('spTopList');
    this.playlistsRow = byId('spPlaylistsRow');
    this.playlistsEmpty = byId('spPlaylistsEmpty');
    this.freeNote = byId('spFreeNote');
    this.spResultsView = byId('spResults');
    this.spDetailView = byId('spDetail');

    this.rowMenu = byId('mpRowMenu');

    this.mini = byId('mpMiniPlayer');
    this.miniImg = byId('mpMiniImg');
    this.miniTitle = byId('mpMiniTitle');
    this.miniSub = byId('mpMiniSub');
    this.miniPlay = byId('mpMiniPlay');

    // Restore persisted UI state.
    this.volumeInput.value = String(Math.round(this.state.volume * 100));
    this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
    this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
    this.applyRepeatVisuals();
    this.updateVolumeIcon();

    this.bindEvents();
    this.setupMediaSession();
    this.watchNavbarIcon();
    this.switchView(this.state.view || 'music');

    // Initial slider fills.
    this.setRangeFill(this.seek);
    this.setRangeFill(this.volumeInput);
    this.root.querySelectorAll<HTMLInputElement>('.volume-slider').forEach((slider) => {
      this.setRangeFill(slider);
    });

    this.renderFreeHome();
    this.restoreFreeQueue();
    this.bootstrap();
  }

  // ---- persistence ---------------------------------------------------------

  private loadState(): MusicPlayerState {
    try {
      const raw = stateGet(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw) as Partial<MusicPlayerState>;
      const freeQueue = Array.isArray(parsed.freeQueue)
        ? parsed.freeQueue
            .filter(
              (track): track is SpotifyTrack =>
                Boolean(track) && typeof track.id === 'string' && typeof track.name === 'string',
            )
            .slice(0, 200)
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
        view: ['music', 'queue', 'ambience'].includes(parsed.view as ViewId)
          ? (parsed.view as ViewId)
          : DEFAULT_STATE.view,
        freeQueue,
        freeIndex:
          typeof parsed.freeIndex === 'number'
            ? Math.min(Math.max(-1, Math.round(parsed.freeIndex)), freeQueue.length - 1)
            : -1,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private persist(): void {
    try {
      stateSet(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable — playback still works, just not restored */
    }
  }

  // ========================================================================
  // Free engine — HTML5 <audio> fed by resolved stream URLs (no login)
  // ========================================================================

  private currentFreeTrack(): SpotifyTrack | null {
    return this.state.freeQueue[this.state.freeIndex] ?? null;
  }

  private ensureFreeAudio(): HTMLAudioElement {
    if (this.freeAudio) return this.freeAudio;
    const audio = new Audio();
    audio.preload = 'none';
    audio.volume = this.state.volume;
    audio.addEventListener('timeupdate', () => {
      if (this.source === 'free') this.updateProgress();
    });
    audio.addEventListener('loadedmetadata', () => {
      if (this.source === 'free') {
        const total = this.currentDurationMs();
        this.timeTotal.textContent = formatMs(total);
        this.seek.setAttribute('aria-valuetext', formatMs(this.currentPositionMs()));
      }
    });
    audio.addEventListener('play', () => this.handleFreePlaybackState(true));
    audio.addEventListener('playing', () => this.handleFreePlaybackState(true));
    audio.addEventListener('pause', () => this.handleFreePlaybackState(false));
    audio.addEventListener('ended', () => this.handleFreeEnded());
    audio.addEventListener('error', () => this.handleFreeAudioError());
    this.freeAudio = audio;
    return audio;
  }

  /** Reflects <audio> play/pause in the bar, rows, mini player and navbar. */
  private handleFreePlaybackState(playing: boolean): void {
    const isFreeEngine =
      this.source === 'free' || (this.source === 'spotify' && this.spotifyMode === 'preview');
    if (!isFreeEngine) return;
    if (playing && this.source === 'free') {
      const track = this.currentFreeTrack();
      if (track && this.pbSub.textContent === 'Finding a stream…') {
        this.pbSub.textContent = trackArtistNames(track);
      }
    }
    this.playerBar.classList.toggle('is-playing', playing);
    this.updatePlayIcon();
    this.updateMini();
    this.updateRowStates();
    this.syncNavbarIcon();
    if (playing) this.startProgressTimer();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      } catch {
        /* playbackState unsupported — non-fatal */
      }
    }
  }

  /** Starts playing the queue at `index` through the free engine. */
  private async playFreeAt(index: number, auto = false): Promise<void> {
    const queue = this.state.freeQueue;
    if (queue.length === 0) return;
    let idx = index;
    if (idx >= queue.length) {
      if (this.state.repeat === 'all') idx = 0;
      else return;
    }
    if (idx < 0) idx = queue.length - 1;

    if (this.state.shuffle && queue.length > 1 && !auto) {
      let randomIdx = idx;
      while (randomIdx === idx) randomIdx = Math.floor(Math.random() * queue.length);
      idx = randomIdx;
    }

    const track = queue[idx];
    if (!track) return;
    this.state.freeIndex = idx;
    this.persist();

    this.stopSpotifyPlayback();
    this.miniDismissed = false;
    this.source = 'free';
    this.spotifyMode = 'resolve';
    this.retriedCurrentTrack = false;
    this.freeMode = 'resolve';
    const token = ++this.freeResolveToken;

    this.syncPlayerBarFree(track, false, 'resolve', 'Finding a stream…');
    this.updateRowStates();
    this.updateQueueView();
    this.syncNavbarIcon();
    this.startProgressTimer();

    if (!this.capsChecked) await this.checkCapabilities();

    if (!this.caps.resolve) {
      this.tryPreviewFallback(track, token, 'Free playback is not available on this deployment.');
      return;
    }

    try {
      const stream = await resolveTrackStream(this.freeResolveInput(track));
      if (token !== this.freeResolveToken) return; // a newer track took over
      const audio = this.ensureFreeAudio();
      this.pbSub.textContent = trackArtistNames(track);
      audio.src = stream.url;
      await audio.play().catch(() => {
        showToast('Tap play to start the audio.');
      });
    } catch (err) {
      if (token !== this.freeResolveToken) return;
      this.handleResolveFailure(track, token, err);
    }
  }

  private freeResolveInput(track: SpotifyTrack): {
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
    if (this.retriedCurrentTrack) {
      this.tryPreviewFallback(track, token, this.describeFreeError(err));
      return;
    }
    // One retry with a fresh (cache-busting) resolution before giving up.
    this.retriedCurrentTrack = true;
    this.pbSub.textContent = 'Retrying…';
    resolveTrackStream(this.freeResolveInput(track), true)
      .then((stream) => {
        if (token !== this.freeResolveToken) return;
        const audio = this.ensureFreeAudio();
        audio.src = stream.url;
        void audio.play().catch(() => undefined);
      })
      .catch((retryErr: unknown) => {
        if (token !== this.freeResolveToken) return;
        this.tryPreviewFallback(track, token, this.describeFreeError(retryErr));
      });
  }

  /** Last resort: the public 30-second preview, when one exists. */
  private tryPreviewFallback(track: SpotifyTrack, token: number, message: string): void {
    if (track.preview_url) {
      showToast(`${message} Playing a 30-second preview instead.`);
      this.freeMode = 'preview';
      this.syncPlayerBarFree(track, false, 'preview');
      const audio = this.ensureFreeAudio();
      audio.src = track.preview_url;
      void audio.play().catch(() => undefined);
      return;
    }
    showToast(message);
    this.updatePlayerBarEmpty();
    this.updateRowStates();
    this.updateQueueView();
  }

  private describeFreeError(err: unknown): string {
    if (err instanceof FreeMusicError) return err.message;
    if (err instanceof Error && err.message) return err.message;
    return 'Could not play this song.';
  }

  private handleFreeAudioError(): void {
    if (this.source !== 'free') return;
    const track = this.currentFreeTrack();
    if (!track) return;
    const token = this.freeResolveToken;
    // The audio element failed on a URL we handed it — re-resolve (fresh)
    // or fall back to the preview.
    this.handleResolveFailure(track, token, new Error('That stream expired — refreshing.'));
  }

  private handleFreeEnded(): void {
    if (this.source !== 'free') return;
    if (this.state.repeat === 'one') {
      void this.playFreeAt(this.state.freeIndex, true);
      return;
    }
    const nextIdx = this.state.freeIndex + 1;
    if (nextIdx < this.state.freeQueue.length || this.state.repeat === 'all') {
      void this.playFreeAt(nextIdx, true);
    } else {
      this.updatePlayerBarEmpty();
      this.updateRowStates();
      this.updateQueueView();
    }
  }

  private freeNext(auto = false): void {
    const queue = this.state.freeQueue;
    if (queue.length === 0) return;
    const idx = this.state.freeIndex;
    if (this.state.shuffle) {
      if (queue.length <= 1) return;
      let randomIdx = idx;
      while (randomIdx === idx) randomIdx = Math.floor(Math.random() * queue.length);
      void this.playFreeAt(randomIdx);
      return;
    }
    let nextIdx = idx + 1;
    if (nextIdx >= queue.length) {
      if (auto && this.state.repeat === 'off') {
        this.updatePlayerBarEmpty();
        return;
      }
      nextIdx = 0;
    }
    void this.playFreeAt(nextIdx);
  }

  private freePrev(): void {
    const audio = this.freeAudio;
    const track = this.currentFreeTrack();
    if (
      audio &&
      track &&
      audio.src &&
      !audio.paused &&
      audio.currentTime > 3 &&
      this.freeResolveToken > 0
    ) {
      audio.currentTime = 0;
      return;
    }
    const queue = this.state.freeQueue;
    if (queue.length === 0) return;
    let prevIdx = this.state.freeIndex - 1;
    if (prevIdx < 0) prevIdx = queue.length - 1;
    void this.playFreeAt(prevIdx);
  }

  /** Appends a track to the free queue (the "+ button"). */
  private enqueueFree(track: SpotifyTrack): void {
    const queue = this.state.freeQueue;
    if (this.source === 'free' || queue.length > 0) {
      queue.push(track);
      this.state.freeIndex = Math.min(this.state.freeIndex, queue.length - 1);
      this.persist();
      this.updateQueueView();
      showToast('Added to queue.');
      return;
    }
    // Nothing playing yet — this becomes the track up next (and now).
    this.state.freeQueue = [track];
    this.state.freeIndex = 0;
    this.persist();
    void this.playFreeAt(0);
  }

  /** Restores the persisted free queue display (paused) after a reload. */
  private restoreFreeQueue(): void {
    const track = this.currentFreeTrack();
    if (!track) return;
    this.source = 'free';
    this.freeMode = 'resolve';
    this.syncPlayerBarFree(track, false, 'resolve');
  }

  // ========================================================================
  // Player bar (all sources)
  // ========================================================================

  private isPlaying(): boolean {
    if (this.source === 'free') {
      return this.freeAudio !== null && !this.freeAudio.paused;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        return this.freeAudio !== null && !this.freeAudio.paused;
      }
      if (this.activeDeviceId) return this.sdkRestPlaying;
      return this.sdkState ? !this.sdkState.paused : false;
    }
    return false;
  }

  private currentDurationMs(): number {
    if (this.source === 'free') {
      if (this.freeMode === 'preview') return 30_000;
      const audio = this.freeAudio;
      if (audio && audio.src && Number.isFinite(audio.duration) && audio.duration > 0) {
        return audio.duration * 1000;
      }
      const track = this.currentFreeTrack();
      return track ? track.duration_ms : 0;
    }
    if (this.source === 'spotify') {
      return this.sdkState?.duration ?? this.sdkRestTrack?.duration_ms ?? 0;
    }
    return 0;
  }

  private currentPositionMs(): number {
    if (this.source === 'free') {
      const audio = this.freeAudio;
      if (audio && audio.src) return audio.currentTime * 1000;
      return 0;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        const audio = this.freeAudio;
        return audio ? audio.currentTime * 1000 : 0;
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

  private syncPlayerBarFree(
    track: SpotifyTrack,
    playing: boolean,
    mode: 'resolve' | 'preview',
    loadingText?: string,
  ): void {
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
    this.pbSub.textContent = loadingText ?? trackArtistNames(track);
    this.pbSource.hidden = false;
    this.pbSource.textContent = mode === 'preview' ? PREVIEW_LABEL : FREE_LABEL;
    this.timeTotal.textContent = formatMs(mode === 'preview' ? 30_000 : track.duration_ms || 0);
    this.playerBar.classList.toggle('is-playing', playing);
    this.updatePlayIcon();
    this.updateProgress();
    this.updateMediaSessionTrack(track);
    this.deviceWrap.hidden = true;
    this.updateMini();
  }

  private syncPlayerBarSpotify(
    track: SpotifyTrack,
    sub: string,
    playing: boolean,
    mode: SpotifyMode,
  ): void {
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
    this.updateMediaSessionTrack(track);
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
    this.pbSub.textContent = 'Search a song or connect Spotify';
    this.pbSource.hidden = true;
    this.pbImg.hidden = true;
    this.pbPlaceholder.hidden = false;
    this.timeCurrent.textContent = '0:00';
    this.timeTotal.textContent = '0:00';
    this.seek.value = '0';
    this.setRangeFill(this.seek);
    this.playerBar.classList.remove('is-playing');
    this.updatePlayIcon();
    this.deviceWrap.hidden = true;
    this.stopProgressTimer();
    this.updateMini();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        /* unsupported — non-fatal */
      }
    }
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
    if (this.source === 'free') {
      const audio = this.freeAudio ?? this.ensureFreeAudio();
      if (!audio.src) {
        const track = this.currentFreeTrack();
        if (track) void this.playFreeAt(Math.max(0, this.state.freeIndex));
        return;
      }
      if (audio.paused) void audio.play().catch(() => undefined);
      else audio.pause();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview' && this.freeAudio) {
        if (this.freeAudio.paused) void this.freeAudio.play().catch(() => undefined);
        else this.freeAudio.pause();
        return;
      }
      if (this.spotifyMode === 'sdk') {
        if (this.activeDeviceId) {
          // Playback lives on another device — control it via REST.
          if (this.isPlaying()) {
            void spotify.pausePlayback(this.activeDeviceId).catch(() => this.toastSpotifyError());
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
    if (this.source === 'free') {
      this.freeNext();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        this.freeNext();
        return;
      }
      if (this.spotifyMode === 'sdk') {
        void this.skipSdk('next');
      }
    }
  }

  prev(): void {
    if (this.source === 'free') {
      this.freePrev();
      return;
    }
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        this.freePrev();
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
    if (this.freeAudio) this.freeAudio.volume = vol;
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
    if (this.source === 'free') {
      const audio = this.freeAudio;
      if (audio && audio.src) {
        const max = this.freeMode === 'preview' ? 29.5 : Number.MAX_SAFE_INTEGER;
        audio.currentTime = Math.min(posMs / 1000, max);
      }
    } else if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview' && this.freeAudio) {
        this.freeAudio.currentTime = Math.min(posMs / 1000, 29.5);
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
  // Spotify: SDK playback (Premium)
  // ========================================================================

  private stopSpotifyPlayback(): void {
    if (this.freeAudio && !this.freeAudio.paused) this.freeAudio.pause();
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
          this.handleNonPremiumAccount();
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
    this.updateRowStates();
    this.updateQueueView();
    this.startProgressTimer();
    this.syncNavbarIcon();
  }

  /** Premium-only SDK hit a wall — stay connected, play via the free engine. */
  private handleNonPremiumAccount(): void {
    if (this.profile && this.profile.product !== 'free') {
      this.profile = { ...this.profile, product: 'free' };
    }
    this.freeNote.hidden = false;
    this.deviceWrap.hidden = true;
  }

  /**
   * Plays a list of Spotify tracks starting at `index`.
   * Premium → Web Playback SDK; everyone else → the free engine.
   */
  private async playTrackList(
    tracks: SpotifyTrack[],
    index: number,
    contextUri?: string | null,
  ): Promise<void> {
    if (tracks.length === 0) return;
    const startIndex = Math.max(0, Math.min(index, tracks.length - 1));
    const isPremium = this.profile?.product === 'premium';

    if (!isPremium) {
      this.state.freeQueue = [...tracks];
      await this.playFreeAt(startIndex);
      return;
    }

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
      this.updateRowStates();
    } catch {
      // SDK unavailable (blocked iframe, network…) — fall back to free engine.
      showToast('Native Spotify playback is unavailable — playing the free stream instead.');
      this.state.freeQueue = [...tracks];
      await this.playFreeAt(startIndex);
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
  // Bootstrap / auth state
  // ========================================================================

  private async bootstrap(): Promise<void> {
    const returning = consumedReturnFlag();
    const result = await completeLogin();
    if (result && !result.ok && result.error) {
      this.showConnectError(result.error);
    }

    if (isAuthenticated()) {
      await this.loadSpotifyProfile();
      if (returning && result?.ok) {
        this.switchView('music');
        $('#musicPlayerModal').modal('show');
        showToast('Spotify connected.');
      }
    } else {
      this.renderAnonymousState();
      void this.checkCapabilities();
    }
  }

  private async checkCapabilities(): Promise<void> {
    this.caps = await fetchMusicCapabilities();
    this.capsChecked = true;
    if (!isAuthenticated() && !this.caps.search) {
      this.showSearchNotice(
        'Free search needs the Padify music API — it looks offline here. Connect Spotify to browse your library instead.',
      );
    }
    if (!this.caps.resolve) {
      this.hero.classList.add('is-degraded');
    }
  }

  private showSearchNotice(message: string): void {
    this.searchNotice.textContent = message;
    this.searchNotice.hidden = false;
  }

  private clearSearchNotice(): void {
    this.searchNotice.hidden = true;
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
            this.handleNonPremiumAccount();
          });
      } else {
        this.freeNote.hidden = false;
      }
    } catch (err) {
      if (err instanceof SpotifyAuthError) {
        this.showConnectError(err.message);
        this.renderAnonymousState();
      } else {
        this.toastSpotifyError(err);
      }
    } finally {
      this.spotifyBusy = false;
    }
  }

  private renderAnonymousState(): void {
    this.accountChipText.textContent = 'Connect Spotify';
    this.accountChip.classList.remove('is-connected');
    this.showMusicSubView(this.searchInput.value.trim().length >= 2 ? 'results-anon' : 'home');
    this.renderFreeHome();
  }

  private renderConnectedState(): void {
    if (!this.profile) return;
    this.clearSearchNotice();
    this.showMusicSubView('app');
    this.accountChipText.textContent = this.profile.display_name ?? 'Spotify';
    this.accountChip.classList.add('is-connected');

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

  // ========================================================================
  // Free home (anonymous) — favorites + the one local playlist
  // ========================================================================

  private renderFreeHome(): void {
    if (isAuthenticated()) return;
    const favorites = this.library.favorites;
    const playlist = this.library.playlist;

    this.queues.set('favorites', favorites);
    this.favoritesList.innerHTML = favorites
      .map((track) => this.trackRowMarkup(track, 'favorites'))
      .join('');
    this.favoritesEmpty.hidden = favorites.length > 0;
    this.favCount.textContent = favorites.length > 0 ? `${favorites.length} songs` : '';

    if (playlist) {
      this.queues.set('local-playlist', playlist.tracks);
      this.playlistName.textContent = playlist.name;
      this.localPlaylistList.innerHTML = playlist.tracks
        .map((track) => this.trackRowMarkup(track, 'local-playlist'))
        .join('');
      this.localPlaylistEmpty.hidden = playlist.tracks.length > 0;
      this.playlistCount.textContent =
        playlist.tracks.length > 0 ? `${playlist.tracks.length} songs` : '';
      this.playlistRename.hidden = false;
      this.playlistClear.hidden = playlist.tracks.length === 0;
    } else {
      this.queues.delete('local-playlist');
      this.playlistName.textContent = 'My Playlist';
      this.localPlaylistList.innerHTML = '';
      this.localPlaylistEmpty.hidden = false;
      this.playlistCount.textContent = '';
      this.playlistRename.hidden = true;
      this.playlistClear.hidden = true;
    }
    this.refreshRowHearts(this.favoritesList);
    this.refreshRowHearts(this.localPlaylistList);
    this.updateRowStates();
    this.updateQueueCount();
  }

  private async renameLocalPlaylist(): Promise<void> {
    const playlist = this.library.playlist;
    if (!playlist) return;
    const result = (await Swal.fire({
      title: 'Rename playlist',
      input: 'text',
      inputValue: playlist.name,
      showCancelButton: true,
      confirmButtonText: 'Rename',
      confirmButtonColor: 'var(--vz-primary, #0070f3)',
      inputValidator: (value: string) => (value.trim() ? null : 'Enter a name.'),
    })) as SweetAlertResult<string>;
    if (result.isConfirmed && typeof result.value === 'string') {
      this.library.renamePlaylist(result.value);
      this.renderFreeHome();
    }
  }

  // ========================================================================
  // Spotify library (connected)
  // ========================================================================

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

      const likedTracks = (liked?.items ?? [])
        .map((item) => item.track)
        .filter((t): t is SpotifyTrack => t !== null);
      for (const track of likedTracks) this.savedIds.add(track.id);
      this.renderTrackRows(this.likedList, likedTracks, 'liked');
      this.likedEmpty.hidden = likedTracks.length > 0;
      this.likedMore.hidden = liked ? this.likedOffset >= (liked.total ?? 0) : true;

      this.renderTrackRows(this.topList, top?.items ?? [], 'top');

      const playlistItems = playlists?.items ?? [];
      this.playlistsCache = playlistItems;
      this.playlistsRow.innerHTML = playlistItems
        .map((playlist) => this.playlistCardMarkup(playlist))
        .join('');
      this.playlistsEmpty.hidden = playlistItems.length > 0;

      this.libraryView.hidden = false;
      this.refreshRowHearts(this.topList);
      this.updateRowStates();
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

  // ========================================================================
  // Track rows (one component for every list, free or connected)
  // ========================================================================

  private trackRowMarkup(track: SpotifyTrack, queueId: string): string {
    const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
    const artists = escapeHtml(trackArtistNames(track));
    const name = escapeHtml(track.name);
    return `
        <div class="sp-row" role="listitem" data-queue-id="${queueId}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.note}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${track.explicit ? ' · E' : ''}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
            <button type="button" class="sp-row-like" data-like aria-pressed="false" title="Favorite" aria-label="Save ${name} to favorites">${ICONS.heart}</button>
            <button type="button" class="sp-row-menu" data-menu aria-haspopup="true" aria-expanded="false" title="More options" aria-label="More options for ${name}">${ICONS.plus}</button>
        </div>`;
  }

  /** Queue rows: same shell + a remove button instead of the menu. */
  private queueRowMarkup(track: SpotifyTrack, index: number): string {
    const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
    const artists = escapeHtml(trackArtistNames(track));
    const name = escapeHtml(track.name);
    return `
        <div class="sp-row" role="listitem" data-queue-index="${index}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.note}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${track.explicit ? ' · E' : ''}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
            <button type="button" class="sp-row-like" data-like aria-pressed="false" title="Favorite" aria-label="Save ${name} to favorites">${ICONS.heart}</button>
            <button type="button" class="sp-row-remove" data-remove title="Remove from queue" aria-label="Remove ${name} from queue">${ICONS.remove}</button>
        </div>`;
  }

  private renderTrackRows(
    container: HTMLElement,
    tracks: SpotifyTrack[],
    queueId = `q-${Math.random().toString(36).slice(2, 8)}`,
  ): void {
    const withArt: SpotifyTrack[] = tracks.filter((t) => t && t.uri);
    this.queues.set(queueId, withArt);
    container.dataset.queueId = queueId;
    container.innerHTML = withArt.map((track) => this.trackRowMarkup(track, queueId)).join('');
    this.updateRowStates();
    this.refreshRowHearts(container);
  }

  private updateRowStates(): void {
    const currentUri = this.currentTrackUri();
    const playing = this.isPlaying();
    this.root.querySelectorAll<HTMLElement>('.sp-row').forEach((row) => {
      const uri = row.dataset.trackUri;
      const isCurrent = uri === currentUri;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && playing);
    });
  }

  private currentTrackUri(): string | null {
    if (this.source === 'free') return this.currentFreeTrack()?.uri ?? null;
    if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') return this.currentFreeTrack()?.uri ?? null;
      return this.sdkState?.track_window.current_track?.uri ?? this.sdkRestTrack?.uri ?? null;
    }
    return null;
  }

  // ---- hearts (local favorites vs Spotify likes) ----------------------------

  /**
   * Fills the heart buttons in a freshly rendered list. Anonymous → local
   * library; connected → one batched /me/tracks/contains call (session
   * cached) for ids we don't know yet.
   */
  private refreshRowHearts(container: HTMLElement): void {
    if (!isAuthenticated()) {
      container.querySelectorAll<HTMLElement>('.sp-row[data-like]').forEach((row) => {
        this.setRowHeart(row, this.library.isFavorite(row.dataset.trackId ?? ''));
      });
      return;
    }
    const queueId = container.dataset.queueId;
    if (queueId === 'liked') {
      // Liked Songs rows are saved by definition.
      container.querySelectorAll<HTMLElement>('.sp-row[data-like]').forEach((row) => {
        this.setRowHeart(row, true);
      });
      return;
    }
    const unknown: string[] = [];
    container.querySelectorAll<HTMLElement>('.sp-row[data-like]').forEach((row) => {
      const id = row.dataset.trackId ?? '';
      if (this.savedIds.has(id)) {
        this.setRowHeart(row, true);
      } else if (!this.savedIdsPending.has(id)) {
        unknown.push(id);
      }
    });
    if (unknown.length === 0) return;
    unknown.forEach((id) => this.savedIdsPending.add(id));
    spotify
      .checkSavedTracks(unknown.slice(0, 50))
      .then((states) => {
        unknown.forEach((id, i) => {
          if (states[i]) this.savedIds.add(id);
          this.savedIdsPending.delete(id);
        });
        container.querySelectorAll<HTMLElement>('.sp-row[data-like]').forEach((row) => {
          this.setRowHeart(row, this.savedIds.has(row.dataset.trackId ?? ''));
        });
      })
      .catch(() => {
        unknown.forEach((id) => this.savedIdsPending.delete(id));
      });
  }

  private setRowHeart(row: HTMLElement, filled: boolean): void {
    const like = row.querySelector<HTMLElement>('[data-like]');
    if (!like) return;
    like.classList.toggle('is-fav', filled);
    like.setAttribute('aria-pressed', String(filled));
    like.innerHTML = filled ? ICONS.heartFilled : ICONS.heart;
  }

  private async toggleRowLike(row: HTMLElement): Promise<void> {
    const trackId = row.dataset.trackId ?? '';
    const track = this.trackFromRow(row);
    if (!track) return;

    if (!isAuthenticated()) {
      const nowFav = this.library.toggleFavorite(track);
      this.setRowHeart(row, nowFav);
      this.renderFreeHome();
      return;
    }

    const wasSaved = this.savedIds.has(trackId);
    try {
      if (wasSaved) {
        await spotify.removeSavedTracks([trackId]);
        this.savedIds.delete(trackId);
      } else {
        await spotify.saveTracks([trackId]);
        this.savedIds.add(trackId);
      }
      this.setRowHeart(row, !wasSaved);
      // Liked Songs list keeps only actually-saved tracks.
      if (wasSaved && row.closest('#spLikedList')) {
        row.remove();
        this.likedTotal = Math.max(0, this.likedTotal - 1);
        if (this.likedList.children.length === 0) this.likedEmpty.hidden = false;
      }
    } catch (err) {
      this.toastSpotifyError(err);
    }
  }

  private trackFromRow(row: HTMLElement): SpotifyTrack | null {
    const trackId = row.dataset.trackId ?? '';
    const queue = this.queues.get(row.dataset.queueId ?? '');
    return (
      queue?.find((track) => track.id === trackId) ??
      this.state.freeQueue.find((track) => track.id === trackId) ??
      this.library.favorites.find((track) => track.id === trackId) ??
      this.library.playlist?.tracks.find((track) => track.id === trackId) ??
      null
    );
  }

  // ---- the row action menu (+ queue, + playlist) -----------------------------

  private openRowMenu(row: HTMLElement, button: HTMLElement): void {
    const track = this.trackFromRow(row);
    if (!track) return;
    this.closeRowMenu();

    const connected = isAuthenticated();
    const items: string[] = [];
    items.push(
      `<button type="button" class="mp-row-menu-item" data-action="queue">${ICONS.queueTab}<span>Add to queue</span></button>`,
    );
    if (!connected) {
      items.push(
        `<button type="button" class="mp-row-menu-item" data-action="local-playlist">${ICONS.playlist}<span>${
          this.library.playlist
            ? `Add to ${escapeHtml(this.library.playlist.name)}`
            : 'Start your playlist'
        }</span></button>`,
      );
    } else {
      const playlists = this.playlistsCache.slice(0, PLAYLIST_MENU_ITEMS);
      if (playlists.length > 0) {
        items.push('<div class="mp-row-menu-divider"></div>');
        for (const playlist of playlists) {
          items.push(
            `<button type="button" class="mp-row-menu-item" data-action="spotify-playlist" data-playlist-id="${playlist.id}" title="${escapeHtml(playlist.name)}">${ICONS.playlist}<span>${escapeHtml(playlist.name)}</span></button>`,
          );
        }
      }
    }

    this.rowMenu.innerHTML = items.join('');
    row.appendChild(this.rowMenu);
    this.rowMenu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    this.rowMenuOpener = button;
    this.rowMenu.querySelector<HTMLElement>('.mp-row-menu-item')?.focus();
  }

  private rowMenuOpener: HTMLElement | null = null;

  private closeRowMenu(): void {
    if (this.rowMenu.hidden) return;
    this.rowMenu.hidden = true;
    this.rowMenu.remove();
    this.rowMenu.innerHTML = '';
    if (this.rowMenuOpener) {
      this.rowMenuOpener.setAttribute('aria-expanded', 'false');
      this.rowMenuOpener = null;
    }
  }

  private async handleRowMenuAction(
    action: string,
    playlistId: string | null,
    row: HTMLElement,
  ): Promise<void> {
    const track = this.trackFromRow(row);
    if (!track) return;

    if (action === 'queue') {
      if (
        isAuthenticated() &&
        this.profile?.product === 'premium' &&
        this.source === 'spotify' &&
        this.spotifyMode === 'sdk'
      ) {
        try {
          await spotify.addToQueue(track.uri, this.activeDeviceId ?? undefined);
          showToast('Added to your Spotify queue.');
        } catch (err) {
          this.toastSpotifyError(err);
        }
      } else {
        this.enqueueFree(track);
      }
      return;
    }

    if (action === 'local-playlist') {
      const result = this.library.addToPlaylist(track);
      if (result === 'duplicate') showToast('Already in your playlist.');
      else if (result === 'full') showToast('Your playlist is full (300 songs).');
      else if (result === 'created') showToast('Playlist started — rename it any time.');
      else showToast('Added to your playlist.');
      this.renderFreeHome();
      return;
    }

    if (action === 'spotify-playlist' && playlistId) {
      const playlist = this.playlistsCache.find((p) => p.id === playlistId);
      try {
        await spotify.addTracksToPlaylist(playlistId, [track.uri]);
        showToast(`Added to ${playlist?.name ?? 'playlist'}.`);
      } catch (err) {
        this.toastSpotifyError(err);
      }
    }
  }

  // ========================================================================
  // Search (one box; anonymous free search vs connected Spotify search)
  // ========================================================================

  private async runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      this.clearResults();
      this.clearSearchNotice();
      return;
    }

    if (isAuthenticated()) {
      await this.runSpotifySearch(trimmed);
      return;
    }

    if (!this.capsChecked) await this.checkCapabilities();
    if (!this.caps.search) {
      this.showSearchNotice(
        'Free search needs the Padify music API — it looks offline here. Connect Spotify to browse your library instead.',
      );
      return;
    }
    this.clearSearchNotice();

    this.showMusicSubView('results-anon');
    this.resultsList.innerHTML =
      '<div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div>';
    this.resultsEmpty.hidden = true;

    try {
      const tracks = await freeSearchTracks(trimmed, FREE_SEARCH_LIMIT);
      this.renderTrackRows(this.resultsList, tracks, 'free-search');
      this.resultsEmpty.hidden = tracks.length > 0;
    } catch (err) {
      this.resultsList.innerHTML = '';
      this.resultsEmpty.hidden = false;
      this.showSearchNotice(
        err instanceof FreeMusicError ? err.message : 'Search failed — try again.',
      );
    }
  }

  private async runSpotifySearch(query: string): Promise<void> {
    try {
      const results = await spotify.search(query, 'track,album,playlist,artist', 10);
      const hasAnything =
        (results.tracks?.items.length ?? 0) > 0 ||
        (results.playlists?.items.length ?? 0) > 0 ||
        (results.albums?.items.length ?? 0) > 0 ||
        (results.artists?.items.length ?? 0) > 0;

      this.showMusicSubView('app');
      this.libraryView.hidden = true;
      this.spDetailView.hidden = true;
      this.spResultsView.hidden = false;

      const tracks = (results.tracks?.items ?? []).filter((t): t is SpotifyTrack => t !== null);
      byId('spSearchTracksSection').hidden = tracks.length === 0;
      this.renderTrackRows(byId('spSearchTracks'), tracks, 'search-tracks');

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

  private clearResults(): void {
    if (isAuthenticated()) {
      this.showLibrary();
    } else {
      this.showMusicSubView('home');
    }
  }

  private showLibrary(): void {
    this.spResultsView.hidden = true;
    this.spDetailView.hidden = true;
    if (this.appView.hidden === false) this.libraryView.hidden = false;
  }

  // ---- detail (playlist / album / artist — connected) ------------------------

  private async openDetail(
    kind: 'playlist' | 'album' | 'artist',
    payload: {
      id: string;
      uri?: string;
      name: string;
      image?: string | null;
    },
  ): Promise<void> {
    this.showMusicSubView('app');
    this.libraryView.hidden = true;
    this.spResultsView.hidden = true;
    this.spDetailView.hidden = false;
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
      this.renderTrackRows(tracksEl, tracks, 'detail');
    } catch (err) {
      byId('spDetailMeta').textContent = 'Could not load tracks.';
      this.toastSpotifyError(err);
    }
  }

  // ========================================================================
  // Queue view
  // ========================================================================

  private updateQueueCount(): void {
    const remaining =
      this.source === 'free' || this.state.freeQueue.length > 0
        ? Math.max(0, this.state.freeQueue.length - Math.max(0, this.state.freeIndex) - 1)
        : (this.sdkState?.track_window.next_tracks.length ?? 0);
    this.queueCount.textContent = remaining > 0 ? String(remaining) : '';
    this.queueCount.hidden = remaining === 0;
  }

  private updateQueueView(): void {
    this.updateQueueCount();
    if (this.queueView.hidden) return;

    // Premium SDK playback: Spotify owns the queue — show what's up next.
    if (this.source === 'spotify' && this.spotifyMode === 'sdk') {
      const current = this.sdkState?.track_window.current_track;
      const next = this.sdkState?.track_window.next_tracks ?? [];
      this.queueHint.textContent = 'Spotify is managing this queue';
      this.queueClear.hidden = true;
      const rows = [...(current ? [current] : []), ...next.slice(0, 20)].map((track) =>
        // Read-only: the remove buttons carry data-readonly so the click
        // handler ignores them (Spotify's queue can't be edited here).
        this.queueRowMarkup(track, 0).replace(
          'class="sp-row-remove" data-remove',
          'class="sp-row-remove" data-remove data-readonly',
        ),
      );
      this.queueList.innerHTML = rows.join('');
      this.queueEmpty.hidden = rows.length > 0;
      this.updateRowStates();
      return;
    }

    const queue = this.state.freeQueue;
    this.queueHint.textContent = queue.length > 0 ? 'Up next on this device' : 'Nothing queued';
    this.queueClear.hidden = queue.length === 0;
    this.queueList.innerHTML = queue
      .map((track, index) => this.queueRowMarkup(track, index))
      .join('');
    this.queueEmpty.hidden = queue.length > 0;
    this.refreshRowHearts(this.queueList);
    this.updateRowStates();
  }

  private removeFromQueue(index: number): void {
    const queue = this.state.freeQueue;
    if (index < 0 || index >= queue.length) return;
    const wasCurrent = index === this.state.freeIndex;
    queue.splice(index, 1);
    if (index < this.state.freeIndex) this.state.freeIndex -= 1;
    if (wasCurrent) {
      this.state.freeIndex = Math.min(this.state.freeIndex, queue.length - 1);
      if (queue.length === 0) {
        this.source = 'none';
        this.freeResolveToken++;
        if (this.freeAudio) this.freeAudio.removeAttribute('src');
        this.updatePlayerBarEmpty();
      } else {
        void this.playFreeAt(Math.max(0, this.state.freeIndex));
      }
    }
    this.persist();
    this.updateQueueView();
    this.updateRowStates();
  }

  private clearQueue(): void {
    this.state.freeQueue = [];
    this.state.freeIndex = -1;
    this.persist();
    if (this.source === 'free') {
      this.source = 'none';
      this.freeResolveToken++;
      if (this.freeAudio) this.freeAudio.removeAttribute('src');
      this.updatePlayerBarEmpty();
    }
    this.updateQueueView();
    this.updateRowStates();
  }

  // ========================================================================
  // Views / tabs
  // ========================================================================

  private switchView(view: ViewId): void {
    this.state.view = view;
    this.persist();
    this.musicView.hidden = view !== 'music';
    this.queueView.hidden = view !== 'queue';
    this.ambienceView.hidden = view !== 'ambience';
    this.tabMusic.classList.toggle('is-active', view === 'music');
    this.tabQueue.classList.toggle('is-active', view === 'queue');
    this.tabAmbience.classList.toggle('is-active', view === 'ambience');
    this.tabMusic.setAttribute('aria-selected', String(view === 'music'));
    this.tabQueue.setAttribute('aria-selected', String(view === 'queue'));
    this.tabAmbience.setAttribute('aria-selected', String(view === 'ambience'));
    this.tabMusic.tabIndex = view === 'music' ? 0 : -1;
    this.tabQueue.tabIndex = view === 'queue' ? 0 : -1;
    this.tabAmbience.tabIndex = view === 'ambience' ? 0 : -1;
    if (view === 'queue') this.updateQueueView();
    if (view === 'music' && isAuthenticated() && !this.profile && !this.spotifyBusy) {
      void this.loadSpotifyProfile();
    }
  }

  /** Sub-navigation inside the Music tab (anonymous ↔ connected). */
  private showMusicSubView(sub: 'home' | 'connect' | 'app' | 'results-anon'): void {
    this.freeHome.hidden = sub !== 'home';
    this.connectView.hidden = sub !== 'connect';
    this.appView.hidden = sub !== 'app';
    this.resultsView.hidden = sub !== 'results-anon';
    if (sub === 'connect') {
      const redirectEl = byId('spRedirectUri');
      redirectEl.textContent = getRedirectUri();
      const savedId = getClientId();
      if (savedId) this.clientIdInput.value = savedId;
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
      (this.source === 'free' && this.currentFreeTrack() !== null) ||
      (this.source === 'spotify' &&
        (this.spotifyMode === 'preview'
          ? this.currentFreeTrack() !== null
          : this.sdkState?.track_window.current_track != null));
    const modalOpen = this.root.classList.contains('in');
    this.mini.hidden = !hasContent || modalOpen || this.miniDismissed;
    if (!hasContent) return;

    let title = '';
    let sub = '';
    let artUrl: string | null = null;

    if (this.source === 'free') {
      const track = this.currentFreeTrack();
      if (track) {
        title = track.name;
        sub = trackArtistNames(track);
        artUrl = pickImage(track.album?.images, 1);
      }
    } else if (this.source === 'spotify') {
      if (this.spotifyMode === 'preview') {
        const track = this.currentFreeTrack();
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
      (this.mini.querySelector('.mp-mini-placeholder') as HTMLElement).hidden = true;
    } else {
      this.miniImg.hidden = true;
      (this.mini.querySelector('.mp-mini-placeholder') as HTMLElement).hidden = false;
    }
    this.updatePlayIcon();
    this.mini.classList.toggle('is-playing', this.isPlaying());
  }

  private stopAndHideMini(): void {
    if (this.source === 'free') {
      this.freeResolveToken++;
      if (this.freeAudio) {
        this.freeAudio.removeAttribute('src');
        this.freeAudio.load();
      }
    }
    if (this.source === 'spotify') {
      this.stopSpotifyPlayback();
      if (this.freeAudio) this.freeAudio.pause();
    }
    this.state.freeQueue = [];
    this.state.freeIndex = -1;
    this.persist();
    this.source = 'none';
    this.miniDismissed = true;
    this.updatePlayerBarEmpty();
    this.updateRowStates();
    this.updateQueueView();
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

  private updateMediaSessionTrack(track: SpotifyTrack): void {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = pickImage(track.album?.images, 0);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: trackArtistNames(track),
        album: track.album?.name ?? 'Padify',
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
    const playerOn = this.isPlaying();
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
    this.tabMusic.addEventListener('click', () => this.switchView('music'));
    this.tabQueue.addEventListener('click', () => this.switchView('queue'));
    this.tabAmbience.addEventListener('click', () => this.switchView('ambience'));
    this.accountChip.addEventListener('click', () => {
      this.switchView('music');
      if (isAuthenticated()) this.showMusicSubView('app');
      else if (this.appView.hidden && this.resultsView.hidden) this.showMusicSubView('connect');
    });

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

    // ---- anonymous home ----
    this.heroConnect.addEventListener('click', () => {
      this.showMusicSubView('connect');
    });
    this.connectBack.addEventListener('click', () => {
      this.connectError.hidden = true;
      this.showMusicSubView('home');
    });
    this.playlistRename.addEventListener('click', () => {
      void this.renameLocalPlaylist();
    });
    this.playlistClear.addEventListener('click', () => {
      if (!this.library.playlist) return;
      this.library.playlist.tracks = [];
      this.library.persist();
      this.renderFreeHome();
      showToast('Playlist emptied.');
    });

    // ---- queue view ----
    this.queueClear.addEventListener('click', () => this.clearQueue());

    // ---- search ----
    this.searchInput.addEventListener('input', () => {
      byId('mpSearchClear').hidden = this.searchInput.value === '';
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        void this.runSearch(this.searchInput.value);
      }, SEARCH_DEBOUNCE_MS);
    });
    byId('mpSearchClear').addEventListener('click', () => {
      this.searchInput.value = '';
      byId('mpSearchClear').hidden = true;
      this.clearSearchNotice();
      this.clearResults();
      this.searchInput.focus();
    });
    byId('mpResultsBack').addEventListener('click', () => {
      this.searchInput.value = '';
      byId('mpSearchClear').hidden = true;
      this.clearSearchNotice();
      this.showMusicSubView('home');
    });

    // ---- Spotify connect screen ----
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
      this.playlistsCache = [];
      this.savedIds.clear();
      this.savedIdsPending.clear();
      this.stopSdkPolling();
      this.freeNote.hidden = true;
      if (this.source === 'spotify') {
        this.source = 'none';
        this.updatePlayerBarEmpty();
      }
      this.searchInput.value = '';
      byId('mpSearchClear').hidden = true;
      this.renderAnonymousState();
      this.updateRowStates();
      this.syncNavbarIcon();
      showToast('Spotify disconnected — your local music stays on this device.');
    });

    byId('spResultsBack').addEventListener('click', () => {
      this.searchInput.value = '';
      byId('mpSearchClear').hidden = true;
      this.showLibrary();
    });
    byId('spDetailBack').addEventListener('click', () => {
      this.spDetailView.hidden = true;
      if (this.searchInput.value.trim().length >= 2) {
        this.spResultsView.hidden = false;
      } else {
        this.showLibrary();
      }
    });

    this.likedMore.addEventListener('click', () => {
      void this.loadMoreLiked();
    });

    // ---- track rows + cards (delegated across every list) ----
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      // Row action menu items.
      if (this.rowMenu.hidden === false && this.rowMenu.contains(target)) {
        const item = target.closest('.mp-row-menu-item') as HTMLElement | null;
        if (item) {
          const row = this.rowMenu.closest('.sp-row') as HTMLElement | null;
          const action = item.dataset.action ?? '';
          const playlistId = item.dataset.playlistId ?? null;
          this.closeRowMenu();
          if (row) void this.handleRowMenuAction(action, playlistId, row);
        }
        return;
      }

      const row = target.closest('.sp-row') as HTMLElement | null;

      if (row) {
        if (target.closest('[data-remove]') && !target.closest('[data-readonly]')) {
          this.removeFromQueue(Number(row.dataset.queueIndex));
          return;
        }
        if (target.closest('[data-menu]')) {
          const button = target.closest('[data-menu]') as HTMLElement;
          this.openRowMenu(row, button);
          return;
        }
        if (target.closest('[data-like]')) {
          void this.toggleRowLike(row);
          return;
        }
      }

      const rowMain = target.closest('.sp-row-main') as HTMLButtonElement | null;
      if (rowMain) {
        const trackId = row?.dataset.trackId ?? '';
        const queueId = row?.dataset.queueId;
        const queueIndex = Number(row?.dataset.queueIndex);
        if (row && !Number.isNaN(queueIndex) && row.dataset.queueIndex !== undefined) {
          // Queue view rows jump to that queue position.
          if (this.source !== 'spotify' || this.spotifyMode !== 'sdk') {
            void this.playFreeAt(queueIndex);
          }
          return;
        }
        const queue = queueId ? this.queues.get(queueId) : undefined;
        if (queue && trackId) {
          const index = queue.findIndex((track) => track.id === trackId);
          const contextUri = queueId === 'detail' ? this.detailContextUri : null;
          void this.playTrackList(queue, Math.max(0, index), contextUri);
        } else if (row && this.source === 'free' && row.dataset.trackUri) {
          // Row from a list we no longer track (stale) — ignore.
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

    // Close the row menu on outside clicks / Escape.
    document.addEventListener('click', (event) => {
      if (this.rowMenu.hidden) return;
      if (!this.rowMenu.contains(event.target as Node) && !targetInMenuOpener(event.target)) {
        this.closeRowMenu();
      }
    });
    const targetInMenuOpener = (target: EventTarget | null): boolean => {
      // SVG icons inside the button are SVGElements, not HTMLElements —
      // match on Element so icon clicks count as "inside the opener".
      if (!(target instanceof Element)) return false;
      return target.closest('[data-menu]') !== null;
    };
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeRowMenu();
    });

    // Detail "Play" button — plays the loaded detail list.
    byId('spDetailPlay').addEventListener('click', () => {
      if (this.detailQueue.length === 0) return;
      void this.playTrackList(this.detailQueue, 0, this.detailContextUri);
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
        this.updateQueueView();
      })
      .on('hidden.bs.modal', () => {
        this.updateMini();
        this.stopSdkPolling();
      });

    // Arrow-key seeking inside the modal (not on form controls).
    $(this.root).on('keydown', (event) => {
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
      if (this.source !== 'free' || !this.freeAudio?.src) return;
      event.preventDefault();
      const delta = key === 'ArrowLeft' ? -5 : 5;
      this.freeAudio.currentTime = Math.max(0, this.freeAudio.currentTime + delta);
    });
  }

  private async loadMoreLiked(): Promise<void> {
    try {
      this.likedMore.disabled = true;
      const page = await spotify.getSavedTracks(30, this.likedOffset);
      const tracks = page.items
        .map((item) => item.track)
        .filter((t): t is SpotifyTrack => t !== null);
      for (const track of tracks) this.savedIds.add(track.id);
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
      this.updateRowStates();
      this.refreshRowHearts(this.likedList);
    } catch (err) {
      this.toastSpotifyError(err);
    } finally {
      this.likedMore.disabled = false;
    }
  }

  // ---- Debug / E2E hooks ------------------------------------------------------

  debugSnapshot(): Record<string, unknown> {
    return {
      source: this.source,
      freeIndex: this.state.freeIndex,
      freeQueueLength: this.state.freeQueue.length,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      caps: this.caps,
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

let player: MusicPlayerApp | null = null;

/**
 * Constructs the player once the storage layer has hydrated (its
 * constructor restores the persisted player state and bootstraps the
 * account state). Called from app.ts after `await storageReady()`; the
 * modal markup is already in the DOM from the module-evaluation injection
 * above.
 */
export function initMusicPlayer(): void {
  if (player) {
    return;
  }
  player = new MusicPlayerApp();

  // Debug/E2E probes (harmless in production, typed via a local interface).
  const debugWindow = window as unknown as MusicDebugWindow;
  debugWindow.__musicPlayer = musicPlayerAPI;
}

export const musicPlayerAPI: {
  open(): void;
  close(): void;
  togglePlay(): void;
  next(): void;
  prev(): void;
} = {
  open: () => {
    $('#musicPlayerModal').modal('show');
  },
  close: () => {
    $('#musicPlayerModal').modal('hide');
  },
  togglePlay: () => player?.togglePlay(),
  next: () => player?.next(),
  prev: () => player?.prev(),
};

interface MusicDebugWindow {
  __musicPlayer?: typeof musicPlayerAPI;
  __musicProbe?: () => Record<string, unknown>;
}
const probeWindow = window as unknown as MusicDebugWindow;
probeWindow.__musicProbe = () => player?.debugSnapshot() ?? {};
