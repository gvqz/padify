# Tasks

> Feature reference for the retired **Tasks** page (`public/tasks/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

Tasks was a "dead simple todo manager": a single-page, local-only task list where each task is a text item that can be completed, edited, reordered, given a due date, and given a reminder time. Completed tasks sink to a separate section at the bottom of the list, and reminders fire both in-page and (if permitted) as OS notifications.

## Data model & storage

- **Storage key:** `tasks` (localStorage) — a JSON array of task objects.
- **Task object shape:**
  - `id` — string; `crypto.randomUUID()` when available, otherwise `task-<Date.now()>-<random6>`.
  - `text` — the task title (plain text).
  - `completed` — boolean.
  - `dueDate` — ISO datetime string or `''`.
  - `reminderAt` — ISO datetime string or `''`.
  - `reminderNotifiedAt` — the `reminderAt` value last notified for this task (used as a "don't re-notify" flag); `''` initially.
- The DOM is the working state: every mutation reads the task cards back out of the list, rebuilds the array in **list order** (active tasks first, then done tasks), and rewrites the whole array to localStorage. There is no separate in-memory model.
- Malformed/corrupt stored JSON falls back to an empty task list on load (try/catch around `JSON.parse`).

## Adding tasks

- A task is added by typing into the **task input** and either pressing **Enter** or clicking the **Add** button. Empty/whitespace-only input is ignored and focus is returned to the input.
- At creation time you can optionally set a **due date** and a **reminder** time (both `datetime-local` inputs, both optional).
- New tasks are **prepended** to the active list (newest on top).
- After adding, the input fields (text, due date, reminder) are cleared and focus returns to the text input.
- The task input is focused automatically on page load.

## Completing / uncompleting tasks

- Each task has a checkbox. Checking it:
  - Marks the task completed.
  - Moves the card to the **Done** list (appended at the end of the done section).
  - Removes the drag handle (done tasks are not reorderable).
  - **Confetti** fires when checking a task completes the *entire* list — two confetti bursts from opposite bottom corners (particle count 100, spread 70, angles 60/120).
- Unchecking a completed task:
  - Marks it active again.
  - **Prepends** it back to the active list.
  - Re-adds the drag handle.

## Editing tasks

- **Inline title editing:** clicking a task's text swaps the text for a text input pre-filled with the current title. Committing happens on **Enter** or **blur**; an empty edit falls back to the original text. The card gets an "is-editing" state while editing.
- **Edit modal (details):** the per-task edit button opens a modal pre-filled with the task's due date and reminder. Saving:
  - Updates the task's `dueDate`/`reminderAt` (empty values clear them).
  - If the reminder time **changed**, the "already notified" flag is reset and any open reminder toast for that task is removed, so the new reminder time will notify again.
- Editing due date/reminder also refreshes the task's meta chips and overdue state.

## Deleting tasks

- The per-task delete button removes the task immediately (no confirmation modal for single deletes), removes any open reminder toast for it, and saves.
- **Clear all:** a "Clear All Tasks" button (only visible when at least one task exists) opens a confirmation modal; confirming empties the active list, done list, and reminder toast stack, then saves (skipping the reminder sweep on that save).
- When the list becomes completely empty, a "no tasks" empty-state message is shown and the Clear All button is hidden.

## Task ordering

- **Drag to reorder** active tasks using a dedicated drag handle on each active task card (Sortable.js):
  - Animation 180ms with a cubic-bezier easing.
  - Only active (not completed) tasks are draggable; the handle is hidden/removed for completed tasks.
  - Reordering persists immediately on drag end.
- Ordering rules:
  - New tasks go to the **top** of the active list.
  - Newly uncompleted tasks go to the **top** of the active list.
  - Newly completed tasks go to the **bottom** of the done list.
  - Loaded tasks restore in stored order.

## Due dates & overdue detection

- A task with a `dueDate` shows a meta chip reading `Due <formatted datetime>`; if the task is **overdue** the chip reads `Overdue <formatted datetime>` and the card is flagged (overdue only applies to *incomplete* tasks with a past due date).
- Datetime formatting is locale-aware: `Intl.DateTimeFormat` with month `short`, day `numeric`, hour `numeric`, minute `2-digit`. Unparseable date strings are displayed raw.
- Overdue state is re-evaluated on every state refresh (each save/load/edit).

## Reminders

- Tasks with a future `reminderAt` show a `Reminder <formatted datetime>` meta chip.
- **Reminder engine:**
  - Sweeps every **30 seconds** (`setInterval`), plus immediately on window **focus** and on `visibilitychange` back to visible.
  - A sweep is re-entrancy guarded (only one sweep at a time).
  - A reminder fires when: the task is active (not completed), `reminderAt` is a valid time in the past, and `reminderNotifiedAt !== reminderAt` (i.e., this exact reminder hasn't already fired).
  - On firing, the task's `reminderNotifiedAt` is stamped with the fired `reminderAt` — so each reminder time notifies **once**; editing the reminder time re-arms it.
- **Notification surfaces:**
  - An in-page reminder **toast** (stacked, bottom area): title "Task reminder", body either "`<task>` is due `<due date>`." (if a due date exists) or "`<task>` is ready for attention.". Includes a dismiss button; auto-dismisses after **10 seconds**.
  - A **Web Notification** (`new Notification('Task reminder', ...)`) in addition to the toast, but only if the browser supports the Notification API **and** permission was already granted (the page never requests permission itself).
- Deleting a task (or clearing all) removes its open toasts; changing a reminder removes that task's toast.

## Task counter & empty states

- A live counter shows `done / total` (e.g. `3 / 7`), updated after every save.
- A **separator** between the active list and the done list is only shown when at least one task is completed.
- Distinct empty states:
  - No tasks at all → "no tasks" message (Clear All hidden).
  - All tasks done (active list empty but done list non-empty) → an "active empty" message above the done section.

## Theme

- Three-state theme: **light / dark / device**, persisted in localStorage key `tasksMode` (`'light' | 'dark' | 'device'`; default device).
- Toggle button in the navbar; cycles light ↔ dark.
- Keyboard shortcut: **Ctrl/Cmd + M** toggles the theme.
- Theme choice also updates the `<meta name="theme-color">` value.

## Dependencies (as shipped)

- jQuery, Bootstrap (modal, form controls), Sortable.js (drag-to-reorder), canvas-confetti (completion celebration), Bootstrap modal for confirmations.
- No build step, no server, no cloud sync — purely local.

## Notes for rebuilding inside the main app

- Everything about the page is replaceable with a task list note type: `content` would hold the task array (id, text, completed, dueDate, reminderAt, reminderNotifiedAt) instead of editor HTML.
- The reminder sweep (30s + focus + visibility) needs a single app-level scheduler rather than a per-page interval, and should only fire while a task note is open (or run globally if tasks stay cross-note).
- Reminder permission requests were never wired up — a rebuilt version should prompt for Notification permission in settings.
- The once-per-`reminderAt` notification guard (stamp-and-compare) is the key behavior to preserve; it prevents duplicate notifications across sweeps and page reloads.
