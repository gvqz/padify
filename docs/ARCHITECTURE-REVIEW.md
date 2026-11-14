# Padify — Architecture Review

**Date:** November 14, 2026 (post `6770840`, after the Phase 1–4 bug-squash)
**Question asked:** the history/duplicates/architecture/trash/conflicts systems need review — is this a mess by design, and does it need an entire overhaul?
**Method:** every claim below is grounded in a file, a line count, or a commit — read, not guessed. ~52,500 lines of hand-written TS (non-test, non-generated), 87 unit-test files (1,690 tests), 289 e2e tests, 61 MB of git history.

---

## 1. The verdict first

**No to a rewrite. Yes to a phased structural overhaul — of four specific things, not the app.**

The honest split: Padify's *engine room* (document model, editor port, storage diffing, sync server, test culture) is the best part of the codebase and is worth every line it occupies. The *superstructure* accreted around it (CSS, the second markdown renderer, the smeared sync state, the god object, the stats module) is where the "extremely big mess" feeling comes from — and it is real, measurable, and fixable layer by layer.

A from-scratch rewrite would discard the one asset that took the longest to build: ~2,000 tests that pin real browser behavior, including the data-loss races fixed in the last three weeks. Those bugs would all come back. The mess is concentrated and separable; that is the key fact.

---

## 2. What is genuinely good (do not touch)

1. **The editor seam is real.** `src/editor/port.ts` (374 lines) is a proper contract — `setHtml` (COMMIT) vs `renderHtml` (RENDER) halves, boolean results, no DOM leakage — and `architecture.test.ts` enforces that only `app.ts` wires the implementation. The unicode picker, voice typing, snapshots, share, statistics all go through it.
2. **The document model is the right design.** `editor/model/` (document, ops, selection, history; ~3,900 lines) is typed, testable without a browser, with one serializer. `model-port.ts`'s "ONE DISCIPLINE" (typing flows natively, structured changes flow through the model) replaced an execCommand-compensating legacy engine — the header lists the eight-plus rewrite paths that used to exist.
3. **Layering is CI-enforced.** `src/architecture.test.ts`: features imported only by composition roots, features never import each other, `src/ui` is passive, no static import cycles (the repo's one lifelong cycle was killed and pinned).
4. **The server is disciplined.** Zero runtime dependencies, schema-light by design (unknown note types survive round-trips), timing-equalized auth, single-statement sweeps, one wire contract (`shared/wire.ts`) compiled under both tsconfigs.
5. **The codebase documents WHY.** Unusually rich rationale comments — every deliberate design has its reason inline. This review leaned on them heavily.

---

## 3. The structural problems, ranked

### S1. Sync state is smeared across five+ structures — the root cause of the data-loss bug *class*

The same two questions — *"have these bytes changed?"* and *"has the cloud seen them?"* — are answered by, and must stay coherent across:

| # | Structure | Lives in | Lifetime |
|---|-----------|----------|----------|
| 1 | `dirtyIds` set | `TabManager` (tabs.ts) | memory |
| 2 | `unpushed` flag | on `NoteTab` / trash rows | durable, rides the record |
| 3 | `lastWritten` signature map | `storage/notes.ts` module global | session |
| 4 | `pendingPush` set | `cloud/sync.ts` module global | memory |
| 5 | `ownEchoes` map | `cloud/sync.ts` module global | memory |

Deletion is *also* tracked five ways: trash rows in the model, graves carrying `syncBase`, `externallyDeletedIds` (storage), `sweptTrashIds`, and the mirror's tombstone handling.

**Consequence, proven:** every data-integrity bug fixed in `b0991d3` (unpushed-vs-dirty-set drift, externallyDeletedIds add-only, failed-write delete loss, clean-merge base pin, trash syncBase, orphaned pendingPush ids) was exactly one of these structures drifting from the others. The bug *class* will keep producing instances as long as the class exists.

**Root cause:** sync metadata lives *inside* the domain object (`NoteTab` carries `syncSeq`, `syncBase`, `conflict`, `unseenChange`, `unpushed`, legacy `copyOf` — 6 of its 11 fields are sync state) and every field must be manually threaded through: `tabs.ts` loadModel → `StoredNoteTab` → the 10-field hand-rolled signature diff in `diffAgainstLastWritten` → `hydrateNotes` → the localStorage mirror → `sync.ts` adoption → the wire shapes. The diff signature alone has three bespoke equality helpers (`sameSyncBase`, `sameUnseen`, `sameConflict`).

**Fix (the single highest-leverage refactor):** extract a per-note **sync ledger** — one module owning `{ baseContent, baseName, seq, lastPushedAt, state: clean|dirty|pushing|conflicted }` keyed by note id. `NoteTab` returns to a pure domain record. The dirty flag, the diff signature, the pending queue and the echo map all become *views* over the ledger instead of parallel structures that can disagree.

### S2. TabManager is a god object — 1,922 lines, ~45 methods

It is simultaneously: the note model, the persistence orchestrator, the tab-strip view (DOM building, labels, drag, rename UI), focus management (with 120-retry deferred focus), the document title, the trash lifecycle, note-type conversion, legacy migration, and four sync-adapter entry points (`exportForSync`, `confirmPushed`, `adoptPushedRows`, `applyExternalMerge`, `applyExternalTrash`).

Every feature must reach through it (the tasks hub reads `allTabs`, sync holds a `manager` reference at module scope). Its size is why `b0991d3`-class fixes are risky: there is no seam *inside* it.

**Fix:** split into `NotesModel` (pure state + events), `TabStripView` (DOM), `TrashStore` (grave lifecycle), and a thin `SyncAdapter` — TabManager becomes the composition of the four. The architecture test already proves the discipline exists to hold such borders once drawn.

### S3. Two full design systems ship on every page — 37 stylesheet links, ~632 KB

`index.html` loads **both** systems at once: 16 legacy sheets *including* `bootstrap.min.css` (121 KB) and *including* files that pair 1:1 with the newer set — `tokens.css` + `vercel/01-tokens.css`, `switches.css` + `vercel/07-switches.css`, `snapshots.css` + `vercel/11-snapshots.css`, `timer.css` + `vercel/12-timer.css`, `unicode-picker.css` + `vercel/14-unicode-picker.css`. Two token systems define the same variables; the cascade order decides. `dead-css-audit.mjs` exists precisely because nobody can say what is live.

**Consequence:** every visual bug is potentially a two-system interaction; theming means overriding twice; the payload is 10× a sane budget.

**Fix:** mechanical consolidation — `vercel/` (the newer, sectioned system) wins; every legacy sheet is either deleted or its few live rules are folded in; bootstrap un-shipped entirely. `dead-css-audit.mjs` already tracks usage. Needs a visual-QA pass across themes/devices — that is why it was deferred, and it is still the right first overhaul item because it is the most mechanical.

### S4. The markdown renderer exists twice — ~10,000 lines

- `src/editor/markdown/render.ts` — 3,523 lines (TypeScript, in-app, CommonMark+GFM+KaTeX)
- `public/share/markdown-render.js` — 6,559 lines (hand-maintained standalone JS for the public share page)

Same pipeline, implemented twice, kept honest by drift/parity tests (`render.github-parity.test.ts`, the share-bundle regeneration rule). Every renderer fix must land twice — commit `1ff74d2` had to regenerate the bundle for an html-policy fix.

**Fix:** `scripts/build-share.mjs` already bundles for the share page — compile the *one* renderer (`render.ts` + its sanitizer) into the standalone share bundle instead of maintaining a hand-written twin. Deletes ~6.5k lines and a whole class of drift bug. The share page's constraints (no-build, CSP) are satisfied by a build artifact it already loads.

### S5. A note's past lives in three systems

- **Cloud rows** (synced, seq-ordered, conflict-reviewed)
- **Snapshots** (`NotepadSnapshotsDB` — a *second* IndexedDB database, local-only, 200-entry cap, 2,339-line module with its own schema/upgrade/dedup/views)
- **Trash** (graves inside the notes store, 30-day clock, restore semantics)

Three persistence subsystems, three UI surfaces, three sets of retention rules — and the delete-everything flow must know about all of them. The user-facing symptom: "History" (snapshots), "Trash", and cloud "conflicts" are three different modals with three different mental models for "an old version of my note."

**Fix (decision first):** either declare the split intentional (local safety net vs cloud truth) and *document* it in one place with one shared vocabulary, or unify snapshots into the notes store as a record type. The current state — neither — is the expensive one.

### S6. Statistics has two definitions of "word" in one file

`lib/text-stats.ts` counts words as whitespace-split + CJK ranges (line ~22-30) but counts *unique* words with a `\p{L}+` unicode match (line 39) — the QA-verified "Unique words 10 > Words 7" impossibility, plus lexical density >100% and URL dots counted as sentences. The module grew field-by-field without one tokenizer.

**Fix:** one `tokenize(text)` function, every stat derived from it. Small, isolated, user-visible.

### S7. Task-land is two layers with a confusing border

`src/editor/tasks/` (3.4k lines — the task *note type*: content serialization, rows, dates, NL parsing, in-editor surface) under `src/features/tasks/` (4.1k lines — the *hub*: calendar 1,528, hub 1,080, rail, migrate, toasts) which imports upward across the "editor/features" boundary. Layered correctly, but the names don't say which is which, both have a `markup.ts`, and the calendar reads like a second app (it creates whole notes as reminder containers — the QA "hijacks the editor" finding is *architectural*: reminders can only exist as task-notes).

**Fix:** rename/move to `tasks/note` and `tasks/hub` under one feature root; decide whether a reminder can exist without a note (that decision, not code, resolves the UX finding).

### S8. Legacy compatibility weight

The localStorage blob mirror (`padifyTabs`), the legacy `note` key migration, `copyOf` lineage, the localStorage fallback backend, `reconcileNotesFromMirror` — several hundred lines keeping pre-storage builds alive. Each was justified when written; together they double the storage layer's surface area. The mirror alone accounts for four module globals in `storage/notes.ts`.

**Fix:** a dated amputation policy: the mirror serves only SW-cached pre-storage installs — pick a date, ship one release that migrates on first online boot, delete the mirror.

### S9. Server shares denormalize full note content

`shares.content` is a copy of the note at share time, refreshed by client-driven batches (≤100/refresh, 10 MB live-byte budget — both recent hardening). Correct for a static public page, but it means share lifecycle = a second content lifecycle (revoke grace, sweeps, byte budgets on create *and* refresh).

**Fix:** acceptable as-is; would be re-derived for free if shares ever move to referencing note versions instead of copying bytes. Not urgent.

### S10. Repo weight

61 MB pack (deleted MP3s). Known, deliberate, deferred — needs a coordinated history rewrite + force push, not a drive-by.

---

## 4. How it got this way (the diagnosis)

Accretion without deletion, and *rules that arrived after the growth*:

- The layering test landed 2026-09-25 (`e7b4247`); the Reminders feature 2026-10-14 (`bc87cf2`); the vercel CSS split 2026-10-02. The borders were frozen *after* the interiors had already grown — `architecture.test.ts` could hold the perimeter but not consolidate what was inside it.
- Each feature (tasks, music, share, snapshots) arrived as a new layer on the plain-notepad core and brought its own UI system (→ triple CSS), its own persistence (→ second DB + cloud), its own renderer where the host page differed (→ twin markdown).
- Sync was retrofitted onto records that were never versioned (`html` field named for a format that outlived its accuracy "by a year", per its own comment) — hence metadata fields accreting onto `NoteTab` one bug at a time instead of a ledger designed up front.

None of this is carelessness — it is the standard cost of a solo project shipping features faster than it consolidates. The presence of the architecture test, the port seam, and the test culture is why this is recoverable without a rewrite.

---

## 5. The phased plan (order = leverage ÷ risk)

| Phase | Work | Size | Risk |
|-------|------|------|------|
| 1 | **CSS consolidation** — vercel/ wins, legacy 16 + bootstrap deleted or folded, dead-css-audit as the map, visual QA pass | ~1–2 weeks, mostly mechanical | Low (visual regressions caught by QA) |
| 2 | **One markdown renderer** — build-share compiles `render.ts` for the share page; delete `markdown-render.js` | days | Low-medium (parity tests already exist as the safety net) |
| 3 | **Sync ledger extraction** (S1) — the fix for the data-loss bug class; then **TabManager split** (S2) | 2–3 weeks | Medium — this is the one that needs the full test suite green at every step |
| 4 | **Statistics unification** (S6), **tasks-land rename/decision** (S7), **snapshots-vs-trash decision** (S5) | ~1 week combined | Low |
| 5 | **Legacy amputation** (S8) after a dated migration release; history rewrite (S10) as a coordinated one-off | small + one event | Low once scheduled |

Phases 1–2 are pure deletion and immediately shrink the "mess" feeling. Phase 3 is the real overhaul and pays for itself by retiring a whole bug class. Nothing here requires a big-bang.

---

## 6. What NOT to do

- **Do not rewrite the editor.** The model/port/engine is the most-tested, best-documented part; the legacy execCommand engine it replaced is the cautionary tale sitting in the git log.
- **Do not rewrite the server.** Zero-dependency, schema-light, hardened in the last three weeks.
- **Do not rewrite to "fix UX."** The UX findings (calendar hijack, PiP vanishing, Ctrl+U conflict, stats nonsense) are each a decision plus a small diff, not a symptom of engine rot.
- **Do not start with the sync ledger because it is the deepest.** Start with deletion (CSS, renderer) — the codebase gets smaller and the mess feeling drops before the hard refactor begins.
