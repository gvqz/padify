import { $ } from './lib/q';
import { registerLayer } from './ui/behavior/layers';
import {
  saveTextAsFile,
  exportNotesAsPDF,
  exportNotesAsDocx,
  downloadHTML,
  getDatedFileStem,
  getFileName,
  getPdfFileName,
  getDocxFileName,
  getHtmlFileName,
  getMarkdownFileName,
} from './exports';
import {
  getEditorText,
  getActiveNoteContent,
  getActiveNoteExportBody,
  type TabManager,
} from './tabs';
import { exportActiveDrawingImage } from './editor/drawing/surface';
import { drawingSceneHasContent, parseDrawingScene } from './editor/drawing/scene';
import { collectNoteAttachmentIds } from '../shared/att-refs';
import {
  PADIFY_MIME_TYPE,
  buildExcalidrawFile,
  bytesToBase64,
  excalidrawFileName,
  padifyFileName,
  padifyWorkspaceFileName,
  serializePadifyNoteFile,
  serializePadifyWorkspaceFile,
  type PadifyFileAttachment,
  type PadifyNotePayload,
  type PadifyWorkspaceTheme,
} from './padify-file';
import { initPadifyFileOpen } from './padify-file-ui';
import { getAttachmentBytes, getAttachmentMeta } from './storage/attachments';
import { getSetting } from './state/settings';
import { isMarkdownNote, DEFAULT_NOTE_TYPE } from './editor/note-types';
import { deriveTabTitle } from './editor/note-content';
import type { NotepadUI } from './selector';

/**
 * The download menu — every way a note leaves to disk, and the open door
 * that brings files back. The menu is a registered dismissable layer (the
 * registry closes every other menu when it opens — see ui/behavior/
 * layers.ts); the rows say what THIS note can become: the Markdown row
 * exists only under a Markdown note, the image rows only under a drawing
 * with something in it, and the .padify/.excalidraw saves carry the
 * note's attachments in their envelopes (the shared reference grammar
 * names the ids; this side fetches the bytes).
 */
export function initDownloadMenu(notepad: NotepadUI, tabManager: TabManager): void {
  // The download menu is a registered dismissable layer — the registry
  // closes every other menu when it opens (and closes it when another
  // layer opens, or on an outside click / Escape). No stopPropagation:
  // the capture-phase sweep has already run by the time this click
  // toggles, so the click cannot stack menus anymore.
  const downloadLayer = registerLayer({
    elements: [
      notepad.downloadNotes.get(0) as HTMLElement,
      document.getElementById('iconDropdown')!,
    ],
    isOpen: () => $('#iconDropdown').hasClass('show'),
    setOpen: (open) => {
      $('#iconDropdown').toggleClass('show', open);
    },
  });

  notepad.downloadNotes.click(function () {
    downloadLayer.toggle();
    // The drawing rows answer "is there anything to save as an image" —
    // content, not just the active type — so they sync as the menu opens,
    // fresh off the live surface (a draw since the last active-note
    // change must be seen without waiting for any save debounce).
    syncDrawingExportRows();
  });

  notepad.downloadNotesPlain.click(function () {
    saveTextAsFile(getEditorText(), getFileName());
  });

  notepad.downloadNotesPdf.click(function () {
    exportNotesAsPDF(getEditorText(), getPdfFileName());
  });

  notepad.downloadNotesDocx.click(function () {
    const textToWrite = getEditorText();
    const fileNameToSaveAs = getDocxFileName();

    exportNotesAsDocx(textToWrite, fileNameToSaveAs);
  });

  notepad.downloadNotesHtml.click(function () {
    // HTML export carries the note, not the editor surface: for a non-html
    // note that surface is a read-only card, and the export must read the
    // model instead (see getActiveNoteExportBody).
    const body = getActiveNoteExportBody();
    if (body !== null) {
      downloadHTML(body, getHtmlFileName());
    }
  });

  // The Markdown export ships the SOURCE — the .md a user would hand to
  // any other tool — captured live through the active note's surface.
  notepad.downloadNotesMarkdown.click(function () {
    const captured = getActiveNoteContent();
    if (captured && captured.noteType === 'markdown') {
      saveTextAsFile(captured.content, getMarkdownFileName(), 'text/markdown');
    }
  });

  // The Markdown row exists only while a Markdown note is active — the
  // download menu says what THIS note can become, like the toolbar chrome.
  const syncMarkdownExportRow = (): void => {
    if (isMarkdownNote(tabManager.getActive())) {
      notepad.downloadNotesMarkdown.removeAttr('hidden');
    } else {
      notepad.downloadNotesMarkdown.attr('hidden', 'hidden');
    }
  };
  tabManager.addActiveListener(syncMarkdownExportRow);
  syncMarkdownExportRow();

  // The drawing rows follow the same rule — a drawing with something in
  // it can become a PNG or an SVG (the plan's canvas-phase export seam;
  // the empty canvas has nothing to save as an image, same rule as the
  // share modal's emptiness gate).
  notepad.downloadNotesPng.click(function () {
    void exportActiveDrawingImage('png');
  });
  notepad.downloadNotesSvg.click(function () {
    void exportActiveDrawingImage('svg');
  });
  const syncDrawingExportRows = (): void => {
    const captured = getActiveNoteContent();
    const exportable = captured?.noteType === 'drawing' && drawingSceneHasContent(captured.content);
    if (exportable) {
      notepad.downloadNotesPng.removeAttr('hidden');
      notepad.downloadNotesSvg.removeAttr('hidden');
      notepad.downloadNotesExcalidraw.removeAttr('hidden');
    } else {
      notepad.downloadNotesPng.attr('hidden', 'hidden');
      notepad.downloadNotesSvg.attr('hidden', 'hidden');
      notepad.downloadNotesExcalidraw.attr('hidden', 'hidden');
    }
  };
  tabManager.addActiveListener(syncDrawingExportRows);
  syncDrawingExportRows();

  // ---- the .padify file — the note as a file ------------------------
  // The app's own save: the whole note (type, name, content, stamps) in
  // one strict envelope that opens back as the same kind of note. The
  // file is named what the rail calls the note; an untitled note falls
  // back to the download family's dated stem.
  const padifyOpen = initPadifyFileOpen(tabManager);
  // The export image pass, shared by every Padify/Excalidraw save: the
  // UNION of the attachment ids the given notes reference — a markdown
  // note's `padify-att:` refs, a drawing's scene fileIds — each fetched
  // from this device's store once (the id union dedupes, so two notes
  // sharing an image ride at one copy, the store's own discipline). A
  // blob that is not on this device (deleted, another device offline)
  // exports as the bare reference — the importing device renders the
  // missing placeholder, the same honesty the preview shows. Plain
  // notes are text-only and carry no attachments, so they contribute
  // nothing — an empty pool is the whole pass for a plain pad.
  const collectReferencedAttachments = async (
    notes: ReadonlyArray<{ noteType?: string | null; content: string }>,
  ): Promise<PadifyFileAttachment[]> => {
    const referencedIds = new Set<string>();
    for (const note of notes) {
      for (const id of collectNoteAttachmentIds(note)) {
        referencedIds.add(id);
      }
    }
    const attachments: PadifyFileAttachment[] = [];
    for (const id of referencedIds) {
      // The meta rides along (the store's own name/mime — an exported
      // webp says webp); a missing meta falls back to the generic
      // octet-stream, which the importer still hydrates and renders.
      const [bytes, meta] = await Promise.all([getAttachmentBytes(id), getAttachmentMeta(id)]);
      if (bytes) {
        attachments.push({
          id,
          name: meta?.name || `${id}.img`,
          mime: meta?.mime || 'application/octet-stream',
          bytes: bytesToBase64(bytes),
        });
      }
    }
    return attachments;
  };
  notepad.downloadNotesPadify.click(function () {
    void (async function () {
      const active = tabManager.getActive();
      const captured = getActiveNoteContent();
      if (!active || !captured) {
        return;
      }
      const attachments = await collectReferencedAttachments([captured]);
      // The LIVE title: the model's content lags typing by the save
      // debounce, and the file is named for the note as it stands — the
      // share modal's live-title lesson, applied to the file family.
      const title = deriveTabTitle({ ...active, content: captured.content });
      saveTextAsFile(
        serializePadifyNoteFile(
          {
            name: active.name,
            noteType: captured.noteType ?? DEFAULT_NOTE_TYPE,
            content: captured.content,
            createdAt: active.createdAt,
            updatedAt: active.updatedAt,
          },
          Date.now(),
          attachments,
        ),
        padifyFileName(title === 'Untitled' ? null : title, getDatedFileStem()),
        PADIFY_MIME_TYPE,
      );
    })();
  });

  // ---- the .padify workspace — the whole pad as one file ------------
  // The pad-level save: every note in rail order, the pad's theming, one
  // shared attachments pool (see padify-file.ts's workspace section). A
  // pad always holds at least one note (the model's never-empty
  // invariant), so the row is always meaningful — no visibility sync.
  notepad.downloadNotesPadifyWorkspace.click(function () {
    void (async function () {
      // The duplicate gesture's discipline: flush the active note's live
      // edits into the model FIRST, so the file carries what the surfaces
      // show and every note reads from one honest snapshot.
      tabManager.saveActiveFromEditor();
      const tabs = tabManager.getTabs();
      const notes: PadifyNotePayload[] = tabs.map((tab) => {
        const note: PadifyNotePayload = {
          name: tab.name,
          noteType: tab.noteType ?? DEFAULT_NOTE_TYPE,
          content: tab.content,
          createdAt: tab.createdAt,
          updatedAt: tab.updatedAt,
        };
        if (tab.colorTheme !== undefined) {
          note.colorTheme = tab.colorTheme;
        }
        return note;
      });
      const attachments = await collectReferencedAttachments(tabs);
      // The manifest's theming is the pad's own persisted choice — a
      // device that never picked one exports no theme field at all.
      const mode = getSetting('mode');
      const theme: PadifyWorkspaceTheme | null =
        mode !== null
          ? { mode, userPreferred: getSetting('isUserPreferredTheme') !== null }
          : null;
      saveTextAsFile(
        serializePadifyWorkspaceFile({ notes, theme, attachments }, Date.now()),
        padifyWorkspaceFileName(getDatedFileStem()),
        PADIFY_MIME_TYPE,
      );
    })();
  });

  // The canvas's interop door: a drawing note out as a native
  // .excalidraw file — excalidraw.com opens it as-is, the scene's image
  // bytes riding the vendor's files map. Rides the same visibility rule
  // as the PNG/SVG rows (something to save).
  notepad.downloadNotesExcalidraw.click(function () {
    void (async function () {
      const active = tabManager.getActive();
      const captured = getActiveNoteContent();
      if (!active || captured?.noteType !== 'drawing') {
        return;
      }
      const scene = parseDrawingScene(captured.content);
      if (scene === null || scene.elements.length === 0) {
        return;
      }
      // The image pass rides the same collector as the .padify save —
      // the drawing branch, keyed on the same captured note.
      const attachments = await collectReferencedAttachments([captured]);
      // Live title, same as the Padify save (the model lags the canvas's
      // announce debounce).
      saveTextAsFile(
        buildExcalidrawFile(scene, attachments),
        excalidrawFileName(
          deriveTabTitle({ ...active, content: captured.content }),
          getDatedFileStem(),
        ),
        'application/json',
      );
    })();
  });

  // The open door: .padify (any note kind) and .excalidraw (a drawing
  // waiting to happen) come back in as notes — see padify-file-ui.ts.
  notepad.openNoteFile.click(function () {
    padifyOpen.openNoteFilePicker();
  });
}
