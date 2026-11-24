# Drawingpad — the rebuild plan

> The retired Drawingpad page (`legacyfeatures/drawingpad.md` is the
> feature reference) returns as a **note type**: a drawing is a note whose
> content is an Excalidraw scene, created from the same "New note" chevron
> as every other type, stored by the same IndexedDB rows, synced by the
> same notes pipeline, tombstoned by the same close flow. This document is
> the contract the scaffold (this branch) put in place and the design the
> canvas phase builds against.
>
> **2026-11-24, supersession:** the owner called the repair-or-restart
> question (issue #172) — the chrome restarts native. The verdict, the
> measured gap inventory and the phased plan are in ["The 2026-11-24 owner
> call"](#the-2026-11-24-owner-call-restart-the-island-native-chrome-native-look)
> below; the phase-2 record that follows stays accurate for the shell it
> describes (surface, scene, images, exports plumbing — all of it
> survives the restart untouched).

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

**The takeover (`drawing-canvas-open`, the full-bleed stage).** A drawing
note is not a reading column — while the canvas owns the host, the
surface paints `drawing-canvas-open` on it (with the wrapper, so even the
loading card sits on the full-bleed stage and nothing reflows when the
chunk lands) and `vercel/16-editor-shell.css` does the rest: the host's
padding/border drop to zero (`!important`, the pip-host precedent — the
optimal-line-length preference writes the host's padding as an inline
style a plain rule would lose to), overflow hides, and the bottom strip
(save state, timer, the counter pill, the stats capsule) steps aside
through `#textareaContainer:has(#note.drawing-canvas-open)`. The navbar
and the notes rail stay: they are app chrome, and everything
below/right of them belongs to the drawing. The class stands down with
the canvas (`standDownLive`, and the two failure-card paths) — a text
note gets its padded column and bottom strip back. The counter pill
stays a text-note citizen: it hides only because the whole strip steps
aside while a drawing owns the stage, and its "Character & word count"
preference keeps governing it everywhere else. `drawing-canvas.spec.ts`
pins the takeover, the edge-to-edge geometry and the stand-down.

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
- [x] Images PR: the attachments mapping (upload on insert, hydrate on
      load, GC on delete), the image tool re-enabled — shipped 2026-11-21
      (the vendor-native insert path + the persistence spine; the shipped
      record is BRAINSTORM.md's).
- [ ] Shares: decide viewer-rendering vs snapshot-export vs hide, then
      ship the gate.
- [x] `.padify` file format (the far-future roadmap item): drawings ride
      it as one more note kind — the scene envelope already carries its
      own version number for exactly this — shipped 2026-11-22 (the
      single-note envelope and the whole-pad workspace envelope).

---

## The 2026-11-24 owner call: restart the island — native chrome, native look

> Owner (issue #172 + the direct call, 2026-11-24): the pad *"just threw
> Excalidraw in and wrapped a skin over it"*, is *"very broken and missing
> a lot of the things"*, and the experimental visuals get overhauled
> anyway. **Verdict: RESTART** — *"I want it to look exactly like the
> native one looks in its own website."* The Padify-side UI components
> around the editor get replaced one by one afterwards, **starting with
> the export**, so every note type gets the same treatment.

This section is the verdict's record: what was measured, what survives,
what dies, and the plan. It discharges the first two checklist items of
issue #172 (the gap inventory; the repair-vs-restart call).

### What was measured

- **The native reference, live** (excalidraw.com, 2026-11-24, real browser
  inventory): Shapes island = tool lock, hand, selection, rectangle,
  diamond, ellipse, arrow, line, draw, text, sticky note, eraser,
  **More tools** (insert image, frame, web embed, draw-to-shape, laser,
  bucket fill, lasso). Canvas-actions island = zoom dropdown, **minimap**,
  undo, redo. Main menu = Open, Save to…, Export image…, Live
  collaboration…, Command palette, **Find on canvas**, Help,
  **Reset the canvas**, Excalidraw+ (upsell), GitHub/X/Discord, Sign up,
  **Preferences** (tool lock, snap to objects, grid, zen mode, view mode,
  minimap, canvas & shape properties, arrow binding, snap to midpoints),
  theme control, canvas background. Plus: the hand-drawn **welcome panel**
  on empty scenes, the **HintViewer** banner, the **Library** button and
  sidebar, live collaboration, and the **Export image dialog** (PNG/SVG,
  Background ✓, Dark mode, Embed scene, export scale 1×/2×).
- **The Padify island, live** (the dist build, same day): the Shapes and
  canvas-actions islands are ALREADY the native set — the vendor renders
  its own toolbar and Padify never curates it, so every tool the site has
  (lasso, sticky notes, eraser, frame, laser, bucket fill…) is on the pad
  too. The divergence is everywhere else: the menu carries only
  Open / Export image… / canvas background; no welcome panel; no
  HintViewer; no Library; no Preferences submenu; no command palette or
  find; and the whole chrome speaks the skin's monochrome instead of the
  vendor's own design language.

### The structural finding: the pad is a shell with a costume

The integration is three layers, and only one of them is the problem:

1. **The shell (KEEP).** `surface.ts` (mount lifecycle, the announce
   contract, capture/clear/dismiss discipline, the read-only card for
   newer formats), `scene.ts` (the versioned envelope, deterministic
   whitelist serialization), `canvas-images.ts` (the attachment spine:
   insert→flush, load→hydrate, delete→GC), `thumb.ts`, the registry
   wiring, the e2e tests. This is the hard, Padify-specific work and it
   is sound.
2. **The mount (KEEP, small edits).** `canvas.ts`'s prop bag — lazy
   chunk, `EXCALIDRAW_ASSET_PATH` self-hosting, image gates, onChange
   bridging. Fine as a seam; some props flip.
3. **The costume (DIE).** `canvas-skin.css` (483 lines re-mapping the
   vendor's palette/typography/islands onto Padify tokens) + the curated
   three-item MainMenu + the off-props. This is what the owner is
   looking at when they say "wrapped a skin over it". The restart is
   almost entirely the removal of this layer plus a vendor bump.

**Can it be replaced from scratch? Yes — and it is small.** The vendor
component (`@excalidraw/excalidraw`, npm) is built for embedding; the
hard parts (offline assets, fonts, React mounting, image persistence,
scene round-trips, exports) are already proven by the shipped island.
"Restart" here means: delete the costume, restore the vendor's own
chrome, bump the vendor to stable, and extend the whitelist where native
preferences need persistence. The shell's tests (scene contract, surface
lifecycle, vendor pin) hold the floor while the chrome changes — the
restart cannot corrupt a note.

### The gap inventory

**(a) Deliberately OFF by the phase-2 chrome — the keep/remove verdicts:**

| What | Native behavior | Padify today | Verdict |
|---|---|---|---|
| `canvas-skin.css` | vendor's own look (purple accents, glass islands, Assistant typeface, hand-drawn wordmark) | full monochrome re-map, compressed islands | **REMOVE** — the owner wants the native look exactly |
| Curated MainMenu (Open / Export image… / canvas background) | full default menu incl. Command palette, Find on canvas, Help, Reset, Preferences | three items | **REPLACE with the vendor default**, minus white-label policy items (Socials, Excalidraw+ upsell, Sign up) and Live collaboration (no backend — the trigger would dead-end) |
| `clearCanvas: false` | "Reset the canvas" in the menu | Padify's context-menu clear with the confirm flow | **KEEP OFF** — the confirmed destructive flow stays app-owned; the menu item would bypass the confirm |
| `export: false` (the JSON export dialog) | "Save to…"/Export dialog | `.excalidraw` save lives in the app's download menu (with attachments embedded) | **KEEP OFF** — the app's `.excalidraw` row is the same door with the Padify attachment spine; revisit only if the unified export pass wants it in-menu |
| `toggleTheme: false` | theme control in the menu | the app's theme switch drives the canvas live (`padify:theme` broadcast) | **KEEP OFF** — one theme authority (the app), no second switch to drift |
| HintViewer hidden | the "hold Scroll wheel…" banner | `display: none` | **RESTORE** — it is native chrome and genuinely helpful |
| Library trigger hidden | Library button + sidebar | hidden | **RESTORE** — local-library works in the embedded component (no server needed) |
| Search menu / Command palette off | native menu items | absent | **RESTORE** with the default menu |
| WelcomeScreen | hand-drawn panel on empty scenes | absent (opt-in in the npm component) | **ADD** (`<WelcomeScreen>` child) |
| `aiEnabled` unset (→ false) | site shows the mermaid Text-to-Diagram trigger | TTD trigger hidden | **ENABLE** — the mermaid dialog is client-side (bundled); audit the chunk-size delta when it lands; diagram-to-code stays off (needs keys) |
| Text default font = Nunito (`FONT_FAMILY.Nunito` at both feed seams) | Excalifont (hand-drawn) is the default everywhere | scenes read differently from the site | **REVERT to the vendor default** — "exactly like native" includes the pen |
| `handleKeyboardGlobally: false` | site binds globally | shortcuts die when the canvas loses focus | **REVISIT (R2)** — restore global bindings scoped to when a drawing note is active, with the app's own shortcuts still winning |
| Excalidraw+ / Socials / Sign up | in the native menu | off | **KEEP OFF** — white-label policy |

**(b) Genuinely missing or broken vs the site (not deliberate):**

| Finding | Evidence | Where it lands |
|---|---|---|
| **Open glitch: the canvas sometimes never opens until a hard refresh** (owner, issue #172 comment) | the mount path has no retry: `import('./canvas')` rejection → error card, and the card offers no action; a deploy changes chunk hashes while a running tab (or the service worker's runtime cache) still resolves the old name — every retry then fails until the page itself re-fetches the index | **R3** — one-shot cache-busting retry, the SW never runtime-caches a non-OK chunk response, and the error card grows a Retry button |
| Preferences missing entirely (snap to objects, zen mode, view mode, arrow binding, snap to midpoints, canvas & shape properties) | the curated menu dropped them; several are appState-level prefs | **R2** — they return with the default menu; persisted prefs need the whitelist (below) |
| The appState whitelist does not carry the native prefs | `DRAWING_APP_STATE_KEYS` = 16 styling/grid keys only — zen/snap/binding choices reset every reload | **R2** — extend the whitelist, re-pin `scene-pin.test.ts` against the bumped vendor |
| "Save to…" menu item absent | the vendor gates it on `appState.fileHandle` (a scene opened from a file) — the pad never opens from files, so the gate stays closed | none — the app's `.excalidraw` row is the door; the native gate behaves as designed |
| App-side image rows bypass the export options | download-menu PNG/SVG call `exportScene` with fixed defaults (scale 1, background on, no embed) — no scale/dark/embed choice | **R1** — the unified export |
| Drawings share as raw text | share modal/viewer carry the scene string (phase-3 milestone, unchecked) | **R4** — snapshot-export first (PNG via `exportScene` at share time), viewer-render later |
| Skin seams (minimap island, vendor popovers, xv21 evidence) | BRAINSTORM's parked visual pass | **moot** — the skin they belong to dies in R0 |
| Open time | warm open median ~350 ms (vendor mount ~60–90 ms of it); cold ~1.7 s first-ever run (2.6 MB chunk, idle-warmed at 4 s) | **R3** — keep lazy + idle warm; add `modulepreload`; re-measure with the item-8 harness discipline |

### The restart plan (R0–R4)

- **R0 — the native mount.** Vendor bump `0.18.0-9fbeaed` → `0.18.1`
  (stable; the eval-sink stub re-pins against the new chunk names),
  delete `canvas-skin.css`, drop the curated menu children, flip the
  verdicts from table (a), add the WelcomeScreen child, revert the font
  default, re-pin `scene-pin.test.ts`, update the e2e chrome assertions.
  *Done when:* a side-by-side with excalidraw.com shows the same chrome
  (modulo Padify's own navbar/rail around it) in both themes.
- **R1 — the unified export (the owner's first component swap).** One
  export surface for every note type: the drawing speaks the vendor's
  exporter with the native options (PNG/SVG, background, dark mode,
  embed scene, scale 1×/2×); the text family keeps TXT/PDF/DOCX/HTML/MD;
  `.padify`/`.excalidraw` ride as-is. Same dialog, same flow, type-gated
  rows — the download dropdown becomes its entry point.
- **R2 — preferences & keyboard parity.** The default menu's Preferences
  live, the whitelist grows (pinned), `handleKeyboardGlobally` gets the
  scoped-global design.
- **R3 — the open-glitch fix + open time.** The retry/lack-of-cache/card
  work from table (b), measured with the item-8 harness before and after.
- **R4 — shares.** The last unchecked phase-3 milestone, decided after
  R1 (the snapshot exporter it needs is the unified one).

Ordering note: R0 is the restart the owner called for; R1 is the owner's
own first stop ("starting with the export"). R2–R4 sequence after the
native mount exists to build against.

## The 2026-11-24 landing: R0–R4 shipped — the island is native

> The owner's final call (2026-11-24, live): *"go ahead and redo it from
> scratch — should be identical to the one on the website — don't take any
> shortcuts."* All five phases landed the same day, one commit per phase.

- **R0 — the native mount** (commit after bd8ad22): the skin dies
  (canvas-skin.css deleted), the vendor re-pins, the menu becomes the
  vendor's own composition minus the policy doors, the WelcomeScreen
  lands, new text speaks Excalifont, the HintViewer/Find/Library return,
  the AI triggers go on. `scene-pin.test.ts` re-pins against the installed
  vendor; the e2e chrome assertions pin the native set.
- **R1 — the unified export**: the download menu's two fixed-default
  image rows become one **Export image…** row opening the drawing export
  dialog — PNG/SVG, Background, Dark mode, Embed scene, 1×/2× scale, the
  vendor's own knobs, named the way it names them. The dialog is a native
  `<dialog>` on the confirm/prompt face's tokens; it rides the app bundle
  while the vendor stays lazy.
- **R2 — preferences & keyboard parity**: the menu grows the native
  Preferences group (Snap to objects, Grid, Zen mode — live checkmarks
  off a filtered onChange subscription); the whitelist carries
  `zenModeEnabled` + `objectsSnapModeEnabled` (view mode stays
  session-only — the vendor's own classification); `handleKeyboardGlobally`
  is ON for the site's global-bindings feel, with the app's dispatcher
  winning its chords via stopImmediatePropagation (registered first,
  same node, same phase) and Escape passing through unless an app modal
  is on stage.
- **R3 — the open-glitch fix + open time**: the mount retries a failed
  import once (transient failures recover in place); the error card grows
  a **Retry** action that asks the service worker to re-fetch the whole
  precache network-first (REFRESH_SHELL, 200/basic-guarded) and reloads —
  the deterministic version of the user's hard refresh. A modulepreload
  hint for the drawing chunk (content-keyed, `data-padify-lazy-preload`)
  is injected into dist/index.html; build-sw skips marked links so the
  chunk keeps its runtime-cached classification. Measured with the item-8
  harness (scripts/measure-canvas-open.mjs): warm flips median 350 ms —
  the ledger's number, unchanged; the preload covers the real-network
  deploy window for free.
- **R4 — shares**: a drawing's link carries the SNAPSHOT — the scene
  renders to a PNG data URL at share time (live canvas first, store
  hydration otherwise; modal create + background refresh both speak it),
  and the viewer paints it as the image it is behind a strict data-URL
  shape check. Legacy raw-JSON shares still get the honest raw-text view.

### The vendor pin decision (amended)

The verdict below pinned **0.18.1 stable**. The landing pins
**`0.18.0-2c3dcc0`** (the npm `next` dist-tag, 2026-11-21) instead — the
owner's "should be identical to the one on the website" outranks the
stable line: stable predates the minimap, the imageOptions gate prop, the
consolidated `exportScene`, and `setViewport`, all of which the site
itself runs (it tracks master). `next` is still an official npm publish,
four days newer than the snapshot this app previously carried. The seams
that differ between stable and master are all landed on the master
spellings (the scene whitelist keeps the named `currentItemStrokeWidthKey`
the master build writes — the shipped scenes' bytes round-trip untouched).

### Done-when, discharged

A side-by-side with excalidraw.com (real browser, 1440×900, 2026-11-24)
shows the same chrome in both themes — floating islands, the tool set,
the HintViewer banner, the hand-drawn welcome panel, the minimap +
footer, the Shortcuts & help hint — modulo Padify's own navbar/rail
around it, and minus the white-label items the policy doors keep off
(Socials, Excalidraw+/Sign up, Live collaboration) and the site's own
app-layer text (the storage warning line).

### The 2026-11-24 owner follow-up — the leaks and the map (measured to zero)

The owner's side-by-side caught two more layers after the restart, both
root-caused in the browser rather than assumed:

1. **The rem baseline** (the previous commit): the app's `html{font-size:
   10px}` shrank every rem-based vendor token to 62.5%.
2. **The app's global css reaching into the vendor's subtrees** — this
   commit. Three verified mechanisms, all measured against excalidraw.com
   at the same viewport:
   - `#note`'s editor typography INHERITED into the island (26px
     line-height, pre-wrap, text cursor) and `#note`'s caret-color
     var; inheritance survives any author `revert`.
   - The app's GLOBAL element rules (`*{box-sizing}`, `h1..h6`,
     `button{color:inherit;font-family:inherit}`, `a`, `img!important`,
     `p/ul/table`, the `textarea,#note` padding/border block, `body
     :focus-visible`) — plain element specificity, so they beat every
     vendor declaration that doesn't exist (the vendor ships for a clean
     page) while the vendor's own class rules beat them back.
   - **The forced-open minimap**: mounting with `minimapEnabled: true`
     made LayerUI subtract its MINIMAP_RESERVED_HEIGHT (138px) from the
     styles panel's clamp (`appState.height - 166`), clipping the panel's
     Layers and Actions rows at the embedded size — the vendor's own
     default (the site's default) has the map closed.

   The fix is `island-shield.css`, loaded last inside the drawing chunk:
   :where()-scoped `revert` rollbacks keyed on the vendor's own
   `.excalidraw` root class (the vendor PORTALS dialogs/toasts onto the
   body with that class on the overlay — a host-scoped shield would have
   spared exactly the biggest surfaces), plus explicit re-declarations
   for what inheritance defeats revert, and the map default returned to
   the vendor's own.

   Measured result: the computed-style sweep (island root, hint, welcome,
   zoom/undo buttons, menu, help-dialog title/headings, wysiwyg textarea)
   shows ZERO property deltas against excalidraw.com at the same
   viewport; the styles panel's clamp computes the vendor's exact native
   formula (height − 166) and carries Layers and Actions.
