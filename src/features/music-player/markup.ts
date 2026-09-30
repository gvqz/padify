/**
 * The music player's markup — icons, the ambience sound definitions, the
 * modal and the mini player, and the mount that puts them in the DOM.
 *
 * Extracted from index.ts (the application controller's file) so the
 * controller reads as behavior, not a 500-line HTML literal — the next
 * step of the split (the controller itself) builds on these seams.
 */

import { $ } from '../../lib/q';

// ---------------------------------------------------------------------------
// Icons (inline, currentColor)
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
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

export const eqMarkup = (cls: string): string =>
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
