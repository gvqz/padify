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

## The question on the table: `.padify` workspace files — the multi-note envelope

**A whole pad — notes, order, theming, images — as one file. Verdict: yes,
a good idea, and the timing is finally right. But it is a "next", not a
"now" — it wants the canvas-images machinery landed first, because the
workspace's attachments pool is the same machinery wearing a bigger hat.**

Why yes:

- The instinct is real. The single-note `.padify` shipped (fcb235b) because
  "one note, fully, as a file" is what a notepad owes its users. A pad is
  more than its notes — the order, the theming, the attached bytes — and a
  workspace file is the only honest way to hand all of it to someone.
- The validation discipline is the template, and it is proven twice: the
  scene envelope (drawing/scene.ts — version, whitelist, byte budget) and
  the single-note envelope (padify-file.ts — discriminator, format version
  with the newer-format refusal, additive extensions, opaque payloads,
  mint-fresh-on-import). The workspace envelope is that discipline applied
  to a manifest plus N payloads. Nothing new to invent, only compose.
- The attachments field already exists on envelope v1 (additive), and the
  re-hydration path under original ids already runs at import. A workspace
  with drawings-in-it is exactly that path, N times.

The design sketch (so the decision never has to be re-litigated):

- `type: "padify-workspace"`, `format: 1` — a NEW discriminator, not a
  version bump of `padify-note`. Older builds refuse it with the same
  "newer-format" honesty the scene format teaches (they answer null today;
  the workspace import path is the only thing that changes).
- The manifest carries what the pad UI owns and nothing more: note list in
  order (each entry = the single-note payload fields), plus the pad-level
  prefs that exist at export time. No sync state, no timestamps beyond
  provenance, no ids that pretend to be stable — import mints fresh note
  lives exactly like the single-note import does.
- One shared attachments pool (id → bytes), referenced by any note's
  content refs and any scene's fileIds. The dedupe the store already does
  by id keeps two drawings sharing a pasted image at one copy.
- JSON envelope (chunked base64, same as v1), not zip — v2 can graduate to
  zip when file sizes earn it; the parse discipline does not change shape
  under it.
- Import UX is the one genuinely new question: add N notes (mint fresh,
  never merge) and say so honestly in a toast with a count. Replace-the-pad
  is a destructive act and stays out of v1.

Costs, stated plainly: base64 inflates a file by 1.33× (a heavy pad with
images can reach tens of MB — acceptable for a download; the browser saves
it either way), and the import path needs a progress affordance because
500-file ceilings × 5 MB caps can decode for a second or two. Both are
honest costs, not blockers.

## NOW — what the working queue holds (non-visual)

4. **Workspace envelope** (the design above) — the single-note envelope's
   discipline, composed N times over; reuses the canvas-images machinery
   that just landed.
5. **Attachment garbage collection.** The store gains tenants without a
   janitor: sweep attachment ids no longer referenced by any live note's
   content or any live scene (local: on open/sync idle; server: the orphan
   GC the schema's collection shape already anticipates). Two-sided, with a
   grace window — a file referenced only by an unsynced second device must
   not die under the first device's broom.
6. **Share links learn images.** Attachments are session-authenticated
   today; a share carrying `padify-att:` refs renders placeholders. The
   honest fix is signed public URLs (short-lived, per-share, server
   verified) — a real server change, worth its own decision. Until then the
   placeholder IS the honest degradation.
7. **Usage & quota surface.** 200 MB / 500 files per user exists on the
   server and is invisible in the app. The cloud panel shows usage, the
   capture paths warn near the ceiling. Small, and it makes the invisible
   pipeline legible.
8. **Canvas open performance.** The island is warmed (25628ec) but the
   open path still pays React mount + font registry + scene restore. Measure
   first (the playwright trace exists); optimize only what the numbers
   name. Images add one async hydration step — keep it off the critical
   paint.
9. **Voice notes, revived on the store.** The attachment pipeline was built
   for them; the feature died with the old app. A voice note = an audio
   attachment + a marker — the plumbing is all there. Decide whether it
   wants to be a note type or an attachment in a text note (owner call).
10. **Sync ledger for attachments.** Notes have seq-backed sync integrity;
    attachments have flush-and-hope. A pending-set ledger with retry
    backoff and an "n uploads pending" chip closes the last honesty gap in
    the offline story.

## The hygiene review (2026-11-21) — what the whole-repo scan found

*The owner asked for a full scan for poorly designed garbage. The deletable
weight is gone (dead exports/params eaf1409, the small honest repairs
31cbdc5, the escape/class-list dedup 6c9499a, plus the sixteen executed
one-off scripts 95693ee). The phantom image-data amputation fd3b7be was
reversed the same day — the owner's restatement kept the text-only line at
the PLAIN surface, and rich/gfm capture + render are back, scoped by
surface. The first fix batch landed the same day too: H1, H2, H7, H10,
H24, H25 and the NotesPutV2 half of H3 (see DONE). What remains below is
the rest of the DESIGN findings — things that need real work or a
decision, ranked by how much they can hurt. Every item was verified
against the code, not grepped on faith.*

### Correctness — the items that can lose or lie about user data

- **H1. ~~The server's seq is arrival-ordered, not recency-ordered; two
  tabs can silently destroy a confirmed push.~~ FIXED** — the upsert's
  live-recency guard plus the client's refusal tell (a refused push is
  not confirmed, not adopted; it falls to the three-way merge).
- **H2. ~~Share PATCH caps truncate silently.~~ FIXED** — the caps live
  in shared/wire.ts and the client chunks to them; a mid-run failure
  settles nothing.
- **H3. The wire module's own types are bypassed on the server.**
  HALF-FIXED: `NotesPutV2` now IS the client's PUT answer type (the
  hand-mirrored `NotesPutAnswer` is gone). Remaining: the server
  hand-builds the PUT answer (notes.ts) and `PullRowV2` is built
  field-by-field — type the server's answers with the wire types.
- **H4. `runMany` is only transactional on the local backend.** The Turso
  HTTP path pipelines bare `execute` with no BEGIN/COMMIT (server/db.ts
  206-216) while notes.ts:251's comment claims single-transaction parity.
  Consequences are bounded (re-push converges; the `landed < rows.length`
  409 is the backstop) but the comment is a lie. Fix: wrap the chunk in
  begin/commit statements or correct the comment.
- **H5. The merge engine's silent fallbacks.** Myers past its step budget
  (a ~150 KB note) returns null → diff3 answers conflict → sync parks,
  with no log anywhere; notes without a `syncBase` skip the three-way
  merge entirely; a name conflict after a clean body merge discards the
  merged body (merge/notes.ts:128-135 computes it, then parks mine's raw
  bytes). None lose data (the park keeps both sides), but the big-note
  NEVER-merges case deserves one honest log line, and the merged-body
  discard is just wasteful.
- **H6. The attachment GC does not exist, and its endpoints are
  production-dead.** `DELETE /api/attachments/:id` and the list route have
  zero non-test callers; client `deleteAttachment`/`clearAttachments` are
  test-only. Deleting an image element from a drawing, purging a note,
  deleting an image-bearing markdown note, and
  "delete everything" all leave bytes in IndexedDB and on the server until
  the quota trips. This is NOW-item 5 above — the review's evidence makes
  it a must, not a nice-to-have: the plumbing exists, unwired. (Rich/gfm
  capture being back makes it more urgent, not less.)

### Consistency — the drift waiting to bite

- **H7. ~~The 5 MB attachment cap is mirrored in four places.~~ FIXED** —
  shared/wire.ts owns MAX_ATTACHMENT_BYTES; every gate (upload route,
  envelope, canvas insert, note capture, scene bridges) reads it.
- **H8. The id border is three different rules**: attachments
  `[A-Za-z0-9_-]{8,64}` (defined twice), music `[A-Za-z0-9_-]{6,64}`,
  note ids any string ≤100. All parameterized (no injection), but the
  contract should be one wire-level shape check.
- **H9. "Is this note empty" is answered differently on each side.** The
  server strips tags crudely; the client's check is per-kind (an empty
  tasks JSON is empty for the client, non-empty text for the server). A
  stale client mints a share link the UI would refuse. Minimal per-kind
  emptiness check belongs in shared/wire.ts.
- **H10. ~~Two color normalizers diverge.~~ FIXED** — canonicalizeColor is
  the picker's own composition now (normalizeHex ?? rgbStringToHex),
  pinned in theme-colors.test.ts.
- **H11. `getCloudConfig()` can never return null**, so `isShareAvailable`
  is a tautology and the unconfigured-installs-hide-cloud-surface guards
  are dead (cloud/config.ts:54-67, share.ts:89-91, ui.ts:33). Either make
  the config honestly nullable or delete the ceremony.

### Refactors — real but behavior-neutral, each worth its own commit

- **H12. The editor model's coordinate system is written four times.**
  `coveredTextNodes`/`streamLengthOfNode` (ops.ts) re-implement
  `walkTextStream`/`streamLength` (document.ts/selection.ts) — the same
  TreeWalker walk, four independent copies that must never disagree (one
  drifted member corrupts carets everywhere). Highest-leverage unification
  in the repo, smallest diff: call the document.ts primitives, keep
  signatures. The same file also copy-pastes the "insert a node at a
  DomSpot" primitive FIVE times (the comments on insertPlainText document
  two shipped bugs it caused) — extract `insertNodeAtSpot`.
- **H13. `initRichToolbar` is ~1080 lines** doing ten jobs in one closure
  scope; the sibling markdown/toolbar.ts already shows the decomposition
  (wire* functions taking `(elements, deps)`). Mirror it.
- **H14. `initApp` is ~920 lines.** The extraction candidates: the
  keyboard-shortcut dispatcher and the download-menu/export wiring — the
  same treatment every other behavior already got.
- **H15. snapshots' `renderRows` is ~258 lines**; the eleven DOM-chore
  tail blocks extract into `renderSheetChrome(segment, facts)`.
- **H16. help.ts's tour hints are hardcoded `ctrl + …`** bypassing
  `shortcutLabel()` — Apple users see "Ctrl + B" in the tour and ⌘B in the
  context menu. Route the hints through the one renderer at build time.
  (Its brand hover-deck block, ~110 lines of animation with nothing to do
  with help, also wants its own module.)
- **H17. model-port's internal clones**: undo/redo and indent/outdent are
  byte-identical pairs; the getSelection→parentElement scaffold opens
  eight methods. Mechanical `walkHistory(dir)` + `ancestorFromCaret()`.
- **H18. render.ts duplicates two of its own grammar pieces** (the
  CommonMark marker-padding rule twice; the destination+title FSM twice —
  `parseInlineDestination` vs `parseLinkRefDef`'s half). Extract
  `markerPadding(rest)` and `parseDestinationAndTitle(scanner)`.
- **H19. The margin-left px parser is hand-rolled three times** (ops,
  model-port, plain-indent) beside document.ts's `stylePropOf` — one
  `marginLeftPxOf(block)` beside it.
- **H20. pip-window re-implements the Mod+B/I/U/⇅X → command map** the
  context menu owns as data. Export `commandFor(id)` from one place.

### Small chores

- **H21.** shares GET limit 200 with no revoked filter — during the
  7-day death grace, dead rows can crowd live links out of the owner's
  inventory.
- **H22.** `/api/music/resolve` peeks the DB cache before any rate limit —
  an anonymous caller gets one free Turso round-trip per unknown id; the
  share route got a bucket for exactly this (an in-memory negative cache
  is the cheap answer).
- **H23.** `music_resolutions.resolved_at` is written, never read — drop
  the column or read it. The seq-backfill migrations also full-scan notes
  on every boot (fine on Turso free tier, worth a note).
- **H24. ~~api() passthrough, twin session parsers, O(n²) dirty loop.~~
  FIXED** — cloud/session.ts owns the key + shape + one reader; the
  wrapper is gone (apiCall directly); the push queue's row builder rides
  an index-carrying map.
- **H25. ~~Function-local quota constants, unremarked TOCTOU.~~ FIXED** —
  server/quota.ts owns the three numbers with the boundedness argument
  written down.

## PARKED — waiting for the owner (visual)
11. **The visual pass** — `qa/VISUAL-QA-HANDOFF.md` is the brief; findings
    land in `qa/findings-LIVE.md`. Exildraw "needs a lot of work" per the
    owner; the canvas-skin misses are the same bucket.
12. **Hover deck polish** — the ten-move rotation is live (c218c10); the
    deck's motion and timing get revisited when the visual pass opens.
13. **Canvas theming follow-ups** — the skin follows the app's tokens; the
    minimap island and vendor popovers have known seams (xv21 evidence).

## DONE — so nobody re-plans it

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
