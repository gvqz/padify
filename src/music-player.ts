/**
 * Padify music player — self-appending modal UI + behavior.
 *
 * The modal DOM is appended to document.body at module evaluation (same
 * pattern as src/timer.ts), so simply importing this module wires
 * everything up. The "Ambience" tab ports the ambient-noise markup (sound
 * cards, global mute/stop, presets) with the exact ids/classes/data
 * attributes that `src/white-noise-player.ts` binds to, so WhiteNoisePlayer
 * keeps working unchanged once the lead points the navbar trigger at
 * `#musicPlayerModal` and removes the legacy `#whiteNoiseModal` markup.
 *
 * Persistence: localStorage key `padify-music-state`.
 */

import $ from 'jquery';
import { MusicEngine } from './music/engine';
import { drawTrackArt } from './music/art';
import {
    TRACKS,
    getTrackById,
    PLAYLIST_LABELS,
    formatTime,
    type Track
} from './music/tracks';

// Bootstrap 3's jQuery modal plugin (registered by the `bootstrap` import in
// main.ts) is not covered by @types/jquery. Identical to the declaration in
// utils.ts — interface declarations merge.
declare global {
    interface JQuery {
        modal(action: string | { [key: string]: unknown }): JQuery;
    }
}

type RepeatMode = 'off' | 'all' | 'one';
type TrackFilter = 'all' | 'focus' | 'calm' | 'sleep' | 'uplift' | 'favorites';

interface MusicPlayerState {
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    lastTrackId: string | null;
    favorites: string[];
}

const STORAGE_KEY = 'padify-music-state';
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];
const PROGRESS_INTERVAL_MS = 250;

const DEFAULT_STATE: MusicPlayerState = {
    volume: 0.7,
    shuffle: false,
    repeat: 'off',
    lastTrackId: null,
    favorites: []
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 20): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
    note: icon('<path d="M9 18V5l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/>', 18),
    musicTab: icon('<path d="M9 18V5l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/>', 16),
    ambienceTab: icon('<path d="M4 9.5v5M8 6.5v11M12 3.5v17M16 6.5v11M20 9.5v5"/>', 16),
    shuffle: icon('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>'),
    prev: icon('<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>'),
    next: icon('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
    repeat: icon('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
    star: icon('<path d="M12 3.3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.7l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"/>', 17),
    volHigh: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>', 19),
    volLow: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>', 19),
    volMute: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/>', 19),
    speaker: '<path d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/>',
    speakerMuted: '<path d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/>'
};

const playIconSvg = (size: number): string =>
    `<svg id="mpPlayIcon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11-6.86a1.05 1.05 0 0 0 0-1.8l-11-6.86A1.05 1.05 0 0 0 8 5.14z"/></svg>`;

const pauseIconSvg = (size: number): string =>
    `<svg id="mpPauseIcon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style="display:none;"><rect x="6" y="4" width="4.4" height="16" rx="1.4"/><rect x="13.6" y="4" width="4.4" height="16" rx="1.4"/></svg>`;

const eqMarkup = (cls: string): string =>
    `<span class="mp-eq ${cls}" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;

// ---------------------------------------------------------------------------
// Ambient sound definitions (25 sounds — keys/names/defaults must match
// src/white-noise-player.ts exactly).
// ---------------------------------------------------------------------------

interface AmbientSoundDef {
    key: string;
    name: string;
    volume: number;
    isNew?: boolean;
    icon: string;
}

const AMBIENT_SOUNDS: AmbientSoundDef[] = [
    {
        key: 'coffee-shop',
        name: 'Coffee Shop',
        volume: 70,
        icon: icon('<path d="M4 9h12v5.5A4.5 4.5 0 0 1 11.5 19h-3A4.5 4.5 0 0 1 4 14.5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.2 5.5c0-1 .7-1.4.7-2.3M11.6 5.5c0-1 .7-1.4.7-2.3"/>')
    },
    {
        key: 'airport',
        name: 'Airport',
        volume: 30,
        icon: icon('<path d="M21 3 3 10.5l6 2.5 2.5 6L21 3z"/><path d="M9 13l12-10"/>')
    },
    {
        key: 'winter-morning',
        name: 'Winter Morning',
        volume: 60,
        icon: icon('<path d="M12 3v18M5.5 6.8l13 10.4M18.5 6.8l-13 10.4"/><path d="M12 6.5 10 4.7M12 6.5 14 4.7M12 17.5l-2 1.8M12 17.5l2 1.8"/>')
    },
    {
        key: 'suburban-street',
        name: 'Suburban Street',
        volume: 70,
        icon: icon('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>')
    },
    {
        key: 'walk-in-snow',
        name: 'Walk in Snow',
        volume: 60,
        isNew: true,
        icon: icon('<ellipse cx="8" cy="7.5" rx="2.4" ry="3.6"/><ellipse cx="16" cy="16.5" rx="2.4" ry="3.6"/><circle cx="8" cy="13.8" r="0.4" fill="currentColor"/><circle cx="16" cy="5.2" r="0.4" fill="currentColor"/>')
    },
    {
        key: 'rain',
        name: 'Rain',
        volume: 15,
        icon: icon('<path d="M7 15a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 15H7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>')
    },
    {
        key: 'rain-on-leaves',
        name: 'Rain on Leaves',
        volume: 70,
        icon: icon('<path d="M4.5 19.5C4.5 10.5 11 5 20 4.5c0 9.5-6 15-15.5 15z"/><path d="M4.5 19.5C8 14.5 12 10.5 17 8"/><path d="M10.8 6.3 9.8 8.4M14.3 8.8l-1 2.1"/>')
    },
    {
        key: 'rain-on-umbrella',
        name: 'Rain on Umbrella',
        volume: 70,
        isNew: true,
        icon: icon('<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9z"/><path d="M12 12v6a2 2 0 0 0 4 0"/>')
    },
    {
        key: 'thunder',
        name: 'Thunder',
        volume: 70,
        icon: icon('<path d="M7 13a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 18 13H7z"/><path d="m12.5 13-2 4h3l-2 4"/>')
    },
    {
        key: 'waves',
        name: 'Waves',
        volume: 50,
        icon: icon('<path d="M2 8.5c2.5-2.6 5.5-2.6 8 0s5.5 2.6 8 0"/><path d="M2 13c2.5-2.6 5.5-2.6 8 0s5.5 2.6 8 0"/><path d="M2 17.5c2.5-2.6 5.5-2.6 8 0s5.5 2.6 8 0"/>')
    },
    {
        key: 'fireside',
        name: 'Fireside',
        volume: 60,
        icon: icon('<path d="M12 2.5c.8 3.8 4.8 4.8 4.8 9.3a4.8 4.8 0 0 1-9.6 0c0-1.8.7-3.2 1.9-4.3.3 1.3 1.1 1.9 1.9 1.9-1-2.8.3-5.4 1-6.9z"/><path d="M8 21.5h8"/>')
    },
    {
        key: 'crickets',
        name: 'Crickets',
        volume: 70,
        icon: icon('<path d="M20 14.5A8.3 8.3 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5z"/><path d="M15.5 4.5 17 3M18.2 7.8 20 6"/>')
    },
    {
        key: 'singing-bowl',
        name: 'Singing Bowl',
        volume: 70,
        icon: icon('<path d="M4 11.5a8 8 0 0 0 16 0H4z"/><path d="M15.5 4.5 13 9"/><circle cx="16.8" cy="3.6" r="1.3"/>')
    },
    {
        key: 'train',
        name: 'Train',
        volume: 65,
        icon: icon('<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 9.5h12"/><path d="M9.8 12.5h.01M14.2 12.5h.01"/><path d="m8 16-2 5M16 16l2 5"/>')
    },
    {
        key: 'inside-a-train',
        name: 'Inside a Train',
        volume: 65,
        isNew: true,
        icon: icon('<rect x="5" y="4" width="14" height="11" rx="2"/><path d="M12 4v6"/><path d="M5 13h14"/><path d="m8 19 2-4M16 19l-2-4"/>')
    },
    {
        key: 'white-noise',
        name: 'White Noise',
        volume: 4,
        icon: icon('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>')
    },
    {
        key: 'keyboard',
        name: 'Keyboard',
        volume: 15,
        icon: icon('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6.5 10.2h.01M10 10.2h.01M13.5 10.2h.01M17 10.2h.01M7 14h10"/>')
    },
    {
        key: 'wind-chimes',
        name: 'Wind Chimes',
        volume: 20,
        icon: icon('<path d="M12 3.5v2.5"/><path d="M7 6h10"/><path d="M7.5 6v6.5M10.5 6v9.5M13.5 6v9.5M16.5 6v6.5"/><path d="M7.5 15.5h.01M10.5 18.5h.01M13.5 18.5h.01M16.5 15.5h.01"/>')
    },
    {
        key: 'clock',
        name: 'Clock',
        volume: 30,
        icon: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2.1"/>')
    },
    {
        key: 'morse-code',
        name: 'Morse Code',
        volume: 40,
        isNew: true,
        icon: icon('<circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M12.5 12h4.5"/><circle cx="20.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>')
    },
    {
        key: 'ceiling-fan',
        name: 'Ceiling Fan',
        volume: 80,
        icon: icon('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 3-6.2 6-5.2C17 7.8 14.8 10 12 10zM14 12c4 0 6.2 3 5.2 6-3-1-5-3.2-5.2-6zM12 14c0 4-3 6.2-6 5.2C7 16.2 9.2 14 12 14zM10 12c-4 0-6.2-3-5.2-6 3 1 5 3.2 5.2 6z"/>')
    },
    {
        key: 'tuning-radio',
        name: 'Tuning Radio',
        volume: 60,
        icon: icon('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="m7 8 9-4.5"/><circle cx="9" cy="13.5" r="2.4"/><path d="M14.5 12.5h4M14.5 16.5h4"/>')
    },
    {
        key: 'fireworks',
        name: 'Fireworks',
        volume: 20,
        icon: icon('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>')
    },
    {
        key: 'owl',
        name: 'Owl',
        volume: 50,
        icon: icon('<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="2.1"/><circle cx="15" cy="10" r="2.1"/><path d="M12 11.6l-1.3 2h2.6l-1.3-2z"/><path d="M8.5 16.5c1 1.3 2.2 1.9 3.5 1.9s2.5-.6 3.5-1.9"/>')
    },
    {
        key: 'underwater',
        name: 'Underwater',
        volume: 60,
        icon: icon('<circle cx="9.5" cy="14.5" r="4.5"/><circle cx="17" cy="8" r="2.6"/><circle cx="17.5" cy="15.5" r="1.4"/><path d="M7.5 13h4"/>')
    }
];

// ---------------------------------------------------------------------------
// Modal markup
// ---------------------------------------------------------------------------

const FILTERS: { id: TrackFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'focus', label: 'Focus' },
    { id: 'calm', label: 'Calm' },
    { id: 'sleep', label: 'Sleep' },
    { id: 'uplift', label: 'Uplift' },
    { id: 'favorites', label: 'Favorites' }
];

const buildChips = (): string =>
    FILTERS.map(
        filter =>
            `<button type="button" class="mp-chip${filter.id === 'all' ? ' is-active' : ''}" data-filter="${filter.id}" aria-pressed="${filter.id === 'all'}">${filter.label}<span class="mp-chip-count" data-count-for="${filter.id}"></span></button>`
    ).join('');

const buildSoundButtons = (): string =>
    AMBIENT_SOUNDS.map(
        sound => `
        <div class="sound-button" data-sound="${sound.key}">
            <div class="sound-button-main">
                ${sound.icon}
                <span>${sound.name}</span>
            </div>
            <div class="volume-control">
                <input type="range" min="0" max="100" value="${sound.volume}" class="volume-slider" id="${sound.key}-volume" aria-label="${sound.name} volume">
            </div>
            ${eqMarkup('mp-card-eq')}
            ${sound.isNew ? '<span class="new-badge">NEW</span>' : ''}
        </div>`
    ).join('\n');

const musicPlayerModalHtml = `
<div class="modal fade mp-modal" id="musicPlayerModal" tabindex="-1" role="dialog" aria-labelledby="musicPlayerTitle">
    <div class="modal-dialog modal-lg" role="document">
        <div class="modal-content">
            <div class="modal-header mp-header">
                <button type="button" class="close" data-dismiss="modal" aria-label="Close">&times;</button>
                <h4 class="modal-title mp-title" id="musicPlayerTitle">
                    ${ICONS.note}
                    <span>Music Player</span>
                </h4>
            </div>
            <div class="modal-body mp-body">
                <div class="mp-tabs" role="tablist" aria-label="Music player views">
                    <button type="button" class="mp-tab is-active" id="mpTabMusic" role="tab" aria-selected="true" aria-controls="mpMusicView">
                        ${ICONS.musicTab}<span>Music</span>
                    </button>
                    <button type="button" class="mp-tab" id="mpTabAmbience" role="tab" aria-selected="false" aria-controls="mpAmbienceView" tabindex="-1">
                        ${ICONS.ambienceTab}<span>Ambience</span>
                    </button>
                </div>

                <div class="mp-view" id="mpMusicView" role="tabpanel" aria-labelledby="mpTabMusic">
                    <section class="mp-now-playing" aria-label="Now playing">
                        <div class="mp-art-wrap">
                            <canvas class="mp-art" id="mpArtCanvas" width="512" height="512" aria-hidden="true"></canvas>
                            ${eqMarkup('mp-eq-overlay')}
                        </div>
                        <div class="mp-np-meta">
                            <div class="mp-np-heading">
                                <div class="mp-np-title-block">
                                    <div class="mp-np-title" id="mpTrackTitle">&mdash;</div>
                                    <div class="mp-np-artist">Padify Studio</div>
                                </div>
                                <span class="mp-np-tag" id="mpTrackTag">&mdash;</span>
                            </div>
                            <div class="mp-seek-row">
                                <span class="mp-time" id="mpTimeCurrent">0:00</span>
                                <input type="range" class="mp-range mp-seek" id="mpSeek" min="0" max="1000" step="1" value="0" aria-label="Seek position" aria-valuetext="0:00">
                                <span class="mp-time" id="mpTimeTotal">0:00</span>
                            </div>
                            <div class="mp-controls">
                                <button type="button" class="mp-ctl" id="mpShuffle" aria-pressed="false" title="Shuffle" aria-label="Shuffle off">${ICONS.shuffle}</button>
                                <button type="button" class="mp-ctl" id="mpPrev" title="Previous track" aria-label="Previous track">${ICONS.prev}</button>
                                <button type="button" class="mp-play" id="mpPlay" title="Play" aria-label="Play">${playIconSvg(22)}${pauseIconSvg(22)}</button>
                                <button type="button" class="mp-ctl" id="mpNext" title="Next track" aria-label="Next track">${ICONS.next}</button>
                                <button type="button" class="mp-ctl mp-repeat" id="mpRepeat" title="Repeat" aria-label="Repeat off" aria-pressed="false">${ICONS.repeat}<span class="mp-repeat-one" aria-hidden="true">1</span></button>
                                <div class="mp-volume">
                                    <button type="button" class="mp-ctl mp-vol-btn" id="mpVolumeIcon" title="Mute" aria-label="Mute">
                                        <span id="mpVolIconHigh">${ICONS.volHigh}</span>
                                        <span id="mpVolIconLow" style="display:none;">${ICONS.volLow}</span>
                                        <span id="mpVolIconMute" style="display:none;">${ICONS.volMute}</span>
                                    </button>
                                    <input type="range" class="mp-range mp-volume-slider" id="mpVolume" min="0" max="100" step="1" value="70" aria-label="Volume">
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="mp-library" aria-label="Track library">
                        <div class="mp-chips" role="group" aria-label="Filter tracks">
                            ${buildChips()}
                        </div>
                        <div class="mp-tracklist" id="mpTrackList" role="list" aria-label="Tracks"></div>
                        <div class="mp-empty" id="mpFavoritesEmpty" hidden>
                            ${icon('<path d="M12 3.3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.7l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"/>', 22)}
                            <p>No favorites yet. Tap the star on any track to keep it close.</p>
                        </div>
                    </section>
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
            </div>
            <div class="modal-footer mp-footer">
                <span class="mp-footer-hint">${icon('<path d="M12 3.3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.7l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"/>', 14)} Playback continues after closing</span>
                <button type="button" class="mp-btn mp-btn-primary" data-dismiss="modal">Close</button>
            </div>
        </div>
    </div>
</div>`;

// Append the modal to the DOM at module evaluation (timer.ts pattern).
$(document.body).append(musicPlayerModalHtml);

// ---------------------------------------------------------------------------
// Player UI controller
// ---------------------------------------------------------------------------

class MusicPlayerUI {
    private engine = new MusicEngine();
    private state: MusicPlayerState;
    private currentId: string;
    private filter: TrackFilter = 'all';
    private seekDragging = false;
    private seekDebounce: ReturnType<typeof setTimeout> | null = null;
    private progressTimer: ReturnType<typeof setInterval> | null = null;
    private lastVolumeBeforeMute: number | null = null;
    private rows = new Map<string, HTMLDivElement>();
    private navbarIconObserver: MutationObserver | null = null;
    private navbarIconWatchedEl: Element | null = null;

    // DOM references (all within #musicPlayerModal).
    private readonly root: HTMLElement;
    private readonly artCanvas: HTMLCanvasElement;
    private readonly trackTitle: HTMLElement;
    private readonly trackTag: HTMLElement;
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
    private readonly trackList: HTMLElement;
    private readonly favoritesEmpty: HTMLElement;
    private readonly nowPlaying: HTMLElement;
    private readonly musicView: HTMLElement;
    private readonly ambienceView: HTMLElement;
    private readonly tabMusic: HTMLButtonElement;
    private readonly tabAmbience: HTMLButtonElement;

    constructor() {
        this.state = this.loadState();

        const byId = <T extends HTMLElement>(id: string): T => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`Music player markup missing #${id}`);
            return el as T;
        };

        this.root = byId('musicPlayerModal');
        this.artCanvas = byId('mpArtCanvas');
        this.trackTitle = byId('mpTrackTitle');
        this.trackTag = byId('mpTrackTag');
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
        this.trackList = byId('mpTrackList');
        this.favoritesEmpty = byId('mpFavoritesEmpty');
        this.nowPlaying = this.root.querySelector('.mp-now-playing') as HTMLElement;
        this.musicView = byId('mpMusicView');
        this.ambienceView = byId('mpAmbienceView');
        this.tabMusic = byId('mpTabMusic');
        this.tabAmbience = byId('mpTabAmbience');

        // Engine wiring.
        this.engine.onStateChange = () => this.handleEngineState();
        this.engine.onEnd = () => this.handleTrackEnd();
        this.engine.setVolume(this.state.volume);

        // Restore persisted UI state.
        this.volumeInput.value = String(Math.round(this.state.volume * 100));
        this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
        this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
        this.shuffleBtn.setAttribute('aria-label', this.state.shuffle ? 'Shuffle on' : 'Shuffle off');
        this.applyRepeatVisuals();
        this.updateVolumeIcon();

        // Library + now-playing.
        this.renderLibrary();
        const restored =
            (this.state.lastTrackId && getTrackById(this.state.lastTrackId)) || TRACKS[0];
        this.currentId = restored.id;
        this.engine.load(restored);
        this.updateNowPlaying();
        this.updateRows();
        this.updateChips();

        this.bindEvents();
        this.setupMediaSession();
        this.watchNavbarIcon();

        // Initial slider fills.
        this.setRangeFill(this.seek);
        this.setRangeFill(this.volumeInput);
        this.root.querySelectorAll<HTMLInputElement>('.volume-slider').forEach(slider => {
            this.setRangeFill(slider);
        });
    }

    // ---- State persistence ---------------------------------------------------

    private loadState(): MusicPlayerState {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_STATE };
            const parsed = JSON.parse(raw) as Partial<MusicPlayerState>;
            const favorites = Array.isArray(parsed.favorites)
                ? parsed.favorites.filter(
                      (id): id is string =>
                          typeof id === 'string' && getTrackById(id) !== undefined
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
                    typeof parsed.lastTrackId === 'string' &&
                    getTrackById(parsed.lastTrackId) !== undefined
                        ? parsed.lastTrackId
                        : null,
                favorites
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

    // ---- Library rendering ---------------------------------------------------

    private renderLibrary(): void {
        const frag = document.createDocumentFragment();
        for (const track of TRACKS) {
            frag.appendChild(this.createRow(track));
        }
        this.trackList.appendChild(frag);
    }

    private createRow(track: Track): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'mp-row';
        row.dataset.trackId = track.id;
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-playlist', track.playlist);

        const label = PLAYLIST_LABELS[track.playlist];
        const isFav = this.state.favorites.includes(track.id);

        row.innerHTML = `
            <button type="button" class="mp-row-main" aria-label="Play ${track.title} (${label})">
                <canvas class="mp-row-art" width="512" height="512" aria-hidden="true"></canvas>
                <span class="mp-row-title">${track.title}</span>
                <span class="mp-row-tag">${label}</span>
                ${eqMarkup('mp-row-eq')}
                <span class="mp-row-dur">${formatTime(track.durationSec)}</span>
            </button>
            <button type="button" class="mp-row-star${isFav ? ' is-fav' : ''}" aria-pressed="${isFav}" title="Favorite" aria-label="${isFav ? 'Remove' : 'Add'} ${track.title} ${isFav ? 'from' : 'to'} favorites">${ICONS.star}</button>`;

        const art = row.querySelector<HTMLCanvasElement>('.mp-row-art');
        if (art) drawTrackArt(art, track);

        const main = row.querySelector<HTMLButtonElement>('.mp-row-main');
        if (main) {
            main.addEventListener('click', () => this.playTrack(track.id));
        }
        const star = row.querySelector<HTMLButtonElement>('.mp-row-star');
        if (star) {
            star.addEventListener('click', event => {
                event.stopPropagation();
                this.toggleFavorite(track.id);
            });
        }

        this.rows.set(track.id, row);
        return row;
    }

    // ---- Now playing ---------------------------------------------------------

    private currentTrack(): Track | null {
        return getTrackById(this.currentId) ?? null;
    }

    private updateNowPlaying(): void {
        const track = this.currentTrack();
        if (!track) return;
        drawTrackArt(this.artCanvas, track);
        this.trackTitle.textContent = track.title;
        this.trackTag.textContent = PLAYLIST_LABELS[track.playlist];
        this.trackTag.className = `mp-np-tag mp-np-tag--${track.playlist}`;
        this.timeTotal.textContent = formatTime(track.durationSec);
        this.updateProgress();
        this.updateMediaSession(track);
    }

    private updateProgress(): void {
        const track = this.currentTrack();
        if (!track) return;
        const pos = this.engine.currentTrack?.id === track.id
            ? this.engine.getPosition()
            : 0;
        this.timeCurrent.textContent = formatTime(pos);
        if (!this.seekDragging) {
            const ratio = track.durationSec > 0 ? pos / track.durationSec : 0;
            this.seek.value = String(Math.round(ratio * 1000));
            this.seek.setAttribute('aria-valuetext', formatTime(pos));
        }
        this.setRangeFill(this.seek);
    }

    // ---- Playback controls ---------------------------------------------------

    playTrack(id: string): void {
        const track = getTrackById(id);
        if (!track) return;
        this.currentId = id;
        this.state.lastTrackId = id;
        this.persist();
        this.engine.play(track, 0);
        this.updateNowPlaying();
        this.updateRows();
    }

    togglePlay(): void {
        if (!this.engine.currentTrack) {
            const track = this.currentTrack() ?? TRACKS[0];
            this.playTrack(track.id);
            return;
        }
        if (this.engine.isPlaying) {
            this.engine.pause();
        } else {
            this.engine.resume();
        }
    }

    /** Advances the queue. `auto` = triggered by a track finishing. */
    next(auto = false): void {
        const idx = TRACKS.findIndex(t => t.id === this.currentId);
        let nextIdx: number;

        if (this.state.shuffle) {
            if (TRACKS.length <= 1) return;
            do {
                nextIdx = Math.floor(Math.random() * TRACKS.length);
            } while (nextIdx === idx);
        } else {
            nextIdx = idx + 1;
        }

        if (nextIdx >= TRACKS.length) {
            if (auto && this.state.repeat === 'off') {
                // End of queue with repeat off: stop (track stays loaded).
                this.engine.stop();
                return;
            }
            nextIdx = 0; // wrap (repeat 'all', or manual next)
        }
        this.playTrack(TRACKS[nextIdx].id);
    }

    prev(): void {
        const track = this.currentTrack();
        if (track && this.engine.currentTrack?.id === track.id && this.engine.getPosition() > 3) {
            this.engine.seek(0);
            return;
        }
        const idx = TRACKS.findIndex(t => t.id === this.currentId);
        let prevIdx: number;
        if (this.state.shuffle) {
            if (TRACKS.length <= 1) return;
            do {
                prevIdx = Math.floor(Math.random() * TRACKS.length);
            } while (prevIdx === idx);
        } else {
            prevIdx = idx - 1;
        }
        if (prevIdx < 0) prevIdx = TRACKS.length - 1;
        this.playTrack(TRACKS[prevIdx].id);
    }

    private handleTrackEnd(): void {
        if (this.state.repeat === 'one') {
            const track = this.currentTrack();
            if (track) this.engine.play(track, 0);
            return;
        }
        this.next(true);
    }

    private handleEngineState(): void {
        const playing = this.engine.isPlaying;
        const isCurrent = this.engine.currentTrack?.id === this.currentId;

        this.nowPlaying.classList.toggle('is-playing', playing && isCurrent);

        this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        this.playBtn.setAttribute('title', playing ? 'Pause' : 'Play');
        const playIcon = document.getElementById('mpPlayIcon');
        const pauseIcon = document.getElementById('mpPauseIcon');
        if (playIcon) playIcon.style.display = playing ? 'none' : 'block';
        if (pauseIcon) pauseIcon.style.display = playing ? 'block' : 'none';

        this.updateRows();
        this.updateProgress();

        if (playing) {
            this.startProgressTimer();
        } else {
            this.stopProgressTimer();
        }

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        }

        this.syncNavbarIcon();
    }

    private startProgressTimer(): void {
        if (this.progressTimer !== null) return;
        this.progressTimer = setInterval(
            () => this.updateProgress(),
            PROGRESS_INTERVAL_MS
        );
    }

    private stopProgressTimer(): void {
        if (this.progressTimer !== null) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    // ---- Volume ----------------------------------------------------------------

    private setVolume(value: number, fromUser: boolean): void {
        const vol = Math.max(0, Math.min(1, value));
        this.engine.setVolume(vol);
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
        const current = this.engine.getVolume();
        if (current > 0) {
            this.lastVolumeBeforeMute = current;
            this.setVolume(0, false);
        } else {
            const restore =
                this.lastVolumeBeforeMute ?? (this.state.volume > 0 ? this.state.volume : 0.7);
            this.state.volume = restore;
            this.setVolume(restore, true);
        }
    }

    private updateVolumeIcon(): void {
        const vol = this.engine.getVolume();
        this.volIconHigh.style.display = vol >= 0.5 ? 'inline' : 'none';
        this.volIconLow.style.display = vol > 0 && vol < 0.5 ? 'inline' : 'none';
        this.volIconMute.style.display = vol <= 0 ? 'inline' : 'none';
        const btn = this.volIconHigh.parentElement as HTMLButtonElement | null;
        if (btn) {
            const muted = vol <= 0;
            btn.title = muted ? 'Unmute' : 'Mute';
            btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
        }
    }

    // ---- Repeat / shuffle ----------------------------------------------------

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
    }

    private toggleShuffle(): void {
        this.state.shuffle = !this.state.shuffle;
        this.persist();
        this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
        this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
        this.shuffleBtn.setAttribute(
            'aria-label',
            this.state.shuffle ? 'Shuffle on' : 'Shuffle off'
        );
    }

    // ---- Library filtering / favorites -----------------------------------------

    private setFilter(filter: TrackFilter): void {
        this.filter = filter;
        this.updateChips();
        this.updateRows();
    }

    private updateChips(): void {
        this.root.querySelectorAll<HTMLButtonElement>('.mp-chip').forEach(chip => {
            const chipFilter = chip.dataset.filter as TrackFilter;
            const active = chipFilter === this.filter;
            chip.classList.toggle('is-active', active);
            chip.setAttribute('aria-pressed', String(active));
        });
        this.root.querySelectorAll<HTMLElement>('.mp-chip-count').forEach(count => {
            const forFilter = count.dataset.countFor as TrackFilter;
            let n: number;
            if (forFilter === 'all') n = TRACKS.length;
            else if (forFilter === 'favorites') n = this.state.favorites.length;
            else n = TRACKS.filter(t => t.playlist === forFilter).length;
            count.textContent = String(n);
        });
    }

    private updateRows(): void {
        const playingId = this.engine.isPlaying ? this.engine.currentTrack?.id : null;
        const favorites = this.state.favorites;
        let visibleCount = 0;

        for (const track of TRACKS) {
            const row = this.rows.get(track.id);
            if (!row) continue;

            const matches =
                this.filter === 'all' ||
                track.playlist === this.filter ||
                (this.filter === 'favorites' && favorites.includes(track.id));
            row.hidden = !matches;
            if (matches) visibleCount++;

            const isCurrent = track.id === this.currentId;
            row.classList.toggle('is-current', isCurrent);
            row.classList.toggle('is-playing', isCurrent && playingId === track.id);
        }

        const showEmpty = this.filter === 'favorites' && visibleCount === 0;
        this.favoritesEmpty.hidden = !showEmpty;
        this.trackList.style.display = showEmpty ? 'none' : '';
    }

    private toggleFavorite(id: string): void {
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

        const row = this.rows.get(id);
        if (row) {
            const star = row.querySelector<HTMLButtonElement>('.mp-row-star');
            if (star) {
                star.classList.toggle('is-fav', isFav);
                star.setAttribute('aria-pressed', String(isFav));
                star.setAttribute(
                    'aria-label',
                    `${isFav ? 'Remove' : 'Add'} ${track.title} ${isFav ? 'from' : 'to'} favorites`
                );
            }
        }
        this.updateChips();
        if (this.filter === 'favorites') this.updateRows();
    }

    // ---- Tabs -----------------------------------------------------------------

    private switchTab(view: 'music' | 'ambience'): void {
        const music = view === 'music';
        this.musicView.hidden = !music;
        this.ambienceView.hidden = music;
        this.tabMusic.classList.toggle('is-active', music);
        this.tabAmbience.classList.toggle('is-active', !music);
        this.tabMusic.setAttribute('aria-selected', String(music));
        this.tabAmbience.setAttribute('aria-selected', String(!music));
        this.tabMusic.tabIndex = music ? 0 : -1;
        this.tabAmbience.tabIndex = music ? -1 : 0;
    }

    // ---- Range fill helper ------------------------------------------------------

    private setRangeFill(input: HTMLInputElement): void {
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        const value = Number(input.value);
        const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
        input.style.setProperty('--mp-fill', `${pct.toFixed(1)}%`);
    }

    // ---- Events ------------------------------------------------------------------

    private bindEvents(): void {
        // Tabs.
        this.tabMusic.addEventListener('click', () => this.switchTab('music'));
        this.tabAmbience.addEventListener('click', () => this.switchTab('ambience'));

        // Transport controls.
        this.playBtn.addEventListener('click', () => this.togglePlay());
        this.root.querySelector('#mpNext')?.addEventListener('click', () => this.next());
        this.root.querySelector('#mpPrev')?.addEventListener('click', () => this.prev());
        this.shuffleBtn.addEventListener('click', () => this.toggleShuffle());
        this.repeatBtn.addEventListener('click', () => this.cycleRepeat());

        // Volume.
        this.volumeInput.addEventListener('input', () => {
            this.setVolume(Number(this.volumeInput.value) / 100, true);
        });
        this.root
            .querySelector('#mpVolumeIcon')
            ?.addEventListener('click', () => this.toggleMute());

        // Seek bar: lock while dragging, commit on change; keyboard seeks
        // debounce through 'input' when not dragging.
        this.seek.addEventListener('pointerdown', () => {
            this.seekDragging = true;
        });
        this.seek.addEventListener('input', () => {
            this.previewSeek();
        });
        this.seek.addEventListener('change', () => {
            this.commitSeek();
        });

        // Filter chips.
        this.root.querySelectorAll<HTMLButtonElement>('.mp-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const filter = chip.dataset.filter as TrackFilter;
                if (filter) this.setFilter(filter);
            });
        });

        // Ambient volume sliders: keep the gradient fill in sync (purely
        // cosmetic; WhiteNoisePlayer owns the actual volume behavior).
        this.root.addEventListener('input', event => {
            const target = event.target as HTMLElement;
            if (target instanceof HTMLInputElement && target.classList.contains('volume-slider')) {
                this.setRangeFill(target);
            }
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
            const track = this.engine.currentTrack;
            if (!track) return;
            event.preventDefault();
            const pos = this.engine.getPosition();
            this.engine.seek(key === 'ArrowLeft' ? pos - 5 : pos + 5);
        });

        // Refresh display whenever the modal becomes visible.
        $(this.root).on('shown.bs.modal', () => this.updateProgress());
    }

    private previewSeek(): void {
        const track = this.currentTrack();
        if (!track) return;
        const ratio = Number(this.seek.value) / 1000;
        const pos = ratio * track.durationSec;
        this.timeCurrent.textContent = formatTime(pos);
        this.seek.setAttribute('aria-valuetext', formatTime(pos));
        this.setRangeFill(this.seek);
        if (!this.seekDragging) {
            if (this.seekDebounce !== null) clearTimeout(this.seekDebounce);
            this.seekDebounce = setTimeout(() => {
                this.seekDebounce = null;
                this.engine.seek(pos);
            }, 180);
        }
    }

    private commitSeek(): void {
        if (this.seekDebounce !== null) {
            clearTimeout(this.seekDebounce);
            this.seekDebounce = null;
        }
        const track = this.currentTrack();
        if (!track) return;
        const pos = (Number(this.seek.value) / 1000) * track.durationSec;
        this.engine.seek(pos);
        this.seekDragging = false;
        this.updateProgress();
    }

    // ---- MediaSession --------------------------------------------------------------

    private setupMediaSession(): void {
        if (!('mediaSession' in navigator)) return;
        const actions: [MediaSessionAction, () => void][] = [
            ['play', () => this.togglePlay()],
            ['pause', () => this.engine.pause()],
            ['nexttrack', () => this.next()],
            ['previoustrack', () => this.prev()]
        ];
        for (const [action, handler] of actions) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                /* action unsupported in this browser */
            }
        }
    }

    private updateMediaSession(track: Track): void {
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title,
                artist: 'Padify Studio',
                album: PLAYLIST_LABELS[track.playlist],
                artwork: [
                    {
                        src: this.artCanvas.toDataURL('image/png'),
                        sizes: '512x512',
                        type: 'image/png'
                    }
                ]
            });
        } catch {
            /* metadata/artwork unsupported — non-fatal */
        }
    }

    // ---- Navbar icon sync ------------------------------------------------------------

    /**
     * The navbar `.ambient-noise-icon` reflects "music OR ambience playing".
     * WhiteNoisePlayer rewrites the class for its own state; a guarded
     * MutationObserver re-applies the combined state whenever that happens.
     */
    private syncNavbarIcon(): void {
        const iconEl = document.querySelector('.ambient-noise-icon');
        if (!iconEl) return;
        this.ensureNavbarIconObserver(iconEl);
        const ambientOn = window.whiteNoisePlayer
            ? window.whiteNoisePlayer.isAnySoundPlaying()
            : false;
        const should = (this.engine.isPlaying && this.engine.currentTrack !== null) || ambientOn;
        const has = iconEl.classList.contains('is-playing');
        if (has !== should) {
            iconEl.classList.toggle('is-playing', should);
        }
    }

    /**
     * Attaches (or re-attaches, if the element was replaced) the class observer
     * so WhiteNoisePlayer's icon rewrites get reconciled with the combined
     * "music OR ambience" state. No-op when already watching `iconEl`.
     */
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
            attributeFilter: ['class']
        });
    }

    private watchNavbarIcon(): void {
        const iconEl = document.querySelector('.ambient-noise-icon');
        if (iconEl) this.ensureNavbarIconObserver(iconEl);
    }

    // ---- Debug / E2E hooks --------------------------------------------------------------

    debugSnapshot(): Record<string, unknown> {
        return {
            engine: this.engine.debugSnapshot(),
            currentId: this.currentId,
            filter: this.filter,
            favorites: this.state.favorites,
            shuffle: this.state.shuffle,
            repeat: this.state.repeat
        };
    }
}

// ---------------------------------------------------------------------------
// Module singletons + public API
// ---------------------------------------------------------------------------

const player = new MusicPlayerUI();

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
    playTrack: (id: string) => player.playTrack(id),
    next: () => player.next(),
    prev: () => player.prev()
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
