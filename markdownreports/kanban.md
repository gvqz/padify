# Simple Kanban

> Feature reference for the retired **Simple Kanban** page (`public/kanban/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

Simple Kanban was a lightweight, local-only three-column task board (To Do / In Progress / Done). Every card is a plain text item; cards are created per-column, dragged freely between columns, edited inline, and exportable as CSV.

## Data model & storage

- **Storage key:** `kanban` (localStorage) — JSON with three arrays:
  - `todo: string[]`
  - `inProgress: string[]`
  - `done: string[]`
- Cards have **no ids, no metadata, no due dates** — a card is purely its text. The saved order of each array is the vertical order of cards in that column.
- Persistence writes the full board on every mutation (add, edit, delete, drag) by reading `.task-text` content out of each column's task list.
- Each column shows a **placeholder** element when it has no cards (hidden while cards exist; visibility recomputed after every save).

## Adding cards

- Each column has its own input field; pressing **Enter** in it adds a card to that column.
- Empty/whitespace-only text is rejected (trimmed check); on rejection the input is focused.
- After adding, the input is cleared and the board is saved.
- New cards are appended to the bottom of their column.

## Moving cards

- All three columns share one Sortable group (`group: 'tasks'`), so cards can be **dragged between any columns** as well as reordered within a column.
- Drag configuration: 150ms drag animation; the source list is highlighted as a drop target during the drag (`onStart`/`onEnd`/`onLeave` hooks).
- Sortable is configured to **filter** (not drag) on placeholders, inline edit inputs, and action buttons so those remain clickable.
- Board state saves on drag end (`onEnd`).

## Editing cards

- Each card has an **edit button** that swaps the card text for an inline text input (pre-filled, auto-focused and selected):
  - **Enter** or **blur** saves the edit (empty text keeps the previous text).
  - **Escape** cancels the edit.
  - Dragging is disabled on the card while it's being edited (cursor changes to text).
  - The blur-save listener is carefully detached on cancel so a cancel doesn't double-fire as a save.
  - Clicking inside the input doesn't start a drag (mousedown/dragstart are stopped).
- Saving an edit persists the whole board.

## Deleting cards

- Each card has a **delete button** which opens a confirmation modal; confirming removes the card, re-shows the column placeholder if the column is now empty, and saves.
- The card pending deletion is tracked in a global (`window.taskToDelete`).

## Touch behavior (mobile)

- On touch devices, the per-card **action buttons are hidden by default** and revealed by touching the card; tapping elsewhere on the page (global touchstart handler) hides them again.
- The revealed buttons auto-hide ~2 seconds after `touchend`.
- Action buttons and the edit input stop touch-event propagation so taps on them don't trigger drag logic or the reveal/hide logic.
- Touchmove on the actions area is prevented entirely so it can't start a drag.

## Export

- **Download CSV** button exports the whole board as `kanban.csv`:
  - Header row: `To Do,In Progress,Done`.
  - Row *i* of the CSV holds the *i*-th card of each column (position-aligned across columns, empty quoted cells when a column runs out).
  - Every cell is wrapped in double quotes with embedded quotes escaped (`"` → `""`).
  - Blob download (`text/csv;charset=utf-8;`), object URL revoked after click.
- There is also a `getTasks(status)` helper that returns a given column's array from storage (used by the export; reflects the *saved* state).

## Fullscreen

- A fullscreen toggle button requests fullscreen on the document (or exits it if already fullscreen), switching icons on state change; the `fullscreenchange` event also keeps the icon in sync.

## Theme

- Three-state theme cycler: **device → light → dark** (in that order) on each toggle click, persisted in localStorage key `kanbanMode` (`'device' | 'light' | 'dark'`, default device).
- In device mode, live `prefers-color-scheme` changes are followed (matchMedia change listener, including the legacy `addListener` path).
- The toggle's label/aria state reflects the current mode; theme choice updates `<meta name="theme-color">`.

## Dependencies (as shipped)

- jQuery (modal, fullscreen button), Bootstrap (delete confirmation modal), Sortable.js (drag & drop). No build step, no server, no cloud sync — purely local.

## Notes for rebuilding inside the main app

- The natural target is a **board note type** whose content is `{ columns: [{ id, title?, cards: [{ id, text }] }] }` — the current model has no ids or column titles, which should be added when rebuilding (ids enable per-card sync and stable drag targets; the current text-only cards make last-write-wins sync coarse).
- The card reveal-on-touch interaction is a mobile affordance that should be replaced by a proper actions pattern in the main app.
- CSV export should be preserved as a note-level export option.
- Inline edit semantics (Enter/blur save, Escape cancel) are worth keeping — they map cleanly onto a card editor.
