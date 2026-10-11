# Text Diff

> Feature reference for the retired **Text Diff** page (`public/text-diff/`), captured before deletion so the feature set can be rebuilt inside the main Padify editor. This document covers behavior and functionality only.

Text Diff compared two blocks of text (Original vs Modified) using a self-contained Myers diff implementation, showing a two-column line diff with word-level highlights, statistics, and one-click actions to pull original lines into the modified text.

## Data model & storage

- **Theme:** localStorage key `notepad_text_diff_theme_v1` (`'light' | 'dark'`, default light). Nothing else persists — the two text panes are session-only.

## Diff engine

- A from-scratch **Myers O(ND) diff** (no external library): forward pass with a V-array and a trace per D-step, then backtracking to produce per-token edit operations (`equal` / `delete` / `insert`).
- Two-level diffing:
  - **Line level** — lines are compared as keys to build row operations.
  - **Word level (inline)** — within a changed line pair, both sides are tokenized (runs of whitespace vs non-whitespace) and diffed again, so *which words changed* inside a modified line are individually highlighted on each side.
- **Comparison options:**
  - **Ignore case** — lowercases both sides for matching (both lines and tokens).
  - **Ignore whitespace** — trims and collapses internal whitespace runs for line keys; whitespace-only tokens normalize to a single space for token matching.
- Consecutive delete/insert runs are paired up into row types: `equal`, `change` (paired delete+insert), `remove` (delete only), `add` (insert only).

## Compare behaviors

- **Auto-compare mode** (on by default): re-runs the diff **220ms** after the last keystroke in either pane (debounced); toggling the ignore-case/ignore-whitespace options also re-runs immediately.
- **Compare button** forces a manual re-run (also the path when auto-compare is off).
- **Swap button** — exchanges the contents of the two panes and re-runs the diff (with a brief flash cue on the two panels).
- **Clear button** — empties both panes and re-runs (returning to the empty state).
- **Empty state:** with no text on either side, the diff area shows a "paste text in both boxes" hint and zeroes the stats.

## Diff presentation (functional aspects)

- A two-column row list (Original | Modified) with **line numbers on both sides** (blank for added/removed rows).
- Row classification per the engine: added / removed / changed / equal.
- For **changed rows**, both cells render word-level inline diffs — deleted tokens marked on the left, inserted tokens marked on the right.
- Every changed row pairs one original line with its replacement; removed rows show original-only; added rows show modified-only.

## Statistics

- Live counters for **added**, **removed**, **changed**, and **equal** rows, updated on every render.

## Pull-original actions

- Each **changed** row carries a **"Apply original to modified"** action:
  - Replaces the paired modified line with the original line.
  - If the stored modified text no longer matches the row's recorded right side (text drifted), it locates the nearest line equal to the old modified text (nearest to the expected index) and replaces that, or bails out safely if it can't find it.
- Each **removed** row carries an **"Insert original into modified"** action:
  - Re-inserts the deleted original line into the modified text at the correct position — positioned by finding the nearest following modified line, or falling back to the nearest preceding one, or appending at the end.
  - Uses the same nearest-match search when indices have drifted.
- Both actions rewrite the modified pane and immediately re-render the diff, so rows update in place.

## Clipboard

- **Copy modified** button copies the modified pane's text; uses `navigator.clipboard.writeText` with a **fallback to `execCommand('copy')`** (selects the textarea, copies, then restores the previous selection) for browsers/contexts without the async clipboard API; the button shows a copied state for ~1.5s.

## Theme

- Light/dark toggle persisted (`notepad_text_diff_theme_v1`); updates the body class, toggle `aria-pressed`/title/label, and `<meta name="theme-color">`.

## Dependencies (as shipped)

- Vanilla JS, zero libraries (diff included). No build step, no network — purely local.

## Notes for rebuilding inside the main app

- The Myers engine (line + token levels, with case/whitespace normalization) is fully self-contained and reusable as-is.
- The most valuable integration target: **compare a note's current text against an older snapshot** (the main app already keeps snapshots), or compare two notes/tabs — both are natural fits that the standalone page couldn't offer.
- The pull-original actions (apply/insert original into modified) are the differentiating features versus a plain viewer; they need the nearest-line recovery logic to survive text drift.
- Auto-compare's 220ms debounce is a good responsiveness/cost balance to keep.
- Export/copy parity: only "copy modified" existed; a rebuild could add "save diff result as a note".
