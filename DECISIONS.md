# Padify — Decisions Needed

**Date:** November 16, 2026
**Companion to:** `docs/ARCHITECTURE-REVIEW.md` (the phased overhaul plan and its progress notes — every claim here traces back to that document or to the source)

---

## Context — where the overhaul stands

Everything through `99eee77` is committed and pushed. Every tranche below was gated on typecheck, ESLint, Prettier, the full unit suite (1,774 tests at the last count), and all 289 e2e specs before it landed.

| Item | Verdict | Status |
|------|---------|--------|
| S1 — sync state smeared across 5+ structures | the root cause of the data-loss bug class | **DONE** — one ledger + one write index, three tranches (`5906876`, `98ea017`, `affe5cc`) |
| S2 — TabManager, a 1,922-line god object | no seam inside it | **DONE** — model / strip view / trash store / domain extracted, two tranches (`c23351e`, `99eee77`) |
| S3 — two design systems on every page (36 links, ~632 KB) | every visual bug is a two-system interaction | **DONE** — 22 links under `vercel/`, bootstrap extracted-and-un-shipped, fold proven rendering-neutral three independent ways (`0b64fec`, `c1cdad9`) |
| S4 — suspected twin markdown renderer | didn't exist — the share bundle is generated + drift-pinned | **No action** (`93d8bb4`) |
| S5 — a note's past lives in three systems | split was never declared intentional or unified | **DECIDED + DOCUMENTED** — intentional; `docs/NOTE-HISTORY.md` (`f1cc8de`) |
| S6 — two definitions of "word" in one file | impossible statistics | **DONE** — one tokenizer, every stat derived from it (`f32c7d0`) |
| S7 — task-land's confusing border | names didn't say which layer is which | **Structure DONE** — `features/tasks/note` + `features/tasks/hub` + the note-projections seam (`a781d32`) — **one decision still open (D1)** |
| S8 — legacy compatibility weight | several hundred lines keeping pre-storage builds alive | **OPEN** — needs a date from you (D4) |
| S9 — shares denormalize full note content | correct for a static public page | **Accepted as-is**; re-derived for free if shares ever reference note versions |
| S10 — 61 MB repo pack (deleted MP3s) | known, deliberate, deferred | **OPEN** — needs a go/no-go (D5) |

Also already fixed (the pre-review bug-squash, all committed): the dead share links (confusable-free token mint, `a71160c`), offline PWA on Apache (dotfiles out of the precache, `62d09db`), the hourly server sweep (`5e39c96`), unpushed edits surviving reloads (`96f1d93`), and the README telling the truth (`cb2bfb6`).

**The engine room was left alone, as the review demanded** — document model, editor port, sync server, test culture. No rewrites happened or are proposed.

---

## The decisions you must make

### D1 — Can a reminder exist without a note? (S7's open decision — the "calendar hijacks the editor" finding)

Today a reminder IS a row in a task note. The calendar's "+ Add" therefore creates a brand-new task-list note ("Untitled list") and switches the editor to it — the QA "hijack" finding falls straight out of the model.

- **(a) Keep reminders note-bound, document it as the model.** Cheapest; zero sync-surface change. The hijack stays.
- **(b) Free-standing reminders as a hub-only record.** Fixes the hijack, but adds a second synced entity and its whole conflict story.
- **(c) Hybrid — reminders stay note-bound, but the calendar opens the DATED ROW instead of the whole note.** A UX diff only; no model change; resolves the QA finding.

**Recommendation: (c) first; revisit (b) only if real usage asks for note-less reminders.**

### D2 — Ctrl+U is bound twice. Which one wins? (QA A2/A6/A8)

The shortcuts dialog lists Ctrl+U as both "Take a snapshot" and "Underline (Rich Text)". In the source, `snapshots.ts` binds a document-level Ctrl+U → create-snapshot, while the rich editor relies on the browser's native contenteditable Ctrl+U underline — two live claims on one chord. The History empty-state repeats the snapshot binding.

- **(a) Underline keeps Ctrl+U** (parity with every editor the user has ever used); the snapshot moves to a new chord (e.g. Ctrl+Alt+S). Update the dialog and empty-states to match.
- **(b) Snapshot keeps Ctrl+U**; the rich editor loses the underline shortcut (toolbar/context-menu only).

**Recommendation: (a).** Small diff either way once you pick.

### D3 — The PiP button silently vanishes on non-plain notes (QA A13)

The Floating Window button exists only when the active note is a standard/plain note (`pip-window.ts` `syncAvailability` — the window is a plain-typing surface by design). On rich/markdown/task notes the button just disappears, unexplained.

- **(a) Explain it:** dim the button with a tooltip ("works on plain notes only") instead of hiding it. Smallest diff.
- **(b) Extend it:** render other note kinds read-only in PiP via the new note-projections seam. Real work, real payoff.

**Recommendation: (a) now; (b) is a good future feature once (a) stops the surprise.**

### D4 — Legacy storage: pick the amputation date (S8)

The storage layer still carries several hundred lines for pre-storage installs: the localStorage blob mirror (`padifyTabs`), the legacy `note`-key migration, `copyOf` lineage, the localStorage fallback backend, `reconcileNotesFromMirror`. Each was justified when written; together they double the storage layer's surface area.

The plan is a dated amputation policy: pick a cutoff, ship **one release** that migrates any pre-storage install on first online boot, then delete the mirror and the fallbacks in the next release.

**Decision needed: the cutoff date/release.** Recommendation: make it the next release after you say go — the migration code is the only new work, and the deletion is pure subtraction afterwards.

### D5 — Repo history rewrite for the 61 MB pack (S10)

The pack is mostly deleted MP3s. The fix is a coordinated one-off: `git filter-repo`, force push, every clone re-made, CI caches reset. It cannot be a drive-by.

**Decision needed: do it at all, and when.** No urgency — the weight only costs cloners. Recommendation: schedule it for a quiet moment (e.g. right after a release, with a HEADS-UP note), not mid-overhaul.

### D6 — Optional: prune the conservative bootstrap subset now? (S3 steady-state)

The ~42 KB bootstrap subset inside `vercel/02-base.css` is conservative by design — the token-level extraction kept some groups that are provably dead (`.table-hover` variants and friends). The three-layer rendering-neutrality harness (static cascade check, computed-style diff, byte-identical pixels) is in place and can re-prove a prune.

- **(a) Prune now** — autonomous, verified, ships a smaller 02-base.
- **(b) Leave it** — the `[phase-1 fold]` banners already mark the provenance for future hygiene passes.

**Recommendation: (a) — it's cheap now that the harness exists.** This one needs no input; it's listed because it's the only ungated work left, and saying "do it" just moves it up the queue.

---

## What still needs to be done (all of it gated on the above)

1. **After D1:** implement the chosen option — (c) is a contained UX diff in the calendar's row-opening path; (b) is a small project (second synced entity + conflicts); (a) is a documentation patch.
2. **After D2:** rebind the loser chord, fix the shortcuts dialog and both History empty-states that repeat it.
3. **After D3:** the tooltip/dim (a) or the read-only projection (b).
4. **After D4:** the migration release, then the deletion tranche (the mirror, the fallback backend, the legacy key migration, `copyOf` reconciliation).
5. **After D5:** the coordinated rewrite event (filter-repo, force push, clone-reset announcement).
6. **Optional, ungated:** D6's prune, and a human visual-QA pass across themes/devices on top of the automated pixel-diff (belt-and-braces for the CSS consolidation).

## What is deliberately NOT on this list

- **S4** — the share renderer "twin" was a misread; the bundle is generated and drift-pinned.
- **S9** — share denormalization is the right price for a no-build static share page; revisit only if shares move to version references.
- **Editor or server rewrites** — the review's "What NOT to do" section stands: both are the best-tested parts of the codebase.
