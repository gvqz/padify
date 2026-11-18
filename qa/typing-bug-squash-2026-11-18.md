# Typing bug squash — the tab/undo/redo caret family (2026-11-18)

**Reported by the owner:** "weird bugs when undoing tabs (with ctrl y) and a lot of
other typing bugs, need fixing!" — with the mandate to test heavily and squash.
**Found:** six distinct symptoms, **one root cause**. **Fixed in one place.**

---

## The root cause

`ModelHistory` stored only serialized document strings. Undo and redo restored the
document but re-placed the caret at the **live offsets captured at walk time,
clamped to the restored length** — never the caret the restored state was actually
left with. Whenever an edit changed the document length *before* the caret, the
restored caret drifted into the text:

| # | Gesture | Before (buggy) | After (fixed) |
|---|---------|----------------|---------------|
| A | type `hello` → Tab → ^Z → **^Y** | caret at 5; typing `Z` wrote **`helloZ⇥`** (mid-word, tab jumped to the end) | caret at 6; `Z` writes `hello⇥Z` |
| B | type → Home → Tab → **^Z** | caret at 1 (`h|ello`) | caret at 0 (line start) |
| E | 3 lines selected → Tab → ^Z → **^Y** | only 2 of 3 lines re-selected; the repeat Shift+Tab dedented two lines and left `⇥l3` behind | the full replacement re-selects; the repeat gesture covers every line |
| F | paste at line start → **^Z → ^Y** | ^Z caret 5 (drifted); ^Y caret **inside** "PASTED" — typing wrote `PASTEZD …` | ^Z caret 0; ^Y caret right after the pasted text |
| G | `abc` ⏎ `def` → **^Y** | caret at 3 (before the break) | caret where the undo left it (line end) |
| J | 3 tabbed lines → Shift+Tab → **^Z** | clamped 2-line selection came back | the original 3-line selection comes back |

Ctrl+Y is the redo chord on Windows/Linux (the context menu shows it), which is
why the owner met the family as "undoing tabs with ctrl y" — but every funnel that
opened a history group was exposed: native typing bursts, Enter, paste, IME
composition, commands, selectionless mutates.

## The fix

History entries now carry the caret they were left with — stream offsets, the one
caret form that survives a repaint:

- `ModelHistory.openGroup(pre, caret?)`, `undo(current, caret?)`,
  `redo(current, caret?)` return `{ state, caret }` entries (`HistoryEntry`).
  The live caret at walk time feeds only the **opposite** stack's entry (the state
  being left — which is exactly where redo must put the caret back).
- Every group-open capture point now passes the caret it already had in hand:
  the command pipeline, the selectionless `mutate`, both `beforeinput` branches,
  and `compositionstart`.
- `undo()`/`redo()` restore `entry.caret` via the existing `reselect` clamp;
  a caret-less entry (selectionless mutate, no live selection) falls back to the
  old behavior, so nothing regresses when there is genuinely no caret.

Byte accounting is untouched (states only) — the budget tests still pass as-is.

## Evidence

Reproduced against `dist/` with `scripts/probe-tab-undo.mjs` (Playwright, fresh
context per scenario, real keyboard):

- `qa/evidence/tab-undo-caret-before.txt` — pre-fix build, scenarios A–J showing
  every drift above (built by stashing the fix, rebuilding, probing).
- `qa/evidence/tab-undo-caret-after.txt` — post-fix build, A–L: all carets and
  selections land where their state left them, including the mid-burst-tab walk
  (K: 4 → 3 → 0 back, 3 → 4 → 6 forward) and the rapid ^Z/^Y mash (L: every press
  lands the state **and** its caret, no drift accumulates, no page errors).

## Coverage added

- `src/editor/model/history.test.ts` — entries carry carets through undo/redo,
  caret-less entries stay caret-less, carets don't disturb the byte budget.
- `src/editor/model-port.test.ts` — the reported dance end-to-end at engine
  level (redo-after-tab caret 6, line-start undo caret 0, the multi-line gesture's
  selection riding both ways, entry caret restoring after the live selection was
  dropped for a menu).
- `e2e/tab-key.spec.ts` — the real-keyboard ^Z/^Y dance and the line-start undo,
  asserting the caret stream offset in the browser.
- `scripts/probe-tab-undo.mjs` — the 12-scenario live probe, kept for reruns.

## Gates

`npm run typecheck`, `npx tsc -p server/tsconfig.json`, `npm run lint`,
`npm run format:check`, `npm run test` (91 files / 1786 tests), `npm run build` —
all green. e2e chunks touching the history surface all green: `tab-key` (6),
`editing-fundamentals` + `context-menu` + `note-context-menu` + `rapid-switching`
+ `markdown-source-mode` (33), `delete-everything` + `docs-toolbar` + `math` +
`snapshots` + `typing-effects` + `platform-shortcuts` (104).

## Not bugs, checked along the way

- The mash probe's first expectations were mine, not the app's: after `Home`+`Tab`
  the caret sits between the tab and the line, so the next burst types
  `\tdefabc` — correct, Docs-like behavior; the probe was corrected, not code.
- Markdown source mode keeps its native textarea undo (the model port goes inert
  there); Ctrl+Z/Y in a markdown note never touches the model engine.
- Undo/redo has exactly one keydown owner (the port) and one `beforeinput` owner —
  no double-fire paths.

## Carry-over from the visual pass

The two taste notes the owner asked to keep on file remain recorded in
`qa/visual-pass-2026-11-17.md` under **Observations for the owner**: (1) the dark
row-reveal bloom is ring-led (the 14% accent wash reads quiet on dark — a one-line
taste nudge if wanted, deliberately not made), and (2) the mobile word pill can
sit over a note's last line at full height (pre-existing fixed furniture, opaque
background — an owner call, not a consolidation artifact).
