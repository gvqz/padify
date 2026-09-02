/**
 * Spotify Web Playback SDK bridge.
 *
 * Loads https://sdk.scdn.co/spotify-player.js on demand and wraps the global
 * `window.Spotify.Player` in a small controller. The SDK streams full tracks
 * inside a hidden iframe — this requires a Spotify **Premium** account; free
 * accounts surface an `account_error` and the player falls back to 30-second
 * previews (HTMLAudio).
 */

import { getAccessToken } from './auth';
import type { SpotifyTrack } from './api';

const SDK_SCRIPT_URL = 'https://sdk.scdn.co/spotify-player.js';
const PLAYER_NAME = 'Padify';

// ---------------------------------------------------------------------------
// SDK typings (minimal — only what we consume)
// ---------------------------------------------------------------------------

export interface WebPlaybackTrackWindow {
    current_track: SpotifyTrack;
    previous_tracks: SpotifyTrack[];
    next_tracks: SpotifyTrack[];
}

export interface WebPlaybackPlayerState {
    device_id?: string;
    context: { uri: string | null; metadata: unknown } | null;
    track_window: WebPlaybackTrackWindow;
    position: number;
    duration: number;
    paused: boolean;
    playback_rate: number;
    disallows?: Record<string, boolean>;
}

export interface WebPlaybackReady {
    device_id: string;
}

export interface WebPlaybackError {
    message: string;
}

interface SdkPlayerInstance {
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: string, listener: (payload: never) => void): boolean;
    removeListener(event: string, listener?: (payload: never) => void): boolean;
    togglePlay(): Promise<void>;
    resume(): Promise<void>;
    pause(): Promise<void>;
    seek(ms: number): Promise<void>;
    setVolume(volume: number): Promise<void>;
    activateElement(): void;
    getCurrentState(): Promise<WebPlaybackPlayerState | null>;
}

type SdkConstructor = new (options: {
    name: string;
    getOAuthToken: (callback: (token: string) => void) => void;
    volume?: number;
}) => SdkPlayerInstance;

interface SpotifyGlobal {
    Player?: SdkConstructor;
}

declare global {
    interface Window {
        Spotify?: SpotifyGlobal;
        onSpotifyWebPlaybackSDKReady?: () => void;
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

let sdkLoading: Promise<void> | null = null;

function loadSdkScript(): Promise<void> {
    if (window.Spotify?.Player) return Promise.resolve();
    if (sdkLoading) return sdkLoading;

    sdkLoading = new Promise<void>((resolve, reject) => {
        window.onSpotifyWebPlaybackSDKReady = () => resolve();

        const script = document.createElement('script');
        script.src = SDK_SCRIPT_URL;
        script.async = true;
        script.onerror = () => reject(new Error('Could not load the Spotify SDK.'));
        document.head.appendChild(script);

        // Safety net: some blockers swallow onSpotifyWebPlaybackSDKReady.
        setTimeout(() => {
            if (window.Spotify?.Player) resolve();
        }, 10_000);
    });
    return sdkLoading;
}

export class SpotifySdkController {
    private player: SdkPlayerInstance | null = null;
    private readyListeners = new Set<(deviceId: string) => void>();
    private stateListeners = new Set<(state: WebPlaybackPlayerState) => void>();
    private errorListeners = new Set<(message: string) => void>();

    /** Device id assigned once the SDK handshake completes. */
    deviceId: string | null = null;
    /** True from `ready` until `disconnect()` — used for UI badges. */
    isReady = false;

    onReady(listener: (deviceId: string) => void): void {
        this.readyListeners.add(listener);
        if (this.deviceId) listener(this.deviceId);
    }

    onState(listener: (state: WebPlaybackPlayerState) => void): void {
        this.stateListeners.add(listener);
    }

    onError(listener: (message: string) => void): void {
        this.errorListeners.add(listener);
    }

    /**
     * Loads the SDK script and connects the player. Resolves with the device
     * id, or rejects with a human-readable message (free account, blocked
     * iframe, network…).
     */
    async init(): Promise<string> {
        if (this.deviceId) return this.deviceId;

        await loadSdkScript();
        const Player = window.Spotify?.Player;
        if (!Player) {
            throw new Error('Spotify SDK unavailable.');
        }

        this.player = new Player({
            name: PLAYER_NAME,
            getOAuthToken: callback => {
                getAccessToken()
                    .then(callback)
                    .catch(() => {
                        /* auth layer reports failures through its own paths */
                    });
            },
            volume: 0.8
        });

        this.player.addListener('ready' as string, ((payload: WebPlaybackReady) => {
            this.deviceId = payload.device_id;
            this.isReady = true;
            this.readyListeners.forEach(listener => listener(payload.device_id));
        }) as (payload: never) => void);

        this.player.addListener(
            'not_ready' as string,
            (() => {
                this.isReady = false;
            }) as (payload: never) => void
        );

        this.player.addListener(
            'player_state_changed' as string,
            ((state: WebPlaybackPlayerState) => {
                if (state) this.stateListeners.forEach(listener => listener(state));
            }) as (payload: never) => void
        );

        const forwardError = (label: string) =>
            ((payload: WebPlaybackError) => {
                const message = payload?.message || label;
                this.errorListeners.forEach(listener => listener(message));
            }) as (payload: never) => void;

        this.player.addListener('initialization_error' as string, forwardError('Initialization error'));
        this.player.addListener('authentication_error' as string, forwardError('Authentication error'));
        this.player.addListener('account_error' as string, forwardError('Premium required'));
        this.player.addListener('playback_error' as string, forwardError('Playback error'));

        const connected = await this.player.connect();
        if (!connected) {
            throw new Error('Spotify player could not connect.');
        }

        // `ready` usually fires within a second; wait up to 15 s for it.
        return new Promise<string>((resolve, reject) => {
            if (this.deviceId) {
                resolve(this.deviceId);
                return;
            }
            const timeout = setTimeout(() => {
                if (!this.deviceId) {
                    reject(new Error('Spotify player took too long to connect.'));
                }
            }, 15_000);
            this.onReady(deviceId => {
                clearTimeout(timeout);
                resolve(deviceId);
            });
        });
    }

    togglePlay(): Promise<void> {
        if (!this.player) return Promise.reject(new Error('Player not connected.'));
        return this.player.togglePlay();
    }

    pause(): Promise<void> {
        if (!this.player) return Promise.reject(new Error('Player not connected.'));
        return this.player.pause();
    }

    resume(): Promise<void> {
        if (!this.player) return Promise.reject(new Error('Player not connected.'));
        return this.player.resume();
    }

    seek(ms: number): Promise<void> {
        if (!this.player) return Promise.reject(new Error('Player not connected.'));
        return this.player.seek(ms);
    }

    setVolume(volume: number): Promise<void> {
        if (!this.player) return Promise.resolve();
        return this.player.setVolume(Math.max(0, Math.min(1, volume)));
    }

    disconnect(): void {
        this.player?.disconnect();
        this.player = null;
        this.deviceId = null;
        this.isReady = false;
    }
}
