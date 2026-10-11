# Teleprompter

> Feature reference for the retired **Teleprompter** page (`public/teleprompter/`), captured before deletion so the feature set can be rebuilt inside the main Padify app. This document covers behavior and functionality only.

Teleprompter turned pasted script text into a smoothly auto-scrolling reading surface with adjustable speed, typography, and reading options — plus fullscreen and keyboard control.

## Data model & storage

- **State key:** `teleprompter-state-v1` (localStorage) — a single JSON payload:
  - `text` — the full script text.
  - `settings` — all reader settings (see below).
- Saves are **debounced 300ms** after any change (script edits or setting changes).
- On load, saved state restores both text and settings; corrupt/missing payloads fall back to a **built-in sample script** (a short "welcome to your teleprompter" text with usage tips).
- A **"Load sample"** button restores the sample script at any time.

## Reader settings (all persisted)

- **Speed** — scroll rate, 10–200 **px/s** (default 60), adjustable live while playing.
- **Font size** — 24–96 px (default 48).
- **Line height** — 1.2–2.4 (default 1.6).
- **Text width** — 40–90 `ch` (default 62), constraining the measure of the reading column.
- **Mirror text** — horizontally flips the prompter frame (for mirror rigs/cameras).
- **Center guide** — toggles a reading guide line on the prompter stage.
- **Start from top** — when enabled (default), pressing play always restarts from the top; when disabled, play resumes from the current scroll position.
- **Background color** / **Text color** — color pickers (defaults `#111827` / `#f8f9fa`).
- All settings apply live through CSS custom properties on the document root.

## Playback

- **Play/Pause toggle**:
  - Scrolling is driven by `requestAnimationFrame` with delta-time integration (frame delta clamped to 50ms so tab-switch stalls don't jump the text).
  - **Smoothed scrolling:** the render position eases toward the target position (35% per frame, snapping when within 0.08px) rather than stepping — constant, jitter-free motion.
  - The speed setting can be changed **mid-scroll** and takes effect immediately.
  - If the script is too short to scroll, play refuses with an "Add more text to scroll" status.
- **Auto-stop at end** — when the bottom is reached, playback pauses itself and reports "Reached end".
- **Reset** — pauses and rewinds to the top (also resets the "has started" memory).
- **Play status pill** — live state label: Waiting for text / Ready / Playing / Paused / Reached end.
- **Scroll position** is user-draggable when paused; the play position resyncs to wherever the user scrolled.

## Script side

- A script textarea (the editing surface) with **live word count**.
- Text syncs into the prompter content on every input; an empty script shows a "Paste or type your script to start." placeholder in the prompter.
- Editing the script resets playback memory (has-started flag) and syncs the scroll anchors, so play after an edit starts consistent.

## Progress & monitoring

- A **progress bar** (0–100%) reflects scroll position; it updates during playback and during manual scrolling.

## Fullscreen

- **Fullscreen toggle** puts the prompter stage into fullscreen (and exits it); a `fullscreenchange` listener keeps the button's label/aria in sync with actual state.

## Keyboard shortcuts

(Active whenever the focus is not in the script textarea.)

- **Space** — play/pause
- **R** — reset scroll
- **F** — toggle fullscreen

## Dependencies (as shipped)

- Vanilla JS, zero libraries. No build step, no network — purely local.

## Notes for rebuilding inside the main app

- Maps cleanly to a **"presentation/read mode" for any note** rather than a separate tool: given the main app's notes, the natural rebuild is "open note → read aloud mode" with the same speed/typography/mirror/guide controls.
- The state payload (`{ text, settings }`) becomes just the settings (the text comes from the note itself).
- Behaviors most worth preserving verbatim: delta-time-clamped rAF loop with eased scroll, live speed changes mid-playback, auto-stop-with-status at the end, and start-from-top vs resume distinction.
- Keyboard guard (ignore shortcuts while typing in the script box) is the pattern to reuse in the main app, which already has a global shortcut layer.
