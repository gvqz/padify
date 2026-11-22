/**
 * The .padify open door — the file picker, the OS launch queue and the
 * one import routine behind them (see padify-file.ts for the formats).
 *
 * Every way a note file can ENTER the app funnels through
 * importNoteFile(): the download menu's "Open a note file…" row (a hidden
 * file input, reset after each pick so the same file can be re-chosen),
 * and — for the installed PWA — the OS's "open with Padify" gesture
 * (window.launchQueue, the manifest's file_handlers entry, feature-
 * detected so plain browsers never notice it exists).
 *
 * Both dialects come through: a single-note envelope mints ONE note,
 * and a workspace envelope mints its whole manifest — each note a fresh
 * life, none merged, the count said honestly in a toast (see
 * importWorkspaceFile). An import always MINTS (the format module's
 * rule: a file is a copy, not a move) — notes land in the rail and from
 * then on live the same local-first life as every other note: autosave,
 * snapshots, sync, trash. "Everything still synced" falls out of that
 * for free, because an imported note is not a second-class citizen
 * riding a sidecar — it IS a note.
 */

import {
  base64ToBytes,
  parseExcalidrawFile,
  parsePadifyFile,
  parsePadifyWorkspaceFile,
  prepareImportedNote,
  type PadifyWorkspaceParseResult,
} from './padify-file';
import { deriveTabTitle } from './editor/note-content';
import type { NoteType } from './editor/note-types';
import { getAttachmentMeta, putAttachment } from './storage/attachments';
import { sanitizeNoteHtml, type TabManager } from './tabs';
import { showToast } from './ui/toast';

/** The hidden picker's class — also the e2e hook (input.padify-open-input). */
const OPEN_INPUT_CLASS = 'padify-open-input';

/** Chromium's File Handling API surface — launchQueue is not in the DOM
 * lib; a structural type is the honest feature-detect. */
interface LaunchQueueLike {
  setConsumer(consumer: (launchParams: { files?: { getFile(): Promise<File> }[] }) => void): void;
}

/** What the shell gets back: the menu row's click handler. */
export interface PadifyFileOpen {
  openNoteFilePicker(): void;
}

/**
 * Wires every import path. One call from app.ts, after the TabManager
 * exists; returns the picker trigger for the download menu's Open row.
 */
export function initPadifyFileOpen(tabManager: TabManager): PadifyFileOpen {
  const input = document.createElement('input');
  input.type = 'file';
  // Both of the app's file dialects: its own .padify and the canvas's
  // native .excalidraw (a drawing picked up from excalidraw.com opens
  // as a drawing note — the bridge's inbound side).
  input.accept = '.padify,.excalidraw';
  input.className = OPEN_INPUT_CLASS;
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // Reset immediately: without this, re-picking the SAME file never
    // fires change again (the value never changed).
    input.value = '';
    if (file) {
      void importNoteFile(file, tabManager);
    }
  });

  // The installed PWA's OS door: "Open with Padify" on a .padify file
  // launches (or focuses) the app and hands the file over. Absent in
  // plain browsers and non-Chromium — the check is the whole story.
  const launchQueue = (window as { launchQueue?: LaunchQueueLike }).launchQueue;
  launchQueue?.setConsumer((launchParams) => {
    const handle = launchParams.files?.[0];
    if (handle) {
      void handle
        .getFile()
        .then((file) => importNoteFile(file, tabManager))
        .catch(() => {
          /* the OS handed us a handle it could not open — nothing to
           * import, nothing to say; the app is simply already open. */
        });
    }
  });

  return {
    openNoteFilePicker(): void {
      input.click();
    },
  };
}

/** Reads one picked/launched file and mints its note, with the honest
 * toast for every way a file can fail to be one. */
async function importNoteFile(file: File, tabManager: TabManager): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    showToast(`Couldn't read "${file.name}".`);
    return;
  }

  const padify = parsePadifyFile(text);
  if (padify !== null && padify.kind === 'newer-format') {
    showToast('This file is from a newer Padify — update the app to open it.');
    return;
  }
  if (padify !== null) {
    const prepared = prepareImportedNote(padify.note, sanitizeNoteHtml);
    await hydrateImportedAttachments(padify.attachments);
    openImportedNote(
      tabManager,
      prepared.name,
      prepared.noteType,
      prepared.content,
      padify.note.colorTheme,
    );
    return;
  }

  // The workspace dialect: a whole pad — every note mints fresh, the
  // count said honestly (the single-note refusal check above already
  // answered for the padify-note type; this is its sibling's).
  const workspace = parsePadifyWorkspaceFile(text);
  if (workspace !== null && workspace.kind === 'newer-format') {
    showToast('This file is from a newer Padify — update the app to open it.');
    return;
  }
  if (workspace !== null) {
    await importWorkspaceFile(workspace, tabManager);
    return;
  }

  const excalidraw = parseExcalidrawFile(text, Date.now());
  if (excalidraw !== null) {
    // The file's own name is the note's name — "sketch.excalidraw"
    // opens as a drawing note called "sketch". Embedded images (the
    // vendor's files map, decoded by the bridge) re-hydrate into the
    // store under their ORIGINAL fileIds first, so the canvas resolves
    // them on the very first paint.
    const stem = file.name.replace(/\.(padify|excalidraw)$/i, '').trim();
    await hydrateImportedAttachments(excalidraw.attachments);
    openImportedNote(tabManager, stem !== '' ? stem : null, 'drawing', excalidraw.content);
    return;
  }

  showToast(`"${file.name}" is not a Padify or Excalidraw file.`);
}

/** The shared landing: append, open, confirm — the duplicate gesture's
 * choreography (duplicateNote), minus the "Copy of" naming. The ink
 * theme rides when the envelope carried one (the additive v1 field —
 * a rich note's colors survive the round trip). */
function openImportedNote(
  tabManager: TabManager,
  name: string | null,
  noteType: NoteType,
  content: string,
  colorTheme?: 'light' | 'dark',
): void {
  const created = tabManager.addBackgroundNote(name, noteType, content, colorTheme);
  if (!created) {
    showToast("Couldn't create the note — the pad is full.");
    return;
  }
  tabManager.switchTo(created.id);
  showToast(`Opened "${deriveTabTitle(created)}".`);
}

/**
 * The workspace import — the brainstorm's v1 contract: add the file's
 * notes (mint fresh, never merge), say so honestly in a toast with a
 * count, and touch nothing else on this device. The manifest's theme
 * rides in the file but is deliberately NOT applied — applying it would
 * be replace-the-pad's little brother, and replace is out of v1.
 */
async function importWorkspaceFile(
  workspace: Extract<PadifyWorkspaceParseResult, { kind: 'workspace' }>,
  tabManager: TabManager,
): Promise<void> {
  if (workspace.notes.length === 0) {
    showToast('This pad has no notes.');
    return;
  }
  // The pool first, under ORIGINAL ids — every note's references then
  // resolve on first paint, exactly like the single-note import.
  await hydrateImportedAttachments(workspace.attachments);
  let added = 0;
  let firstId: string | null = null;
  for (const entry of workspace.notes) {
    const prepared = prepareImportedNote(entry, sanitizeNoteHtml);
    const minted = tabManager.addBackgroundNote(
      prepared.name,
      prepared.noteType,
      prepared.content,
      entry.colorTheme,
    );
    if (minted !== null) {
      added++;
      if (firstId === null) {
        firstId = minted.id;
      }
    }
  }
  if (added === 0 || firstId === null) {
    showToast("Couldn't add notes — the pad is full.");
    return;
  }
  // The open lands on the FIRST of the batch — every file-open gesture
  // in the app shows what arrived (the single-note import opens its
  // note; the duplicate opens its copy), and the toast carries the
  // count so a 12-note import never reads as one.
  tabManager.switchTo(firstId);
  if (added < workspace.notes.length) {
    showToast(`Added ${added} of ${workspace.notes.length} notes — the pad is full.`);
  } else {
    showToast(`Added ${added} ${added === 1 ? 'note' : 'notes'}.`);
  }
}

/**
 * The envelope's embedded images → the local attachment store, under
 * their ORIGINAL ids — the imported note's references then resolve
 * without rewriting a byte of content. Files this device already holds
 * (a re-import, or a round trip through a friend) keep their bytes: the
 * store write is skipped, nothing is duplicated.
 *
 * Hydrated records carry uploaded=0, so the cloud flush pushes them up
 * after the next sync cycle — the server answers the same (id, sha256)
 * idempotently, so a same-account re-import is free and a fresh account
 * simply gets its own copies.
 */
async function hydrateImportedAttachments(
  attachments: Array<{ id: string; name: string; mime: string; bytes: string }>,
): Promise<void> {
  for (const attachment of attachments) {
    const bytes = base64ToBytes(attachment.bytes);
    if (bytes === null) {
      continue; // parseEmbeddedAttachments already validated; belt and braces
    }
    const existing = await getAttachmentMeta(attachment.id);
    if (existing) {
      continue;
    }
    await putAttachment(
      { id: attachment.id, name: attachment.name, mime: attachment.mime, size: bytes.byteLength },
      new Blob([bytes], { type: attachment.mime }),
    );
  }
}
