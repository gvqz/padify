# The legacy storage amputation — D4, decided and scheduled

**Decided:** 2026-11-16 (the owner said go).
**Tranche 1 (this release):** the migration-certainty release — nothing is deleted; the import is verified, made visible, and the policy below is the contract for the deletion.
**Tranche 2 (the deletion):** ships no earlier than **2026-11-30** (two weeks of window). It is pure subtraction; the checklist is below and complete.

---

## The question the owner asked, answered

> "So users just need to open the note? And if they don't they'll lose data?"

- **What a user must do:** open the **app** once — any time between the storage layer's first deploy (2026-09-24) and the day tranche 2 ships. Not "open each note": the boot migration reads the whole `padifyTabs` blob and imports every note at once, words, names, types, trash and all.
- **What happens on that open:** IndexedDB is empty (first post-storage boot), the legacy blobs are there → every note row is written into IndexedDB, every legacy setting key fills its gap, and the data is home. The words never leave the device; the network is not involved.
- **If they never open the app during the window:** after tranche 2, their pre-storage notes still sit physically in `localStorage` (`padifyTabs`) but no shipped code reads them — from the app's view the notes are gone. They are recoverable only by downgrading to a pre-tranche-2 build (or exporting `padifyTabs` by hand). This is the accepted cost of the amputation, and the reason tranche 2 waits two more weeks: every extra day converts more of the never-opened population.
- **Users who opened the app at least once since 2026-09-24 are already migrated and lose nothing.** For them tranche 2 is invisible: their data lives in IndexedDB and the deleted code was write-only compatibility.

## What tranche 2 deletes — the checklist

All in `src/storage/` unless noted. Each item is compat-only: no current-build data path depends on it.

1. **The note-blob mirror (writes only)** — `mirrorLegacyNotes`, `writeLegacyNotesMirror`, the mirror call in `saveNotes` (notes.ts ~810), the mirror state (`mirrorTimer`, `mirrorDirty`, `lastMirrorWriteAt`, `MIRROR_MIN_INTERVAL_MS`), and the IDB-path half of `flushNotesMirror`. Keeps `localStorage` from receiving whole-blob copies it no longer needs.
2. **`reconcileNotesFromMirror`** (notes.ts:659) and its boot call (index.ts ~260). The boot rescue that healed torn IndexedDB writes from the mirror — the mirror's writes are gone, so the rescue has nothing to read. *Accepted trade:* the IndexedDB write-behind + pagehide flush becomes the only durability path (same as every IndexedDB-first app).
3. **The one-time legacy import** — `migrateLegacyLocalStorage`, `parseLegacyNoteRecords`, `MIGRATED_FLAG_KEY`, and the `LEGACY_KV_KEYS` sweep (index.ts). Every install that ever booted a post-storage build has run it.
4. **`copyOf` lineage** — the `StoredNoteTab.copyOf` field, its dual-reads in the row mappers (notes.ts), and `NoteTab.copyOf` in `src/notes/domain.ts` + `src/notes/trash-store.ts`. Pre-review builds minted twin notes with it; nothing has written it since; values ride unread.
5. **The `html` dual-read in the legacy blob path** stays ONLY where the fallback needs it (see below); the copy in `parseLegacyNoteRecords` dies with item 3.

## What tranche 2 deliberately keeps — and why

- **The localStorage fallback backend** (`loadLegacySnapshot`, `persistLegacyBlobs`, the kv fallback paths). The D4 draft listed it for deletion, but it is not pre-storage compatibility: it is the entire storage layer for environments where IndexedDB is blocked or absent (hardened browsers, private-mode oddities). Deleting it would not remove legacy weight — it would make the app amnesiac for those users, losing **current** data, not old blobs. The storage layer's own roadmap note ("the fallback backend stays forever", `src/storage/index.ts`) is the position this policy ratifies. If the owner wants it gone, that is a separate decision with its own migration story.
- **The `html`/`content` dual-read in row migration** (`migrateNoteRecord`, IndexedDB rows). Rows written by mid-2026 builds say `html`; the storage schema versions forward and the dual-read is three lines, not the several-hundred-line weight this amputation targets.

## Tranche 1 changes (this release)

1. The migration's note import now **logs its count** on success (`[storage] imported N note(s) from the legacy localStorage blobs`) — the settings import already did; support could see settings but not notes land.
2. This document. Tranche 2 needs no further decision — only the date and the checklist above.
