# Drawingpad — the rebuild plan

> The retired Drawingpad page (`legacyfeatures/drawingpad.md` is the
> feature reference) returns as a **note type**: a drawing is a note whose
> content is an Excalidraw scene, created from the same "New note" chevron
> as every other type, stored by the same IndexedDB rows, synced by the
> same notes pipeline, tombstoned by the same close flow. This document is
> the contract the scaffold (this branch) put in place and the design the
> canvas phase builds against.

## Status of this branch

The canvas ships with this branch — the type exists end-to-end AND the
Excalidraw island renders it (the phase-2 design below, as built):

- **`src/editor/drawing/scene.ts`** — the scene content model: the
  Generation-2 persistence contract (version, `elements`, whitelisted
  `appState`, `savedAt`) as parse/serialize/projection helpers over the
  note's `content` string.
- **`src/editor/drawing/canvas.ts`** — the Excalidraw island, the ONE
  module that imports the vendor (React included), loaded exclusively
  through `import('./canvas')`: the surface's lazy chunk. It mounts the
  component with the Gen-2 chrome (open/save `.excalidraw`, save as
  PNG/SVG, canvas background — with the vendor's clear-canvas, full
  export, theme toggle, socials, search, command palette and image tool
  all off) and exposes the export API behind the download menu's rows.
- **`src/editor/drawing/surface.ts`** — the drawing `NoteSurface`: the
  mount lifecycle (wrapper + loading card + lazy import with a
  mid-download race guard), the announce discipline (one bubbling
  `input` per user edit, 300 ms trailing, byte-equality-guarded so
  opens/pans/zooms never write), capture's savedAt stamping, the reuse
  path (drawing→drawing keeps the canvas, swaps the scene, clears the
  history), the teardown (dismiss unmounts the React root and kills
  pending announces), and the read-only refusal for newer format
  versions.
- **`src/editor/surface.ts`** — the surface registry's **type-keyed
  layer** (`registerNoteSurfaceForType`): 'drawing' and 'tasks' share
  the `json` content kind, so the kind registry alone cannot serve
  both. The kind layer stays the default; a type claim is the exception.
- **`src/editor/note-types.ts`** — the registry entry: id `drawing`,
  label "Drawing", contentKind `json`, a pencil icon. The new-note
  menu, the strip badge and every `contentKindFor` consumer pick it up
  from here.
- **Tests** — the scene contract, the surface lifecycle (vendor mocked
  at the island seam), the **vendor pin** (`scene-pin.test.ts`: the
  appState whitelist keys exist in the installed Excalidraw's default
  state and its own serializer agrees), the registry precedence, the
  server border (scene bytes cross untouched), the Vite stub pin, e2e
  for the draw → autosave → reload round trip and the menu chrome, and
  the cross-kind guards (share emptiness, picker refusal) from the
  scaffold.

## Decisions (made once, recorded here)

1. **Sync as notes.** The scene JSON is the note's `content` and the
   type is a `note_type` slug — the existing notes pipeline carries it
   with **zero schema changes** (see "The storage map" below). The
   Turso/API migration cut drawing sync because the old Supabase layer
   had no place for it; this build has one.
2. **Vector-only scenes for v1.** Image insert ships disabled in the
   canvas phase; embedded photos arrive later through the existing
   `attachments` blob store (phase 3 below). A vector scene is 1–100 KB
   of JSON — three orders of magnitude inside every budget on the wire.
3. **Stock Excalidraw chrome with the Gen-2 tweaks.** Full toolbar; the
   library-export action off; clear-canvas as a Padify-confirmed
   destructive action; no vendor badge/footer link. The deliberate
   constraints of the vendored bundle carry over (see phase 2).
4. **No new infrastructure — everything stays free-tier.** Drawings ride
   IndexedDB locally and Turso via the existing API. Cloudflare R2 (or
   any object storage) is **not needed**: there is no binary to store
   until phase 3, and even then the `attachments` table already exists
   for exactly that shape of data. The day many users' image-heavy
   drawings outgrow the 200 MB/user attachment quota, R2's free tier is
   the drop-in upgrade behind the same `/api/attachments` routes — the
   client contract does not change when the backend does.

## The scene format (the Gen-2 contract, typed)

A drawing note's `content` is a JSON envelope — the retired pad's
Generation-2 payload, lifted verbatim into the typed content model:

```jsonc
{
  "version": 1,               // format version (migrations dispatch on it)
  "savedAt": 1700000000000,   // epoch ms — rides for migrations, not content
  "elements": [ /* Excalidraw elements, verbatim */ ],
  "appState": { /* whitelisted tool defaults, values verbatim */ }
}
```

The envelope rules live in `src/editor/drawing/scene.ts` and are pinned
by `scene.test.ts`:

- **Elements are opaque to this layer.** The canvas owns their schema.
  Parse demands exactly one structural thing — a valid `elements` array
  exists — per the Gen-2 rule "a payload missing a valid elements array is
  ignored (fresh canvas)". Unknown future versions pass through verbatim;
  this module never rewrites what it cannot interpret (the same promise
  the wire makes to unknown note types).
- **appState is a whitelist, never a dump.** The Gen-2 tool-default keys
  (`viewBackgroundColor`, the `currentItem*` styling family including
  start/end arrowheads and roundness, `gridSize`, `gridModeEnabled`) keep
  their values; selection state, scroll offsets and collaborators are
  dropped at parse time. `DRAWING_APP_STATE_KEYS` is the one list; the
  canvas phase pins it against the vendored Excalidraw version.
- **Bytes are deterministic.** Serialization goes through a fixed key
  order and the same whitelist, so identical scenes produce identical
  strings — content-diff checks, snapshot equality and sync's
  byte-identical conflict probes stay honest.
- **The plain-text projection ships now.** `drawingScenePlainText` reads
  text elements as the note's words (the word pill, statistics, the
  close-tab prompt), a textless scene as "Drawing — N elements" (never
  mistaken for an empty note by a destructive prompt), and unparseable
  bytes as their raw content (the opaque discipline). Statistics will
  not shift when the canvas lands.
- **The byte budget.** `DRAWING_SCENE_SOFT_BUDGET_BYTES` (1 MB) is the
  autosave's warn line; the wire's hard ceiling is `MAX_BODY_BYTES`
  (2 MB, `shared/wire.ts`) and the server's per-user note quota is 25 MB.
  Vector scenes sit at 1–100 KB. The sync batcher already isolates a row
  that cannot fit a body — an oversized scene never blocks other notes,
  but the canvas phase must surface the warning instead of letting a
  scene silently go sync-less.

## The storage map (zero schema changes)

Every layer already speaks the drawing note's language, because the
pipeline was built content-agnostic and the type registry is its only
interpreter:

| Layer | What carries a drawing | What changed |
|---|---|---|
| Local (IndexedDB `notes` store) | `content` = scene JSON, `noteType = 'drawing'` | nothing — `StoredNoteTab` is type-open |
| The wire (`IncomingNoteRow`) | `content` + `note_type` strings | nothing — `shared/wire.ts` is content-agnostic |
| Server (Turso `notes` table) | `content` text, `note_type` column | nothing — `parseNoteRows` stores any well-formed slug verbatim |
| Sync v2 (seq/cursor pulls) | scene rides tombstones + last-write-wins + seq stamping | nothing — the merge compares strings |
| Snapshots | content + noteType captured verbatim; titles derive "Drawing" | nothing |
| Exports | `<pre>`-escaped scene for the text family; "Download as PNG/SVG image" rows appear for drawn scenes (the Excalidraw export API, behind the island's lazy import) | the drawing rows in the download menu |
| Share modal | a never-drawn note and a cleared-canvas scene refuse to share (`noteContentIsEmpty` reads the scene, like the empty task list); scenes with elements share as raw text | the drawing branch in `cloud/share.ts` |
| Share viewer | raw scene text (the viewer renders non-html kinds as text) | phase 3 decides rendering vs hiding |
| The HTML sanitizer | never applies — `isHtmlContent('drawing')` is false | the gate already existed |
| Unicode picker | `insertSymbol` consults the active surface first; a kind whose surface cannot take text is refused with a toast — no glyph is spliced into the placeholder card | the kind gate in `unicode/picker.ts` |

Free-tier arithmetic, for the record: Turso's free plan is 5 GB storage,
500 M row reads and 10 M row writes a month. A synced 50 KB scene costs
one row write per push cycle; filling 5 GB with 50 KB drawings takes
~100,000 of them. The 25 MB per-user server quota and the 2 MB body cap
are the real ceilings and both are enforced before Turso is ever
consulted. Drawings change none of the budgets that matter.

## The architecture integration points

- **Registry entry** (`editor/note-types.ts`): one `NoteTypeDef` — the
  creation menu item, the strip badge, the `contentKindFor` answer and
  the `normalizeNoteType` round-trip all follow from it. Unknown-type
  forward compatibility is unaffected: the open string type keeps
  carrying newer builds' types through this one untouched ('drawingpad'
  in the old test corpus still reads as opaque — 'drawing' is the
  registered id).
- **Type-keyed surface claim** (`editor/surface.ts`): the registry's
  kind layer serves many types; the type layer exists because two types
  can share a kind and still need different surfaces. Lookup order is
  pinned by test: type claim → kind (for registered types) → opaque.
  The tasks surface keeps the `json` kind; the drawing surface claims
  the type. A type the registry has never heard of (a future board from
  a newer build) answers opaque through `contentKindFor` directly — the
  forward-compat path — so nothing moved for anyone but 'drawing'.
- **The ModelPort parks itself** (`app.ts`'s `syncPortInert`): the html
  engine already keys on `isHtmlContent`, so a drawing note parks the
  contenteditable pipeline without any new wiring.
- **Placeholder surface** (`editor/drawing/surface.ts`): the opaque
  discipline with drawing-specific copy and a scene summary; `editable`
  is false until the canvas ships, which keeps `getActiveNoteContent`
  reading the model (byte-exact) rather than the host.
- **Strip + title derivation**: the badge comes from `NOTE_TYPE_ICONS`;
  the title derives from the registry label ("Drawing") for unnamed
  notes via the non-html branch of `deriveTabTitle`.

## Phase 2 — the canvas (Excalidraw in the surface)

One PR replaces the placeholder's internals; nothing outside
`src/editor/drawing/` should need to change except the pinned
`editable` test.

**Shipping method.** `@excalidraw/excalidraw` as an npm dependency
(bundled by Vite), mounted behind a **dynamic import** — the established
lazy-chunk pattern (the Unicode database and the PDF/DOCX exporters
already ride it), so React + the canvas (~1–2 MB) load on first drawing
note instead of joining the boot payload. This satisfies the Gen-2
deliberate constraints — no CDN, no external requests, no telemetry, no
badge — because the bundle IS the app's own origin, precached for
offline exactly like every other hashed artifact. (Audit
`scripts/build-sw.mjs`'s precache manifest when the chunk lands: a
1–2 MB artifact in the precache bumps the install download; if the
existing lazy chunks are runtime-cached instead of precached, follow
that precedent.)

**Mount lifecycle** (all inside `editor/drawing/surface.ts`):

- `display()` mounts a `div[data-drawing-canvas]` inside the host
  (`contenteditable` stays false — the canvas is the editable), feeds
  `parseDrawingScene(content)` into `initialData`, and follows the
  theme at mount time (the Gen-2 behavior). Reuse the mounted instance
  across drawing→drawing switches (the tasks surface's `live` pattern).
- **The announce contract**: every user mutation surfaces as one
  bubbling `input` event on the host — autosave, the word pill and the
  save indicator all already listen for it. Autosave itself is the
  Gen-2 debounce: save 300 ms after the last change, swallow quota
  failures, stamp `savedAt`.
- `capture()` returns the serialized live scene; `commit()` and
  `clear()` repaint from fresh bytes. Clear keeps the Padify choice:
  the vendor's built-in clear stays disabled and a Padify confirm ("this
  cannot be undone") empties the scene — Gen-2's deliberate destructive
  action.
- `focusTarget()` answers the canvas mount; `dismiss()` disposes the
  instance and aborts its listeners through an `AbortController` —
  CONTRIBUTING's teardown rule for removable surfaces.
- UI options: the Gen-2 set — open/save `.excalidraw`, save as PNG/SVG,
  change canvas background; the library-export action off. Image insert
  disabled for v1 (decision 2): the canvas should hide the image tool
  and reject pasted image files with a "later this year" toast rather
  than embed data-URI bloat into scenes.
- Export: "Save as image" (PNG/SVG) joins the downloads menu via the
  Excalidraw export API; the existing HTML/text exports keep reading the
  projection.

**Pinning the format.** DONE as shipped: `scene-pin.test.ts` asserts every
`DRAWING_APP_STATE_KEYS` entry exists in the installed
`@excalidraw/excalidraw` (0.18.1) default appState (`restore(null,…)`),
that the vendor's default values survive the whitelist serialize → parse
round trip verbatim, and that the vendor's own `serializeAsJSON` agrees on
every whitelisted key it keeps. A vendor rename fails the pin at the
seam, not silently in every future save.

**The build-hygiene discovery (and why the plan is better for it).** The
vendor's `subset-shared.chunk.js` re-exports an Emscripten blob
(HarfBuzz-wasm for font subsetting) that constructs functions from
strings — the exact `new Function(` sink the repo's
`forbidEvalSinks()` build invariant refuses (CSP without `unsafe-eval`,
malware-scanner heuristics). The fix followed the repo's own precedent
(`stripDependencyEvalSinks`): `stubExcalidrawFontSubsetting()` in
vite.config.ts redirects both subsetter chunks to a throwing stub — the
vendor's font manager already wraps every subsetting call in a try/catch
whose fallback references the FULL font URL, so embed-font exports
degrade instead of breaking — and the wasm chunk becomes unreachable,
so Rollup drops it. `vite-plugin.test.ts` pins both interception arms,
and a future vendor bump that renames the chunks fails the build loudly
on the eval sink instead of shipping silently.

**What the shipped chunk graph looks like.** The island is
`assets/canvas-*.js` (~1.27 MB with the vendor's own prebundled graph)
plus `canvas-*.css` and the vendor's locale/font assets — all in the
service worker's RUNTIME-CACHE class (build-sw's three-way
split put 207 lazy files there; the precache stayed at the app shell +
small public assets). First drawing note downloads the island once;
from then on it is offline-capable like every other hashed artifact.
React (18.3.1) and react-dom ship inside the island's graph — the boot
payload never sees them.

**The skin (`src/editor/drawing/canvas-skin.css`).** The vendor ships
its own design language — purple brand accents, floating glass islands
on layered shadows, the Assistant typeface, lavender-tinted surfaces —
which inside Padify's Vercel-style monochrome read as a foreign frame.
The skin re-maps the vendor's entire theme-variable surface (the
`--color-*`, `--island-*`, `--button-*`, `--shadow-*`, `--ui-font`
families) onto Padify's design tokens, then patches the few structures
variables cannot reach: islands become 1px-bordered cards, dropdowns
and the canvas context menu become the app's popover pattern (8px
radius, menu shadow, 13px/500 rows, surface-hover hovers — the
context menu's inverted hover is replaced outright), chrome buttons
become quiet icon buttons (transparent until hover, 0.98 press
feedback), tooltips become the app's inverted chips, and the
`--color-selection` override retints the on-canvas selection box (the
renderer reads that variable live). Two pieces of vendor chrome are
hidden by policy rather than restyled: the `HintViewer` instructional
banner and the always-visible Library sidebar trigger. The skin is
imported from `canvas.ts` right after the vendor's own stylesheet, so
both ride the same lazy chunk with the skin later in the cascade;
every rule is scoped under `[data-drawing-canvas]` for one class of
specificity over the vendor, so nothing relies on source order alone.
Because it speaks only in tokens (`--surface-*`, `--fg*`,
`--border`, …), one declaration serves both themes and the chrome
follows the app's theme switch live — even though the vendor's own
`theme` prop is a mount-time snapshot. What is deliberately NOT
skinned: the drawing itself. Element colors, roughness and fonts-in-use
are the note's content and must render identically on every device and
in exports; the one content-adjacent choice that IS made is the
default: new text speaks the vendor's "normal" Nunito
(`FONT_FAMILY.Nunito`, injected at both the `initialData` and
`updateScene` seams — a scene's persisted `currentItemFontFamily`
always wins the spread) instead of the hand-drawn Excalifont default.
The public/css dead-CSS audit never sees the skin (it scans
index.html's `<link>` chain only); a future vendor bump is caught the
same way every other pin catches it — visually, and by the e2e menu
assertions.

## Phase 3 — embedded images (the attachments upgrade path)

The scene format does not change; the storage story does, and it is
already half-built. Excalidraw keeps embedded images as binary files
referenced by element `fileId` — the mapping is:

- Insert an image → upload the bytes through the existing
  `POST /api/attachments` (5 MB/file, sha256 dedupe, idempotent retries)
  → keep the attachment id where the canvas keeps its `fileId`.
- The scene JSON stores the reference, not the data-URI — the payload
  stays a vector scene plus id strings.
- Scene load hydrates the referenced files on demand
  (`GET /api/attachments/:id`, ETag-cached) — the same
  upload-pending/download-on-demand pattern voice notes use.
- Garbage collection stays the feature's job (the attachments table has
  no note→attachment linkage by design): deleting an image element
  deletes its attachment on the next sync cycle.

That is the whole design; no R2, no schema change, no new quota math
beyond the existing 200 MB/user / 500-file cap. If that cap is ever the
binding constraint, the swap happens behind `/api/attachments` and the
client never learns about it.

**Share links for drawings** are a phase-3 sibling: either render scenes
in the public viewer (the vendored canvas in read-only mode — heavier
page, honest preview) or export a PNG snapshot at share time. Decide
when the canvas exists; until then the share modal offers drawings as
raw text (today's behavior) — except emptiness, which the drawing
branch of `noteContentIsEmpty` already refuses: a never-drawn note and
a cleared-canvas envelope never become links, the same rule as the
empty task list. If "hide" wins later it is a one-line gate in
`cloud/share-ui.ts`.

## Test map

| Concern | File |
|---|---|
| Scene envelope, whitelist, determinism, projections | `src/editor/drawing/scene.test.ts` |
| Surface claims + lifecycle: mount, announce guard, capture stamping, clear, reuse, teardown, newer-version refusal | `src/editor/drawing/surface.test.ts` (vendor mocked at the island seam) |
| The vendor pin: whitelist keys vs the installed Excalidraw | `src/editor/drawing/scene-pin.test.ts` |
| Registry precedence: type → kind → opaque | `src/editor/surface.test.ts` |
| Type registry entry, sanitizer gate, icon | `src/editor/note-types.test.ts` |
| Server border: scene bytes verbatim through `parseNoteRows` | `src/server-notes.test.ts` |
| Share emptiness per kind (drawing scene, task list, html projection) | `src/cloud/share-url.test.ts` |
| Picker insert gate: refusal for kinds without a text-taking surface, ladder preserved for html | `src/unicode/picker-insert.test.ts` |
| The font-subsetting stub: both arms, scoped, stubbing throws | `src/vite-plugin.test.ts` |
| Creation flow, badge, title, canvas mounts (browser) | `e2e/note-types.spec.ts` |
| Draw → autosave → IndexedDB envelope → reload restore, download rows, curated menu, kind switching | `e2e/drawing-canvas.spec.ts` |
| Old build meets a drawing note | covered by the opaque fallback + the unknown-type corpus (no new test needed) |

## Milestones

- [x] Scaffold: type registered end-to-end, scene contract pinned, sync
      verified content-agnostic, free-tier budget confirmed — the note
      was durable before the canvas existed. Cross-kind guards shipped
      with it: the share modal refuses empty scenes, the unicode picker
      refuses kinds it cannot type into.
- [x] Canvas: Excalidraw behind the dynamic import, the mount lifecycle,
      autosave + announce (equality-guarded, `savedAt` stamped at save),
      clear-canvas as the Padify-confirmed flow only, PNG/SVG rows in
      the download menu, `editable` flipped with its test — plus the
      format pin against the installed vendor and the eval-sink stub
      the build invariant demanded.
- [ ] Images PR: the attachments mapping (upload on insert, hydrate on
      load, GC on delete), the image tool re-enabled.
- [ ] Shares: decide viewer-rendering vs snapshot-export vs hide, then
      ship the gate.
- [ ] `.padify` file format (the far-future roadmap item): drawings ride
      it as one more note kind — the scene envelope already carries its
      own version number for exactly this.
