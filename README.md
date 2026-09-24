Padify
======

An offline-capable, no-frills notepad. Quick, distraction-free, dark-mode enabled, mobile-compatible and minimalist in nature. Runs entirely in your browser — notes are stored locally and keep working without a connection.

Built as a Progressive Web App using the [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), so it keeps working even when you're offline.

## Notable features

- Write notes in plain text or with rich formatting, autosaved [locally](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
- Multiple notes in a sidebar — plus bold, italic, underline and strikethrough that render right in the editor
- **Voice typing** — dictate into the note with the Web Speech API (mic icon or alt/option + v)
- **Optional cloud sync** — create a free account and your notes back up automatically, restoring on any device you sign in on (see [docs/CLOUD_SETUP.md](docs/CLOUD_SETUP.md))
- **Share links** — publish a read-only copy of a note with a chosen expiry (1–90 days) and cancel it at any time (cloud accounts; see [docs/CLOUD_SETUP.md](docs/CLOUD_SETUP.md))
- [Installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Developer_guide/Installing) on supported browsers for offline usage
- "Add To Home Screen" on supported mobile devices
- Dark mode
- Writing timer
- Word and character count with note statistics
- Snapshots — restore notes from previously saved versions
- Keyboard shortcuts for common actions
- Focus mode and full-screen mode for distraction-free writing
- Optimal line length for a better reading experience
- Floating window (Picture-in-Picture) to take notes on top of other apps
- Multiple notes in **tabs** on the main page, with **bold / italic / underline / strikethrough** formatting that renders right in the editor
- Download notes as **plain text**, **PDF**, **HTML**, and **DOCX**
- Monospaced, serif and dyslexic fonts
- Optional typewriter sound, break reminders, and a built-in music player with generative ambient tracks plus a 25-sound ambience mixer
- Unicode character picker — 5,400+ symbols, math, arrows, currency, box drawing, braille and emoji with search, favorites and recents (`Ctrl/Cmd + Shift + O`)
- Privacy-focused — nothing you type is ever collected or sent anywhere

## Retired mini tools

The standalone companion-tool pages (Rich Text Notes, Markdown Editor, Voice Notes, Simple Kanban, Text Tools, Text Diff, Teleprompter, Drawingpad, Tasks) have been removed from the app. Their full feature sets were captured before deletion in [markdownreports/](markdownreports/) — one report per page — to serve as the reference for rebuilding those features as note types inside the main editor's new-note flow.

## Privacy

Everything stays on your device by default: notes, snapshots, settings. Nothing is collected and no analytics exist. Cloud sync is strictly opt-in — when a user signs in, only their note tabs are stored in the app owner's sync project, locked to that account. Sign out and new edits never leave the device again.

## Running locally

The app is fully static — no build step required.

1. Serve the repository root over HTTP (Service Workers don't work from `file://`):

   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```

2. Open `http://localhost:8080` in your browser.

## License

MIT — see [LICENSE.txt](LICENSE.txt)

## Development

The app is built with [TypeScript](https://www.typescriptlang.org/) and [Vite](https://vitejs.dev/).

```
bun install        # install dependencies (or: npm install)
bun run dev        # dev server with HMR at http://localhost:5173
bun run build      # typecheck + production build into dist/ (+ service worker)
bun run preview    # serve the production build locally
bun run typecheck  # strict TypeScript check only
bun run lint       # eslint (or: bun run lint:fix)
npm run test       # vitest, single run (Node runtime — jsdom breaks on some Bun builds; or: npm run test:watch)
bun run format     # prettier --write (or: bun run format:check)
```

CI runs typecheck, lint, format check, tests and the production build on
every push and pull request (`.github/workflows/ci.yml`).

### Project layout

- `index.html` — main app entry, references `/src/main.ts`
- `src/` — application code as strict TypeScript modules
  - `src/unicode/` — the character picker (`picker.ts`) and the generated symbol database
- `public/` — static assets copied verbatim to the build (css, fonts, sounds, images, mini tools)
- `scripts/build-sw.mjs` — post-build step that generates `dist/sw.js` with a precache manifest of every build artifact
- `scripts/gen-unicode-data.mjs` — regenerates `src/unicode/symbols-data.ts` from the Unicode Character Database (`bun run gen:unicode`)

The service worker is generated from the build output, so every hashed asset is
precached automatically. Code-split chunks (the Unicode database, PDF/DOCX
exporters) are fetched on first use, keeping the initial payload small.

The mini tools under `public/` are self-contained static pages; they can be
migrated into TypeScript modules incrementally over time.
