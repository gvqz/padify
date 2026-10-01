/**
 * Padify storage — durable-storage stewardship.
 *
 * IndexedDB is "best effort" territory in the browser: under storage
 * pressure the engine may evict the whole database, and quota exhaustion
 * makes every write silently fail. The notes layer already retries on the
 * next change (see notes.ts), but a failing save was until now only a
 * console.warn — the user kept typing under a "Saved" indicator while
 * nothing landed. This module owns the two halves of fixing that:
 *
 *  1. DURABILITY: ask for navigator.storage.persist() — a granted request
 *     moves the padify database out of the evictable "best effort" bucket,
 *     and (in Chromium) raises the quota ceiling. Asked at boot and once
 *     more after the first user interaction, because the grant heuristics
 *     favour engaged installs. Silent by design: durability is not a
 *     notification-worthy event, and a denied request changes nothing.
 *
 *  2. HONESTY: a save-health signal the UI can subscribe to. notes.ts
 *     reports every failed write (quota vs other) and every recovery;
 *     the save indicator turns the signal into a persistent warning the
 *     user can actually read. On a quota failure the module also asks for
 *     persist() again — the failing write itself is engagement evidence —
 *     and surfaces one estimate-based hint about how much room is left.
 *
 * Everything here degrades silently: environments without
 * navigator.storage (the fallback backend, tests, workers) get a no-op,
 * never an exception.
 */

export type StorageSaveHealth =
  { state: 'healthy' } | { state: 'failing'; cause: 'quota' | 'other'; detail?: string };

let health: StorageSaveHealth = { state: 'healthy' };
const listeners = new Set<(health: StorageSaveHealth) => void>();

/** True when the failure looks like storage pressure, not a bug. */
function quotaLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError';
  }
  const name = error instanceof Error ? error.name : '';
  return name === 'QuotaExceededError';
}

/**
 * A save write failed. Called from notes.ts's write-behind catch. Notifies
 * subscribers only on a HEALTH TRANSITION — a burst of failed keystroke
 * saves is one warning, not one per keystroke.
 */
export function reportSaveFailure(error: unknown): void {
  const cause = quotaLikeError(error) ? 'quota' : 'other';
  const detail = error instanceof Error ? error.message : undefined;
  if (health.state === 'failing' && health.cause === cause) {
    return; // already reported — the indicator stays up until recovery
  }
  health = { state: 'failing', cause, detail };
  listeners.forEach((listener) => listener(health));

  // The failing write is evidence of engagement the persist() heuristics
  // respect — and a granted request raises the quota ceiling in Chromium.
  void requestPersistentStorage();
}

/**
 * A save write landed again after failures. Called from notes.ts when the
 * retried write resolves. Subscribers hear about the recovery.
 */
export function reportSaveRecovered(): void {
  if (health.state === 'healthy') {
    return;
  }
  health = { state: 'healthy' };
  listeners.forEach((listener) => listener(health));
}

/** The current save health (the UI reads this on wiring). */
export function storageSaveHealth(): StorageSaveHealth {
  return health;
}

/**
 * Subscribes to save-health transitions. Returns an unsubscriber.
 */
export function onStorageSaveHealth(listener: (health: StorageSaveHealth) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook — forget any failure state between tests. */
export function resetPersistenceForTests(): void {
  health = { state: 'healthy' };
  listeners.clear();
}

// ---------------------------------------------------------------------------
// Durability and estimates
// ---------------------------------------------------------------------------

/**
 * Asks the browser to mark the app's storage as persistent. Resolves with
 * 'granted' or 'denied' when an answer came, 'unavailable' when the API
 * does not exist. Never rejects.
 */
export function requestPersistentStorage(): Promise<'granted' | 'denied' | 'unavailable'> {
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') {
    return Promise.resolve('unavailable');
  }
  return storage
    .persist()
    .then((persisted) => (persisted ? 'granted' : 'denied'))
    .catch(() => 'denied');
}

/**
 * navigator.storage.estimate(), when available: usage and quota in bytes.
 * Null when the browser cannot answer.
 */
export function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage = navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') {
    return Promise.resolve(null);
  }
  return storage
    .estimate()
    .then((estimate) => ({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }))
    .catch(() => null);
}

/** Warned once per session — the estimate re-checks on every quota failure. */
let quotaWarned = false;

/**
 * Fires a one-per-session toast when the estimate says storage is nearly
 * spent (>= 90%). Imported lazily by the boot wiring, not here — this
 * module lives under src/storage and must not depend on UI code. It
 * returns the message instead, and the caller decides how to show it.
 */
export function quotaWarningMessage(usage: number, quota: number): string | null {
  if (quota <= 0 || usage / quota < 0.9) {
    return null;
  }
  const usedMb = Math.round(usage / (1024 * 1024));
  const totalMb = Math.round(quota / (1024 * 1024));
  return `Storage is almost full (${usedMb} of ${totalMb} MB) — notes may stop saving. Download or clean up large notes.`;
}

/** One-shot estimate check for the boot path. Returns the message, if any. */
export async function checkQuotaOnce(): Promise<string | null> {
  if (quotaWarned) {
    return null;
  }
  const estimate = await estimateStorage();
  if (!estimate) {
    return null;
  }
  const message = quotaWarningMessage(estimate.usage, estimate.quota);
  if (message) {
    quotaWarned = true;
  }
  return message;
}

/** Test hook for the once-per-session guard. */
export function resetQuotaWarningForTests(): void {
  quotaWarned = false;
}
