/**
 * Padify storage layer — IndexedDB with an in-memory synchronous mirror.
 *
 * Architecture (one paragraph): the app opens the `padify` IndexedDB
 * database at boot, migrates any pre-existing localStorage data into it, and
 * hydrates everything into an in-memory mirror. From then on:
 *
 *  • Reads  are synchronous, served from the mirror — every consumer keeps
 *    the exact localStorage call shape (stateGet/stateSet/stateRemove) or
 *    the TabManager snapshot (loadNotes/saveNotes), so no call site needed
 *    restructuring.
 *  • Writes update the mirror immediately and land in IndexedDB shortly
 *    after via coalesced transactions (write-behind). Notes persist
 *    per-record — only rows whose updatedAt/name/position actually changed
 *    are written, replacing the old whole-blob JSON.stringify per
 *    keystroke.
 *  • localStorage survives as a COMPATIBILITY MIRROR (settings write
 *    through synchronously; the note blobs are mirrored at a bounded
 *    cadence) so service-worker-cached versions from before this layer keep
 *    reading fresh data during the rollout window — and as a durable
 *    backup: if IndexedDB alone is wiped, the next boot re-imports.
 *  • If IndexedDB is unavailable (blocked, disabled, private-mode oddities),
 *    the layer falls back to localStorage with byte-for-byte the
 *    pre-migration behaviour. Consumers never know.
 *
 * Boot order contract: main.ts kicks storageReady() at module evaluation;
 * app.ts and the white-noise player await it in their ready handlers before
 * touching any state, and the music player is constructed only after. See
 * docs in each module.
 *
 * Roadmap: once no SW-cached pre-storage version can run anymore, the
 * compatibility mirror can be dropped; the fallback backend stays forever.
 */

import {
  NOTES_STORE,
  openDatabase,
  readAll,
  resetBackendForTests,
  storageBackend,
  KV_STORE,
  writeAll,
  type StorageBackend,
} from './idb';
import {
  flushKv,
  hydrateKv,
  importLegacyKey,
  reconcileKv,
  resetKvForTests,
  stateGet,
  stateRemove,
  stateSet,
  type KvRow,
} from './kv';
import {
  ACTIVE_TAB_KEY,
  flushNotesMirror,
  hydrateNotes,
  loadNotes,
  parseLegacyNoteRecords,
  reconcileNotesFromMirror,
  resetNotesForTests,
  saveNotes,
  whenNotesIdle,
  type NoteRecord,
  type NotesSnapshot,
  type StoredNoteTab,
  type StoredTombstone,
} from './notes';

export { stateGet, stateSet, stateRemove, storageBackend, type StorageBackend };
export {
  ACTIVE_TAB_KEY,
  loadNotes,
  saveNotes,
  whenNotesIdle,
  type NotesSnapshot,
  type StoredNoteTab,
  type StoredTombstone,
};

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/** Set once the localStorage import has completed (stored in kv). */
const MIGRATED_FLAG_KEY = 'padifyStorageMigrated';

/**
 * Every localStorage key the current app still reads. The one-time
 * migration imports these into the kv store. Unknown keys (leftovers from
 * the retired mini tools) are ignored — they stay frozen in localStorage
 * and nothing ever reads them.
 */
const LEGACY_KV_KEYS: readonly string[] = [
  // preferences (selector.ts + app.ts + utils.ts)
  'mode',
  'isUserPreferredTheme',
  'selectedFont',
  'dyslexicFont',
  'monospaced',
  'serifFont',
  'userChosenFontSize',
  'userChosenFontWeight',
  'userChosenLineHeight',
  'userChosenWordCountPillSelected',
  'userChosenTransparentWordCountPillSelected',
  'userChosenWriteDirection',
  'userChosenTexture',
  'userChosenOptimalLineLengthSelected',
  'userChosenSpellCheck',
  'userChosenBreakReminders',
  'userChosenExplodingEffect',
  'userChosenExplodingEffectStyle',
  'hasUserDismissedDonationPopup',
  'breakReminderState',
  // tabs
  'padifyActiveTab',
  'note',
  // unicode picker
  'recentUnicodeSymbols',
  'unicodeFavorites',
  // timer
  'timerChime',
  'timerChimeSound',
  'lastCustomTimerMinutes',
  // music (ambience now rides the player as regular tracks)
  'padify-music-state',
  'padify-music-library',
  // tasks (the retired modal's store — read by the notes migration)
  'padify-tasks',
  // cloud
  'padifyCloudConfig',
  'padifySession',
];

/**
 * Imports the legacy localStorage world into the padify database. Runs once
 * (guarded by the migrated flag). Legacy keys are intentionally left in
 * localStorage afterwards: they are the compatibility mirror and the
 * fallback's data, and deleting them would starve any old SW-cached app
 * version still running.
 *
 * The flag is only set when legacy data was actually found — a boot with
 * nothing to import leaves it unset, so legacy data appearing later (an
 * old app version still running in another tab, restored storage) is
 * still imported on the next boot. Re-runs are safe: IndexedDB is the
 * incumbent, so note blobs only import into an empty store and kv keys
 * only fill gaps.
 */
async function migrateLegacyLocalStorage(): Promise<void> {
  let foundLegacyData = false;

  const records = parseLegacyNoteRecords();

  // Notes: only import when the store is empty — IndexedDB is the
  // incumbent; localStorage only fills the vacuum.
  if (records.length > 0) {
    foundLegacyData = true;
    const existing = await readAll<NoteRecord>(NOTES_STORE);
    if (existing.length === 0) {
      try {
        await writeAll(NOTES_STORE, records, []);
      } catch (error) {
        console.warn('[storage] legacy notes import failed — will retry next boot', error);
        return; // do not set the migrated flag
      }
    }
  }

  let imported = 0;
  LEGACY_KV_KEYS.forEach((key) => {
    let value: string | null;
    try {
      value = localStorage.getItem(key);
    } catch {
      return;
    }
    if (value !== null) {
      foundLegacyData = true;
      // Only fill gaps — a key already in IndexedDB keeps its (newer) value.
      if (stateGet(key) === null) {
        importLegacyKey(key, value);
        imported += 1;
      }
    }
  });

  if (!foundLegacyData) {
    return; // nothing to import — leave the flag unset for a later boot
  }

  importLegacyKey(MIGRATED_FLAG_KEY, '1');

  if (imported > 0) {
    console.info(`[storage] imported ${imported} setting(s) from localStorage`);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let bootPromise: Promise<StorageBackend> | null = null;

/**
 * Boots the storage layer: opens the database, runs the one-time legacy
 * migration, hydrates the mirrors. Idempotent — every consumer can call it
 * freely. main.ts kicks it at module evaluation so the IndexedDB open starts
 * as early as possible; ready handlers await it before reading any state.
 */
export function storageReady(): Promise<StorageBackend> {
  if (!bootPromise) {
    bootPromise = boot();
  }
  return bootPromise;
}

async function boot(): Promise<StorageBackend> {
  const backend = await openDatabase();

  if (backend === 'indexeddb') {
    hydrateKv(await readAll<KvRow>(KV_STORE));

    // The newest kv operation per key may live only in localStorage (a
    // flush that died with the page) — reconcile before anything reads.
    if (reconcileKv()) {
      await flushKv();
    }

    if (stateGet(MIGRATED_FLAG_KEY) !== '1') {
      await migrateLegacyLocalStorage();
      await flushKv();
    }

    hydrateNotes(await readAll<NoteRecord>(NOTES_STORE));

    // The newest note rows may live only in the legacy mirror (a pagehide
    // save whose IndexedDB write died with the page) — reconcile before
    // anything reads, then heal the database with an immediate save so
    // the rescue is not re-needed on the next boot. Same shape as the kv
    // reconcile above.
    if (reconcileNotesFromMirror()) {
      saveNotes(await loadNotes(), null, { immediate: true });
    }
  }

  // Best-effort flush when the page goes away — coalesced kv writes and a
  // pending throttled note-blob mirror land before the process dies.
  // (Guarded for non-window environments: web workers, tests, SSR probes.)
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPendingWrites);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushPendingWrites();
      }
    });
  }

  console.info(`[storage] backend: ${backend}`);
  return backend;
}

/** Pagehide/visibility hook — public for completeness. */
export function flushPendingWrites(): void {
  // Late captures first: the app's editor flush must land in the model (and
  // its saveNotes must be queued) BEFORE the kv/mirror drains run, or the
  // last ~900ms of typing dies with the page.
  for (const hook of preFlushHooks) {
    try {
      hook();
    } catch {
      /* a failing capture must not block the drain */
    }
  }
  void flushKv();
  flushNotesMirror();
}

/**
 * Registers a callback that runs at the top of every unload flush, before
 * the kv batches and the notes mirror drain. The app uses this to capture
 * the live editor into the model — closing the ~500ms input + 400ms
 * persist debounce window that a page kill would otherwise swallow.
 * Registration order vs. the pagehide listeners above doesn't matter; the
 * hook list is drained inside flushPendingWrites itself.
 */
export function registerPreFlushHook(hook: () => void): void {
  preFlushHooks.add(hook);
}

const preFlushHooks = new Set<() => void>();

/** Test hook — full reset (call before booting between tests). */
export function resetStorageForTests(): void {
  bootPromise = null;
  resetBackendForTests();
  resetKvForTests();
  resetNotesForTests();
}
