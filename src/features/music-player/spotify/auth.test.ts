import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin } from './auth';

// The OAuth echo is the only proof that a ?code= callback came from a flow
// THIS browser started. These tests pin the one property that matters:
// when a verifier exists (a flow was started here), no state in the URL —
// or a different one — must never reach the token exchange.

const PKCE_KEY = 'padify-spotify-pkce';
const CLIENT_ID_KEY = 'padify-spotify-client-id';

function seedLoginSession(state: string): void {
  localStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier: 'v'.repeat(64), state, redirect: 'http://localhost:3000/' }),
  );
  localStorage.setItem(CLIENT_ID_KEY, 'test-client-id');
}

function arriveWith(query: string): void {
  window.history.replaceState({}, document.title, `http://localhost:3000/${query}`);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('completeLogin — the state echo', () => {
  it('rejects a callback whose state does not match, before any exchange', async () => {
    seedLoginSession('the-state-we-sent');
    arriveWith('?code=stolen-code&state=something-else');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await completeLogin();

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('state mismatch');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a callback with no state at all — the crafted-URL case', async () => {
    seedLoginSession('the-state-we-sent');
    arriveWith('?code=stolen-code');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await completeLogin();

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('state mismatch');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets a matching state through to the token exchange', async () => {
    seedLoginSession('the-state-we-sent');
    arriveWith('?code=a-real-code&state=the-state-we-sent');
    // The exchange runs and fails on this sentinel — proving the request
    // got PAST the state gate (the gate's own error never mentions tokens).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reached the token endpoint')));

    const result = await completeLogin();

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('reached the token endpoint');
  });
});
