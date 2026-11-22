# The brainstorm — everything Padify could do next

*2026-11-21. The working instrument: ranked, opinionated, and allowed to be
wrong. Finished work leaves this file (the git log and DECISIONS.md are the
record); parked work stays parked visibly. The owner's two standing scope
lines live at the top because everything else defers to them.*

## The owner's scope lines (2026-11-21)

1. **Plain notes stay text-only; rich/gfm (markdown) notes carry images.**
   Restated from the day's back-and-forth: "no images in standard notes"
   meant the PLAIN surface — the markdown surface keeps capture (paste,
   drop, the toolbar's image row → the attachment store, `padify-att:`
   references) and the preview's resolver. The drawing canvas
   (Excalidraw's image elements) is the store's other tenant, with its
   own module. No image wiring ever lands on the plain surface.
2. **No visual work yet.** The visual pass, hover-deck polish and
   canvas-skin misses wait for the owner, who will help drive it
   (`qa/VISUAL-QA-HANDOFF.md` is the standing brief).

---

## NOW — what the working queue holds (non-visual)

9. **Voice notes — DECIDED AND SHIPPED (2026-11-22).** The owner's call:
   an audio attachment in a RICH note, not a note type — the type
   registry owns content formats, and a recording owns none. What landed:
   the mic row on the rich toolbar (MediaRecorder → the attachment store,
   offline-first, the 5 MB wire cap with a 20-minute seatbelt), the card
   as the storage subset's `<audio src="padify-att:…" data-duration="…">`
   (both GCs and both .padify envelopes collect it through
   shared/att-refs.ts), insertion through the engine's typed op (one undo
   removes the take), the live wrapper chrome (`figure.padify-voice` —
   the UA stylesheet hides a controls-less audio behind an !important no
   author rule beats, so the paint pass wraps and every absorb unwraps,
   exactly like math), the rail's mic badge, and the share story: the
   token-gated /att endpoint already serves them (mime-agnostic), the
   viewer builds the wrapper and plays. Plain and markdown notes stay as
   they were.

## The hygiene review (2026-11-21) — what the whole-repo scan found

*The owner asked for a full scan for poorly designed garbage. The deletable
weight is gone (dead exports/params eaf1409, the small honest repairs
31cbdc5, the escape/class-list dedup 6c9499a, plus the sixteen executed
one-off scripts 95693ee). The phantom image-data amputation fd3b7be was
reversed the same day — the owner's restatement kept the text-only line at
the PLAIN surface, and rich/gfm capture + render are back, scoped by
surface. The first fix batch landed the same day (H1, H2, H7, H10, H24,
H25 and H3's client half), and the second day closed the REST of the
list except the three items named at the bottom — every remaining entry
below was verified against the code, not grepped on faith.*

### Correctness — the items that can lose or lie about user data

- **H1. ~~The server's seq is arrival-ordered, not recency-ordered; two
  tabs can silently destroy a confirmed push.~~ FIXED** — the upsert's
  live-recency guard plus the client's refusal tell (a refused push is
  not confirmed, not adopted; it falls to the three-way merge).
- **H2. ~~Share PATCH caps truncate silently.~~ FIXED** — the caps live
  in shared/wire.ts and the client chunks to them; a mid-run failure
  settles nothing.
- **H3. ~~The wire module's own types are bypassed on the server.~~
  FIXED** — NotesPutV2 is the PUT answer's one type on both sides; the
  pull's payload rides NotesPullV2.
- **H4. ~~runMany is only transactional on the local backend.~~ FIXED** —
  the Turso HTTP path sends each 100-statement chunk as ONE all-or-nothing
  batch (BEGIN, condition-chained statements, COMMIT, a ROLLBACK gated on
  COMMIT's failure — Turso's own PROTOCOL.md recipe; a failed step throws
  via the step_errors scan). The interface docs say what is true: one
  transaction per chunk, several for a >100-row call.
- **H5. ~~The merge engine's silent fallbacks.~~ FIXED** — a divergence
  past a merge budget logs one honest line naming the note and the three
  sizes (bail: 'size' | 'budget' rides up from diff3); a title collision
  over cleanly-merging words keeps the SPLICE as the canonical body
  (wordsMerged) while mine's whole version still parks for review — the
  old path took the remote's raw body and threw the computed merge away.
- **H6. ~~The attachment GC does not exist, and its endpoints are
  production-dead.~~ FIXED** — the store has its janitor, two-sided, on
  the SAME rule: shared/att-refs.ts owns the reference grammar (the
  padify-att: scan, the scene fileIds walk, the drawing dispatch — the
  export pass reads it too) and the orphan verdict (referenced → forget
  the clock; newly unreferenced → stamp it; unreferenced past the
  shared 7-day grace → garbage). The server's sweepOrphanAttachments
  rides sweepAll (boot + hourly), reads per-user without ever touching
  the bytes column, and writes in one runMany; the client's
  sweepLocalAttachmentGarbage fires after a clean sync cycle + the
  upload flush, over the live model's projection (never the boot
  snapshot — a mid-session reference would look unreferenced to it).
  A DELETE endpoint gained its first real caller; the trash is a
  tenant (a restore must find its images), snapshots deliberately are
  not (a restored snapshot shows the honest placeholder — counting
  them would pin every once-seen image forever). The grace window is
  the unsynced-second-device promise: the clock starts only when the
  removal has reached the side doing the sweeping, so a device that
  reconnects and re-pushes its referencing copy resets it.

### Consistency — the drift waiting to bite

- **H7. ~~The 5 MB attachment cap is mirrored in four places.~~ FIXED** —
  shared/wire.ts owns MAX_ATTACHMENT_BYTES; every gate (upload route,
  envelope, canvas insert, note capture, scene bridges) reads it.
- **H8. ~~The id border is three different rules.~~ FIXED** — the wire's
  id border (ATTACHMENT_ID_SOURCE/PATTERN, MUSIC_TRACK_ID_PATTERN,
  MAX_NOTE_ID_CHARS) is the one definition; the six attachment spellings
  (server gate, route path, the padify-att gates, canvas file ids, the
  .padify envelope) all compose or test it.
- **H9. ~~"Is this note empty" is answered differently on each side.~~
  FIXED** — the wire's shareContentIsEmpty is the server's share gate:
  html kinds strip tags, the structured kinds this wire ships read their
  payload array, unknown content stays shareable (a stale client can no
  longer mint a link the UI would refuse). The client's per-kind registry
  stays the primary and the finer gate.
- **H10. ~~Two color normalizers diverge.~~ FIXED** — canonicalizeColor is
  the picker's own composition now (normalizeHex ?? rgbStringToHex),
  pinned in theme-colors.test.ts.
- **H11. ~~getCloudConfig() can never return null.~~ FIXED** — the dead
  ceremony left with the guards that could never fire: isShareAvailable
  (a tautology) and the unconfigured-install early returns in ui.ts and
  share-ui.ts.

### Refactors — real but behavior-neutral, each worth its own commit

- **H12. ~~The editor model's coordinate system is written four times.~~
  FIXED** — walkTextStream gains an early-stop and is the one walk
  (coveredTextNodes rides it); streamLengthOfSubtree is the one counter
  (ops' and selection's byte-identical twins deleted); insertNodeAtSpot
  is the one insertion primitive the styled-caret plant, link plant,
  math shell and plain-text splice all ride (five hand-copies, two
  shipped caret bugs among them).
- **H13. ~~`initRichToolbar` is ~1080 lines~~ FIXED** — the markdown
  toolbar's discipline, mirrored: one module state bag (elements + the
  per-feature lets) and a wire* function per feature (grid picker, color
  pickers, toolbar events, link popover, math popover, document events),
  the pressed-state/menu/popover logic as module functions reading that
  bag. The mirror also gained the guard markdown always had — a second
  init against a wired shell is a no-op (stacked listeners would
  double-toggle a menu); the characterization suite pins it, and the
  pin was mutation-tested both ways.
- **H14. ~~`initApp` is ~920 lines.~~ FIXED** — the two extractions the
  review named: app-shortcuts.ts (the shortcuts sheet's search + the
  document-level chord dispatcher) and download-menu.ts (the dismissable
  layer, every save-as row, the row-visibility syncs, the .padify/
  .excalidraw saves with the shared attachment collector, the open
  door). app.ts is the boot orchestrator again at 749 lines, and the
  listener registration order is preserved exactly — both calls sit
  where the moved blocks sat.
- **H15. ~~snapshots' `renderRows` is ~258 lines.~~ FIXED** — the DOM-chore
  tail blocks live in renderSheetChrome(facts) now; renderRows stays
  about rows.
- **H16. ~~help.ts's tour hints are hardcoded `ctrl + …`.~~ FIXED** — the
  hints render through shortcutLabel() like every other shortcut surface
  (Apple visitors see ⌘/⌥). Its brand hover-deck block (~110 lines)
  still wants its own module — deferred to the visual pass, which owns
  the deck's motion and timing anyway.
- **H17. ~~model-port's internal clones.~~ FIXED** — walkHistory(dir) and
  shiftIndent(delta) fold the byte-identical pairs; the five caret
  queries open with one ancestorFromCaret().
- **H18. ~~render.ts duplicates two of its own grammar pieces.~~ FIXED** —
  markerPadding() is the one padding rule; scanDestination()/scanTitle()
  are the one link grammar (the definition's title folds lines through a
  hook). Unifying surfaced a real drift: the definition's pointy
  destination rejected the spaces the spec allows — both grammars answer
  the spec's one answer now.
- **H19. ~~The margin-left px parser is hand-rolled three times.~~ FIXED**
  — document.ts's marginLeftPxOf, beside stylePropOf, is the one margin
  reader (ops, model-port and plain-indent all import it).
- **H20. ~~pip-window re-implements the Mod+B/I/U/⇅X → command map.~~
  FIXED** — both keydown handlers ask the context menu's
  formatShortcutFor (the menu owns the map as data); the pip's Mod+S
  export stays its own line.

### Small chores

- **H21. ~~shares GET limit 200 with no revoked filter.~~ FIXED** — the
  inventory keeps dead rows only while their death is news (the sweep's
  own 7-day grace), so they can no longer crowd live links out of the
  window.
- **H22. ~~/api/music/resolve peeks the DB cache before any rate limit.~~
  FIXED** — an in-memory negative cache (60 s TTL) makes a repeat unknown
  id cost memory, not a Turso read, and the peek carries its own generous
  pace ('music-peek', 240/min) so spraying fresh unknown ids cannot draw
  one free database round-trip per request. Cached answers stay free for
  real listeners.
- **H23. ~~music_resolutions.resolved_at is written, never read.~~ FIXED**
  — the column left the schema, with an idempotent drop-column migration
  for databases that predate the removal (expires_at already drives the
  re-resolve decision and the sweep). The seq-backfill migrations still
  full-scan notes on every boot — fine on Turso free tier, noted here.
- **H24. ~~api() passthrough, twin session parsers, O(n²) dirty loop.~~
  FIXED** — cloud/session.ts owns the key + shape + one reader; the
  wrapper is gone (apiCall directly); the push queue's row builder rides
  an index-carrying map.
- **H25. ~~Function-local quota constants, unremarked TOCTOU.~~ FIXED** —
  server/quota.ts owns the three numbers with the boundedness argument
  written down.

*What remains of the whole review: H16's hover-deck module move, which
belongs to the visual pass (the deck's motion and timing are that
pass's to own). Every line item the review found is closed.*

## PARKED — waiting for the owner (visual)
11. **The visual pass** — `qa/VISUAL-QA-HANDOFF.md` is the brief; findings
    land in `qa/findings-LIVE.md`. Exildraw "needs a lot of work" per the
    owner; the canvas-skin misses are the same bucket.
12. **Hover deck polish** — the ten-move rotation is live (c218c10); the
    deck's motion and timing get revisited when the visual pass opens.
13. **Canvas theming follow-ups** — the skin follows the app's tokens; the
    minimap island and vendor popovers have known seams (xv21 evidence).

## DONE — so nobody re-plans it

- **Item 8, canvas open performance — measured, the numbers name nothing
  actionable (2026-11-22).** The ledger's rule was measure first, and the
  measurement (a temporary playwright harness over the real open path,
  five opens and five drawing↔text flips, since deleted with the work)
  says: the WARM open — the one a user actually experiences after the
  island has warmed — lands at 329–443 ms wall-clock, median ~350 ms, of
  which the vendor's React mount is only ~60–90 ms; most of the rest is
  the measuring harness's own actionability overhead, not app time. The
  COLD open (clicking Drawing inside the idle-warm window) pays the
  2.6 MB vendor chunk: ~1.7 s in the dev build, first run only. The
  trigger is requestIdleCallback with a 4 s timeout — a deliberate
  "warm when the app is idle, never compete with boot" choice; making it
  eager would trade boot responsiveness for a race the user rarely
  loses. The scene-restore cost rides the same mount; the images work
  keeps its standing instruction (async hydration, off the critical
  paint) for whenever note-type images arrive. Closed without a code
  change — the honest answer the numbers gave.

- **Item 10, the attachment sync ledger (2026-11-22).** Notes have
  seq-backed sync integrity; attachments had flush-and-hope — an image
  that failed to reach the server was skipped for the SESSION and nobody
  was told. The flush now keeps a per-id ledger with the failure's MEANING:
  transient trouble (network, 5xx, 429, auth) gets an exponential backoff
  (30 s doubling to a 15-minute ceiling) retried on the cycle clock — a
  flaky connection heals itself instead of waiting for a reload, while
  never burning a 5 MB request every 30 seconds; poison trouble (409
  collision, 413 over-cap, 400 — answers that cannot change without user
  action) is marked and skipped for the session, the old behavior; a
  success clears the entry. The ledger paces in memory only — the IDB
  `uploaded` flag stays the durable truth — so a reload restarts the
  schedule and the first flush re-learns it. SEEING IT: the upload-pending
  chip (upload-chip.ts) sits beside the offline chip in the same capsule
  voice and counts what the STORE says has not reached the server — "2
  uploads pending" — refreshed by cloud/attachments.ts's change signal
  after every flush and every capture (a file captured offline joins the
  count immediately, no cycle required). Deliberately auth-blind: pending
  bytes while signed out are still the truth, and the tooltip says when
  they leave. Gates: lint, both tscs, 2011 unit tests (+9), smoke,
  platform-shortcuts, share-links and note-images e2e.

- **Item 6, share links learn their images (2026-11-22).** The public
  viewer's `padify-att:` refs resolve now: `GET /api/share/:token/att/:id`,
  a new public route on the SAME 'share' rate bucket, whose authorization
  is the token itself. Signed URLs were weighed and declined — a minted
  signature needs a server secret (a fifth credential to rotate) for a
  property the token already carries: the URL dies exactly when the link
  dies, because it IS the link's URL. Per-request the server re-reads the
  share row (live only — the same unified 404 the body gives), confirms the
  id appears in the snapshot content through the ONE reference grammar
  (shared/att-refs.ts), and reads the bytes owner-scoped — an id the share
  does not reference is a 404, never a store to mine. The response shape is
  the session endpoint's, extracted once (attachmentBytesResponse):
  ETag=sha256, 304, disposition attachment + nosniff (an uploaded HTML file
  must never render inline on the API origin, where session cookies live).
  The viewer runs one resolve pass over the rendered note (real refs →
  public URLs, failures → the app's own dashed missing-image placeholder);
  the markdown/task/raw branches all funnel through it. The orphan sweep's
  tenant set grew its second leg: LIVE shares pin their bytes (the owner
  can remove an image from the note; the link keeps rendering it until the
  link dies), DEAD shares protect nothing, and a revived reference clears
  the clock as always. Gates: lint, both tscs, 2002 unit tests (+9), and
  the e2e round trip — a pasted PNG shared to the public page decodes real
  pixels there while a ghost id degrades to the placeholder.

- **Item 4, the workspace envelope — a whole pad as one .padify file
  (2026-11-22, 0dada39).** The top-of-file question is answered and
  shipped. A NEW discriminator (`padify-workspace`, format 1) — never a
  version bump of `padify-note`: older builds answer null exactly as
  before, so no older reader can mangle what it was never taught. The
  manifest is the single-note payload composed N times — ONE shared
  note-entry validation and writer (the hygiene discipline, applied at
  birth) — notes in rail order, the pad's theming as data, and one
  shared attachments pool deduped by id. Export flushes the active
  note's live edits first (the duplicate gesture's discipline), the
  download menu's image collector became a union pass over all notes,
  and the menu grew a "Save whole pad as a file" row. Import mints
  every note fresh (never merge), says the honest count in a toast —
  partial counts when entries drop, "no notes" when they all did —
  and lands on the first of the batch. The manifest's theme is
  deliberately NOT applied on import (replace-the-pad stays out of
  v1). The additive `colorTheme` field rode along on BOTH envelopes —
  a rich note's ink colors now survive file round trips, where before
  they silently didn't. Ceilings with their reasons in the format
  module: 2000 note entries, attachments the same 500 × 5 MB as the
  single-note envelope and the server. The planning sketch left with
  the work, per this file's own convention — padify-file.ts's module
  doc is the design's home now. Gates: lint, tsc, 1993 unit tests
  (+13), padify-file + smoke + platform-shortcuts e2e (+3), the new
  menu row geometry-checked against its siblings.

- **Item 7, the usage & quota surface — Settings → Account (2026-11-22).**
  The owner's instruction folded three moves into one: the settings section
  "Cloud sync" became **Account** (person icon, same nav/tablist machinery),
  a **storage card** renders `GET /api/usage` Apple's-storage-page style —
  one stacked bar per quota with segment widths as shares of the QUOTA
  (never of the used bytes), a largest-first legend per note type plus the
  trash as its own slice (it keeps its content, so it occupies exactly the
  storage it looks like) — and the shared-links inventory stays in the same
  pane. The endpoint folds the owner's notes by (type, deleted) with the
  ONE measurement the quota check counts (`length(cast(content as blob))`),
  attachments by sum(size); the limits travel inside the answer from
  server/quota.ts — no mirrored constants (the H7 discipline). The wire
  gained its UsageReport type (shared/wire.ts, both tsconfigs). The client
  (cloud/usage.ts) fetches on settings-open and the sync engine's settle
  transitions, gated by a 20 s stand-down, cached per account email so a
  switch never flashes another account's bytes. Gates green: lint, both
  tscs, 1976 unit tests, smoke + platform-shortcuts + share-links e2e; the
  pane shot-verified in both themes (multi-type notes, real attachments,
  a trashed slice).

- **The two giant closures, closed (2026-11-22).** The hygiene review's
  last two line items, each its own commit: H13's rich toolbar folds
  into the markdown twin's wire* shape (module state bag + a wire
  function per feature + the double-init guard, mutation-tested), and
  H14's boot orchestrator sheds its two named extractions
  (app-shortcuts.ts, download-menu.ts) back to 749 lines with listener
  order preserved. Gates green throughout: lint, both tscs, 1968 unit
  tests, and the e2e families that own the touched behavior (smoke,
  platform-shortcuts, docs-toolbar, padify-file, drawing-canvas,
  markdown-features). The hygiene review is done — only the hover-deck
  move remains, and it is the visual pass's.

- **H6, the attachment GC (2026-11-22).** The review's last real feature,
  landed two-sided on one rule: shared/att-refs.ts (the grammar AND the
  verdict, its own test file), the server's sweepOrphanAttachments on the
  boot+hourly clock with an orphan_since migration, the client's
  cloud/attachment-gc.ts on the post-cycle hook (throttled to 6h, kv
  markers, live-model tenants). The reference grammar moved out of
  note-images.ts and canvas-images.ts into shared — the export pass, the
  hydration diff and both GCs now read one spelling. Gates green
  throughout: lint, both tscs (the server tsconfig's pre-existing
  server-db.test.ts mock-tuple error fixed in passing), 1967 unit tests,
  and the e2e attachment family (attachments, note-images, padify-file,
  drawing-canvas) plus smoke + platform-shortcuts.
- **The hygiene fix batch, day two (2026-11-22).** Everything the review
  found except H6, H13, H14 and the hover-deck move: the server's writes
  became honest (H3's typed PUT answer, H4's all-or-nothing Turso batches
  by the PROTOCOL.md recipe), the merge engine stopped discarding clean
  splices and started logging its bails (H5), the wire gained its id
  border and its emptiness gate (H8, H9 — the share-refusal and six id
  spellings now read one definition), the shares inventory and the music
  peek got their pacing fixes (H21, H22), a dead column left the schema
  with a migration (H23), the dead config ceremony left (H11), and the
  refactors each landed as their own commit: the editor model's one
  coordinate spelling (H12 — walkTextStream/streamLengthOfSubtree/
  insertNodeAtSpot), model-port's folded pairs (H17), the one margin
  reader (H19), the one format keymap (H20), the markdown renderer's one
  link grammar — which surfaced and fixed a real spec drift in link
  reference definitions (H18), the snapshots sheet's chrome extraction
  (H15), and the tour's platform-honest shortcuts (H16). Gates green
  throughout: 1940 unit tests, the 652-example CommonMark corpus, the
  full editor characterization suites, and the smoke e2e pair.
- **The hygiene fix batch (2026-11-21).** The first H-list batch: H1's
  live-recency guard on the server upsert plus the client's refusal tell
  (a refused push stays dirty and takes the three-way merge — the
  two-tab silent-loss race is closed on both sides of the wire); H2's
  share-PATCH chunking against wire-owned caps; H7's one 5 MB constant
  (shared/wire.ts) behind every gate; H10's canonicalizeColor as the
  picker's own composition; H24's session.ts (one key, one reader) and
  the de-quadraticized push queue; H25's quota.ts with the race
  boundedness written down; and H3's client half (NotesPutV2 is the PUT
  answer's one type). Prettier also folded the format drift the earlier
  cleanup commits had left in selector.ts and sheet-kit.ts.
- **The hygiene review (2026-11-21, fd3b7be → e8a9178).** The owner asked
  for a whole-repo scan for poorly designed garbage. Dead exports, dead
  params and dead branches deleted across eleven modules; the silent
  PDF/docx export failures and the CORS DELETE hole fixed; the share
  island's favicon 404 gone; sixteen executed one-off scripts deleted.
  The review also amputated the note-image render path on a
  "no standard note ever carried a reference" reading — corrected the
  same day (see the scope lines: that call meant PLAIN notes; rich/gfm
  capture and render are restored, now scoped by surface). The design
  findings that remain are the H-list above.
- **Plain notes go text-only; rich/gfm keeps images (2026-11-21,
  ab22aa9 + f18ba24, restated same day).** The first reading took capture
  out of the markdown surface entirely; the owner's restatement kept the
  line at the PLAIN surface — markdown notes capture (paste, drop,
  picker, toolbar row), render and round-trip their references again,
  scoped to the markdown surface so plain never sees a picker. The
  drawing canvas turned Excalidraw's image tool on with the
  vendor-native insert path — resize and caps at insert — and grew the
  persistence spine: files flush to the attachment store offline-first,
  hydrate at open (local first, the cloud's lazy pull, cached on
  arrival), and the bridges carry the bytes (.excalidraw both ways,
  .padify embedding, PNG/SVG with real pixels).
- Excalidraw master 0.18.0-9fbeaed — the excalidraw.com train: minimap on
  every open (50c511c), same-origin fonts (canvas-assets.ts), theme that
  follows (f26aa84). The "latest version / map" question is closed.
- The canvas island warms itself while the app idles (25628ec).
- `.padify` single-note envelope v1 + `.excalidraw` two-way door (fcb235b),
  with the additive attachments extension (379507a).
- The shortcuts sheet teaches the canvas (703b616); the file names the live
  note (8f9d63f).
- Offline as a state you can see (70d9e54); the mobile hamburger (86ef052).
- Hover deck live (893e29c → c218c10); substitution family shipped
  (9428257, fd4b3c8).
- Images-in-notes shipped and was rescoped the same day (379507a →
  restated): the capture machinery serves the markdown surface (and the
  canvas keeps its own module), the renderer stays for data.
