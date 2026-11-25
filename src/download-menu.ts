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
import { drawingImageExportTypes, snapshotDrawingContent } from './editor/drawing/surface';
import { drawingSceneHasContent, parseDrawingScene } from './editor/drawing/scene';
import { collectNoteAttachmentIds } from '../shared/att-refs';
import {
  PADIFY_MIME_TYPE,
  buildExcalidrawFile,
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
 * The export center's wiring — every way a note leaves to disk, behind the
 * ONE door.
 *
 * The old download dropdown answered "what can THIS note become" with nine
 * rows (six always on, three note-conditional), each firing a fixed-default
 * exporter with no preview and no name control. The owner consolidated:
 * the download button now opens the export center (ui/export-center.ts —
 * preview left, settings right, file name and file type editable in one
 * place), and this module builds the type list for the ACTIVE note:
 *
 *   drawing          → PNG, SVG (the vendor's native options ride along),
 *                      .excalidraw, .padify
 *   markdown         → .md, .txt, PDF, DOCX, HTML, .padify
 *   everything else  → .txt, PDF, DOCX, HTML, .padify
 *   every note       → the whole pad as one .padify workspace file
 *
 * The canvas's own Export image row (canvas.ts) lands here too, over the
 * `padify:open-export` bus — the same door, one dialog fewer to learn.
 * The open door (a .padify/.excalidraw file back IN) rides the center's
 * footer, so even the round trip answers from the one popup.
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
   * pad out as one workspace file, a drawing out as native .excalidraw. */
  const envelopeTypes = (): ExportCenterType[] => {
    const captured = getActiveNoteContent();
    const active = tabManager.getActive();
    const isDrawing = captured?.noteType === 'drawing';

    const padifyType: ExportCenterType = {
      id: 'padify',
      label: 'Padify file',
      extension: 'padify',
      defaultStem: stemForActive(),
      section: 'pad',
      hint: 'The note as a file — opens back as the same kind of note',
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
      hint: 'Every note, the theming, one attachments pool — one file',
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

    const excalidrawType: ExportCenterType | null =
      isDrawing && captured
        ? {
            id: 'excalidraw',
            label: 'Excalidraw file',
            extension: 'excalidraw',
            defaultStem: stemForActive(),
            hint: 'Native .excalidraw — excalidraw.com opens it as-is',
            preview: async () => {
              const scene = parseDrawingScene(captured.content);
              const elements = scene?.elements.filter((e) => e.isDeleted !== true).length ?? 0;
              const thumb = await snapshotDrawingContent(captured.content, active?.id ?? null);
              return {
                image: thumb ?? undefined,
                note:
                  elements > 0
                    ? `The scene, as Excalidraw will re-open it (${elements} element${elements === 1 ? '' : 's'}).`
                    : 'Nothing to export yet — draw something first.',
              };
            },
            run: async (fileName) => {
              const activeNow = tabManager.getActive();
              const capturedNow = getActiveNoteContent();
              if (!activeNow || capturedNow?.noteType !== 'drawing') return false;
              const scene = parseDrawingScene(capturedNow.content);
              if (scene === null || scene.elements.length === 0) return false;
              const attachments = await collectReferencedAttachments([capturedNow]);
              saveTextAsFile(buildExcalidrawFile(scene, attachments), fileName, 'application/json');
              return true;
            },
          }
        : null;

    return [...(excalidrawType ? [excalidrawType] : []), padifyType, workspaceType];
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
      ? // The image types first — the drawing's headline exports — then the
        // envelopes. An empty canvas still opens the center: the stage says
        // what an export would need (the honest-gate wording), and the
        // envelope types stay fully alive.
        [...drawingImageExportTypes(stemForActive()), ...envelopeTypes()]
      : [...textTypes(), ...envelopeTypes()];

    const host: ExportCenterHost = {
      heading: 'Export',
      subheading:
        title === 'Untitled'
          ? 'Choose a file type and name — the file downloads to your device.'
          : `${title} — choose a file type and name; the file downloads to your device.`,
      types,
      initialTypeId:
        initialTypeId ??
        (isDrawing && drawingSceneHasContent(captured?.content ?? '') ? 'png' : types[0]?.id),
      door: {
        label: 'Open a Padify or Excalidraw file…',
        onOpen: () => padifyOpen.openNoteFilePicker(),
      },
    };
    openExportCenter(host);
  };

  // The one door: the download button opens the center (the old dropdown
  // layer is gone — no menu to toggle, one dialog to learn).
  notepad.downloadNotes.on('click', () => {
    openCenter();
  });

  // The canvas menu's Export image row rides the bus (canvas.ts dispatches
  // it; document, not window — the app's bridge lives there, the same bus
  // padify:open-shortcuts rides). The center presets to the drawing's PNG
  // type, the row's promise on the site; the app's export chord (app-
  // shortcuts.ts) dispatches the same bus with no preset — the active
  // note's first type answers.
  document.addEventListener('padify:open-export', (event) => {
    const detail = (event as CustomEvent<{ initialTypeId?: string }>).detail;
    openCenter(detail?.initialTypeId);
  });
}
