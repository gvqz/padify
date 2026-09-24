# Text Tools

> Feature reference for the retired **Text Tools** page (`public/text-tools/`), captured before deletion so the feature set can be rebuilt inside the main Padify editor. This document covers behavior and functionality only.

Text Tools was a single-textarea utility workbench: paste text once, then run line operations, cleanup transforms, find & replace, and data extraction against it, all live in the browser with stats and clipboard helpers.

## Data model & storage

- **Text:** localStorage key `notepad_text_tools_text_v1` — the textarea content, persisted on every input.
- **Theme:** localStorage key `notepad_text_tools_theme_v1` (`'light' | 'dark'`, default light).
- **First run:** if no saved text exists, the textarea is seeded with a **sample text** (an Alice in Wonderland sentence plus lines with emails, URLs and phone/ID numbers chosen to demo the extraction tools) and immediately persisted.
- The working document is a single plain-text buffer — every tool transforms it in place (except extraction, which outputs to a results panel).

## Live stats

- A status line under the editor shows **word count, character count and line count**, recomputed on every input and after every transform.
- Word count splits trimmed text on whitespace; line count splits on `\r?\n`.
- A separate status message narrates the last action ("Sorted lines A-Z.", "Replaced 3 matches.", …).

## Tool tabs

Tools are grouped into tabbed panels (switching tabs away from the extract panel hides the results panel):

### Line operations

- **Sort lines A-Z** / **Z-A** — locale-aware (`localeCompare`) ascending/descending sort.
- **Sort by length** — ascending line-length sort.
- **Reverse order** — flips the line order.
- **Shuffle lines** — Fisher-Yates shuffle.
- **Remove duplicates** — exact-line dedupe (case-sensitive).
- **Add line numbers** — prefixes `1. `, `2. `, …
- **Remove line numbers** — strips leading `N.` / `N)` / `N-` / bare `N` prefixes with surrounding whitespace.

### Cleanup

- **Trim lines** — trims each line.
- **Remove empty lines** — drops blank/whitespace-only lines.
- **Remove extra spaces** — collapses runs of spaces/tabs to one space and 3+ consecutive newlines to 2.
- **Join lines** — trims non-empty lines and joins them with single spaces (one paragraph).
- **Wrap at 80 / 120 chars** — greedy word wrapping per line at the given width (blank lines preserved).

### Encode / decode

- **URL encode** — `encodeURIComponent` of the whole text.
- **URL decode** — `decodeURIComponent`, with a friendly toast when the input isn't valid encoded text.

### Find & replace

- Inputs: **find**, **replace**, plus checkboxes **regex mode** and **case-insensitive**.
- **Replace next** — replaces the next match after the last replacement position (sequential stepping); wraps back to the start when no further matches remain ("No more matches found."). The matched region is selected in the textarea as it's replaced.
- **Replace all** — replaces every match in one pass and reports the count.
- Non-regex mode escapes the query so it matches literally.
- Invalid regular expressions are reported via toast instead of throwing.
- Editing the find/replace inputs, toggling the checkboxes, or editing the text resets the "next match" cursor.

### Data extraction

Runs against the whole text and writes **unique** (case-insensitive dedupe), **order-preserving** matches to a results area with a count line, plus a **copy all** button for the results:

- **Extract emails** — standard email pattern.
- **Extract URLs** — matches `http(s)://` and `www.`-prefixed URLs; trims surrounding quotes/brackets/punctuation; filters empties.
- **Extract numbers** — integers, decimals, thousand-separated numbers, and signed values (including `.5` forms).

## Clipboard

- **Copy button** copies the whole editor text via `navigator.clipboard.writeText`; the button confirms with a temporary "Copied!" state (~1.8s).
- The extraction panel has its own **Copy All** for the results.

## Feedback patterns

- Transient **toast** messages (auto-hide ~2.2s) for validation errors ("Please enter text first.", "Invalid regular expression.") and empty results.
- All transforms refuse to run on empty input (toast instead of no-op).
- Every in-place transform persists, refreshes stats, and sets the status message.

## Theme

- Light/dark toggle persisted (`notepad_text_tools_theme_v1`); updates body class, the toggle's `aria-pressed`/title/label, and `<meta name="theme-color">`.

## Dependencies (as shipped)

- Vanilla JS + a Bootstrap-styled page. No libraries, no build step, no network calls — purely local.

## Notes for rebuilding inside the main app

- These are **transform commands**, not a document type — they fit best as an action set applicable to the selected text (or whole note) from the main editor's context menu / command palette, rather than a separate page.
- The whole feature set is pure functions over `string` / `string[]` plus the debounced-persist + stats wiring, so it ports directly onto the main app's plain-text notes.
- Extraction currently outputs to a side panel; in the main app, results could be copied to the clipboard, inserted at the cursor, or saved as a new note.
- Keep the sequential replace-next cursor semantics — it's the behavior users notice when it's missing.
