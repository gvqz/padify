/**
 * The music player's markup — icons, the modal (sidebar + views + bottom
 * player bar), the mini player, and the mount that puts them in the DOM.
 *
 * The v4 layout: a left sidebar switches destinations (Search, Favorites,
 * My Playlist, Ambience, Queue), the content pane fills the middle, and the
 * player bar rides the bottom of the modal like every music app the user
 * already knows. Ambience is a list of tracks now — the old mixer tab
 * (per-sound sliders, layered mixes, presets) is gone; the sounds live in
 * ./ambient.ts and play through the regular engine.
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
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 17),
  heart: icon(
    '<path d="M12 20.5c-5.2-3.4-8.5-6.3-8.5-10A4.6 4.6 0 0 1 8 6c1.6 0 3.1.8 4 2.1A4.9 4.9 0 0 1 16 6a4.6 4.6 0 0 1 4.5 4.5c0 3.7-3.3 6.6-8.5 10z"/>',
    17,
  ),
  heartFilled: icon(
    '<path fill="currentColor" stroke="none" d="M12 20.5c-5.2-3.4-8.5-6.3-8.5-10A4.6 4.6 0 0 1 8 6c1.6 0 3.1.8 4 2.1A4.9 4.9 0 0 1 16 6a4.6 4.6 0 0 1 4.5 4.5c0 3.7-3.3 6.6-8.5 10z"/>',
    17,
  ),
  playlist: icon(
    '<path d="M21 15V6"/><path d="M21 15a3 3 0 1 1-3-3h3z" fill="currentColor" stroke="none"/><path d="M3 12V5"/><path d="M3 12a2.5 2.5 0 0 1 2.5-2.5L9 9.5"/><path d="M3 12a2.5 2.5 0 0 0 2.5 2.5L9 14.5"/><path d="M9 9.5v5"/><path d="M9 12h12"/>',
    17,
  ),
  waves: icon(
    '<path d="M3 12c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 17c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 7c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/>',
    17,
  ),
  queue: icon('<path d="M4 6h16M4 12h16"/><circle cx="9" cy="18" r="3"/><path d="M13 18h7"/>', 17),
  shuffle: icon(
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  ),
  prev: icon('<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>'),
  next: icon('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
  repeat: icon(
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  ),
  volHigh: icon(
    '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    19,
  ),
  volLow: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>', 19),
  volMute: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/>', 19),
  plus: icon('<path d="M12 5v14M5 12h14"/>', 15),
  dots: icon(
    '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    17,
  ),
  remove: icon('<path d="M18 6 6 18M6 6l12 12"/>', 14),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>', 16),
};

const playIconSvg = (size: number, id = 'mpPlayIcon'): string =>
  `<svg id="${id}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11-6.86a1.05 1.05 0 0 0 0-1.8l-11-6.86A1.05 1.05 0 0 0 8 5.14z"/></svg>`;

const pauseIconSvg = (size: number, id = 'mpPauseIcon'): string =>
  `<svg id="${id}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style="display:none;"><rect x="6" y="4" width="4.4" height="16" rx="1.4"/><rect x="13.6" y="4" width="4.4" height="16" rx="1.4"/></svg>`;

export const eqMarkup = (cls: string): string =>
  `<span class="mp-eq ${cls}" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

const navItem = (id: string, view: string, iconSvg: string, label: string, extra = ''): string => `
                    <button type="button" class="mp-nav-item" id="${id}" role="tab" data-view="${view}" aria-selected="false" aria-controls="mpView-${view}" tabindex="-1">
                        <span class="mp-nav-icon">${iconSvg}</span>
                        <span class="mp-nav-label">${label}</span>
                        ${extra}
                    </button>`;

const musicPlayerModalHtml = `
<div class="modal fade mp-modal" id="musicPlayerModal" tabindex="-1" role="dialog" aria-labelledby="musicPlayerTitle">
    <div class="modal-dialog modal-lg mp-dialog" role="document">
        <div class="modal-content mp-content">
            <div class="modal-header mp-header">
                <h4 class="modal-title mp-title" id="musicPlayerTitle">
                    ${ICONS.note}
                    <span>Music</span>
                </h4>
                <button type="button" class="close" data-dismiss="modal" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
            </div>

            <div class="modal-body mp-body">
                <nav class="mp-nav" role="tablist" aria-label="Music sections">
                    ${navItem('mpNavSearch', 'search', ICONS.search, 'Search')}
                    ${navItem('mpNavFavorites', 'favorites', ICONS.heart, 'Favorites')}
                    ${navItem('mpNavPlaylist', 'playlist', ICONS.playlist, '<span id="mpPlaylistNavName">Playlist</span>')}
                    ${navItem('mpNavAmbience', 'ambience', ICONS.waves, 'Ambience')}
                    ${navItem(
                      'mpNavQueue',
                      'queue',
                      ICONS.queue,
                      'Queue',
                      '<span class="mp-nav-count" id="mpQueueCount" hidden></span>',
                    )}
                </nav>

                <div class="mp-main">
                    <section class="mp-view mp-view-search" id="mpView-search" role="tabpanel" aria-labelledby="mpNavSearch">
                        <div class="mp-search">
                            ${ICONS.search}
                            <input type="search" id="mpSearchInput" class="mp-search-input" placeholder="Search songs, artists, albums…" autocomplete="off" spellcheck="false" aria-label="Search music">
                            <button type="button" class="mp-search-clear" id="mpSearchClear" aria-label="Clear search" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
                        </div>
                        <div class="mp-search-notice" id="mpSearchNotice" role="status" hidden></div>

                        <div class="mp-scroll">
                            <div class="mp-search-idle" id="mpSearchIdle">
                                ${ICONS.search}
                                <p class="mp-search-idle-title">Find your focus track</p>
                                <p class="mp-search-idle-sub">Millions of songs, free — no account needed. Search by song, artist or album.</p>
                            </div>
                            <div class="mp-results" id="mpResults" hidden>
                                <header class="mp-list-head">
                                    <h4 class="mp-list-title">Results</h4>
                                    <span class="mp-section-count" id="mpResultsCount"></span>
                                </header>
                                <div class="mp-tracks" id="mpResultsList" role="list" aria-label="Search results"></div>
                                <div class="mp-empty" id="mpResultsEmpty" hidden>
                                    <p>Nothing found — try a different search.</p>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="mp-view" id="mpView-favorites" role="tabpanel" aria-labelledby="mpNavFavorites" hidden>
                        <header class="mp-list-head">
                            <h4 class="mp-list-title">${ICONS.heart} Favorites</h4>
                            <span class="mp-section-count" id="mpFavCount"></span>
                        </header>
                        <div class="mp-scroll">
                            <div class="mp-tracks" id="mpFavoritesList" role="list" aria-label="Favorite tracks"></div>
                            <div class="mp-empty" id="mpFavoritesEmpty">
                                ${ICONS.heart}
                                <p>Tap the heart on any song to keep it here.</p>
                            </div>
                        </div>
                    </section>

                    <section class="mp-view" id="mpView-playlist" role="tabpanel" aria-labelledby="mpNavPlaylist" hidden>
                        <header class="mp-list-head">
                            <h4 class="mp-list-title">${ICONS.playlist} <span id="mpPlaylistName">My Playlist</span></h4>
                            <span class="mp-section-count" id="mpPlaylistCount"></span>
                            <span class="mp-list-actions">
                                <button type="button" class="mp-chip-btn" id="mpPlaylistRename" hidden>Rename</button>
                                <button type="button" class="mp-chip-btn" id="mpPlaylistClear" hidden>Remove all</button>
                            </span>
                        </header>
                        <div class="mp-scroll">
                            <div class="mp-tracks" id="mpLocalPlaylistList" role="list" aria-label="Local playlist tracks"></div>
                            <div class="mp-empty" id="mpLocalPlaylistEmpty">
                                ${ICONS.playlist}
                                <p>Use the ⋯ menu on any song to add it here.</p>
                            </div>
                        </div>
                    </section>

                    <section class="mp-view" id="mpView-ambience" role="tabpanel" aria-labelledby="mpNavAmbience" hidden>
                        <header class="mp-list-head">
                            <h4 class="mp-list-title">${ICONS.waves} Ambience</h4>
                            <span class="mp-section-count mp-list-sub">Loops until you skip</span>
                        </header>
                        <div class="mp-scroll">
                            <div class="mp-tracks" id="mpAmbienceList" role="list" aria-label="Ambience sounds"></div>
                        </div>
                    </section>

                    <section class="mp-view" id="mpView-queue" role="tabpanel" aria-labelledby="mpNavQueue" hidden>
                        <header class="mp-list-head">
                            <h4 class="mp-list-title">${ICONS.queue} Queue</h4>
                            <span class="mp-list-actions">
                                <button type="button" class="mp-chip-btn" id="mpQueueClear" hidden>Clear</button>
                            </span>
                        </header>
                        <div class="mp-scroll">
                            <div class="mp-tracks" id="mpQueueList" role="list" aria-label="Play queue"></div>
                            <div class="mp-empty" id="mpQueueEmpty">
                                ${ICONS.queue}
                                <p>Nothing queued. Play a song, or use the + on any row to line one up.</p>
                            </div>
                        </div>
                    </section>
                </div>
            </div>

            <div class="mp-playerbar" id="mpPlayerBar">
                <div class="mp-pb-main">
                    <div class="mp-pb-art-wrap">
                        <span class="mp-pb-placeholder">${ICONS.note}</span>
                        <img class="mp-pb-img" id="mpPbImg" alt="" hidden />
                        ${eqMarkup('mp-pb-eq')}
                    </div>
                    <div class="mp-pb-meta">
                        <div class="mp-pb-title" id="mpPbTitle">Nothing playing</div>
                        <div class="mp-pb-sub" id="mpPbSub">Search a song to play</div>
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
                </div>
            </div>

            <div class="mp-row-menu" id="mpRowMenu" hidden></div>
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
    <button type="button" class="mp-mini-btn" id="mpMiniPlay" title="Play" aria-label="Play">${playIconSvg(16, 'mpMiniPlayIcon')}${pauseIconSvg(16, 'mpMiniPauseIcon')}</button>
    <button type="button" class="mp-mini-btn" id="mpMiniNext" title="Next track" aria-label="Next track">${ICONS.next}</button>
    <button type="button" class="mp-mini-close" id="mpMiniClose" title="Stop and hide player" aria-label="Stop and hide player">${ICONS.close}</button>
</div>`;

/**
 * Mounts the music player + mini player modal markup. Called by boot.ts
 * before initMusicPlayer().
 */
export function mountMusicPlayer(): void {
  $(document.body).append(musicPlayerModalHtml + miniPlayerHtml);
}
