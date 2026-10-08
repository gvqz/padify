/**
 * Padify music player — v4.
 *
 * Free search (zero login) — search a music catalog through the Padify
 * API (metadata only), then play full tracks in a plain HTML5 <audio>
 * element using stream URLs the API resolves with yt-dlp. Users keep
 * local favorites, a local queue and exactly one local playlist, all
 * on-device.
 *
 *   • Ambience is tracks now (./ambient.ts): the twelve bundled loops play
 *     through the same queue/engine/mini player as songs — no mixer tab.
 *
 * The layout: a sidebar switches destinations (search / favorites /
 * playlist / ambience / queue), the content pane lists the rows, and the
 * player bar rides the bottom of the modal. The controller owns the queue
 * math and reacts to engine events; markup lives in markup.ts.
 *
 * Persistence (storage layer → IndexedDB + localStorage mirror):
 *   padify-music-state   volume / shuffle / repeat / view / free queue
 *   padify-music-library local favorites + the single local playlist
 */

import { $ } from '../../lib/q';
import { openModal, closeModal } from '../../ui/behavior/modal';
import Swal from 'sweetalert2';
import type { SweetAlertResult } from 'sweetalert2';
import { showToast } from '../../ui/toast';
import { LocalMusicLibrary } from './music/library';
import {
  fetchMusicCapabilities,
  freeSearchTracks,
  FreeMusicError,
  type MusicCapabilities,
} from './music/client';
import type { SpotifyTrack } from './types';

import { ICONS } from './markup';
import { byId, formatMs, trackArtistNames, pickImage } from './helpers';
import { queueRow, rowMenuItems, trackRow } from './rows';
import { ambientTracks, AMBIENCE_QUEUE_ID } from './ambient';
import {
  REPEAT_MODES,
  loadPlayerState,
  savePlayerState,
  type MusicPlayerState,
  type ViewId,
} from './state';
import {
  endedAction,
  enqueueTrack,
  freeQueueRemaining,
  nextPlayIndex,
  normalizePlayIndex,
  prevPlayIndex,
  removeQueueAt,
} from './queue';
import { FreeEngine, type FreeEngineEvent, type FreeEngineHost } from './free-engine';

export { mountMusicPlayer } from './markup';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type PlayerSource = 'none' | 'free';

const PROGRESS_INTERVAL_MS = 250;
const SEARCH_DEBOUNCE_MS = 350;
const PREVIEW_LABEL = '30s preview';
const FREE_LABEL = 'Free';
const FREE_SEARCH_LIMIT = 24;

const VIEW_IDS: ViewId[] = ['search', 'favorites', 'playlist', 'ambience', 'queue'];

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
  private lastVolumeBeforeMute: number | null = null;

  // ---- free engine (no login): <audio> + resolved stream URLs ----
  /** Lazy closures over the app — nothing runs before the first play. */
  private readonly engineHost: FreeEngineHost = {
    volume: () => this.state.volume,
    canResolve: () => this.canResolveNow(),
    activeFreeTrack: () => (this.source === 'free' ? this.currentFreeTrack() : null),
    notify: (event) => this.handleEngineEvent(event),
  };
  private readonly engine = new FreeEngine(this.engineHost);

  // ---- local (on-device) library ----
  private library = new LocalMusicLibrary();

  // ---- capabilities of this deployment's API ----
  private caps: MusicCapabilities = { search: false, resolve: false };
  private capsChecked = false;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic search token — stale responses must never clobber fresh ones. */
  private searchSeq = 0;

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

  private readonly navItems: HTMLButtonElement[];
  private readonly views: Record<ViewId, HTMLElement>;
  private readonly playlistNavName: HTMLElement;

  private readonly searchInput: HTMLInputElement;
  private readonly searchNotice: HTMLElement;
  private readonly searchIdle: HTMLElement;
  private readonly resultsView: HTMLElement;
  private readonly resultsList: HTMLElement;
  private readonly resultsEmpty: HTMLElement;
  private readonly resultsCount: HTMLElement;

  private readonly favoritesList: HTMLElement;
  private readonly favoritesEmpty: HTMLElement;
  private readonly favCount: HTMLElement;

  private readonly localPlaylistList: HTMLElement;
  private readonly localPlaylistEmpty: HTMLElement;
  private readonly playlistName: HTMLElement;
  private readonly playlistCount: HTMLElement;
  private readonly playlistRename: HTMLButtonElement;
  private readonly playlistClear: HTMLButtonElement;

  private readonly ambienceList: HTMLElement;

  private readonly queueCount: HTMLElement;
  private readonly queueList: HTMLElement;
  private readonly queueEmpty: HTMLElement;
  private readonly queueClear: HTMLButtonElement;

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

    this.navItems = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.mp-nav-item'));
    this.views = {
      search: byId('mpView-search'),
      favorites: byId('mpView-favorites'),
      playlist: byId('mpView-playlist'),
      ambience: byId('mpView-ambience'),
      queue: byId('mpView-queue'),
    };
    this.playlistNavName = byId('mpPlaylistNavName');

    this.searchInput = byId('mpSearchInput');
    this.searchNotice = byId('mpSearchNotice');
    this.searchIdle = byId('mpSearchIdle');
    this.resultsView = byId('mpResults');
    this.resultsList = byId('mpResultsList');
    this.resultsEmpty = byId('mpResultsEmpty');
    this.resultsCount = byId('mpResultsCount');

    this.favoritesList = byId('mpFavoritesList');
    this.favoritesEmpty = byId('mpFavoritesEmpty');
    this.favCount = byId('mpFavCount');

    this.localPlaylistList = byId('mpLocalPlaylistList');
    this.localPlaylistEmpty = byId('mpLocalPlaylistEmpty');
    this.playlistName = byId('mpPlaylistName');
    this.playlistCount = byId('mpPlaylistCount');
    this.playlistRename = byId('mpPlaylistRename');
    this.playlistClear = byId('mpPlaylistClear');

    this.ambienceList = byId('mpAmbienceList');

    this.queueCount = byId('mpQueueCount');
    this.queueList = byId('mpQueueList');
    this.queueEmpty = byId('mpQueueEmpty');
    this.queueClear = byId('mpQueueClear');

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
    this.switchView(this.state.view || 'search');

    // Initial slider fills.
    this.setRangeFill(this.seek);
    this.setRangeFill(this.volumeInput);

    this.renderLibrary();
    this.renderAmbience();
    this.restoreFreeQueue();
    this.bootstrap();
  }

  // ---- persistence ---------------------------------------------------------

  private loadState(): MusicPlayerState {
    return loadPlayerState();
  }

  private persist(): void {
    savePlayerState(this.state);
  }

  // ========================================================================
  // Free engine — HTML5 <audio> fed by resolved stream URLs (no login).
  // The engine (free-engine.ts) owns the element and the resolve/retry/
  // fallback machine; the controller keeps the queue math and reacts to
  // engine events.
  // ========================================================================

  private currentFreeTrack(): SpotifyTrack | null {
    return this.state.freeQueue[this.state.freeIndex] ?? null;
  }

  /** The engine's lazy capabilities check (once per session). */
  private async canResolveNow(): Promise<boolean> {
    if (!this.capsChecked) await this.checkCapabilities();
    return this.caps.resolve;
  }

  /** Starts playing the queue at `index` through the free engine. */
  private async playFreeAt(index: number, auto = false): Promise<void> {
    const queue = this.state.freeQueue;
    const idx = normalizePlayIndex(
      queue.length,
      index,
      { shuffle: this.state.shuffle, repeat: this.state.repeat },
      auto,
    );
    if (idx === null) return;

    const track = queue[idx];
    if (!track) return;
    this.state.freeIndex = idx;
    this.persist();

    this.engine.pauseIfPlaying();
    this.miniDismissed = false;
    this.source = 'free';
    await this.engine.playTrack(track);
  }

  /** Reflects <audio> play/pause in the bar, rows, mini player and navbar. */
  private handleFreePlaybackState(playing: boolean): void {
    if (this.source !== 'free') return;
    if (playing) {
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

  /** Everything the engine tells the UI, in one dispatcher. */
  private handleEngineEvent(event: FreeEngineEvent): void {
    switch (event.kind) {
      case 'resolving':
        this.syncPlayerBarFree(event.track, false, 'resolve', 'Finding a stream…');
        this.updateRowStates();
        this.updateQueueView();
        this.syncNavbarIcon();
        this.startProgressTimer();
        return;
      case 'retrying':
        this.pbSub.textContent = 'Retrying…';
        return;
      case 'stream':
        this.pbSub.textContent = trackArtistNames(event.track);
        return;
      case 'preview':
        showToast(`${event.message} Playing a 30-second preview instead.`);
        this.syncPlayerBarFree(event.track, false, 'preview');
        return;
      case 'unavailable':
        showToast(event.message);
        this.updatePlayerBarEmpty();
        this.updateRowStates();
        this.updateQueueView();
        return;
      case 'playback':
        this.handleFreePlaybackState(event.playing);
        return;
      case 'time':
        if (this.source === 'free') this.updateProgress();
        return;
      case 'metadata':
        if (this.source === 'free') {
          const total = this.currentDurationMs();
          this.timeTotal.textContent = formatMs(total);
          this.seek.setAttribute('aria-valuetext', formatMs(this.currentPositionMs()));
        }
        return;
      case 'ended':
        this.handleFreeEnded();
        return;
      case 'autoplay-blocked':
        showToast('Tap play to start the audio.');
        return;
    }
  }

  private handleFreeEnded(): void {
    if (this.source !== 'free') return;
    const action = endedAction(
      this.state.freeQueue.length,
      this.state.freeIndex,
      this.state.repeat,
    );
    if (action.kind === 'replay') {
      void this.playFreeAt(this.state.freeIndex, true);
      return;
    }
    if (action.kind === 'play') {
      void this.playFreeAt(action.index, true);
      return;
    }
    this.updatePlayerBarEmpty();
    this.updateRowStates();
    this.updateQueueView();
  }

  private freeNext(auto = false): void {
    const queue = this.state.freeQueue;
    const next = nextPlayIndex(
      queue.length,
      this.state.freeIndex,
      { shuffle: this.state.shuffle, repeat: this.state.repeat },
      auto,
    );
    if (next === null) return;
    if (next === 'stop') {
      this.updatePlayerBarEmpty();
      return;
    }
    void this.playFreeAt(next);
  }

  private freePrev(): void {
    const track = this.currentFreeTrack();
    if (track && this.engine.restartIfActive()) return;
    const queue = this.state.freeQueue;
    const prevIdx = prevPlayIndex(queue.length, this.state.freeIndex);
    if (prevIdx === null) return;
    void this.playFreeAt(prevIdx);
  }

  /** Appends a track to the free queue (the "+" button). */
  private enqueueFree(track: SpotifyTrack): void {
    const result = enqueueTrack(
      this.state.freeQueue,
      this.state.freeIndex,
      track,
      this.source === 'free',
    );
    this.state.freeQueue = result.queue as SpotifyTrack[];
    this.state.freeIndex = result.index;
    this.persist();
    if (result.kind === 'appended') {
      this.updateQueueView();
      showToast('Added to queue.');
      return;
    }
    // Nothing playing yet — this became the track up next (and now).
    void this.playFreeAt(0);
  }

  /** Restores the persisted free queue display (paused) after a reload. */
  private restoreFreeQueue(): void {
    const track = this.currentFreeTrack();
    if (!track) return;
    this.source = 'free';
    this.engine.resetMode();
    this.syncPlayerBarFree(track, false, 'resolve');
  }

  // ========================================================================
  // Player bar (all sources)
  // ========================================================================

  private isPlaying(): boolean {
    return this.source === 'free' && this.engine.isPlaying;
  }

  private currentDurationMs(): number {
    if (this.source === 'free') {
      if (this.engine.mode === 'preview') return 30_000;
      const audioMs = this.engine.audioDurationMs;
      if (audioMs !== null) return audioMs;
      const track = this.currentFreeTrack();
      return track ? track.duration_ms : 0;
    }
    return 0;
  }

  private currentPositionMs(): number {
    if (this.source === 'free') {
      return this.engine.positionMs;
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
    this.pbSub.textContent = 'Search a song to play';
    this.pbSource.hidden = true;
    this.pbImg.hidden = true;
    this.pbPlaceholder.hidden = false;
    this.timeCurrent.textContent = '0:00';
    this.timeTotal.textContent = '0:00';
    this.seek.value = '0';
    this.setRangeFill(this.seek);
    this.playerBar.classList.remove('is-playing');
    this.updatePlayIcon();
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
      if (!this.engine.hasSource) {
        const track = this.currentFreeTrack();
        if (track) void this.playFreeAt(Math.max(0, this.state.freeIndex));
        return;
      }
      this.engine.toggle();
    }
  }

  next(): void {
    if (this.source === 'free') {
      this.freeNext();
    }
  }

  prev(): void {
    if (this.source === 'free') {
      this.freePrev();
    }
  }

  // ---- volume ------------------------------------------------------------

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
  }

  private toggleShuffle(): void {
    this.state.shuffle = !this.state.shuffle;
    this.persist();
    this.shuffleBtn.classList.toggle('is-on', this.state.shuffle);
    this.shuffleBtn.setAttribute('aria-pressed', String(this.state.shuffle));
    this.shuffleBtn.setAttribute('aria-label', this.state.shuffle ? 'Shuffle on' : 'Shuffle off');
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
      this.engine.seekToMs(posMs);
    }
  }

  // ========================================================================
  // Bootstrap
  // ========================================================================

  private async bootstrap(): Promise<void> {
    await this.checkCapabilities();
  }

  private async checkCapabilities(): Promise<void> {
    this.caps = await fetchMusicCapabilities();
    this.capsChecked = true;
    if (!this.caps.search) {
      this.showSearchNotice('Search needs the Padify music API — it looks offline here.');
    }
  }

  /** Plays a list of tracks starting at `index` through the free engine. */
  private async playTrackList(tracks: SpotifyTrack[], index: number): Promise<void> {
    if (tracks.length === 0) return;
    const startIndex = Math.max(0, Math.min(index, tracks.length - 1));
    this.state.freeQueue = [...tracks];
    await this.playFreeAt(startIndex);
  }

  private showSearchNotice(message: string): void {
    this.searchNotice.textContent = message;
    this.searchNotice.hidden = false;
  }

  private clearSearchNotice(): void {
    this.searchNotice.hidden = true;
  }

  // ========================================================================
  // Library views (favorites + the one local playlist)
  // ========================================================================

  private renderLibrary(): void {
    const favorites = this.library.favorites;
    const playlist = this.library.playlist;

    this.queues.set('favorites', favorites);
    this.favoritesList.innerHTML = favorites.map((track) => trackRow(track, 'favorites')).join('');
    this.favoritesEmpty.hidden = favorites.length > 0;
    this.favCount.textContent = favorites.length > 0 ? `${favorites.length} songs` : '';

    if (playlist) {
      this.queues.set('local-playlist', playlist.tracks);
      this.playlistName.textContent = playlist.name;
      this.playlistNavName.textContent = playlist.name;
      this.localPlaylistList.innerHTML = playlist.tracks
        .map((track) => trackRow(track, 'local-playlist'))
        .join('');
      this.localPlaylistEmpty.hidden = playlist.tracks.length > 0;
      this.playlistCount.textContent =
        playlist.tracks.length > 0 ? `${playlist.tracks.length} songs` : '';
      this.playlistRename.hidden = false;
      this.playlistClear.hidden = playlist.tracks.length === 0;
    } else {
      this.queues.delete('local-playlist');
      this.playlistName.textContent = 'My Playlist';
      this.playlistNavName.textContent = 'Playlist';
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

  /** The ambience list — the same twelve tracks every session. */
  private renderAmbience(): void {
    const tracks = ambientTracks();
    this.queues.set(AMBIENCE_QUEUE_ID, tracks);
    this.ambienceList.innerHTML = tracks
      .map((track) => trackRow(track, AMBIENCE_QUEUE_ID))
      .join('');
    this.refreshRowHearts(this.ambienceList);
    this.updateRowStates();
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
      this.renderLibrary();
    }
  }

  // ========================================================================
  // Rows (shared by every list)
  // ========================================================================

  private renderTrackRows(
    container: HTMLElement,
    tracks: SpotifyTrack[],
    queueId = `q-${Math.random().toString(36).slice(2, 8)}`,
  ): void {
    const withArt: SpotifyTrack[] = tracks.filter((t) => t && t.uri);
    this.queues.set(queueId, withArt);
    container.dataset.queueId = queueId;
    container.innerHTML = withArt.map((track) => trackRow(track, queueId)).join('');
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
    return this.source === 'free' ? (this.currentFreeTrack()?.uri ?? null) : null;
  }

  // ---- hearts (local favorites) ---------------------------------------------

  /** Fills the heart buttons in a freshly rendered list — local favorites. */
  private refreshRowHearts(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>('.sp-row[data-like]').forEach((row) => {
      this.setRowHeart(row, this.library.isFavorite(row.dataset.trackId ?? ''));
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
    const track = this.trackFromRow(row);
    if (!track) return;

    const nowFav = this.library.toggleFavorite(track);
    this.setRowHeart(row, nowFav);
    this.renderLibrary();
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

  // ---- the row action menu (playlist, and friends) -----------------------------

  private openRowMenu(row: HTMLElement, button: HTMLElement): void {
    const track = this.trackFromRow(row);
    if (!track) return;
    this.closeRowMenu();

    this.rowMenu.innerHTML = rowMenuItems({
      localPlaylistName: this.library.playlist?.name ?? null,
    });
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

  private async handleRowMenuAction(action: string, row: HTMLElement): Promise<void> {
    const track = this.trackFromRow(row);
    if (!track) return;

    if (action === 'queue') {
      this.enqueueFree(track);
      return;
    }

    if (action === 'local-playlist') {
      const result = this.library.addToPlaylist(track);
      if (result === 'duplicate') showToast('Already in your playlist.');
      else if (result === 'full') showToast('Your playlist is full (300 songs).');
      else if (result === 'created') showToast('Playlist started — rename it any time.');
      else showToast('Added to your playlist.');
      this.renderLibrary();
      return;
    }
  }

  // ========================================================================
  // Search (the free catalog through the Padify API)
  // ========================================================================

  private showSearchIdle(): void {
    this.searchIdle.hidden = false;
    this.resultsView.hidden = true;
  }

  private showSearchResults(): void {
    this.searchIdle.hidden = true;
    this.resultsView.hidden = false;
  }

  private async runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    const seq = ++this.searchSeq;
    if (trimmed.length < 2) {
      this.showSearchIdle();
      this.clearSearchNotice();
      return;
    }

    if (!this.capsChecked) await this.checkCapabilities();
    if (seq !== this.searchSeq) return; // a newer keystroke won
    if (!this.caps.search) {
      this.showSearchNotice('Search needs the Padify music API — it looks offline here.');
      return;
    }
    this.clearSearchNotice();

    this.showSearchResults();
    this.resultsList.innerHTML =
      '<div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div><div class="sp-skeleton-row"></div>';
    this.resultsEmpty.hidden = true;

    try {
      const tracks = await freeSearchTracks(trimmed, FREE_SEARCH_LIMIT);
      if (seq !== this.searchSeq) return; // stale response — drop it
      this.renderTrackRows(this.resultsList, tracks, 'free-search');
      this.resultsCount.textContent = tracks.length > 0 ? `${tracks.length} songs` : '';
      this.resultsEmpty.hidden = tracks.length > 0;
    } catch (err) {
      if (seq !== this.searchSeq) return; // stale failure — drop it too
      this.resultsList.innerHTML = '';
      this.resultsCount.textContent = '';
      this.resultsEmpty.hidden = true;
      this.showSearchNotice(
        err instanceof FreeMusicError ? err.message : 'Search failed — try again.',
      );
    }
  }

  // ========================================================================
  // Queue view
  // ========================================================================

  private updateQueueCount(): void {
    const remaining = freeQueueRemaining(this.state.freeQueue.length, this.state.freeIndex);
    this.queueCount.textContent = remaining > 0 ? String(remaining) : '';
    this.queueCount.hidden = remaining === 0;
  }

  private updateQueueView(): void {
    this.updateQueueCount();
    if (this.views.queue.hidden) return;

    const queue = this.state.freeQueue;
    this.queueClear.hidden = queue.length === 0;
    this.queueList.innerHTML = queue.map((track, index) => queueRow(track, index)).join('');
    this.queueEmpty.hidden = queue.length > 0;
    this.refreshRowHearts(this.queueList);
    this.updateRowStates();
  }

  private removeFromQueue(index: number): void {
    const result = removeQueueAt(this.state.freeQueue, this.state.freeIndex, index);
    if (!result) return;
    this.state.freeQueue = result.queue as SpotifyTrack[];
    this.state.freeIndex = result.index;
    if (result.wasCurrent) {
      if (result.emptied) {
        this.source = 'none';
        this.engine.stop();
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
      this.engine.stop();
      this.updatePlayerBarEmpty();
    }
    this.updateQueueView();
    this.updateRowStates();
  }

  // ========================================================================
  // Views (the sidebar)
  // ========================================================================

  private switchView(view: ViewId): void {
    this.state.view = view;
    this.persist();
    for (const id of VIEW_IDS) {
      const active = id === view;
      this.views[id].hidden = !active;
    }
    for (const item of this.navItems) {
      const active = (item.dataset.view as ViewId) === view;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    }
    if (view === 'queue') this.updateQueueView();
    if (view === 'search' && this.root.classList.contains('in')) {
      this.searchInput.focus();
    }
  }

  // ========================================================================
  // Mini player
  // ========================================================================

  /** Hides the mini player until the next track starts. */
  private miniDismissed = false;

  private updateMini(): void {
    const hasContent = this.source === 'free' && this.currentFreeTrack() !== null;
    const modalOpen = this.root.classList.contains('in');
    this.mini.hidden = !hasContent || modalOpen || this.miniDismissed;
    if (!hasContent) return;

    let title = '';
    let sub = '';
    let artUrl: string | null = null;

    const track = this.currentFreeTrack();
    if (track) {
      title = track.name;
      sub = trackArtistNames(track);
      artUrl = pickImage(track.album?.images, 1);
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
      this.engine.stop();
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
    const should = this.isPlaying();
    const has = iconEl.classList.contains('is-playing');
    if (has !== should) {
      iconEl.classList.toggle('is-playing', should);
    }
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
    // Sidebar navigation.
    for (const item of this.navItems) {
      item.addEventListener('click', () => this.switchView(item.dataset.view as ViewId));
    }

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

    // ---- local library views ----
    this.playlistRename.addEventListener('click', () => {
      void this.renameLocalPlaylist();
    });
    this.playlistClear.addEventListener('click', () => {
      if (!this.library.playlist) return;
      this.library.playlist.tracks = [];
      this.library.persist();
      this.renderLibrary();
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
      this.showSearchIdle();
      this.searchInput.focus();
    });

    // ---- track rows (delegated across every list) ----
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      // Row action menu items.
      if (this.rowMenu.hidden === false && this.rowMenu.contains(target)) {
        const item = target.closest('.mp-row-menu-item') as HTMLElement | null;
        if (item) {
          const row = this.rowMenu.closest('.sp-row') as HTMLElement | null;
          const action = item.dataset.action ?? '';
          this.closeRowMenu();
          if (row) void this.handleRowMenuAction(action, row);
        }
        return;
      }

      const row = target.closest('.sp-row') as HTMLElement | null;

      if (row) {
        if (target.closest('[data-remove]')) {
          this.removeFromQueue(Number(row.dataset.queueIndex));
          return;
        }
        if (target.closest('[data-menu]')) {
          const button = target.closest('[data-menu]') as HTMLElement;
          this.openRowMenu(row, button);
          return;
        }
        if (target.closest('[data-queue-add]')) {
          const track = this.trackFromRow(row);
          if (track) this.enqueueFree(track);
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
          void this.playFreeAt(queueIndex);
          return;
        }
        const queue = queueId ? this.queues.get(queueId) : undefined;
        if (queue && trackId) {
          const index = queue.findIndex((track) => track.id === trackId);
          void this.playTrackList(queue, Math.max(0, index));
        }
        return;
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

    // ---- Mini player ----
    byId('mpMiniOpen').addEventListener('click', () => {
      openModal($('#musicPlayerModal').get(0));
    });
    this.miniPlay.addEventListener('click', () => this.togglePlay());
    byId('mpMiniNext').addEventListener('click', () => this.next());
    byId('mpMiniClose').addEventListener('click', () => this.stopAndHideMini());

    // ---- Modal visibility: mini player + progress refresh ----
    $(this.root)
      .on('shown.bs.modal', () => {
        this.updateProgress();
        this.updateMini();
        this.syncNavbarIcon();
        this.updateQueueView();
        if (this.state.view === 'search') this.searchInput.focus();
      })
      .on('hidden.bs.modal', () => {
        this.updateMini();
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
      if (this.source !== 'free' || !this.engine.hasSource) return;
      event.preventDefault();
      const delta = key === 'ArrowLeft' ? -5 : 5;
      this.engine.nudgeSeconds(delta);
    });
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
    openModal($('#musicPlayerModal').get(0));
  },
  close: () => {
    closeModal($('#musicPlayerModal').get(0));
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
