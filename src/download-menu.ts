import {
  saveTextAsFile,
  exportNotesAsPDF,
  exportNotesAsDocx,
  downloadHTML,
  getDatedFileStem,
} from './exports';
import {
  getEditorText,
  getActiveNoteContent,
  getActiveNoteExportBody,
  type TabManager,
} from './tabs';
import { openDrawingImageExportDialog } from './editor/drawing/surface';
import { collectNoteAttachmentIds } from '../shared/att-refs';
import {
  PADIFY_MIME_TYPE,
  bytesToBase64,
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
import { openExportCenter, type ExportCenterHost, type ExportCenterType } from './ui/export-center';
import type { NotepadUI } from './selector';

/**
 * The export center's wiring — the file-type exports' one door.
 *
 * THE DRAWINGPAD'S EXPORT IS THE VENDOR'S OWN (the owner's verdict on the
 * unified popup: "it looks horrible … need 100% of features and done in
 * the exact same way"): on a live drawing, the download button opens the
 * vendor's own ImageExportDialog — the exact face excalidraw.com opens —
 * with every built-in feature (only-selected, background, dark mode,
 * embed scene, the 1×/2×/3× scale, the live preview, the PNG/SVG/
 * clipboard presses), and the canvas's own doors answer the same way (its
 * "Export image…" menu row, its Ctrl+Shift+E chord, and now the vendor's
 * own Export row — the jsonExport dialog that saves the scene as
 * .excalidraw). No re-implemented option rows, no second face.
 *
 * THE CENTER'S REMAINING CONTRACT: every note that is NOT a live drawing
 * answers here — the text family (txt/md/pdf/docx/html), the .padify
 * envelopes and the whole-pad save; a drawing whose canvas cannot
 * answer (the error card, the load card) falls back to its envelope rows
 * until the canvas is live again. The open door (a .padify/.excalidraw
 * file back IN) keeps riding the footer.
 */
export function initDownloadMenu(notepad: NotepadUI, tabManager: TabManager): void {
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

  /** The file stem every type starts from: the note as the rail calls it
   * (the share modal's live-title lesson), sanitized, with the download
   * family's dated stem answering for an untitled note. */
  const stemForActive = (): string => {
    const active = tabManager.getActive();
    const captured = getActiveNoteContent();
    const title = active
      ? deriveTabTitle({
          ...active,
          content: captured?.content ?? active.content,
        })
      : 'Untitled';
    const cleaned = title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned === '' || cleaned === 'Untitled' ? getDatedFileStem() : cleaned;
  };

  /** The text the plain-text family exports — the editor surface's live
   * text (the model lags the save debounce). */
  const activeText = (): string => getEditorText();

  /** The text delegates — plain text, Markdown source, PDF, DOCX, HTML.
   * The preview shows what will ship (the markdown ships its SOURCE, the
   * HTML ships the sanitized body rendered as it will read); the run is
   * the same exporter the dropdown rows always called, now with the
   * user's name. */
  const textTypes = (): ExportCenterType[] => {
    const markdown = isMarkdownNote(tabManager.getActive());
    const body = (): string | null => getActiveNoteExportBody();
    const mdType: ExportCenterType = {
      id: 'md',
      label: 'Markdown',
      extension: 'md',
      defaultStem: stemForActive(),
      hint: 'The source, for any other Markdown tool',
      preview: async () => {
        const captured = getActiveNoteContent();
        return {
          text: captured?.noteType === 'markdown' ? captured.content : '',
          note: 'The .md source ships verbatim.',
        };
      },
      run: async (fileName) => {
        const captured = getActiveNoteContent();
        if (captured?.noteType !== 'markdown') return false;
        saveTextAsFile(captured.content, fileName, 'text/markdown');
        return true;
      },
    };
    const txtType: ExportCenterType = {
      id: 'txt',
      label: 'Plain text',
      extension: 'txt',
      defaultStem: stemForActive(),
      hint: 'The words, nothing else',
      preview: async () => ({ text: activeText() }),
      run: async (fileName) => {
        saveTextAsFile(activeText(), fileName);
        return true;
      },
    };
    const pdfType: ExportCenterType = {
      id: 'pdf',
      label: 'PDF',
      extension: 'pdf',
      defaultStem: stemForActive(),
      hint: 'A text document, paginated',
      preview: async () => ({ text: activeText(), note: 'Paginated text layout (A4).' }),
      run: async (fileName) => {
        exportNotesAsPDF(activeText(), fileName);
        return true;
      },
    };
    const docxType: ExportCenterType = {
      id: 'docx',
      label: 'DOCX',
      extension: 'docx',
      defaultStem: stemForActive(),
      hint: 'A Word document, one paragraph per line',
      preview: async () => ({ text: activeText(), note: 'One paragraph per line, Word-shaped.' }),
      run: async (fileName) => {
        exportNotesAsDocx(activeText(), fileName);
        return true;
      },
    };
    const htmlType: ExportCenterType = {
      id: 'html',
      label: 'HTML',
      extension: 'html',
      defaultStem: stemForActive(),
      hint: 'A standalone page that opens anywhere',
      preview: async () => {
        const content = body();
        return content !== null
          ? { html: content, note: 'The sanitized body, as the page renders it.' }
          : { note: 'Nothing to export yet.' };
      },
      run: async (fileName) => {
        const content = body();
        if (content === null) return false;
        downloadHTML(content, fileName);
        return true;
      },
    };
    return markdown
      ? [mdType, txtType, pdfType, docxType, htmlType]
      : [txtType, pdfType, docxType, htmlType];
  };

  /** The envelope delegates — the note out as a .padify file, the whole
   * pad out as one workspace file. (A drawing's .excalidraw save is the
   * vendor's own door now — the canvas menu's "Save to…" row, the native
   * jsonExport dialog — so no center row duplicates it.) */
  const envelopeTypes = (): ExportCenterType[] => {
    const captured = getActiveNoteContent();

    const padifyType: ExportCenterType = {
      id: 'padify',
      label: 'Padify file',
      extension: 'padify',
      defaultStem: stemForActive(),
      hint: 'Opens back as the same kind of note',
      preview: async () => {
        // The id count answers without fetching any bytes — the run does
        // the real attachment pass at export time.
        const ids = new Set(captured ? collectNoteAttachmentIds(captured) : []);
        return {
          card: {
            title: `${stemForActive()}.padify`,
            meta: [
              `Type: ${captured?.noteType ?? DEFAULT_NOTE_TYPE}`,
              ids.size > 0
                ? `${ids.size} attachment${ids.size === 1 ? '' : 's'} embedded`
                : 'No attachments to embed',
            ],
          },
        };
      },
      run: async (fileName) => {
        const activeNow = tabManager.getActive();
        const capturedNow = getActiveNoteContent();
        if (!activeNow || !capturedNow) return false;
        const attachments = await collectReferencedAttachments([capturedNow]);
        saveTextAsFile(
          serializePadifyNoteFile(
            {
              name: activeNow.name,
              noteType: capturedNow.noteType ?? DEFAULT_NOTE_TYPE,
              content: capturedNow.content,
              createdAt: activeNow.createdAt,
              updatedAt: activeNow.updatedAt,
            },
            Date.now(),
            attachments,
          ),
          fileName,
          PADIFY_MIME_TYPE,
        );
        return true;
      },
    };

    const workspaceType: ExportCenterType = {
      id: 'workspace',
      label: 'Whole pad',
      extension: 'padify',
      defaultStem: getDatedFileStem(),
      section: 'pad',
      hint: 'Every note in one file',
      preview: async () => {
        tabManager.saveActiveFromEditor();
        const tabs = tabManager.getTabs();
        return {
          card: {
            title: `${getDatedFileStem()}.padify`,
            meta: [`${tabs.length} note${tabs.length === 1 ? '' : 's'} in rail order`],
          },
        };
      },
      run: async (fileName) => {
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
          fileName,
          PADIFY_MIME_TYPE,
        );
        return true;
      },
    };

    return [padifyType, workspaceType];
  };

  /** The host for the ACTIVE note — the type list says what it can become. */
  const openCenter = (initialTypeId?: string): void => {
    const active = tabManager.getActive();
    const captured = getActiveNoteContent();
    const title = active
      ? deriveTabTitle({ ...active, content: captured?.content ?? active.content })
      : 'Untitled';
    const isDrawing = captured?.noteType === 'drawing';

    const types: ExportCenterType[] = isDrawing
      ? // The fallback face (the native dialog owns the image exports on
        // a live canvas): the drawing's Padify envelopes alone. An empty
        // canvas or an error card still opens the center — the envelopes
        // serialize from the note's saved bytes and keep working.
        [...envelopeTypes()]
      : [...textTypes(), ...envelopeTypes()];

    const host: ExportCenterHost = {
      heading: 'Export',
      subheading:
        title === 'Untitled'
          ? 'Choose a file type and name — the file downloads to your device.'
          : `${title} — choose a file type and name; the file downloads to your device.`,
      types,
      initialTypeId: initialTypeId ?? undefined,
      door: {
        label: 'Open a Padify or Excalidraw file…',
        onOpen: () => padifyOpen.openNoteFilePicker(),
      },
    };
    openExportCenter(host);
  };

  // The one door: on a LIVE drawing the download button answers the
  // VENDOR's own image-export dialog (openDrawingImageExportDialog — the
  // owner's verdict: 100% of the built-in features, the exact built-in
  // way); every other note — and a drawing whose canvas cannot answer —
  // opens the center.
  notepad.downloadNotes.on('click', () => {
    if (openDrawingImageExportDialog()) {
      return;
    }
    openCenter();
  });

  // The app's export chord rides the bus (app-shortcuts.ts dispatches it
  // when NO drawing canvas is live — on a live drawing the vendor's own
  // Ctrl+Shift+E opens the vendor's own dialog, native parity); document,
  // not window — the app's bridge lives there, the same bus
  // padify:open-shortcuts rides. No preset: the active note's first
  // selectable type answers.
  document.addEventListener('padify:open-export', (event) => {
    const detail = (event as CustomEvent<{ initialTypeId?: string }>).detail;
    openCenter(detail?.initialTypeId);
  });
}
