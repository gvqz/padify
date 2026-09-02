/**
 * Spotify OAuth 2.0 — Authorization Code flow with PKCE.
 *
 * Padify is a static site, so the whole flow runs in the browser:
 *
 *   1. `beginLogin()`   → redirect to accounts.spotify.com/authorize with a
 *                         S256 code challenge derived from a random verifier.
 *   2. `completeLogin()`→ exchange ?code= for tokens at /api/token (CORS is
 *                         allowed for PKCE exchanges — no client secret).
 *   3. `getAccessToken()`→ returns a valid token, refreshing it when it is
 *                         about to expire.
 *
 * The user's Spotify app Client ID (from developer.spotify.com/dashboard) is
 * stored in localStorage — see the Connect screen in the music player.
 */

export interface SpotifyAuthSession {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds when the access token expires. */
    expiresAt: number;
    scope: string;
}

const AUTH_STORAGE_KEY = 'padify-spotify-auth';
const PKCE_STORAGE_KEY = 'padify-spotify-pkce';
export const CLIENT_ID_STORAGE_KEY = 'padify-spotify-client-id';
/** Set right before leaving for the authorize page, read on return. */
const RETURN_FLAG_KEY = 'padify-spotify-return';

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';

export const SPOTIFY_SCOPES = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-library-read',
    'user-library-modify',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-top-read',
    'user-read-recently-played'
].join(' ');

/** Refresh this many ms before the actual expiry. */
const EXPIRY_MARGIN_MS = 30_000;

export class SpotifyAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpotifyAuthError';
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length: number): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes).slice(0, length);
}

async function sha256Base64Url(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return base64UrlEncode(new Uint8Array(digest));
}

/** The page Spotify should send the user back to (origin + current path). */
export function getRedirectUri(): string {
    const path = window.location.pathname.replace(/index\.html$/, '');
    return `${window.location.origin}${path || '/'}`;
}

// ---------------------------------------------------------------------------
// Client ID
// ---------------------------------------------------------------------------

export function getClientId(): string | null {
    try {
        const value = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
        return value && value.trim() ? value.trim() : null;
    } catch {
        return null;
    }
}

export function saveClientId(clientId: string): void {
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId.trim());
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export function getSession(): SpotifyAuthSession | null {
    try {
        const raw = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<SpotifyAuthSession>;
        if (
            typeof parsed.accessToken !== 'string' ||
            typeof parsed.refreshToken !== 'string' ||
            typeof parsed.expiresAt !== 'number'
        ) {
            return null;
        }
        return {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            expiresAt: parsed.expiresAt,
            scope: typeof parsed.scope === 'string' ? parsed.scope : ''
        };
    } catch {
        return null;
    }
}

function saveSession(session: SpotifyAuthSession): void {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    } catch {
        /* storage unavailable — session lives for this page only */
    }
}

export function isAuthenticated(): boolean {
    return getSession() !== null;
}

export function disconnect(): void {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(PKCE_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export async function beginLogin(): Promise<void> {
    const clientId = getClientId();
    if (!clientId) {
        throw new SpotifyAuthError('Missing Spotify Client ID');
    }

    const verifier = randomString(64);
    const state = randomString(16);
    const codeChallenge = await sha256Base64Url(verifier);
    try {
        localStorage.setItem(
            PKCE_STORAGE_KEY,
            JSON.stringify({ verifier, state, redirect: getRedirectUri() })
        );
        localStorage.setItem(RETURN_FLAG_KEY, '1');
    } catch {
        /* proceed without persistence — the exchange will fail gracefully */
    }

    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: getRedirectUri(),
        scope: SPOTIFY_SCOPES,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        state
    });

    window.location.assign(`${AUTHORIZE_ENDPOINT}?${params.toString()}`);
}

export interface LoginResult {
    ok: boolean;
    error?: string;
}

/**
 * Runs on page load. Detects the OAuth redirect response in the URL, exchanges
 * the code for tokens when present, and cleans the URL. Returns the outcome so
 * the player can greet the returning user.
 */
export async function completeLogin(): Promise<LoginResult | null> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const returnedState = params.get('state');
    if (!code && !error) return null;

    let verifier: string | null = null;
    let expectedState: string | null = null;
    let redirect: string | null = null;
    try {
        const raw = localStorage.getItem(PKCE_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as {
                verifier?: string;
                state?: string;
                redirect?: string;
            };
            verifier = parsed.verifier ?? null;
            expectedState = parsed.state ?? null;
            redirect = parsed.redirect ?? null;
        }
    } catch {
        /* corrupted storage — treat as missing */
    }
    localStorage.removeItem(PKCE_STORAGE_KEY);

    // Strip the OAuth params from the address bar.
    window.history.replaceState(
        {},
        document.title,
        window.location.origin + window.location.pathname
    );

    if (error) {
        return { ok: false, error: describeError(error, params.get('error_description')) };
    }

    if (!verifier) {
        return { ok: false, error: 'Login session expired — try connecting again.' };
    }
    if (expectedState && returnedState && expectedState !== returnedState) {
        return { ok: false, error: 'Login verification failed (state mismatch). Try again.' };
    }

    const clientId = getClientId();
    if (!clientId) {
        return { ok: false, error: 'Missing Spotify Client ID.' };
    }

    try {
        const session = await requestTokens({
            grant_type: 'authorization_code',
            code: code as string,
            redirect_uri: redirect || getRedirectUri(),
            client_id: clientId,
            code_verifier: verifier
        });
        saveSession(session);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Token exchange failed.' };
    }
}

export function consumedReturnFlag(): boolean {
    try {
        if (localStorage.getItem(RETURN_FLAG_KEY) !== '1') return false;
        localStorage.removeItem(RETURN_FLAG_KEY);
        return true;
    } catch {
        return false;
    }
}

function describeError(code: string, description: string | null): string {
    if (code === 'access_denied') return 'Connection cancelled.';
    return description || `Spotify returned “${code}”.`;
}

// ---------------------------------------------------------------------------
// Token requests
// ---------------------------------------------------------------------------

interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
}

async function requestTokens(
    body: Record<string, string>
): Promise<SpotifyAuthSession> {
    const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString()
    });

    if (!response.ok) {
        let message = `Spotify responded ${response.status}`;
        try {
            const data = (await response.json()) as { error?: string; error_description?: string };
            if (data.error_description) message = data.error_description;
            else if (data.error) message = data.error;
        } catch {
            /* non-JSON error body */
        }
        throw new Error(message);
    }

    const data = (await response.json()) as TokenResponse;
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? body.refresh_token ?? '',
        expiresAt: Date.now() + data.expires_in * 1000,
        scope: data.scope ?? ''
    };
}

/**
 * Returns an access token that is still valid, refreshing it if needed.
 * Throws SpotifyAuthError when there is no session or refresh fails.
 */
export async function getAccessToken(): Promise<string> {
    const session = getSession();
    if (!session) {
        throw new SpotifyAuthError('Not connected to Spotify.');
    }
    if (Date.now() < session.expiresAt - EXPIRY_MARGIN_MS) {
        return session.accessToken;
    }
    return refreshAccessToken();
}

/**
 * Refreshes the access token even when it does not look expired — used when
 * the Web API answers 401 (token revoked elsewhere). Disconnects the session
 * when the refresh is rejected.
 */
export async function refreshAccessToken(): Promise<string> {
    const session = getSession();
    if (!session || !session.refreshToken) {
        disconnect();
        throw new SpotifyAuthError('Spotify session expired — please reconnect.');
    }

    const clientId = getClientId();
    if (!clientId) {
        disconnect();
        throw new SpotifyAuthError('Missing Spotify Client ID.');
    }

    try {
        const refreshed = await requestTokens({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: clientId
        });
        saveSession(refreshed);
        return refreshed.accessToken;
    } catch {
        disconnect();
        throw new SpotifyAuthError('Spotify session expired — please reconnect.');
    }
}
