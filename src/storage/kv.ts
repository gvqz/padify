/**
 * Padify storage — settings key/value store.
 *
 * Replaces direct localStorage access for every small setting (theme, fonts,
 * writing sessions, …). Semantics are identical to the
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
  /** Monotonic write sequence — the tie-breaker when the two stores disagree (see below). */
  v?: number;
}

/** Hydrated mirror — the synchronous read source in IndexedDB mode. */
const mirror = new Map<string, string>();

/** Coalesced pending writes (IndexedDB mode). */
let pendingPuts = new Map<string, KvRow>();
/** Pending deletes — the value is the write sequence of the delete. */
let pendingDeletes = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Batching window for kv writes — settings change on user clicks, not typing. */
const KV_FLUSH_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// Write sequence bookkeeping
// ---------------------------------------------------------------------------

/**
 * The dual-write problem this solves: every set writes localStorage
 * synchronously but IndexedDB only after the coalescing window. If the
 * page dies inside that window (fast tab close, reload, crash) the newest
 * value survives ONLY in localStorage — and the old boot order trusted
 * IndexedDB as the incumbent, silently resurrecting stale settings.
 * (Found by the music player's e2e: switch tab → reload within 150ms and
 * the restored view was always the pre-switch one.)
 *
 * `padify-kv-vseq` in localStorage is the durable record of the NEWEST
 * operation per key: a monotonic counter plus, per key, the sequence
 * number and whether it was a set or a delete. Each IndexedDB row carries
 * the sequence it committed as `v`. At boot, any vseq entry newer than its
 * committed row means the IndexedDB copy is stale: a set recovers from the
 * localStorage mirror, a delete is re-applied. Entries prune once their
 * write lands in IndexedDB.
 *
 * Cross-tab: the counter is read fresh from localStorage on every mutation
 * (read-merge-write), so it stays monotonic across tabs. Two tabs writing
 * the same key in the same millisecond can still tie — last flush wins,
 * exactly the pre-existing behaviour.
 */
const LS_VSEQ_KEY = 'padify-kv-vseq';

type VseqOp = 's' | 'd';
interface VseqState {
  n: number;
  keys: Record<string, [v: number, op: VseqOp]>;
}

let seq: VseqState = { n: 0, keys: {} };
/** The v each key's IndexedDB row actually committed (0 = unversioned/none). */
const rowVersions = new Map<string, number>();

function readVseqFromLs(): VseqState {
  try {
    const raw = localStorage.getItem(LS_VSEQ_KEY);
    if (!raw) return { n: 0, keys: {} };
    const parsed = JSON.parse(raw) as Partial<VseqState>;
    const keys: VseqState['keys'] = {};
    if (parsed.keys && typeof parsed.keys === 'object') {
      for (const [key, entry] of Object.entries(parsed.keys)) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'number' &&
          (entry[1] === 's' || entry[1] === 'd')
        ) {
          keys[key] = [entry[0], entry[1]];
        }
      }
    }
    return { n: typeof parsed.n === 'number' ? parsed.n : 0, keys };
  } catch {
    return { n: 0, keys: {} };
  }
}

/**
 * Read-merge-write: keeps entries from other tabs, ours win on ties.
 * Entries whose write has committed (v ≤ the row's committed version) are
 * dropped — they are no longer evidence of anything.
 */
function persistVseq(prunedDeletes?: Set<string>): void {
  try {
    const merged = readVseqFromLs();
    merged.n = Math.max(merged.n, seq.n);
    for (const [key, entry] of Object.entries(seq.keys)) {
      const other = merged.keys[key];
      if (!other || other[0] <= entry[0]) merged.keys[key] = entry;
    }
    for (const key of prunedDeletes ?? []) {
      delete merged.keys[key];
    }
    for (const key of Object.keys(merged.keys)) {
      if ((merged.keys[key] as [number, VseqOp])[0] <= (rowVersions.get(key) ?? 0)) {
        delete merged.keys[key];
      }
    }
    seq = merged;
    localStorage.setItem(LS_VSEQ_KEY, JSON.stringify(seq));
  } catch {
    /* quota/unavailable — no evidence is written, reconciliation degrades
       to trusting IndexedDB (the pre-fix behaviour) */
  }
}

function nextV(): number {
  const lsN = readVseqFromLs().n;
  seq.n = Math.max(seq.n, lsN) + 1;
  return seq.n;
}

/**
 * Boot hook: fills the mirror from the database rows and seeds the write
 * sequence — the counter starts above anything either store has ever seen.
 */
export function hydrateKv(rows: KvRow[]): void {
  rows.forEach((row) => {
    if (row && typeof row.key === 'string' && typeof row.value === 'string') {
      mirror.set(row.key, row.value);
      rowVersions.set(row.key, typeof row.v === 'number' ? row.v : 0);
    }
  });
  const ls = readVseqFromLs();
  const maxRowV = rows.reduce(
    (max, row) => Math.max(max, typeof row.v === 'number' ? row.v : 0),
    0,
  );
  seq = { n: Math.max(ls.n, maxRowV), keys: { ...ls.keys } };
}

/**
 * Boot hook (IndexedDB mode): reconciles the two stores. For every vseq
 * entry newer than its committed IndexedDB row, the IndexedDB copy is
 * stale — a lost set recovers from the localStorage mirror, a lost delete
 * is re-applied so the row cannot resurrect. Returns true when a flush is
 * needed. Unrecoverable entries (non-mirrored values whose transaction
 * died — the value existed nowhere durable) drop their evidence so they
 * cannot misfire on later boots.
 */
export function reconcileKv(): boolean {
  let changed = false;
  let droppedEvidence = false;
  for (const [key, [v, op]] of Object.entries(seq.keys)) {
    if (v <= (rowVersions.get(key) ?? 0)) continue; // committed — nothing stale
    if (op === 'd') {
      if (mirror.has(key)) {
        mirror.delete(key);
        pendingDeletes.set(key, v);
        changed = true;
      } else {
        droppedEvidence = true;
      }
      continue;
    }
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      /* storage unavailable — treat as no recoverable mirror copy */
    }
    if (value !== null) {
      mirror.set(key, value);
      pendingPuts.set(key, { key, value, v });
      changed = true;
    } else {
      // A {localStorage: false} write whose flush died — the value is gone;
      // keep the row (it is the last durable copy) and drop the evidence.
      droppedEvidence = true;
    }
  }
  if (droppedEvidence) {
    for (const [key, [v, op]] of Object.entries(seq.keys)) {
      if (v > (rowVersions.get(key) ?? 0)) {
        // Keep evidence for operations that became pending (they still
        // need to survive a flush that dies); drop only the ones that
        // could not be applied at all.
        if (op === 'd' ? !pendingDeletes.has(key) : !pendingPuts.has(key)) {
          delete seq.keys[key];
        }
      }
    }
    persistVseq();
  }
  return changed;
}

/**
 * Migration hook: imports a legacy localStorage key into the mirror and
 * queues the IndexedDB write. Does NOT touch localStorage — the value comes
 * from there and stays put (legacy keys are kept frozen as a backup).
 */
export function importLegacyKey(key: string, value: string): void {
  mirror.set(key, value);
  pendingDeletes.delete(key);
  pendingPuts.set(key, { key, value });
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

/**
 * Optional write-through behaviour. By default every set/remove mirrors to
 * localStorage synchronously so pre-IndexedDB SW versions keep reading
 * fresh settings and the inline pre-paint theme script keeps working.
 *
 * Pass `{ localStorage: false }` for sensitive values (e.g. OAuth tokens)
 * that should live in IndexedDB only — XSS can still reach IndexedDB in
 * theory, but the synchronous, world-readable `localStorage` API is a
 * much wider attack surface. The pre-IndexedDB fallback path is
 * unaffected: when IndexedDB is unavailable, the value lands in
 * `localStorage` regardless, because that's the only backend.
 */
export interface StateSetOptions {
  localStorage?: boolean;
}

export function stateSet(key: string, value: string, options: StateSetOptions = {}): void {
  const mirrorToLocal = options.localStorage !== false;

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
  if (mirrorToLocal) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* quota exceeded — the mirror is best-effort */
    }
  }

  const v = nextV();
  seq.keys[key] = [v, 's'];
  persistVseq();

  mirror.set(key, value);
  pendingDeletes.delete(key);
  pendingPuts.set(key, { key, value, v });

  // A non-mirrored value has no localStorage copy to recover from — it
  // must not linger in the coalescing window longer than necessary.
  if (mirrorToLocal) {
    scheduleFlush();
  } else {
    void flushKv();
  }
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

  const v = nextV();
  seq.keys[key] = [v, 'd'];
  persistVseq();

  mirror.delete(key);
  pendingPuts.delete(key);
  pendingDeletes.set(key, v);
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
 * re-queued so the next flush retries them; successful batches prune
 * their vseq evidence — the write is durable in IndexedDB now, the
 * entry has nothing left to say.
 */
export async function flushKv(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingPuts.size === 0 && pendingDeletes.size === 0) {
    return;
  }

  const puts: KvRow[] = [...pendingPuts.values()];
  const deletes = [...pendingDeletes.keys()];
  pendingPuts = new Map();
  pendingDeletes = new Map();

  try {
    await writeAll(KV_STORE, puts, deletes);
    const prunedDeletes = new Set<string>();
    puts.forEach((row) => {
      rowVersions.set(row.key, row.v ?? 0);
      const entry = seq.keys[row.key];
      if (entry && entry[0] <= (row.v ?? 0)) delete seq.keys[row.key];
    });
    deletes.forEach((key) => {
      rowVersions.delete(key);
      prunedDeletes.add(key);
      delete seq.keys[key];
    });
    persistVseq(prunedDeletes);
  } catch (error) {
    console.warn('[storage] kv flush failed — retrying on the next change', error);
    puts.forEach((row) => pendingPuts.set(row.key, row));
    deletes.forEach((key) => {
      const v = seq.keys[key];
      pendingDeletes.set(key, v ? v[0] : 0);
    });
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
  pendingDeletes = new Map();
  seq = { n: 0, keys: {} };
  rowVersions.clear();
}
