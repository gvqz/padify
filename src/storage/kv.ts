/**
 * Padify storage — settings key/value store.
 *
 * Replaces direct localStorage access for every small setting (theme, fonts,
 * typewriter volume, sessions, …). Semantics are identical to the
 * localStorage API on purpose:
 *
 *   stateGet(key)     → string | null, synchronous
 *   stateSet(key, v)  → void, synchronous
 *   stateRemove(key)  → void, synchronous
 *
 * In IndexedDB mode the synchronous reads are served from an in-memory mirror
 * hydrated at boot (see index.ts), so consumers never change their call
 * shapes; writes land in IndexedDB shortly after via a coalesced transaction.
 *
 * Two properties worth knowing about:
 *
 *  • Write-through to localStorage. Every set/remove also updates
 *    localStorage synchronously (same cost as the pre-storage code). This
 *    keeps pre-IndexedDB service-worker versions of the PWA — which can run
 *    alongside the new one for a while — reading fresh settings, and keeps
 *    the inline pre-paint theme script in index.html working. It doubles as
 *    a durable backup: if IndexedDB alone is wiped, the next boot re-imports.
 *
 *  • Fallback backend. When IndexedDB is unavailable the functions are
 *    literally localStorage calls — the app degrades to its old behaviour.
 */

import { KV_STORE, storageBackend, writeAll } from './idb';

export interface KvRow {
  key: string;
  value: string;
}

/** Hydrated mirror — the synchronous read source in IndexedDB mode. */
const mirror = new Map<string, string>();

/** Coalesced pending writes (IndexedDB mode). */
let pendingPuts = new Map<string, string>();
let pendingDeletes = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Batching window for kv writes — settings change on user clicks, not typing. */
const KV_FLUSH_DELAY_MS = 150;

/** Boot hook: fills the mirror from the database rows. */
export function hydrateKv(rows: KvRow[]): void {
  rows.forEach((row) => {
    if (row && typeof row.key === 'string' && typeof row.value === 'string') {
      mirror.set(row.key, row.value);
    }
  });
}

/**
 * Migration hook: imports a legacy localStorage key into the mirror and
 * queues the IndexedDB write. Does NOT touch localStorage — the value comes
 * from there and stays put (legacy keys are kept frozen as a backup).
 */
export function importLegacyKey(key: string, value: string): void {
  mirror.set(key, value);
  pendingDeletes.delete(key);
  pendingPuts.set(key, value);
}

export function stateGet(key: string): string | null {
  if (storageBackend() === 'local-storage') {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return mirror.get(key) ?? null;
}

export function stateSet(key: string, value: string): void {
  if (storageBackend() === 'local-storage') {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — the setting lives for this page only */
    }
    return;
  }

  // Write-through: the localStorage copy feeds old app versions and the
  // pre-paint theme script; the IndexedDB copy is the durable one.
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded — the mirror is best-effort */
  }

  mirror.set(key, value);
  pendingDeletes.delete(key);
  pendingPuts.set(key, value);
  scheduleFlush();
}

export function stateRemove(key: string): void {
  if (storageBackend() === 'local-storage') {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    return;
  }

  try {
    localStorage.removeItem(key);
  } catch {
    /* quota / unavailable — best-effort mirror */
  }

  mirror.delete(key);
  pendingPuts.delete(key);
  pendingDeletes.add(key);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushKv();
  }, KV_FLUSH_DELAY_MS);
}

/**
 * Flushes the coalesced kv writes in one transaction. Called on the flush
 * timer, at pagehide, and by the boot migration. Failed batches are
 * re-queued so the next flush retries them.
 */
export async function flushKv(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingPuts.size === 0 && pendingDeletes.size === 0) {
    return;
  }

  const puts: KvRow[] = [...pendingPuts].map(([key, value]) => ({ key, value }));
  const deletes = [...pendingDeletes];
  pendingPuts = new Map();
  pendingDeletes = new Set();

  try {
    await writeAll(KV_STORE, puts, deletes);
  } catch (error) {
    console.warn('[storage] kv flush failed — retrying on the next change', error);
    puts.forEach((row) => pendingPuts.set(row.key, row.value));
    deletes.forEach((key) => pendingDeletes.add(key));
  }
}

/** Boot hook / test hook: drops all pending writes without flushing. */
export function resetKvForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  mirror.clear();
  pendingPuts = new Map();
  pendingDeletes = new Set();
}
