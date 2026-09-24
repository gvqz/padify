# Markdown Editor

> Feature reference for the retired **Markdown Editor** page (`public/markdown-editor/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

The Markdown Editor was a two-pane editor: plain markdown source on the left, live rendered preview on the right, with a formatting toolbar, math rendering, emoji shortcode support, and three export formats. The document autosaves to localStorage as you type.

## Data model & storage

- **Document:** localStorage key `markdown` — the raw markdown text of the single document. Restored into the editor on load; overwritten on every keystroke (`cm.on('change')`).
- **Theme:** localStorage key `theme` (`'light' | 'dark'`); restored on load.
- **Panel layout:**
  - `textPanelWidth` / `previewPanelWidth` — saved pixel widths of the two panes after manual resize.
- No multi-document support — one document per browser profile.

## Editing surface

- The source editor is **CodeMirror** configured for markdown:
  - Line numbers, line wrapping, auto-close brackets, huge viewport margin (renders the whole document at once).
  - Light/dark CodeMirror themes (`default` / `base16-dark`) follow the theme toggle.
- The right pane renders the live preview; typing re-renders the preview immediately on every change.

## Rendering pipeline

- Preview rendering uses **marked** with GFM enabled (`marked(md, { gfm: true })`).
- **KaTeX math support:** after markdown→HTML conversion, `renderMathInElement` runs over the rendered DOM with delimiters:
  - `$$ … $$` (display math)
  - `\( … \)` (inline math)
  - `$ … $` (inline math)
  - `throwOnError: false` (bad math renders as-is instead of throwing).
- **Emoji shortcodes:** the rendered HTML passes through a `replaceWithEmojis` pass (local emoji.js with a large shortcode→unicode map), so `:smile:`-style codes render as emoji.
- A second, hidden conversion via **showdown** feeds the "HTML source" view (below).

## Preview / HTML-source toggle

- The right pane has two modes, toggled by a dropdown:
  - **Preview** — the rendered markdown (`#markdown`).
  - **HTML** — a textarea showing the generated HTML source (`#htmlPreview`, produced by the showdown converter with KaTeX-processed input).

## Sync scroll

- **Synchronized scrolling** between editor and preview: scrolling either pane scrolls the other proportionally (percent-of-scrollable-height mapping, both directions, with a temporary "mute" swap of the scroll listener to avoid feedback loops).
- The sync-scroll checkbox reflects an always-on default (the config flag is written but the toggle is initialized to checked).
- A window resize event re-syncs the panes.

## Resizable panes

- A drag handle between the panes allows **manual resizing**:
  - Each pane has a minimum width of 20% of the edit area; the split is otherwise free.
  - Dragging live-refreshes CodeMirror so the editor re-measures.
  - Widths persist to localStorage (`textPanelWidth` / `previewPanelWidth`) and are restored on load.
  - On window resize, the split re-validates so neither pane drops below the 20% minimum.
- **Toggle side panel:** a toolbar button hides/shows the preview pane entirely; hiding expands the source pane to 100% width; showing restores the saved widths (or a 50/50 default).

## Formatting toolbar

Toolbar actions operate on the CodeMirror selection:

- **Bold** — wraps selection in `**…**` (toggling strips existing `**`/`__` wrappers first).
- **Italic** — wraps in `_…_` (strips `*`/`_` wrappers).
- **Strikethrough** — wraps in `~~…~~` (strips existing `~~`).
- **Heading** — cycles heading level "smaller": no heading → `# `, then `## `… up to `###### `; at h6 it strips back to plain text. (A `toggleHeadingBigger` and fixed-size `_toggleHeading(_, 1|2|3)` variants exist in the code as well.)
- **Blockquote** — toggles `> ` at line start (per selected line range).
- **Unordered list** — toggles `* ` at line start (also recognizes `- ` / `+ ` forms when removing).
- **Ordered list** — toggles `1. ` at line start (removes `\d+. ` forms).
- **Link** — inserts `[selection](#url#)` with `#url#` pre-filled as `http://`; if the cursor is already in a link it behaves as an unwrap.
- **Image** — inserts `![selection](#url#)` similarly.
- **Table** — inserts a 3×3 markdown table skeleton (header row + separator + one text row) below the cursor.
- **Horizontal rule** — inserts `-----` with surrounding blank lines.
- All wrap/line actions preserve and re-select the affected selection so repeated invocations toggle cleanly.

## Keyboard shortcuts

(Active while the CodeMirror editor has focus; Mac uses ⌘, others Ctrl.)

- **Ctrl/Cmd + B** — bold
- **Ctrl/Cmd + I** — italic
- **Ctrl/Cmd + H** — heading smaller
- **Ctrl/Cmd + /** — strikethrough
- **Ctrl/Cmd + L** — insert link
- **Ctrl/Cmd + Alt + I** — insert image
- **Ctrl/Cmd + Shift + T** — insert table

## Export

- **Download Markdown** (`downloadMarkdown`) — the raw source as `markdown-document.md` (Blob, `text/markdown`).
- **Download HTML** (`downloadHTML`) — a complete standalone HTML document `markdown-document.html`:
  - Built via showdown from the source with KaTeX-processed content.
  - Embeds a small default stylesheet for typography, code blocks, blockquotes, tables.
  - References KaTeX CSS + JS from a CDN and runs auto-render math on load with the same delimiters as the app.
- **Download PDF** (`downloadPDF`) — `markdown-document.pdf`:
  - Renders the markdown in an off-screen iframe (800px wide, GitHub-like typography).
  - After load (~1s), the iframe body is captured with **html2canvas** at 2× scale, then paginated into A4 pages with **jsPDF** (210×297mm; image is sliced page by page while content remains).
  - Math is *not* rendered in the PDF path (KaTeX processing is skipped for PDF generation).
  - Errors alert the user and clean up the hidden iframe.

## Theme

- Light/dark toggle in the navbar; persists via the `theme` key.
- Switching theme changes the CodeMirror theme, the body class, the toggle's icon/aria state, and restores on next load.

## Tool visibility

- The formatting **toolbar itself can be collapsed/expanded** via a chevron button (`showToolBar`).

## Dependencies (as shipped)

- CodeMirror (markdown mode, theming), marked (GFM rendering), showdown (HTML source + HTML export), KaTeX + auto-render (math), html2canvas (CDN, PDF), jsPDF (PDF), local emoji shortcode table, jQuery, Bootstrap. No build step for the page; no cloud sync — purely local.

## Notes for rebuilding inside the main app

- The main app's note tabs already store an HTML subset; a markdown note type needs to store the **source text** (plus a type discriminator) and render on demand — the two-pane preview/HTML-toggle model can be preserved as a note view mode.
- KaTeX delimiter set (`$$`, `\(\)`, `$`) and emoji shortcode pass are the two rendering extras most likely to be forgotten in a rebuild.
- The wrap/toggle toolbar logic (strip-then-rewrap so actions toggle) and the line-prefix toggles (quote/list) are self-contained and portable.
- Export parity to preserve: **.md** (source), **.html** (standalone document with CDN KaTeX), **.pdf** (iframe render + html2canvas + jsPDF, no math).
- Autosave already matches the main app's per-keystroke persistence; only the storage key changes.
