/**
 * The drawing export dialog — the native options AND the native face,
 * spoken in the app's own modal.
 *
 * WHY THIS EXISTS (the R1 unified export, restored): the download menu's
 * drawing rows used to export with fixed defaults baked in (scale 1,
 * background on, no embed) — options the vendor's own export dialog
 * offers were unreachable from the app side. This dialog is the one
 * surface for the drawing's image exports, and the export center's image
 * rows hand off to it: format (PNG/SVG), background, dark mode, embed
 * scene, scale — the same knobs the vendor's dialog turns, named the way
 * it names them.
 *
 * NATIVE PARITY (the restore's lesson — and the refinement's): the
 * vendor's dialog is not just an option list, it is a FACE — a live
 * preview of exactly what will ship, the file's name, the scene's facts.
 * This dialog speaks all of it:
 *   - the live preview: a rendered thumbnail that honors Background and
 *     Dark mode, refreshed (debounced) as the options flip — surface.ts
 *     hands the renderer in as a delegate, so this module never imports
 *     the vendor island and the dialog markup still loads with the app,
 *     not the 1.3 MB canvas chunk. With Background off the stage wears
 *     a checkerboard, so transparency is SEEN, not guessed.
 *   - the file name: an editable stem with a live suffix chip (`.png`,
 *     `.excalidraw.png` the moment Embed scene turns on — the vendor's
 *     own double extension, visible before the Save, never a surprise
 *     in the Downloads folder).
 *   - the scene's facts: element count and the natural pixel bounds,
 *     re-multiplied as the scale flips ("1,240 × 860 px — 3,720 × 2,580
 *     px at 3×") — the answer to "how big is this file going to be?"
 *   - the keyboard: Enter in the name field Saves, the segmented
 *     switches answer Arrow keys (selection follows focus), Escape is
 *     the dialog's own.
 *
 * The dialog stays pure UI. The exporter (gating, rendering, downloading,
 * copying, toasts) stays in surface.ts (`exportActiveDrawingImage` /
 * `copyActiveDrawingImage`) — it arrives as the `invoker` callback; the
 * preview renderer and the scene facts arrive the same way.
 *
 * THE FACE: a native <dialog> on the design tokens (the confirm/prompt
 * dialog's recipe — src/ui/dialog.css), extended with the preview panel,
 * the name row, and the two controls the options need: a segmented
 * format/scale switch and checkbox rows. Native <dialog> brings the
 * focus trap, Escape and the top layer.
 */

import './export-dialog.css';
import { sanitizeFileStem } from '../../ui/file-name';

/** The chosen format — the vendor's own two image types. */
export type DrawingExportFormat = 'png' | 'svg';

/** The scale options — the vendor's EXPORT_SCALES ([1, 2, 3]), verbatim. */
export type DrawingExportScale = 1 | 2 | 3;

/** One dialog session's answers. */
export interface DrawingExportChoices {
  format: DrawingExportFormat;
  background: boolean;
  dark: boolean;
  embed: boolean;
  scale: DrawingExportScale;
}

/** Where the answers go: a file on disk, or the clipboard. */
export type DrawingExportDestination = 'file' | 'clipboard';

/**
 * The exporter surface.ts hands in — one call per Save press (after the
 * dialog closed; the export may take a beat, and a closed dialog never
 * covers the toasts that answer it) and one per Copy press (the dialog
 * stays open for those, the vendor's own behavior). The Save press
 * names its file — the dialog owns the stem + suffix, sanitized.
 * Answers whether the export actually happened — the copy press
 * flashes "Copied" on a `true`.
 */
export type DrawingExportInvoker = (
  choices: DrawingExportChoices,
  destination: DrawingExportDestination,
  fileName?: string,
) => Promise<boolean>;

/** Renders the preview image honoring the choices (a URL the dialog
 * owns and revokes). surface.ts's seam — the vendor never rides here. */
export type DrawingExportPreviewDelegate = (
  choices: DrawingExportChoices,
) => Promise<string | null>;

/** The scene's honest facts, computed once at open (the modal freezes
 * the canvas): the visible element count and the natural bounds. */
export interface DrawingExportMeta {
  elements: number;
  width?: number;
  height?: number;
}

/** One dialog session's inputs — the exporter, the preview renderer,
 * the scene's facts, the launcher's format preset, the name default. */
export interface DrawingExportDialogSetup {
  invoker: DrawingExportInvoker;
  /** The launcher's ask: the center's PNG/SVG rows press their format
   * before the face shows. */
  presetFormat?: DrawingExportFormat;
  /** The preview renderer; without it the preview panel stays down
   * (jsdom-grade embeds) and the dialog reads as the option list. */
  preview?: DrawingExportPreviewDelegate;
  /** The scene's facts — element count, natural bounds. */
  meta?: DrawingExportMeta;
  /** The prefilled file stem (the note's name, sanitized by the caller). */
  defaultStem?: string;
}

/** The clipboard flavors this environment can hold, per format — the
 * vendor's own capability checks (probablySupportsClipboardBlob for the
 * PNG blob, probablySupportsClipboardWriteText for the SVG markup). */
function clipboardSupports(format: DrawingExportFormat): boolean {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard) return false;
  if (format === 'png') {
    return 'write' in clipboard && typeof window !== 'undefined' && 'ClipboardItem' in window;
  }
  return 'writeText' in clipboard;
}

interface ExportDialogFace {
  dialog: HTMLDialogElement;
  previewPanel: HTMLElement;
  stage: HTMLElement;
  stageNote: HTMLElement;
  previewImg: HTMLImageElement;
  meta: HTMLElement;
  formatPng: HTMLButtonElement;
  formatSvg: HTMLButtonElement;
  stem: HTMLInputElement;
  suffix: HTMLElement;
  background: HTMLInputElement;
  dark: HTMLInputElement;
  embed: HTMLInputElement;
  scaleRow: HTMLElement;
  scaleButtons: HTMLButtonElement[];
  cancel: HTMLButtonElement;
  copy: HTMLButtonElement;
  save: HTMLButtonElement;
  onExport:
    | ((
        choices: DrawingExportChoices,
        destination: DrawingExportDestination,
        fileName?: string,
      ) => void)
    | null;
  preview: DrawingExportPreviewDelegate | null;
}

let face: ExportDialogFace | null = null;
/** The copy button's 2s "Copied" flash — the vendor's useCopyStatus. */
let copyFlashTimer: number | null = null;
/** The preview's lifecycle: one token per scheduled render, one object
 * URL alive at a time, both stood down on close. */
let previewToken = 0;
let previewTimer: number | null = null;
let previewUrl: string | null = null;
/** The open session's scene facts (the modal freezes the canvas, so one
 * capture answers the whole session). */
let currentMetaFacts: DrawingExportMeta | null = null;

/** A pressed-state toggle button in a segmented switch. */
function segmentButton(group: HTMLElement, label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'drawing-export-seg-btn';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-pressed', 'false');
  group.append(button);
  return button;
}

/** A labeled checkbox row. */
function checkboxRow(
  text: string,
  hint: string,
): {
  row: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const row = document.createElement('label');
  row.className = 'drawing-export-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'drawing-export-check';
  const textEl = document.createElement('span');
  textEl.className = 'drawing-export-option-text';
  textEl.textContent = text;
  const hintEl = document.createElement('span');
  hintEl.className = 'drawing-export-option-hint';
  hintEl.textContent = hint;
  textEl.append(hintEl);
  row.append(input, textEl);
  return { row, input };
}

/**
 * The arrow keys on a segmented switch — selection follows focus, the
 * native radio behavior. One keydown binding on the group covers every
 * button it will ever hold.
 */
function wireSegmentKeys(group: HTMLElement): void {
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains('drawing-export-seg-btn')) return;
    const buttons = Array.from(
      group.querySelectorAll<HTMLButtonElement>('.drawing-export-seg-btn'),
    );
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index === -1) return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    event.preventDefault();
    next.focus();
    next.click();
  });
}

function isPressed(button: HTMLButtonElement): boolean {
  return button.getAttribute('aria-pressed') === 'true';
}

/** One face's answers, read live. */
function readChoicesFor(current: ExportDialogFace): DrawingExportChoices {
  const scaleIndex = Math.max(
    current.scaleButtons.findIndex((button) => isPressed(button)),
    0,
  );
  return {
    format: isPressed(current.formatPng) ? 'png' : 'svg',
    background: current.background.checked,
    dark: current.dark.checked,
    embed: current.embed.checked,
    scale: (scaleIndex + 1) as DrawingExportScale,
  };
}

/** The suffix chip: `.png` → `.excalidraw.png` the moment Embed turns
 * on — the double extension SEEN before the Save, not discovered in
 * the Downloads folder. */
function syncSuffixFor(current: ExportDialogFace): void {
  const format = isPressed(current.formatPng) ? 'png' : 'svg';
  const embed = current.embed.checked;
  current.suffix.textContent = `${embed ? '.excalidraw' : ''}.${format}`;
}

/** The facts line: element count, natural bounds, the scale-multiplied
 * answer — "3 elements — 1,240 × 860 px — 3,720 × 2,580 px at 3×". */
function syncMetaFor(current: ExportDialogFace): void {
  const facts = currentMetaFacts;
  if (!facts) {
    current.meta.textContent = '';
    return;
  }
  const pieces = [`${facts.elements} element${facts.elements === 1 ? '' : 's'}`];
  const scale = readChoicesFor(current).scale;
  if (facts.width !== undefined && facts.height !== undefined) {
    pieces.push(
      `${facts.width.toLocaleString('en-US')} × ${facts.height.toLocaleString('en-US')} px`,
    );
    if (scale > 1) {
      pieces.push(
        `${(facts.width * scale).toLocaleString('en-US')} × ${(facts.height * scale).toLocaleString('en-US')} px at ${scale}×`,
      );
    }
  }
  current.meta.textContent = pieces.join(' — ');
}

/** The copy button's honesty: it speaks the CURRENT format's clipboard
 * flavor (PNG blob / SVG text) and stands down when the environment
 * holds neither — the vendor's own capability gates, the app's words. */
function syncClipboardButtonFor(current: ExportDialogFace): void {
  const format = isPressed(current.formatPng) ? 'png' : 'svg';
  current.copy.hidden = !clipboardSupports(format);
}

/** Builds (once) the one export dialog the drawing owns. */
function dialogFace(): ExportDialogFace {
  if (face) {
    return face;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'vz-dialog drawing-export-dialog';
  dialog.setAttribute('aria-label', 'Export image');

  const title = document.createElement('h2');
  title.className = 'vz-dialog-title';
  title.textContent = 'Export image';
  dialog.append(title);

  // The preview panel — the live thumbnail the vendor's own dialog
  // leads with, plus the scene's facts. Hidden whole when this
  // session hands in no renderer (jsdom-grade embeds).
  const previewPanel = document.createElement('div');
  previewPanel.className = 'drawing-export-preview';
  const stage = document.createElement('div');
  stage.className = 'drawing-export-stage';
  const previewImg = document.createElement('img');
  previewImg.className = 'drawing-export-preview-img';
  previewImg.alt = 'Export preview — the drawing as it will export';
  const stageNote = document.createElement('p');
  stageNote.className = 'drawing-export-stage-note';
  stageNote.textContent = 'Rendering the preview…';
  stage.append(previewImg, stageNote);
  const meta = document.createElement('p');
  meta.className = 'drawing-export-meta';
  previewPanel.append(stage, meta);
  dialog.append(previewPanel);

  // The format switch — PNG / SVG, the vendor's own two types.
  const formatGroup = document.createElement('div');
  formatGroup.className = 'drawing-export-seg drawing-export-format-row';
  formatGroup.setAttribute('role', 'group');
  formatGroup.setAttribute('aria-label', 'Format');
  const formatPng = segmentButton(formatGroup, 'PNG', 'Export as a PNG image');
  const formatSvg = segmentButton(formatGroup, 'SVG', 'Export as an SVG image');
  wireSegmentKeys(formatGroup);
  dialog.append(formatGroup);

  // The file name — the vendor's dialog owns one too. The stem is the
  // user's; the suffix chip is the truth of format + embed, live.
  const nameLabel = document.createElement('p');
  nameLabel.className = 'drawing-export-label';
  nameLabel.textContent = 'File name';
  const nameRow = document.createElement('div');
  nameRow.className = 'drawing-export-name-row';
  const stem = document.createElement('input');
  stem.type = 'text';
  stem.className = 'vz-dialog-input';
  stem.setAttribute('aria-label', 'File name');
  stem.spellcheck = false;
  const suffix = document.createElement('span');
  suffix.className = 'drawing-export-name-suffix';
  nameRow.append(stem, suffix);
  dialog.append(nameLabel, nameRow);

  // The option rows — the vendor dialog's own labels and semantics. Both
  // rows answer for both formats: the vendor's dialog shows Embed scene
  // and Scale whatever the export button will be, and both DO apply to
  // the SVG (scale sizes it, embed writes its metadata).
  const background = checkboxRow(
    'Background',
    'Paint the canvas background color; off leaves a transparent backdrop',
  );
  const dark = checkboxRow('Dark mode', 'Render the export in the dark palette');
  const embed = checkboxRow(
    'Embed scene',
    'Carry the editable scene inside the file — excalidraw.com re-opens it',
  );
  dialog.append(background.row, dark.row, embed.row);

  // The scale switch — 1× / 2× / 3×, the vendor's EXPORT_SCALES.
  const scaleRow = document.createElement('div');
  scaleRow.className = 'drawing-export-scale-row';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'drawing-export-scale-label';
  scaleLabel.textContent = 'Scale';
  const scaleGroup = document.createElement('div');
  scaleGroup.className = 'drawing-export-seg';
  scaleGroup.setAttribute('role', 'group');
  scaleGroup.setAttribute('aria-label', 'Export scale');
  wireSegmentKeys(scaleGroup);
  const scaleButtons: HTMLButtonElement[] = [];
  const scales: DrawingExportScale[] = [1, 2, 3];
  for (const scale of scales) {
    const button = segmentButton(
      scaleGroup,
      `${scale}×`,
      scale === 1 ? 'Export at natural size' : `Export at ${scale} times the natural size`,
    );
    scaleButtons.push(button);
  }
  scaleRow.append(scaleLabel, scaleGroup);
  dialog.append(scaleRow);

  const actions = document.createElement('div');
  actions.className = 'vz-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vz-dialog-cancel';
  cancel.textContent = 'Cancel';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'vz-dialog-confirm drawing-export-copy';
  copy.textContent = 'Copy to clipboard';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'vz-dialog-confirm';
  save.textContent = 'Save';
  actions.append(cancel, copy, save);
  dialog.append(actions);

  document.body.append(dialog);
  face = {
    dialog,
    previewPanel,
    stage,
    stageNote,
    previewImg,
    meta,
    formatPng,
    formatSvg,
    stem,
    suffix,
    background: background.input,
    dark: dark.input,
    embed: embed.input,
    scaleRow,
    scaleButtons,
    cancel,
    copy,
    save,
    onExport: null,
    preview: null,
  };
  const current = face;

  const syncFormat = (): void => {
    const png = isPressed(current.formatPng);
    current.formatPng.setAttribute('aria-pressed', png ? 'true' : 'false');
    current.formatSvg.setAttribute('aria-pressed', png ? 'false' : 'true');
    syncClipboardButtonFor(current);
    syncSuffixFor(current);
    schedulePreview();
  };
  current.formatPng.addEventListener('click', () => {
    current.formatPng.setAttribute('aria-pressed', 'true');
    syncFormat();
  });
  current.formatSvg.addEventListener('click', () => {
    current.formatPng.setAttribute('aria-pressed', 'false');
    syncFormat();
  });

  for (const button of current.scaleButtons) {
    button.addEventListener('click', () => {
      for (const other of current.scaleButtons) {
        other.setAttribute('aria-pressed', 'false');
      }
      button.setAttribute('aria-pressed', 'true');
      syncMetaFor(current);
      schedulePreview();
    });
  }

  // The options flip the preview (Background/Dark change the pixels)
  // and the suffix (Embed changes the name); each row says so once.
  current.background.addEventListener('change', () => {
    syncStageBackdropFor(current);
    schedulePreview();
  });
  current.dark.addEventListener('change', () => schedulePreview());
  current.embed.addEventListener('change', () => syncSuffixFor(current));

  // Enter in the name field is a Save — the native save-dialog
  // discipline; the field never owns a newline to keep.
  current.stem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      current.save.click();
    }
  });

  current.cancel.addEventListener('click', () => {
    current.onExport = null;
    closeDialog();
  });
  dialog.addEventListener('cancel', () => {
    current.onExport = null;
  });
  // The dialog going away (Escape, cancel, a Save) ends the preview's
  // lifecycle: the pending render stands down, the object URL dies, the
  // stage clears. A reopen starts clean.
  dialog.addEventListener('close', () => {
    previewToken++;
    if (previewTimer !== null) {
      window.clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (previewUrl !== null) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    current.onExport = null;
    current.preview = null;
    current.previewImg.removeAttribute('src');
    current.stageNote.textContent = 'Rendering the preview…';
    current.stageNote.hidden = false;
    current.meta.textContent = '';
  });
  current.save.addEventListener('click', () => {
    const choices = readChoicesFor(current);
    // The Save names its file: the sanitized stem + the live suffix
    // (the embed's double extension included) — read at press time, so
    // the name the user sees is the name that downloads.
    const fileName = `${sanitizeFileStem(current.stem.value, 'drawing')}${current.suffix.textContent ?? ''}`;
    const handler = current.onExport;
    current.onExport = null;
    closeDialog();
    handler?.(choices, 'file', fileName);
  });
  current.copy.addEventListener('click', () => {
    const choices = readChoicesFor(current);
    const handler = current.onExport;
    // The dialog STAYS open on a copy — the vendor's own behavior: copy,
    // see the flash, keep tuning, save when ready.
    if (!handler) return;
    flashCopied();
    void handler(choices, 'clipboard');
  });

  return face;
}

/** The debounced, token-guarded preview render — the live thumbnail,
 * honoring Background/Dark, refreshed as the options flip. */
function schedulePreview(): void {
  const current = face;
  if (!current || !current.preview) return;
  const token = ++previewToken;
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
  }
  previewTimer = window.setTimeout(() => {
    void (async () => {
      const delegate = current.preview;
      if (!delegate) return;
      let url: string | null;
      try {
        url = await delegate(readChoicesFor(current));
      } catch {
        url = null;
      }
      if (token !== previewToken) {
        // A stale render: discard, and release its object URL if it
        // made one — the newer render owns the stage.
        if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      if (url === null || url === '') {
        current.stageNote.textContent = 'The preview could not render — the export can still try.';
        current.stageNote.hidden = false;
        return;
      }
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
      if (url.startsWith('blob:')) previewUrl = url;
      current.previewImg.src = url;
      current.stageNote.hidden = true;
    })();
  }, 160);
}

/** The stage's backdrop tells the transparency truth: with Background
 * off the stage wears a checkerboard, so the transparent PNG is SEEN. */
function syncStageBackdropFor(current: ExportDialogFace): void {
  current.stage.classList.toggle('drawing-export-stage--transparent', !current.background.checked);
}

/** The 2-second "Copied" flash on the copy button (the vendor's
 * useCopyStatus, in the app's own voice). */
function flashCopied(): void {
  const current = face;
  if (!current) return;
  if (copyFlashTimer !== null) {
    window.clearTimeout(copyFlashTimer);
  }
  current.copy.textContent = 'Copied';
  copyFlashTimer = window.setTimeout(() => {
    copyFlashTimer = null;
    if (face) {
      face.copy.textContent = 'Copy to clipboard';
    }
  }, 2_000);
}

function closeDialog(): void {
  const current = face;
  if (current && typeof current.dialog.close === 'function' && current.dialog.open) {
    current.dialog.close();
  }
}

/**
 * Opens the export dialog. The setup carries the exporter (`invoker` —
 * once per Save press, on the dialog's own turn after it closed; once
 * per Copy press, the dialog still open), the preview renderer, the
 * scene's facts, and the launcher's format preset. Defaults match the
 * vendor dialog's: PNG, background on, dark off, embed off, scale 1×,
 * and the file named after the note — a previous session's picks do
 * not leak.
 */
export function openDrawingExportDialog(setup: DrawingExportDialogSetup): void {
  const current = dialogFace();
  const format = setup.presetFormat ?? 'png';
  current.formatPng.setAttribute('aria-pressed', format === 'png' ? 'true' : 'false');
  current.formatSvg.setAttribute('aria-pressed', format === 'svg' ? 'true' : 'false');
  current.background.checked = true;
  current.dark.checked = false;
  current.embed.checked = false;
  for (const [index, button] of current.scaleButtons.entries()) {
    button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
  }
  current.copy.textContent = 'Copy to clipboard';
  current.stem.value = setup.defaultStem ?? 'drawing';
  current.preview = setup.preview ?? null;
  current.previewPanel.hidden = !current.preview;
  currentMetaFacts = setup.meta ?? null;

  current.onExport = (choices, destination, fileName) =>
    setup.invoker(choices, destination, fileName);

  syncSuffixFor(current);
  syncMetaFor(current);
  syncClipboardButtonFor(current);
  syncStageBackdropFor(current);
  current.stageNote.textContent = 'Rendering the preview…';
  current.stageNote.hidden = false;
  current.previewImg.removeAttribute('src');
  if (current.preview) {
    schedulePreview();
  }
  if (typeof current.dialog.showModal === 'function') {
    current.dialog.showModal();
  } else {
    // jsdom-grade embeds: no native <dialog> — the attribute keeps the
    // controls reachable without the top-layer promise.
    current.dialog.setAttribute('open', '');
  }
}
