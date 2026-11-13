## [A1] alwaysdata — first load (logged out)
- Load OK, no JS console errors. Console: "[storage] backend: indexeddb".
- Welcome modal note preloaded in tab rail; word pill 356 words / 2051 chars.
- Top bar: Padify menu, Download, Copy, Voice, Music, Writing Session, Cloud sync, Share, PiP, History, Unicode, Fullscreen, Reminders calendar.
- Padify menu = About / Keyboard shortcuts (Ctrl+K) / Help.

## [A2] Keyboard shortcuts dialog (Ctrl+K)
- **BUG (doc conflict): Ctrl+U listed TWICE — "Take a snapshot" AND "Underline (Rich Text)".** Which wins? → verify.
- **BUG (doc conflict): menu button labels shortcuts dialog "Ctrl + K", but dialog says Ctrl+K = "Insert or edit link".** → verify.
- Alt+S = Save as PDF; Ctrl+, = Preferences; Ctrl+Shift+Del = delete note; Ctrl+Alt+←/→ = switch tabs.
- Minor (dev-facing): document.querySelector('[role=dialog]') matches a hidden context-menu template, not the visible dialog.

## [A3] Editor & formatting (alwaysdata, rich note)
- Autosave works ("Saved" indicator), IndexedDB "padify" + "NotepadSnapshotsDB".
- Reload persistence OK; tab auto-title from first line. Word/char counts exact (24 words/136 chars verified).
- Ctrl+B -> <b>, Ctrl+I -> <i>, Ctrl+U -> <u> all render in contenteditable. GOOD.
- **CONFIRMED DOC BUG: Ctrl+U in editor underlines; shortcuts dialog also claims Ctrl+U = "Take a snapshot". Confusing/wrong.**
- Context menu = native items (Undo/Redo/Cut/Copy/Paste/Delete/Select all) + B/I/U/S checkboxes + Clear formatting + Insert link + Insert equation + Case converter (12 conversions). Also a floating toolbar (Bold/Italic/Link) appears on selection.
- **MAJOR BUG — Case conversion corrupts text:** select "The budget number" (line 3) while caret was last on line 2, right-click > Case converter > Title Case. Result: converted text "The Budget Number" inserted at END of line 2 ("parts.The Budget Number" glued, no space), original text deleted from line 3, remainder " is critical here." pushed to its own line. Selection replacement used stale caret position. (verify again via dblclick flow)
- Case conversion follow-up: keyboard-select + right-click INSIDE selection works correctly in place ("BUDGET"/"CRITICAL"). Right-click OUTSIDE selection collapses it; conversion then no-ops (safe). The original corruption (text teleported to end of previous line, glue without space) reproduced ONCE — steps involved Escape-closing a menu, reselecting, right-click near selection edge. INTERMITTENT data-corrupting bug, evidence captured (innerHTML before/after).

## [A4] Equation insertion (rich note) — BROKEN
- **BUG 1: Insert equation with default prefilled LaTeX (e^{i\pi}+1=0) + Insert = silent no-op.** Dialog closes, nothing inserted (repro'd twice, caret placed + not placed).
- **BUG 2: Typing custom "E=mc^2" then Insert → equation inserted at START of note (before first line), NOT at caret (Ctrl+End had been pressed). Screenshot: shot-equation-misplace.png.**
- Minor: tab auto-title becomes "E=mc^2Meeting notes f…" — LaTeX source leaks into the note title.
- KaTeX rendering itself looks great once inserted. Symbol palette tabs (Greek/Operations/Relations/Arrows/Misc) present.

## [A5] Rich toolbar (alwaysdata)
- Checklist toggle works; numbered/bulleted lists OK; 2x2 table OK; Ctrl+K link OK; <sup>/<sub> OK; undo/redo OK.
- **BUG: Text style (Heading 1) silently does NOTHING when caret is inside a list item** (no change, no feedback). Works on paragraphs (<h1>).
- **BUG (invalid HTML): inserting a table while caret is in an empty checklist item nests <table> directly inside <ul data-rich-checklist> — invalid HTML, may break exports/paste.**
- Select-all + Delete leaves an empty <ul data-rich-checklist> block behind (stray artifact).
- Default "New note" = plain note, no toolbar; rich features need type chooser > Rich text note.
- Word/char count accurate vs visible text (65 chars verified). Link inserted after a word glues visually ("Pharmacyhttps://...") — count consistent.

## [A6] History / snapshots / trash (alwaysdata)
- History panel: This note / All notes / Trash tabs, filter box, "+ Take snapshot", version limit "200 across all notes", Restore (saves current first — good), copy button, list/grid toggle.
- **CONFIRMED BUG: while History modal is open, the trash-toast "Undo" button is NOT clickable — modal backdrop (#snapshotsModal) intercepts the click (elementFromPoint proof). Clicking it just dismisses the modal; note stays in trash. User sees toast, clicks Undo, nothing happens.**
- Trash: 30-day retention w/ countdown ("30 DAYS", "next leaves in 30 days"), Restore works, Delete forever = 2-step inline red confirm (works), Empty trash available. Restore hint mentions share links keep working.
- History empty state says snapshot shortcut = "Ctrl + U" — conflicts with editor Ctrl+U = underline (doc bug duplicated here).

## [A7] Misc editor notes
- Select-all+Delete leaves stray empty checklist <ul>. Heading style silently no-ops inside list items. Georgia font + red color apply (to empty selection → zero-width spans).

## [A8] Note statistics modal (alwaysdata)
- Beautiful layout: WORDS/CHARS/SENTENCES/PARAGRAPHS + VOCABULARY/TIME/RECORDS/QUALITY.
- **BUG: "Unique words 10" exceeds total "Words 7" — impossible; unique-words tokenizer differs from word-count tokenizer.**
- **BUG: "Lexical density 142.9%" — percentage >100%, formula broken.**
- Sentence count (2) appears to split on URL dots (note text has no sentence punctuation).
- History modal quirk: Escape does NOT close it (shortcuts claim Esc closes popups); backdrop click does.

## [A9] Reminders calendar + task lists (alwaysdata)
- Full calendar (Day/Week/Month/Year, mini-cal, lists panel). Reminder add works; NL date parsing ("friday 3pm" → "Tomorrow 3:00 PM") works.
- **UX SURPRISE: calendar "+ Add" creates a brand-new Task-list NOTE ("Untitled list") and hijacks the editor view — not a lightweight calendar entry.**
- **BUG: renamed list ("Untitled list" → "Errands") does NOT update the sidebar tab — tab still shows generic "Task list" (title desync).**
- Reminder default time auto-assigned Sat 9:00 AM. Reminders panel: Today/Scheduled/All/Flagged/Completed/Calendar with badges. Solid.
- Writing session: presets + custom; "0" clamps to 1-min countdown silently (no validation message). Countdown pill + X cancel work; ends cleanly.
- Statistics modal has role=dialog but aria-modal/aria-labelledby missing (a11y).

## [A10] Music player + Unicode picker (alwaysdata)
- Music search works (22 results for Moonlight Sonata via /padifyapi/api/music/search), streams = YouTube audio (googlevideo videoplayback). Favorites add/list works. Queue auto-filled from search (badge 20), ambience plays with autoplay-policy toast. Mini-player docks bottom-right when modal closed. Ambience tab = 12 tracks ("Loops until you skip").
- **BUG: contradictory player state after stream retry failure — bar says "Nothing playing"/0:00 while play button shows PAUSE and list row shows equalizer icon. No error surfaced to user; recovers only after manual pause+play.**
- **README mismatch: "12-sound ambience mixer" is actually just a 12-track LIST — no per-sound mixer UI found.**
- Unicode picker (Ctrl+Shift+O): 5,418 chars, categories with counts, search, detail panel (U+2654, HTML entity), Favorites/Recents, keyboard hints. Insert targets LAST-FOCUSED input — landed in reminder input when that was last focused (surprising but consistent).

## [A11] Settings modal (alwaysdata)
- Sections: Appearance (Theme Device/Light/Dark + 6 paper textures), Text, Writing, Interface, Effects, Cloud sync. Search box, Reset to defaults, Done. Dark mode applies instantly.
- Text fonts offered: Default/Serif/Monospaced/Handwritten/Humanist/Pixel/Typewriter/Crayon + size 10-30 + line height 18-40 + Easy Read (66ch).
- **README mismatch: README advertises "Monospaced, serif and dyslexic fonts" — NO dyslexia-friendly font option exists in Settings.**
- Ctrl+, shortcut did NOT open settings when tested via keyboard event (opened via gear icon instead) — shortcut maybe editor-focus-dependent; verify later.

## [A12] Exports + misc (alwaysdata)
- All 4 download formats work and are valid: TXT (text matches), PDF (1.3, 1 page, jsPDF), DOCX (Word 2007+, text verified), HTML (valid). Table exports as tabs in TXT; heading stays styled in HTML.
- Minor: exported filename is generic "Notes-12-11-2026" (DD-MM-YYYY) — not the note title; hard to distinguish exports.
- Settings gear opened reliably; "Typing explosion effect" + fireworks works (particles visibly render in dark mode).

## [A13] Voice, PiP, Fullscreen (alwaysdata)
- Voice typing: mic blocked in headless → clear toast "Microphone access is blocked…" — graceful degradation GOOD.
- Fullscreen toggles on/off correctly.
- **PiP "Floating Window" button ONLY exists when active note = plain/standard type (by design per src/pip-window.ts syncAvailability) — button silently vanishes when switching to rich/markdown/task note with no explanation. UX surprise; document in tooltip.**
- PiP window itself can't be opened in headless (env limit) — logic verified only.

## [A14] Markdown note (alwaysdata)
- Dedicated md toolbar (B/I/S/code/sub, block-style dropdown, lists, task, link, image?, table, divider, equation) + Source/Split/Preview modes + top-bar preview eye icon. Tab title derives from "# Heading". Monospace source editor.
- **BUG (documented feature missing): shortcuts dialog says "/" at line start opens a Slash command menu ("insert headings, tables, blocks") — typing "/" at line start does NOTHING, and no slash-menu code exists in the repo (rg-verified). Feature never shipped.**
- Block styling available via toolbar dropdown instead (Normal text > Heading 1..3/Quote/Code block).

## [A15] Save indicator bug (alwaysdata)
- **BUG: after typing "/" (key event) in a Markdown note, the save indicator sticks on "Saving…" (class save-state saving + spinner) for 20+ s through further inputs until reload. Data DOES persist (verified via reload). Cosmetic but erodes trust.**
- Preview mode renders # heading correctly.

## [A16] MAJOR: Offline/PWA broken on alwaysdata
- Reload while offline → chrome-error://chromewebdata/ (app dead). NO service worker registered (navigator.serviceWorker.getRegistration = null) even though "app-v62723ed84c" cache exists.
- Root cause: build-sw.mjs precache list includes "/padify/.htaccess" — Apache (alwaysdata) returns **403 Forbidden** for .htaccess → SW install fails silently → worker never activates → no offline support.
- Manual registration attempts confirm: register() resolves, then the worker errors out during install and the registration vanishes.
- **The app's headline feature ("offline-capable PWA") does not work on the alwaysdata deployment.** Fix: exclude .htaccess from precache (or serve it 200), or conditionally filter 403/404 URLs at build time per deploy target.

## [A17] Netlify deployment (padify.netlify.app) — logged out spot-check
- App loads fine, welcome note, same feature set, /api proxy to alwaysdata API works (music capabilities OK).
- **WORSE than alwaysdata: /padify/sw.js returns 404 (SPA index fallback) — no service worker file deployed at all → PWA offline/install impossible on Netlify.** Also /padify/.htaccess 404s (ignored by Netlify).
- Different build hash (cache app-va8150a551d vs alwaysdata app-v62723ed84c) — the two deployments are NOT the same version; Netlify appears to run a different build (netlify.toml builds from source).

## [A18] CRITICAL: Share link URL token corruption (alwaysdata)
- POST /api/shares → 201; DB stores token 4yB4HVJJQRw5XMbPi06Zxc7g (verified via authenticated GET /api/shares).
- Share dialog DISPLAYS https://functionhost.alwaysdata.net/padify/share/?t=4yB4HVJJ0RwSXmMbPi06zXc7g — token corrupted (Q→0, 5→S, Z→z; looks like confusable-char mangling somewhere in the display/copy pipeline).
- Result: the public share page for the DISPLAYED URL says "This link isn't available" (API 404). The CORRECT token URL renders perfectly (title, dates, content, Read-only badge, footer).
- **Net effect: every share link a user copies is DEAD. Feature works only if the URL is hand-corrected. Highest-priority fix.**
- Also noted: share page favicon requests 404 (share/favicon.png, share/favicon.ico) — cosmetic.
