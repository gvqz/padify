# Padify — Deep Real-User QA Report

**Tester:** AI agent operating as a real user (exploratory + scripted passes)
**Date:** November 12, 2026
**Targets:**
- A = `https://functionhost.alwaysdata.net/padify` (Apache/alwaysdata, API at `/padifyapi`)
- N = `https://padify.netlify.app` (Netlify, API proxied to alwaysdata)
**Source reference:** `gvqz/padify` (cloned to verify behavior against code)
**Session:** Chromium 1440×900, dark/light themes exercised, logged-out and signed-in rounds, ~4 hours of interaction.

---

## 1. Executive summary

Padify is an unusually feature-rich offline notepad (7 note types, cloud sync, share links, history/snapshots, trash, music/ambience, unicode picker, 4 export formats). The core writing experience is genuinely solid: autosave, persistence, formatting, lists, tables, links, exports, statistics, reminders and cross-device cloud sync all work.

However, the report found **2 critical**, **5 major** and **~12 minor** issues. The two critical ones undermine the app's two headline promises:

| # | Severity | Issue |
|---|----------|-------|
| C1 | **CRITICAL** | Share links: the URL shown/copied by the Share dialog contains a **corrupted token** — every link a user shares is dead for recipients |
| C2 | **CRITICAL** | **Offline PWA is broken on both deployments** — reload while offline shows the browser error page; no service worker ever controls the page |

---

## 2. Coverage matrix (what was exercised)

| Area | A (alwaysdata) | N (Netlify) | Result |
|------|----------------|-------------|--------|
| Load, console cleanliness | ✔ | ✔ | Pass — no JS errors, IndexedDB backend chosen |
| Editor typing / autosave / word+char counts | ✔ | ✔ | Pass (counts verified exact vs computation) |
| Persistence across reload | ✔ | ✔ | Pass |
| Bold / italic / underline / strikethrough (kbd + toolbar) | ✔ | — | Pass |
| Right-click context menu (12 case conversions, clear formatting, link, equation) | ✔ | — | 1 major bug (case conversion corruption, intermittent) |
| Rich toolbar (lists, checklist toggle, table, superscript/subscript, fonts, colors, styles) | ✔ | — | Pass w/ 2 bugs (heading-in-list silent no-op; table nested in checklist = invalid HTML) |
| **Equation (KaTeX) insertion** | ✔ | — | **Broken:** default insert = no-op; custom insert lands at start of note, not caret |
| Markdown note (Source/Split/Preview, md toolbar) | ✔ | — | Pass, except slash command menu documented but nonexistent |
| Task list note + reminders calendar (Day/Week/Month/Year, NL dates) | ✔ | — | Pass w/ UX finding (calendar Add hijacks editor; rename doesn't update tab) |
| Drawing note (Excalidraw) | ✔ | — | Pass |
| History: snapshots, version preview/restore, 200-version quota | ✔ | — | Pass; Ctrl+U doc conflict |
| Trash: delete → toast Undo → 30-day retention → restore → delete-forever (2-step) → empty | ✔ | — | Pass, **except toast Undo unclickable while History open** (backdrop intercepts) |
| Note statistics modal | ✔ | — | 2 data bugs (unique words > total words; lexical density 142.9%) |
| Writing session timer (presets + custom + countdown pill) | ✔ | — | Pass (0 minutes silently clamps to 1) |
| Settings (Appearance/Text/Writing/Interface/Effects, dark mode, textures, fonts, explosion effects) | ✔ | — | Pass; **no dyslexic font despite README claim** |
| Music player: search (YouTube-backed), play, favorites, queue, ambience (12 tracks) | ✔ | — | Pass w/ stuck-state bug after stream failure (bar "Nothing playing" + Pause icon + equalizer row simultaneously) |
| Unicode picker (5,418 symbols, categories, search, detail panel, favorites/recents) | ✔ | — | Pass |
| Exports: TXT / PDF / DOCX / HTML | ✔ | — | All 4 valid (verified by file/parse); filename is generic "Notes-DD-MM-YYYY" |
| Fullscreen, PiP button logic, voice typing degradation | ✔ | — | Pass (PiP hidden for non-plain note types by design — surprise factor noted) |
| Auth: register, validation (empty/bad email/short pw), wrong-credential error, sign out/in | ✔ | ✔ | Pass — clean validation and error text |
| Cloud sync: push, last-sync status, restore-on-signin, **cross-device (A→N)** | ✔ | ✔ | Pass — 8 notes restored on the other origin |
| Share links: create, expiry chips, public page, cancel | ✔ | — | **C1: displayed URL token corrupted → dead links** |
| Offline / service worker | ✔ | ✔ | **C2: broken on both** |

---

## 3. Critical bugs

### C1. Share-link URL shown to users has a corrupted token (all copied links are dead)
- Create a share (POST `/api/shares` → 201). The Share dialog displayed:
  `…/padify/share/?t=4yB4HVJJ0RwSXmMbPi06zXc7g`
- The token actually stored (verified via authenticated `GET /api/shares`):
  `4yB4HVJJQRw5XMbPi06Zxc7g`
- Differences: `Q→0`, `5→S`, `Z→z` (font-confusable characters) — the display/copy pipeline mangles the token.
- Consequence: the public page for the displayed URL returns 404 → "This link isn't available". The identical page for the correct token renders perfectly.
- The corruption is **transient**: after a reopen/refresh of the dialog the correct token was shown, so first render uses a stale/incorrect value.
- **Fix direction:** render the URL from the exact token returned by the POST (and from the canonical `shareUrlFor(token)` only); add a test that round-trips the displayed URL through the public endpoint.
- Extra: `share/favicon.png` / `share/favicon.ico` 404 on the public page (cosmetic).

### C2. Offline PWA does not work on either deployment
- Offline + reload → `chrome-error://chromewebdata/` on both A and N. No SW ever controls the page.
- **alwaysdata root cause:** the SW precache list (generated by `scripts/build-sw.mjs`) includes `/padify/.htaccess`. Apache answers **403 Forbidden** for `.htaccess` → worker install fails silently → registration vanishes (reproduced by manual `navigator.serviceWorker.register`).
- **Netlify:** `/padify/sw.js` is not deployed at all (404 → SPA index fallback served as text/html). `.htaccess` is ignored there (404). No worker can exist.
- A cache (`app-v62723ed84c` on A, `app-va8150a551d` on N) exists — evidence the SW *tried* to cache but never finished installing.
- **Fix direction:** exclude dotfiles from the precache list (or per-deploy filter 403/404 URLs at build time); ensure `sw.js` ships in the Netlify `dist/` publish. Add an e2e test: go offline → reload → app must boot from cache.

---

## 4. Major bugs

### M1. Case conversion can corrupt note text (intermittent, data-destroying)
Reproduced once with captured before/after HTML: selecting "The budget number" (line 3) while the caret context was stale, right-clicking near the selection edge, then Case converter → Title Case produced:
- converted text **inserted at the end of the previous line** (glued without a space: `parts.The Budget Number`),
- the original selection **deleted** from its line,
- the remainder pushed onto a new line.
Later attempts with a clean selection worked correctly in place. The write path appears to use a stale caret/range in some sequences (menu re-open after Escape is involved). Any occurrence of this is silent data corruption.

### M2. Equation insertion is broken (rich notes)
- With the prefilled `e^{i\pi}+1=0`, pressing **Insert** closes the dialog and inserts **nothing** (reproduced twice, with and without caret placement).
- Typing a custom formula (`E=mc^2`) inserts a KaTeX render **at the start of the note**, not at the caret (verified: caret had been placed with Ctrl+End; screenshot captured). The tab auto-title then becomes `E=mc^2Meeting notes f…` (LaTeX leaks into titles).

### M3. Trash toast "Undo" is unclickable while the History sheet is open
- Trash a note while History is open → toast `"…" moved to trash. Undo` appears, but `document.elementFromPoint` on the Undo button returns the `#snapshotsModal` backdrop: the click dismisses the modal and **never triggers the Undo**; the note stays in trash. The user sees an affordance that lies to them.

### M4. Stuck "Saving…" indicator in Markdown notes
- After a keystroke (`/`) in a Markdown note, the save pill stays in class `save-state saving` with a spinning icon for 20+ seconds through further edits, until reload. Data does persist (verified), but the indicator freezes in "Saving…" — trust-eroding.

### M5. Ctrl+U is documented for two different actions, and the conflict is real
- The Keyboard-shortcuts dialog lists **Ctrl+U = Take a snapshot** AND **Ctrl+U = Underline (Rich Text)**; the History empty state repeats "or Ctrl + U".
- In the editor, Ctrl+U underlines (correct rich-text convention) and does **not** snapshot. The snapshot hint is wrong wherever the editor is focused. Same class of conflict: the Padify menu labels the shortcuts dialog "Ctrl + K" while the dialog itself says Ctrl+K = insert/edit link (Ctrl+K does insert a link in-editor).

---

## 5. Minor bugs & polish

1. **Heading style silently does nothing inside list items** — Text styles → Heading 1 with the caret in an `<li>` produces no change and no feedback.
2. **Invalid HTML on table insert into an empty checklist item** — `<table>` becomes a direct child of `<ul data-rich-checklist>` (verified in innerHTML). Risky for exports/paste/sanitizers.
3. **Select-all + Delete leaves a stray empty `<ul data-rich-checklist>`** block behind.
4. **Note statistics data bugs** — "Unique words 10" > "Words 7" (two different tokenizers); "Lexical density 142.9%" (>100% is impossible); sentence count appears to split on URL dots.
5. **Equation LaTeX leaks into note auto-title** (see M2).
6. **Rename of a task list doesn't update the sidebar tab** — list renamed "Untitled list" → "Errands", tab still reads "Task list".
7. **Calendar "+ Add" hijacks the editor** — it creates a whole new Task-list note and switches the view, rather than a lightweight calendar entry.
8. **Export filenames are generic** (`Notes-12-11-2026.*`) — not the note title; hard to manage multiple exports.
9. **Music player contradictory state after stream failure** — bar shows "Nothing playing / 0:00" while the play button shows Pause and the list row shows the equalizer icon; no error surfaced; recovers only after a manual pause+play toggle.
10. **"12-sound ambience mixer" (README) is actually a 12-track list** — no per-sound mixer UI exists.
11. **PiP button silently vanishes when the active note isn't a plain note** (by design in `src/pip-window.ts` `syncAvailability()`, but there's no tooltip/explanation for the disappearance).
12. **Share-page favicon 404s** (`share/favicon.png`, `share/favicon.ico`).
13. **Zero-width span litter**: applying font/color with an empty selection creates `<span style="font-family: Georgia"><span style="color: #ea4335">​</span></span>` (zero-width chars) in the HTML.
14. **Writing-session "0 minutes" silently clamps to a 1-minute countdown** — no validation message.
15. **Two-step confirmations disarm after 4 s** (cancel link / delete forever) — slower clickers re-arm instead of confirming; consider a slightly longer window or keeping armed state on hover.
16. **Escape doesn't close the History sheet** although the shortcuts dialog claims "Esc — Close popups & menus".
17. **A11y:** statistics modal has `role=dialog` but no `aria-modal`/`aria-labelledby`; save-state has no `aria-label`/live region.

---

## 6. README / documentation mismatches

| Claimed | Reality |
|---------|---------|
| "Monospaced, serif and **dyslexic** fonts" | No dyslexia-friendly option; fonts are Default/Serif/Mono/Handwritten/Humanist/Pixel/Typewriter/Crayon |
| "12-sound ambience **mixer**" | It's a 12-track list; no mixer UI |
| Shortcuts: "Ctrl+U = Take a snapshot" | Ctrl+U underlines in the editor (conflict) |
| Shortcuts: "Padify menu = Ctrl+K" | Ctrl+K inserts a link in-editor |
| Shortcuts: "/" opens a Slash command menu in Markdown | Feature doesn't exist (no slash-menu code in the repo; typing "/" does nothing) |
| "Offline-capable … keeps working even when you're offline" | Broken on both live deployments (C2) |
| "Share any note with a read-only link" | Works, but the URL the user copies is corrupted (C1) |

---

## 7. What works well (worth keeping / celebrating)

- **Editor fundamentals:** typing feel, autosave ("Saved" pill), exact word/char counts, accurate persistence, tab titles auto-derived from content.
- **Formatting:** B/I/U/S, lists (bullet/numbered/checklist with working toggles), tables, links (Ctrl+K), superscript/subscript, fonts/sizes/colors — all render live in the contenteditable.
- **Undo/redo** reliably restored complex corruptions during testing (even partially recovered the M1 case).
- **History & trash:** snapshots with quota (200), version preview + safe restore ("your current text is saved first"), 30-day trash with countdown, working restore & delete-forever (2-step).
- **Exports:** all four formats valid and content-faithful.
- **Statistics modal** is beautiful (layout-wise) and mostly informative.
- **Reminders/calendar:** full calendar views, natural-language date parsing ("friday 3pm" → correct), badges.
- **Cloud sync:** registration, validation, error text, sign-out/in, and genuine cross-device restore (8 notes merged on a second origin). "Last sync" status + manual refresh.
- **Unicode picker:** 5,418 characters, fast search, category counts, detail panel with codepoint + HTML entity, favorites/recents.
- **Music:** search + streaming works end-to-end (YouTube audio), favorites, queue, ambience tracks, autoplay-policy toast, docked mini-player.
- **Graceful degradation:** voice typing shows a clear "Microphone access is blocked…" toast instead of failing silently; clipboard copy falls back with instructions.
- **Polish touches:** welcome note onboarding, typing explosion effects, dark mode instant switch, settings search, Reset to defaults.

---

## 8. Recommended fix order

1. **C1** share-URL token corruption (user-facing data loss of the share feature) + regression test hitting the public endpoint with the displayed URL.
2. **C2** service worker (exclude `.htaccess` from precache; ship `sw.js` on Netlify) + offline e2e test on both targets.
3. **M1** case-conversion stale caret corruption (audit `case-conversions.ts` range handling).
4. **M2** equation insertion (default no-op + caret targeting).
5. **M3** toast z-order vs `#snapshotsModal` backdrop.
6. **M4** save-state machine stuck in `saving` (Markdown path).
7. **M5** + shortcuts documentation sweep (Ctrl+U/Ctrl+K/slash menu) and README feature-claims sync.
8. Minor list (5) as polish batches.

---

## 9. Test artifacts

- Incremental findings log: [`qa/findings-LIVE.md`](qa/findings-LIVE.md) (raw notes, kept verbatim)
- Screenshots: [`qa/evidence/shot-toolbar-overlap.png`](qa/evidence/shot-toolbar-overlap.png), [`qa/evidence/shot-equation-misplace.png`](qa/evidence/shot-equation-misplace.png) (equation inserted at wrong position), plus live-session captures referenced in the log.
- Test account used: `qa.tester.padify@example.com` (left active; contains the 8 test notes and one revoked share).
