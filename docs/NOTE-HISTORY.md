# A note's past — the three systems, one decision

**Date:** November 15, 2026 (S5 of the architecture review, `docs/ARCHITECTURE-REVIEW.md`)
**Question:** a note's past lives in three persistence systems — cloud rows, snapshots, trash. Is that an accident to be unified, or a design to be named?
**Decision (this document, ratified as the default):** the split is **intentional**. Each system answers a different question with a different trust model, and the review's expensive state was not the split itself but the absence of one written answer. This is that answer. It is a decision about *intent*, not immutability — the reopening triggers are at the bottom.

---

## 1. The three questions

A person brings three different questions to their note's past, and conflating them is what made the UI feel like three apps:

| The question | The system | The one-sentence answer |
|---|---|---|
| "What did my note say before?" | **Snapshots** (versions) | A local, private chain of what the note's content was, newest first. |
| "I deleted something — can I get it back?" | **Trash** (graves) | A waiting room with a clock: 30 days, then it goes for good. |
| "What do my other devices think?" | **Cloud rows** (sync) | The shared truth devices converge on, with conflicts surfaced for review instead of silently resolved. |

## 2. The vocabulary (use these words)

| Word | Means | Lives in | Clock | Syncs? |
|---|---|---|---|---|
| **Snapshot** | One capture of a note's *content* (a version). Not a note — restoring one writes into its source note. | `NotepadSnapshotsDB` — its own local IndexedDB | Cap: 200 newest per install | Never — local by design |
| **Grave** | A *deleted note waiting* — the full record plus its trash stamp (`deleted_at`), restorable to the exact same id. | The notes store, as `TrashedNote` | 30-day retention, both sides sweep | Yes — a delete must reach every device |
| **Cloud row** | The *converged truth* for a note — seq-ordered content with the server's version of events. | The sync server (`notes` table) | Quota in bytes; conflicts park as versions for the review sheet | It **is** the sync |

The words are already the code's words (`snapshot`, `TrashedNote`/graves, `sync` rows); this table is where they stop being folklore. Note the asymmetry that follows from the trust models: a **snapshot never leaves the device** (your history is nobody else's business, and a version chain needs no consensus), while a **grave must propagate** (a delete that stays local resurrects on the next pull — the exact bug class the trash sync fixes were about).

## 3. The rules each system follows

**Snapshots — the local safety net** (`src/snapshots.ts`)
- Written by explicit capture (Ctrl+U), delete-safety flows and restore-loop protections; captures serialize through a queue so two rapid presses cannot both pass the duplicate check.
- Dedup is **content identity** per note: an identical capture against any of that note's existing snapshots is declined; drawings compare their canonical scene so the envelope's volatile `savedAt` stamp never files the same drawing twice.
- The cap keeps the newest 200 — safety copies, not an archive.
- Restore is identity-driven: the source note is brought on stage and restored *there*; a trashed source is un-deleted first (same id — share links survive); a gone source resurrects as its own note.
- "This note" / "All notes" scope deletes exist inside the History sheet; the trash's deletion is deliberately *not* one of them (a deleted note is not a version of anything).

**Trash — the delayed action** (`TabManager`'s grave lifecycle + `server/notes.ts`)
- Deleting a note parks it as a grave with `deleted_at`; the client counts the retention down, and the server's hourly sweep retires graves whose window closed — including rows a device offline past the deadline never saw, because the stamp rides the row.
- Restore un-deletes in place; emptying the trash purges for good.
- Trashed bytes count against the storage quota on purpose: the trash keeps exactly the storage it looks like it keeps.

**Cloud rows — the truth** (`server/notes.ts`, `src/cloud/sync.ts`)
- Seq-ordered; a device pushes what it changed and pulls what others did.
- A conflict is never silently resolved: the losing bytes park as a *version of the note* and the review sheet asks — which is why the review flow and the snapshot chain feel related (both are "versions") while remaining different systems (one is device-local history, the other is a sync outcome).

## 4. Where the systems meet (and must keep agreeing)

- **The History sheet is one surface with three views** — "This note" and "All notes" read snapshots; "Trash" reads graves. The delete-flash lands the sheet on the Trash view once, then every open starts on the note being written.
- **The scope-delete row** deletes versions for this note / all versions / empties the trash — three buttons that must never blur (deleting a version is not deleting a note; emptying the trash is not clearing history).
- **Restore crossings**: restoring a snapshot of a trashed note un-deletes the grave first — one flow, two systems, deliberately.

## 5. What would reopen this decision

- Users asking for **version history across devices** — that is a product request to sync snapshots (or to make cloud versions the chain), and it would fold two systems into one *by making their trust models equal*, not by tidiness.
- A privacy model change (e.g., optional E2E history) that makes local-only the wrong default.
- The maintenance cost of the three retention/cap regimes genuinely colliding — today they share no invariants they can violate against each other; the day they do, the split has stopped paying.

Until one of those is true, the answer to "should snapshots unify into the notes store as a record type?" is **no** — the unification would couple a private, cap-bounded, never-synced safety net to a synced, quota-bounded convergence system, and every rule in section 3 would become a compromise between them.
