# Padify — Open decisions and open work

**Nothing here is decided yet.** Finished decisions and their implementation
notes live in the git log and `docs/ARCHITECTURE-REVIEW.md`, not in this
file — this page carries only what still needs an owner's call or an
owner's calendar.

---

## Decisions you still owe

None right now. D1–D5 (2026-11-16) were the last open set; their outcomes
are in the commit history.

## Work still to be done

1. **D4 tranche 2 — the legacy storage deletion.** Ships **no earlier than
   2026-11-30**. Pure subtraction; the complete item-by-item checklist
   (what dies, what stays and why — including why the localStorage
   fallback backend stays) is `docs/STORAGE-AMPUTATION.md`. No decision
   left in it, only the date.
2. **Human visual-QA pass** across themes/devices on top of the automated
   pixel-diff — belt-and-braces for the CSS consolidation (S3). Optional;
   the automated proof is three-layered already. **In progress (2026-11-17):**
   a vision-model pass is running it — brief, change list and rules of
   engagement are `qa/VISUAL-QA-HANDOFF.md`; findings will land in `qa/`.
3. **D3(b), parked:** render non-plain note kinds read-only in the
   Floating Window via the note-projections seam. Deliberately parked —
   do only if real usage asks.
4. **D5, deferred:** the repo-history rewrite (`git filter-repo` for the
   deleted-MP3 pack, 61 MB). Needs a coordinated quiet moment (force
   push + clone-reset announcement), not mid-stream.
