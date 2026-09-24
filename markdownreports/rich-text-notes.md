# Rich Text Notes

> Feature reference for the retired **Rich Text Notes** page (`public/rich-text-notes/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

Rich Text Notes was a single-document WYSIWYG editor built on **Quill** (snow theme): full rich formatting with a toolbar, autosave to localStorage, and PDF/HTML export.

## Data model & storage

- **Storage key:** `richNotes` (localStorage) — the editor's **HTML** content, saved on every text change.
- On load, the saved HTML is injected directly into the Quill root (`quill.root.innerHTML`).
- The saved HTML is a *cleaned clone* of the editor DOM: before persisting, any dark-mode text-override classes are stripped so the stored document never contains theme-remediation artifacts.
- **Theme key:** `richNotesMode` (`'light' | 'dark' | 'device'`; default device).
- No multi-document support — one document per browser profile.

## Editing

- **Quill** WYSIWYG editor with placeholder text ("Type your text here...") and autofocus on load.
- Full formatting surface (Quill toolbar):
  - Inline: **bold, italic, underline, strike**, **subscript/superscript**.
  - Blocks: **blockquote, code block**; **ordered and bullet lists**; **indent / outdent**.
  - **Text alignment** (left/center/right/justify).
  - **Links, images, videos** (embeddable media).
  - **Font family** and **font size** (small/medium/large/huge).
  - **Text color** and **background color** pickers.
  - **Formula** (KaTeX math insertions).
- **Autosave:** every `text-change` event persists the cleaned HTML to localStorage.

## Dark-mode text remediation

A notable behavior for content fidelity in dark mode:

- When dark mode is active, the page scans the editor for elements with **dark gray inline font colors** (grayscale colors with all channels < 200, parsed from hex/named/rgb(a) forms) and applies a `dark-text-override` class so dark-on-dark text stays legible.
- The scan runs on theme switch and after every edit (debounced through a `requestAnimationFrame`).
- The override **never leaks into storage or exports**: saving strips the class from the stored clone, and the PDF export starts from a cloned root as well.

## Export

- **Download PDF** (`downloadAsPdf`):
  - Builds a "PDF-ready" HTML clone of the document with Quill's class-based formatting translated into concrete inline styles: alignments, heading scales (h1–h6), font families (serif/monospace), font sizes (small/large/huge), the eight standard Quill colors and background colors, blockquote styling, code blocks and inline code, table borders, list styles, indentation levels (1–9), RTL direction, link styling, and media max-width.
  - Renders via **jsPDF**'s `pdf.html()` (A4 portrait, 180mm content width, 800px window width, 15mm margins, auto-paging by text).
  - Filename: `Rich-Notes-<d>-<m>-<yyyy>.pdf`.
  - Keyboard shortcut: **Ctrl/Cmd + S** triggers the PDF download (and suppresses the browser's save dialog).
- **Download HTML** (`saveHTML`):
  - Converts the document from Quill's **Delta ops** (not the raw DOM) using **QuillDeltaToHtmlConverter** into standalone HTML.
  - Downloads as `Rich-Notes-<d>-<m>-<yyyy>.htm`.

## Theme

- Three-state theme: **light / dark / device**, persisted in `richNotesMode`; default is device.
- Toggle button cycles light ↔ dark; **Ctrl/Cmd + M** is the keyboard shortcut.
- Theme switch triggers (or clears) the dark-text-override scan described above.

## Other interactions

- The download button is a **dropdown** (PDF / HTML) that opens on click and closes when clicking outside it.

## Dependencies (as shipped)

- Quill (snow theme + formula module), QuillDeltaToHtmlConverter (delta→HTML export), DOMPurify (sanitizer available on the page), jsPDF + html2canvas(-pro) (PDF), jQuery, Bootstrap. No build step; no cloud sync — purely local.

## Notes for rebuilding inside the main app

- The main app's note tabs already hold an HTML subset (b/i/u/s/br/div/span) with `sanitizeNoteHtml` gating what may enter the editor — a rich-text note type is an *expansion* of that whitelist plus the formatting UI (the main app currently exposes bold/italic/underline/strikethrough via the context menu only).
- The dark-gray-color remediation logic is a genuinely useful content-fidelity behavior to carry over whenever user-colored text can meet dark mode.
- Export parity to preserve: PDF via style-flattened HTML (the Quill-class → inline-style flattening list above is the checklist), and HTML export via **Delta ops** rather than raw DOM.
- Quill's storage format here was raw HTML; the main app could either keep HTML for this type or store Deltas — but Delta-based export should be preserved either way for clean HTML output.
