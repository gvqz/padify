/**
 * Padify API — rate limiting and sign-in lockout.
 *
 * Fixed-window, per key, in memory. Two defenses with different keys:
 *
 *  • Rate buckets pace endpoints per client (or per account, when the
 *    caller is signed in). Which proxy hop is trusted is explicit — see
 *    clientKey.
 *  • Sign-in lockout counts FAILED VERIFICATIONS per account, so it
 *    outlives any address rotation: the account being guessed at is the
 *    one thing the attacker cannot change.
 */

const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Buckets for keys that never come back would otherwise sit in the map for
// the lifetime of the process; sweep expired entries so memory stays flat
// on a long-lived always-data host.
const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
  for (const [key, entry] of authFailures) {
    if (entry.resetAt <= now) {
      authFailures.delete(key);
    }
  }
}, 5 * 60_000);
// Never keep a process alive for the sweeper (tests import this module).
rateSweep.unref?.();

/** Test hook — forget every bucket and lockout between tests. */
export function resetRateLimitsForTests(): void {
  rateBuckets.clear();
  authFailures.clear();
}

/**
 * The key a rate-limit bucket hangs on.
 *
 * x-forwarded-for is client-forgeable end to end: any hop that appends
 * instead of replacing lets a spoofed value ride the whole chain, and with
 * no proxy in front at all the header is just attacker text. The chain is
 * therefore only read when TRUST_PROXY_HOPS declares how many proxies in
 * front of this server are trusted to append truthful addresses — and the
 * value taken is the one the CLOSEST trusted proxy observed (rightmost
 * minus hops), never the first entry. With the default 0 nothing is
 * trusted and every caller shares the one 'local' bucket: over-strict,
 * never spoofable. Deployments behind the repo's Caddyfile (which sets
 * X-Forwarded-For to the address it actually saw) set TRUST_PROXY_HOPS=1
 * to get honest per-IP buckets back; see docs/CLOUD_SETUP.md.
 */
export function clientKey(request: Request): string {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
  if (Number.isFinite(hops) && hops > 0) {
    const forwarded = request.headers.get('x-forwarded-for');
    const parts = forwarded?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    const index = parts.length - Math.floor(hops);
    if (index >= 0 && index < parts.length) {
      return parts[index]!;
    }
  }
  return 'local';
}

export function rateLimited(
  request: Request,
  bucket: 'auth' | 'api' | 'music-search' | 'music-resolve' | 'share',
  subject?: string,
): boolean {
  const limits: Record<string, number> = {
    auth: 30,
    api: 300,
    'music-search': 60,
    // Actual yt-dlp WORK only (cached answers never charge the bucket —
    // see handleMusicResolve): 60 resolutions/min is still a heavy load
    // cap, but it no longer counts plays.
    'music-resolve': 60,
    share: 120
  };
  const limit = limits[bucket] ?? 300;
  // Authenticated traffic keys its bucket on the account, not the address:
  // a shared or spoofed IP then cannot pace someone else's requests, and
  // a signing-in stranger cannot get fresh buckets by rotating addresses.
  const key = subject ?? clientKey(request);
  const now = Date.now();
  const entry = rateBuckets.get(`${bucket}:${key}`);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(`${bucket}:${key}`, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

// ---------------------------------------------------------------------------
// Sign-in lockout — the brute-force defense that does not depend on
// addresses at all: failed verifications are counted PER ACCOUNT. A lockout
// outlives any IP rotation because it keys on the one thing the attacker
// cannot change: the account being guessed at.
// ---------------------------------------------------------------------------

const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
const AUTH_FAILURE_LIMIT = 8;
const authFailures = new Map<string, { count: number; resetAt: number }>();

/** True when this account burned through its failed-verification budget. */
export function signinBlocked(email: string): boolean {
  const entry = authFailures.get(email);
  return !!entry && entry.resetAt > Date.now() && entry.count >= AUTH_FAILURE_LIMIT;
}

/** One more failed verification against this account. */
export function recordSigninFailure(email: string): void {
  const now = Date.now();
  const entry = authFailures.get(email);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(email, { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** A successful sign-in clears the account's failure count. */
export function clearSigninFailures(email: string): void {
  authFailures.delete(email);
}
