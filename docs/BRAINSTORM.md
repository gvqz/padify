# The brainstorm — everything Padify could do next

*2026-11-21. The working instrument: ranked, opinionated, and allowed to be
wrong. Finished work leaves this file (the git log and DECISIONS.md are the
record); parked work stays parked visibly. The owner's two standing scope
lines live at the top because everything else defers to them.*

## The owner's scope lines (2026-11-21)

1. **Standard notes stay text-only.** No images in plain, rich or markdown
   notes — capture surfaces there come back out. The attachment store keeps
   its one true tenant: the **drawing canvas** (Excalidraw's image elements).
   Notes that already carry a `padify-att:` reference (the feature shipped
   earlier the same day) still *render* — the resolver stays as graceful
   degradation for existing data, but nothing writes new references into
   notes anymore.
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

## NOW — this session's work (non-visual)

1. **Notes go text-only.** Capture (paste, drop, picker, toolbar row) comes
   out of the markdown surface; the renderer's resolver stays so existing
   references keep rendering; the `.padify` envelope keeps embedding
   whatever references still exist in real data.
2. **Canvas images v1 — the attachment store's real tenant.** The drawing
   canvas turns Excalidraw's image tool on and grows the persistence spine:
   vendor-native insert (paste, drop, tool — master resizes at insert via
   `imageOptions`, content-hashes file ids), bytes flushed to the local
   store offline-first and uploaded by the existing cloud flush, files
   re-hydrated at open (local first, the cloud's lazy pull for another
   device's bytes, cached on arrival). Scene bytes stay tiny: an image
   element carries a fileId, never pixels — the 2 MB wire cap is untouched.
3. **The bridges carry images.** `.excalidraw` save embeds the files map
   (excalidraw.com opens images natively); `.excalidraw` open admits one
   (today it refuses with `embedded-images` — the refusal flips, the
   ceilings do not: 5 MB/file, 500 files, junk entries drop). `.padify`
   export embeds a drawing's referenced bytes; PNG/SVG exports pass the
   files map so exported images are the real pixels.

## NEXT — ranked, still non-visual

4. **Workspace envelope** (the design above) — lands after canvas images,
   reuses their machinery.
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

## PARKED — waiting for the owner (visual)

11. **The visual pass** — `qa/VISUAL-QA-HANDOFF.md` is the brief; findings
    land in `qa/findings-LIVE.md`. Exildraw "needs a lot of work" per the
    owner; the canvas-skin misses are the same bucket.
12. **Hover deck polish** — the ten-move rotation is live (c218c10); the
    deck's motion and timing get revisited when the visual pass opens.
13. **Canvas theming follow-ups** — the skin follows the app's tokens; the
    minimap island and vendor popovers have known seams (xv21 evidence).

## DONE — so nobody re-plans it

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
- Images-in-notes shipped and then rescoped the same day (379507a) — the
  capture machinery moves to the canvas, the renderer stays for data.
