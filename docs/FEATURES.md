# The feature matrix — what each note type can do

*Created 2026-11-23 (the owner's ask: "a feature comparison markdown table/document
that compares the features across all note types"). Every cell is grounded in the
registry and the surfaces — the sources are listed at the bottom. Keep it honest
when a type gains or loses a capability.*

Five types ship today (`src/editor/note-types.ts`): **Plain**, **Rich text**,
**Markdown**, **Task list**, **Drawing**. A note's type owns its content format:
plain/rich store the sanitized-HTML subset, markdown stores its source text, and
task lists and drawings store structured JSON. A type this build has never heard
of rides through as `opaque` — stored verbatim, shown as a placeholder, never
corrupted.

| Capability | Plain | Rich text | Markdown | Task list | Drawing |
|---|---|---|---|---|---|
| **Editing surface** | contenteditable (no toolbar) | contenteditable + the rich toolbar | source textarea + split/preview modes | its own row UI | the Excalidraw island |
| **Bold / italic / underline / strike** | via right-click menu | toolbar + right-click + chords | toolbar + right-click + chords | — | vendor text elements |
| **Text color / highlight** | color via right-click | ink color + highlight pickers (the highlight glyph: issue #166) | — (GFM carries none) | — | vendor colors |
| **Headings & block styles** | — | text-style menu (H1…) | block-style dropdown (H1–3, quote, code block) | — | — |
| **Lists** (bulleted / numbered / checklist) | typed by hand | toolbar inserts | GFM lists + task-list checkboxes | the whole note is a list | — |
| **Links** | remove only (caret-gated) | Ctrl+K popover + right-click | markdown links + autolinks | — | — |
| **Images** | **never** (the owner's scope line) | paste / drop / toolbar row → the attachment store | paste / drop / toolbar row → the attachment store | — | the vendor image tool → the attachment store |
| **Voice recordings** | — | mic row → the `padify-voice` card (3daad1e) | — | — | — |
| **Math** (KaTeX) | — | equation popover + symbol palette | `$…$`, `$$…$$` in source and preview | — | — |
| **Tables** | — | 2×2 insert + cell operations | GFM tables (source + rendered) | — | — |
| **Case conversion** (12 forms) | right-click | right-click | right-click (source-level) | — | — |
| **Clear formatting** | right-click | right-click | right-click + source pass | — | — |
| **Typing substitutions** (em-dash, ellipsis…) | engine path | engine path | field path (source textarea) | field path (composer inputs) | — |
| **Unicode picker insert** | yes | yes | yes (source) | composer fields | no text surface, refused |
| **Floating window (PiP)** | yes — the one type it serves | dims with a tooltip | dims | dims | dims |
| **Export** (download menu) | TXT · PDF · DOCX · HTML · `.padify` | same | same + **`.md`** | same | same + **PNG · SVG · `.excalidraw`** |
| **Share links (public viewer)** | rendered | rendered, images + voice cards resolve | rendered from source, images resolve | rendered rows | raw scene text today — the render-vs-snapshot-vs-hide call: issue #172 |
| **Snapshots (History)** | yes | yes | yes | yes | yes (the scene string; images show the honest placeholder) |
| **Cloud sync + conflict review** | yes | yes | yes | yes | yes (content-agnostic pipeline) |
| **Trash** (30-day, restorable) | yes | yes | yes | yes | yes |
| **Offline-first** | yes (IndexedDB + service worker) | yes | yes | yes | yes (the vendor chunk warms while idle) |

## The small print

- **Plain is the same contenteditable surface rich is** — the type decides the
  toolbar's presence, not the editor. Its right-click rows run the same
  `EditorPort` commands (`src/context-menu.ts`). The "plain stays text-only"
  scope line is about images and captures, not about bold.
- **Structured kinds get no formatting context menu** — a task list or drawing
  has no text caret, so the menu declines (`src/context-menu.ts`'s kind gate).
- **The markdown viewer on share links** renders the same GFM grammar the in-app
  preview uses, and runs the same `padify-att:` resolve pass the editor does.
- **Unknown types** (a newer build's) round-trip byte-exact: never edited,
  never sanitized, never lost.

## Sources

`src/editor/note-types.ts` (the registry), `src/context-menu.ts` (per-kind menu
gating), `src/editor/rich-toolbar.ts` + `src/ui/editor-shell.html` (the rich and
markdown toolbars), `src/editor/markdown/render.ts` (the GFM grammar), `src/editor/voice-notes.ts`
(the mic + card), `src/download-menu.ts` (export rows), `shared/wire.ts`
(share emptiness per kind), `src/pip-window.ts` (PiP availability),
`src/editor/storage-subset.ts` (the storage vocabulary), plus the shipped record
in `docs/BRAINSTORM.md`.
