# Voice Notes

> Feature reference for the retired **Voice Notes** page (`public/voice-notes/`), captured before deletion so the feature set can be rebuilt as a note type inside the main Padify editor. This document covers behavior and functionality only.

Voice Notes was an in-browser voice recorder: record audio from the microphone, convert it to MP3, keep every recording (with per-recording notes) in IndexedDB, and play/download/delete them later.

## Data model & storage

- **IndexedDB database:** `VoiceNotesDB` (version 2).
- **Object store:** `recordings`, keyed by `timestamp` (epoch ms, unique index).
  - Record shape: `{ timestamp: number, blob: Blob (audio/mp3), notes: string }`.
  - Version 2 of the DB schema added the `notes` field (with a non-unique `notes` index) for upgrades from version 1.
- All recordings live locally; nothing is uploaded anywhere.
- Recordings are listed **newest-first** on load (sorted by timestamp).

## Recording

- Single **record/stop toggle button**:
  - First press requests the microphone (`navigator.mediaDevices.getUserMedia({ audio: true })`) and starts a `MediaRecorder`.
  - While recording, the button label reads "Stop recording", a recording indicator is active, and a **live elapsed timer** (MM:SS) updates every second.
  - Second press stops the recording: the MediaRecorder and all mic tracks are stopped and released (the stream is fully torn down; a fresh `getUserMedia` is requested for the next recording).
- **Failure handling:** if the microphone can't be accessed, the error is logged and the recording state resets (no crash).
- **Post-processing indicator:** stopping a recording **longer than 10 seconds** shows a "processing" loader while the MP3 conversion runs (short recordings skip the loader).

## Audio conversion (WebM → MP3)

- On stop, the recorded WebM chunks become a Blob and are converted to MP3 before saving:
  - The blob is decoded with the **Web Audio API** (`decodeAudioData`).
  - Float sample data is converted to 16-bit PCM (clamped to ±32768) for the left (and right, if stereo) channels; mono audio duplicates the single channel.
  - **lamejs** encodes it to MP3 at **128 kbps**, preserving the source channel count and sample rate, in 1152-sample blocks, then flushes the tail.
- The resulting MP3 Blob is what gets stored and played.

## Recording list

Each recording renders as an item with:

- **Header:** the recording date (formatted like `4th Jun, 2024` with locale month names and an ordinal suffix) plus a **"time ago" label** ("just now", "N minutes ago", "yesterday", … "N years ago") that **refreshes every 60 seconds** while the item is on screen (the interval self-cleans when the item is removed from the DOM).
- **Inline audio player** (`<audio controls>`) fed by an object URL of the MP3 blob.
- **Per-recording notes field:** a textarea ("Add notes about this recording...") pre-filled from storage.
  - Notes **autosave** 500ms after the last keystroke (debounced).
  - A "Saved" indicator appears for 2 seconds after a successful write.
- **Actions:**
  - **Download** — saves the MP3 as `recording-<timestamp>.mp3` via object URL.
  - **Delete** — deletes the row from IndexedDB and removes the item from the list.
- New recordings are **inserted at the top** of the list.
- An **empty state** shows when there are no recordings; it reappears (with a fade) when the last recording is deleted, and hides as soon as a recording exists.

## Theme

- Light/dark toggle persisted in localStorage key `voice_notes_theme_v1` (`'light' | 'dark'`; falls back to the device `prefers-color-scheme` when unset or unreadable).
- Applies a body class, a `data-bs-theme` attribute on the document element, updates `<meta name="theme-color">`, and reflects an `aria-pressed` state on the toggle button.

## Dependencies (as shipped)

- lamejs (MP3 encoding), Bootstrap, Bootstrap Icons. MediaRecorder + Web Audio APIs (browser-native). No build step; no cloud sync — purely local, including all audio blobs.

## Notes for rebuilding inside the main app

- A "voice note" type for the main app should store **audio blobs** — IndexedDB is the right store for that (localStorage can't hold blobs), so the main app will need an IndexedDB attachment store keyed by note/tab id, since the current note sync only covers text HTML.
- The record-per-session stream teardown (mic released after every recording) is privacy-correct behavior to keep.
- The WebM→MP3 conversion exists for portability of downloads; if the main app keeps recordings internal, storing the original compressed WebM/Opus and converting only on download would save CPU and quality loss.
- The timestamp-keyed schema (`{ timestamp, blob, notes }`) maps naturally to `{ noteId, blob, text }`; per-recording notes become the note's own text once a recording is a first-class note.
- The self-cleaning 60s "time ago" interval pattern is worth reusing wherever the main app shows relative timestamps.
