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
import { getDrawingExportSession, type DrawingExportSession } from './editor/drawing/surface';
import { showToast } from './ui/toast';
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
import {
  openExportCenter,
  type ExportCenterHost,
  type ExportCenterType,
  type ExportOption,
} from './ui/export-center';
import type { NotepadUI } from './selector';

/**
 * The export center's wiring — the ONE export dialog, every door.
 *
 * THE OWNER'S FOURTH VERDICT: "1 unified ui for all note/note types" —
 * the download button, the export chord, and the canvas's own two menu
 * rows all open the one dialog now. The drawingpad's rows inside it
 * keep the standing verdict whole ("100% of the built-in features,
 * done in the exact built-in way"): every row is the vendor dialogs'
 * own engine, delegated through the surface's session seam —
 * only-selected (the built-in selection/frame resolution), background,
 * dark mode, embed scene (the .excalidraw.png/.excalidraw.svg double
 * extension), the 1×/2×/3× scale, the live canvas preview (the native
 * preview's own exportScene call), the PNG/SVG presses
 * (App.onExportImage's own exportCanvas), the clipboard copy with the
 * built-in visibility rule and error classes, and the .excalidraw
 * scene save (the JSON dialog's own saveAsJSON).
 *
 * THE CENTER'S REMAINING CONTRACT: every note that is NOT a live
 * drawing answers here too — the text family (txt/md/pdf/docx/html),
 * the .padify envelopes and the whole-pad save. A drawing whose canvas
 * cannot answer (the error card, the load card) falls back to its
 * envelope rows until the canvas is live again. The open door (a
 * .padify/.excalidraw file back IN) keeps riding the footer.
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

  /** The file stem every format starts from: the note as the rail calls it
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

  /** One honest failure line — the native dialogs' own words where they
   * have them (the empty canvas, the clipboard), the error's own message
   * where they do not. */
  const exportFailureText = (error: unknown): string => {
    if (error instanceof Error && error.message) return error.message;
    return 'The export could not finish.';
  };

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
      hint: 'The .md source, verbatim — download or copy to the clipboard',
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
      copy: async () => {
        const captured = getActiveNoteContent();
        if (captured?.noteType !== 'markdown') return false;
        try {
          await navigator.clipboard.writeText(captured.content);
          return true;
        } catch {
          showToast('Fail to copy. Check permissions for clipboard.', 'error');
          return false;
        }
      },
    };
    const txtType: ExportCenterType = {
      id: 'txt',
      label: 'Plain text',
      extension: 'txt',
      defaultStem: stemForActive(),
      hint: 'The words, nothing else — download or copy to the clipboard',
      preview: async () => ({ text: activeText() }),
      run: async (fileName) => {
        saveTextAsFile(activeText(), fileName);
        return true;
      },
      // The clipboard press, the app's own copy discipline — the same
      // Alt+C pipe (its toast speaks both ways; the press flashes only on
      // the real copy).
      copy: async () => {
        try {
          await navigator.clipboard.writeText(activeText());
          return true;
        } catch {
          showToast('Fail to copy. Check permissions for clipboard.', 'error');
          return false;
        }
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

  // ---------------------------------------------------------------------------
  // The drawing's rows — the built-in feature set on the built-in pipeline
  // ---------------------------------------------------------------------------

  /**
   * The drawing's export rows: the two image formats + the .excalidraw
   * scene save, all on the vendor dialogs' own engine (the session
   * seam). One option set shared by PNG and SVG (the native dialog's
   * own discipline — the switches do not reset between formats), every
   * flip writing the native dialog's own appState keys through the
   * seam (the switch actions' write-through, dark mode included via the
   * session override), the selection row gated by the snapshot's own
   * selection and defaulted to it (the native default).
   */
  const drawingImageTypes = (session: DrawingExportSession): ExportCenterType[] => {
    const appState = session.appState;

    // The option model — the native dialog's own control set. The
    // only-selected row is gated by the snapshot's selection (the native
    // dialog's own {hasSelection && …} mount rule: no selection at open,
    // no row — and its default IS the selection when one rides).
    const onlySelected: ExportOption = {
      kind: 'toggle',
      id: 'selection',
      label: 'Only selected',
      hint: 'Export the selected elements alone',
      value: session.hasSelection,
    };
    const background: ExportOption = {
      kind: 'toggle',
      id: 'background',
      label: 'Background',
      hint: 'Transparent when off',
      value: appState.exportBackground !== false,
      onFlip: (value) => session.setPrefs({ background: value }),
    };
    const dark: ExportOption = {
      kind: 'toggle',
      id: 'dark',
      label: 'Dark mode',
      hint: 'Render in the dark palette',
      value: appState.exportWithDarkMode === true,
      onFlip: (value) => session.setPrefs({ dark: value }),
    };
    const embed: ExportOption = {
      kind: 'toggle',
      id: 'embed',
      label: 'Embed scene',
      hint: 'The file re-opens as an editable drawing',
      // The vendor's own tooltip words — the native dialog's help.
      tooltip:
        'Scene data will be saved into the exported PNG/SVG file so that the scene can be restored from it.\nWill increase exported file size.',
      value: appState.exportEmbedScene === true,
      onFlip: (value) => session.setPrefs({ embedScene: value }),
    };
    const scale: ExportOption = {
      kind: 'segment',
      id: 'scale',
      label: 'Scale',
      values: [
        { id: '1', label: '1×' },
        { id: '2', label: '2×' },
        { id: '3', label: '3×' },
      ],
      value: String(
        appState.exportScale === 2 || appState.exportScale === 3 ? appState.exportScale : 1,
      ),
      onPick: (value) => session.setPrefs({ scale: Number(value) as 1 | 2 | 3 }),
    };
    const options: ExportOption[] = [
      ...(session.hasSelection ? [onlySelected] : []),
      background,
      dark,
      embed,
      scale,
    ];

    /** The built-in selection/frame resolution for the live values. */
    const resolve = (values: Record<string, boolean | string>) =>
      session.resolveElements(values.selection === true);

    /** The stem the run hands the pipeline (fileSave appends its own
     * extension — the built-in way the file name is built). */
    const stemOf = (fileName: string, extension: string): string =>
      fileName.toLowerCase().endsWith(`.${extension}`)
        ? fileName.slice(0, -(extension.length + 1))
        : fileName;

    const stem = stemForActive();

    /** The native preview's own render on the live values — the actual
     * canvas element, the stage's box as the native's
     * maxWidthOrHeight, the honest notes where there is nothing to
     * show. */
    const imagePreview = async (
      values: Record<string, boolean | string>,
      stage: { width: number; height: number },
    ) => {
      const { elements, exportingFrame } = resolve(values);
      if (elements.length === 0) {
        return { note: 'The scene is empty — nothing to export yet.' };
      }
      const canvas = await session.renderPreview({
        elements,
        exportingFrame,
        background: values.background !== false,
        dark: values.dark === true,
        maxWidthOrHeight: Math.max(stage.width, stage.height),
      });
      return {
        canvas,
        transparent: values.background === false,
      };
    };

    const pngType: ExportCenterType = {
      id: 'png',
      label: 'PNG',
      extension: 'png',
      extensionFor: (values) => (values.embed === true ? 'excalidraw.png' : 'png'),
      defaultStem: stem,
      hint: 'A lossless image of the scene — download or copy to the clipboard',
      options,
      // The native image dialog's own behavior: an export is not a
      // dismissal — the dialog stands for the next press.
      keepOpen: true,
      preview: imagePreview,
      run: async (fileName, values) => {
        const { elements, exportingFrame } = resolve(values);
        // The built-in empty gate — the vendor's own words.
        if (elements.length === 0) {
          showToast('Cannot export empty canvas.');
          return false;
        }
        const extension = values.embed === true ? 'excalidraw.png' : 'png';
        try {
          await session.exportImage('png', stemOf(fileName, extension), elements, exportingFrame);
          return true;
        } catch (error) {
          showToast(exportFailureText(error));
          return false;
        }
      },
      copy: async (values) => {
        const { elements, exportingFrame } = resolve(values);
        if (elements.length === 0) {
          showToast('Cannot export empty canvas.');
          return false;
        }
        try {
          // The clipboard press's own body — App.onExportImage on the
          // clipboard type; the name is unused on this path.
          await session.exportImage('clipboard', '', elements, exportingFrame);
          return true;
        } catch (error) {
          showToast(exportFailureText(error));
          return false;
        }
      },
      copySupported: () => session.clipboardSupported,
      onNameChange: (nameStem) => session.setPrefs({ name: nameStem }),
    };

    const svgType: ExportCenterType = {
      id: 'svg',
      label: 'SVG',
      extension: 'svg',
      extensionFor: (values) => (values.embed === true ? 'excalidraw.svg' : 'svg'),
      defaultStem: stem,
      hint: 'Vector markup that scales without limits',
      options,
      keepOpen: true,
      preview: imagePreview,
      run: async (fileName, values) => {
        const { elements, exportingFrame } = resolve(values);
        if (elements.length === 0) {
          showToast('Cannot export empty canvas.');
          return false;
        }
        const extension = values.embed === true ? 'excalidraw.svg' : 'svg';
        try {
          await session.exportImage('svg', stemOf(fileName, extension), elements, exportingFrame);
          return true;
        } catch (error) {
          showToast(exportFailureText(error));
          return false;
        }
      },
      onNameChange: (nameStem) => session.setPrefs({ name: nameStem }),
    };

    const sceneType: ExportCenterType = {
      id: 'excalidraw',
      label: 'Excalidraw scene',
      extension: 'excalidraw',
      defaultStem: stem,
      hint: 'The live scene as an .excalidraw file — opens in any Excalidraw',
      preview: async () => ({
        card: {
          title: `${stem}.excalidraw`,
          meta: [
            'The whole scene, images and undo trail included',
            'The JSON dialog\u2019s own save, unchanged',
          ],
        },
      }),
      run: async (fileName) => {
        try {
          await session.exportSceneJSON(stemOf(fileName, 'excalidraw'));
          return true;
        } catch (error) {
          showToast(exportFailureText(error));
          return false;
        }
      },
    };

    return [pngType, svgType, sceneType];
  };

  /** The envelope delegates — the note out as a .padify file, the whole
   * pad out as one workspace file. */
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

    // The drawing's rows: a live canvas answers with the image formats
    // and the scene save (the built-in pipeline); a canvas that cannot
    // answer (the error card, the load card) falls back to its envelope
    // rows — the honest face until the canvas is live again.
    const session = isDrawing ? getDrawingExportSession() : null;
    const types: ExportCenterType[] = session
      ? [...drawingImageTypes(session), ...envelopeTypes()]
      : isDrawing
        ? [...envelopeTypes()]
        : [...textTypes(), ...envelopeTypes()];

    const host: ExportCenterHost = {
      heading: 'Export',
      subheading:
        title === 'Untitled'
          ? 'Choose a format and a name — the file downloads to your device.'
          : `${title} — choose a format and a name; the file downloads to your device.`,
      types,
      initialTypeId: initialTypeId ?? undefined,
      door: {
        label: 'Open a Padify or Excalidraw file…',
        onOpen: () => padifyOpen.openNoteFilePicker(),
      },
    };
    openExportCenter(host);
  };

  // The one door: the download button opens the unified center for every
  // note kind — the drawingpad's image exports ride it on the built-in
  // pipeline (the canvas's own menu rows and the chord land here too,
  // through the padify:open-export bus).
  notepad.downloadNotes.on('click', () => {
    openCenter();
  });

  // The app's export chord rides the bus (app-shortcuts.ts claims
  // Ctrl+Shift+E on EVERY note kind now — one chord, one dialog); the
  // canvas's own menu rows ride it with their initial type (the PNG row
  // and the .excalidraw row). document, not window — the app's bridge
  // lives there, the same bus padify:open-shortcuts rides.
  document.addEventListener('padify:open-export', (event) => {
    const detail = (event as CustomEvent<{ initialTypeId?: string }>).detail;
    openCenter(detail?.initialTypeId);
  });
}
