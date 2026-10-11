# Drawingpad

> Feature reference for the retired **Drawingpad** page (`public/drawingpad/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

The Drawingpad went through three generations:

1. **Fabric.js pad** (early) — freehand pen/eraser drawing.
2. **Excalidraw canvas** (most recent full implementation) — a self-hosted copy of the Excalidraw canvas component wrapped in a thin Padify shell with scene autosave. **This is the feature set that matters for the rebuild.**
3. **Locked shell** (state at deletion) — the page was stripped to its navbar + placeholder behind a temporary PIN gate while "the canvas is rebuilt from the ground up".

## Current state at deletion

- The page carried only its shell: brand navbar, a "The drawing canvas is being rebuilt — it'll be back soon." placeholder, and a **4-digit PIN gate** (PIN `1234`, defined in `public/drawingpad/lock.js`).
- Entering the correct PIN unlocks the pad **for the current browser session** (unlock flag in `sessionStorage`, key `padifyDrawingpadUnlocked`); closing the tab re-locks it. A wrong PIN shakes the entry and resets it; the pad remains hidden while locked.
- The gate's stated design intent: "When the new canvas lands, its scripts mount here again."

## Generation 2 — the Excalidraw-based pad (the reference feature set)

### Architecture

- A self-hosted, vendored copy of **Excalidraw** (React + ReactDOM + excalidraw.production.min.js + font assets + ~60 locale files) served entirely from the app's own directory — **no CDN, no external requests, no telemetry, no links back to the vendor site, no badge**; the stock Excalidraw footer was replaced with a quiet "Padify" label.
- The wrapper (`app.js`, ~170 lines) mounted the Excalidraw component into the page root and drove persistence through its `onChange` + `excalidrawAPI` hooks.

### Scene persistence

- **Storage key:** `padifyDrawingpadScene` (localStorage).
- **Payload:** `{ version: 1, savedAt: <epoch ms>, elements: [...], appState: {picked keys} }`.
- **Debounced autosave:** every change schedules a save **300ms** later (trailing debounce); storage failures (quota/unavailable) are swallowed — drawing keeps working.
- **Restore on load:** the saved scene feeds Excalidraw's `initialData` (elements + appState). A payload missing a valid `elements` array is ignored (fresh canvas).
- **Persisted app-state subset** (the tool defaults worth keeping between sessions): canvas background color; current item stroke color, background color, fill style, stroke width, stroke style, roughness, opacity, font family, font size, text align, start/end arrowheads, roundness, edge kind; grid size; grid mode.
- The **`savedAt`** timestamp rides along for future migrations.

### Canvas actions (as exposed)

Enabled in the UI options:
- **Open/Load file** (`.excalidraw` files).
- **Save to disk** (`.excalidraw` scene file).
- **Save as image** (PNG/SVG export).
- **Change canvas background**.
- **Disabled on purpose:** the multi-canvas "export"/"save as image library" export action and the built-in **clear canvas** action (Padify keeps its own) — keeping destructive/leave-app actions out.

### Excalidraw feature surface (everything the vendored canvas provided)

- **Drawing tools:** selection, rectangle, diamond, ellipse, arrow, line, freedraw (pen), text, image insert, frame, laser pointer, library of reusable elements.
- **Element styling:** stroke color, background color, fill styles (hachure/cross-hatch/solid), stroke widths, stroke styles (solid/dashed/dotted), sloppiness/roughness, opacity, edge kinds, arrowheads per end, corner roundness.
- **Text:** multiple font families (with the vendored handwritten/casual/code fonts), font sizes, text alignment, editable text elements.
- **Canvas aids:** grid mode with adjustable grid size, snapping, zoom & pan, dark-mode canvas.
- **Scene operations:** multi-select, grouping/ungrouping, duplicate, delete, undo/redo history, z-order changes, lock elements, align/distribute, resize/rotate handles, copy/paste (including paste as PNG), context menus.
- **Files:** open `.excalidraw`, save `.excalidraw` to disk, save as image (PNG/SVG).
- ~60 UI locales shipped with the vendored bundle.

### Padify-level actions

- **Clear canvas** (navbar button): asks for confirmation (`confirm` dialog — "Clear the whole canvas? This cannot be undone."), then empties the scene via `excalidrawAPI.updateScene({ elements: [] })`.
- **Theme:** the canvas followed the **device preference** at mount time (`prefers-color-scheme: dark` → dark canvas).
- **Failure mode:** if the Excalidraw/React scripts failed to load, the page showed a "canvas failed to load, try refreshing" message instead of a broken page.

## Generation 1 — the Fabric.js pad (historical, superseded)

Feature set of the original drawing pad, kept for the record:

- Fabric.js canvas in **drawing mode** with:
  - **Pen** and **eraser** tool modes.
  - Four **pen sizes** (2 / 5 / 10 / 20 px).
- **Clear drawing** button.
- **Download drawing** button (exported the canvas image).
- **Undo** via **Ctrl/Cmd + Z**: a 20-state-deep undo stack of canvas snapshots (`canvas.toJSON()`), pushed on `object:added` only when the object count actually changed; undo pops and restores via `loadFromJSON`, temporarily suspending the object-added listener to avoid polluting the stack.
- **Responsive canvas:** on resize, the canvas is resized to its container and **all existing objects are rescaled proportionally** to the new dimensions (scale computed from old→new width/height).
- Persistence (if any) was tied to Fabric's JSON serialization of the same canvas.

## Cloud sync history (relevant context)

- An **opt-in cloud sync for "notes and drawings"** existed when the sync layer ran on Supabase (commit `49f8001`): the drawing scene was stored per-account alongside notes.
- The Turso/API migration (commit `7b66e15`) dropped drawing sync — the current cloud layer syncs **note tabs only** (see `server/schema.sql`: users/sessions/notes/shares). Any drawing-note type that returns will need its own sync path (scene JSON per note, analogous to the notes table's html column, plus tombstone semantics).

## Notes for rebuilding inside the main app

- The stated product direction: **the "new note" flow becomes the home for creating drawings** — i.e., a drawing note type whose content is a scene payload (`{ version, elements, appState }`) rather than editor HTML.
- The Generation-2 persistence contract is directly reusable as the note content format: version number, `elements` array, a whitelisted `appState` subset, and `savedAt`.
- The vendored, fully self-hosted Excalidraw bundle (React + assets + locales) is the known-good implementation of the drawing surface itself; the same no-CDN/no-telemetry constraints were deliberate and should carry over.
- Cloud sync for drawings was deliberately cut in the Turso migration, not forgotten — a drawing note type must decide: local-only, or a schema addition (`type` + scene column) to the notes API.
- Clear-canvas-as-a-confirmed-destructive-action (rather than the vendor's built-in) was a deliberate Padify choice worth keeping.
