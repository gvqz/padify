Notepad
========

An offline-capable, no-frills notepad. Quick, distraction-free, dark-mode enabled, mobile-compatible and minimalist in nature. Runs entirely in your browser — your notes never leave your device.

Built as a Progressive Web App using the [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), so it keeps working even when you're offline.

## Notable features

- Write notes in plain text, autosaved [locally](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
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
- Download notes as **plain text**, **PDF**, **HTML**, and **DOCX**
- Monospaced, serif and dyslexic fonts
- Optional typewriter sound, break reminders, and 20+ ambient sounds
- Privacy-focused — nothing you type is ever collected or sent anywhere

## Mini tools

The notepad ships with a small suite of companion tools:

- [Rich Text Notes](/rich-text-notes/) — write with formatting, export as PDF
- [Markdown Editor](/markdown-editor/) — two-pane markdown editor with live preview
- [Voice Notes](/voice-notes/) — record and manage voice notes in the browser
- [Simple Kanban](/kanban/) — lightweight task board with CSV export
- [Case Converter](/case-converter/) — convert text between letter cases
- [Tabbypad](/tabbypad/) — take multiple notes at once
- [Text Tools](/text-tools/) — line operations, cleanup, find & replace, data extraction
- [Text Diff](/text-diff/) — compare two blocks of text
- [Teleprompter](/teleprompter/) — scrolling text with adjustable speed and styling
- [Deep Breath](/deep-breath/) — a simple guided breathing exercise
- [Drawingpad](/drawingpad/) — freehand drawing/sketching (beta)
- [Tasks](/tasks/) — a dead simple todo manager

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
