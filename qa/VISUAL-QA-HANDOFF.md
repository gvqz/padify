# Visual QA pass — handoff to the vision model

**Date:** 2026-11-17 · **Repo:** `/home/z/my-project/padify` (main @ `272dd23`, all CI green, deployed)
**Job:** the human-eye pass that `DECISIONS.md` lists as open work item 2 — belt-and-braces
on top of the automated three-layer proof (static fold-check, computed-style diff,
pixel diff) that guarded the CSS consolidation. You are the layer that can judge
*aesthetics and affordances*, which no diff can.

**Read first:** `docs/ARCHITECTURE-REVIEW.md` (what was overhauled and why — S1–S10),
`qa/findings-LIVE.md` (the previous QA pass; note many of its findings are already
FIXED — see the change list below).

## What changed since the last visual pass (what to look at hardest)

1. **CSS consolidation, complete** (review doc S3): the two design systems became one
   (`public/css/vercel/`, 22 sheets), bootstrap was extracted to a 42 KB subset and
   then pruned again (171 of 382 groups removed, 2026-11-16). Automated proof says
   rendering-neutral; your job is to catch what byte-diffs cannot: cramped spacing,
   broken rhythm, contrast that changed *because* a rule that used to fight another
   one is now gone.
2. **Modal headers went title-only** (`272dd23`): Statistics, About, Keyboard
   Shortcuts, Writing Session each lost their eyebrow label and subtitle sentence —
   one clean line now. History / conflict / unseen / share sheets KEEP their two-line
   heads deliberately (per-view context). Verify the four look right and nothing
   around them sagged.
3. **D1(c) reminder landing**: origin chips, calendar picks and reminder toasts open
   the note ON the dated row — centered, bloomed once (`tk-reveal` animation,
   1.1 s accent wash; respects `prefers-reduced-motion`). The calendar's first
   quick-add creates its task list in the BACKGROUND — no editor hijack.
4. **D2 chord split**: snapshot is Ctrl+Alt+S now (Ctrl+U is underline again). The
   shortcuts modal, History empty-states and dialogs must all speak the new chord.
5. **D3 floating window**: on non-plain notes the PiP button DIMS (opacity .45,
   not-allowed cursor, tooltip "works on plain notes only") instead of vanishing.

## How to drive the app

```bash
cd /home/z/my-project/padify
npm run build                 # dist/ is already built @ 272dd23; rebuild if in doubt
python3 -m http.server 4174 --directory dist   # then browse http://localhost:4174
```

- The repo's own screenshot harness: `node scripts/css-shot.mjs <outDir>` (7 views ×
  light/dark, reduced motion, port 4173, refuses stale servers).
- Playwright chromium is already installed in this sandbox (`~/.cache/ms-playwright`).
- The app is a PWA with a service worker: **clear site data between scenarios** or
  state leaks across "fresh" loads.
- Dark mode, device theme and ink are separate toggles (see `e2e/theme-ink.spec.ts`
  for how they interact); paper textures and fonts live in Preferences.

## Environment quirks (learned the hard way)

- Background processes get reaped between tool calls — run long jobs in the
  foreground. `npm run test:e2e` exceeds the 10-minute limit: chunk it by spec file.
- Kill a stale `http.server` on your port before reuse (`pkill -f "http.server 4174"`).
- Full gates before any commit: `npm run typecheck`, `npx tsc -p server/tsconfig.json`,
  `npm run lint`, `npm run format:check`, `npm run test`, `npm run build`.
- Commit author policy: author AND committer email must be
  `119090177+gvqz@users.noreply.github.com` (git config in the repo is already set —
  "Padify Fix Agent"). CI enforces it, then ~15 min of run time; token for the GitHub
  API lives in `/home/z/my-project/.git-credentials`.

## Rules of engagement

- **Report first, fix second.** Clear-cut regressions (a broken layout, a missing
  border, unreadable contrast) → fix, verify with before/after shots, run the gates,
  commit in the repo's voice (see `git log` for style).
- Aesthetic judgment calls → findings with evidence, owner decides. Do not restyle
  anything on taste alone.
- Do NOT touch: the sync/storage internals (S1's ledger, D4 tranche 2 — scheduled
  2026-11-30, see `docs/STORAGE-AMPUTATION.md`), the repo history (D5, deferred),
  `DECISIONS.md` (the owner's file — findings may be appended to a NEW doc under
  `qa/`, not there).
- Write findings as `qa/visual-pass-2026-11-17.md` + evidence shots under
  `qa/evidence/`, same convention as `findings-LIVE.md`.
