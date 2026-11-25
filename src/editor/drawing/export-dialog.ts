/**
 * The drawing export dialog — the native options, spoken in the app's own
 * modal face.
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
 * NATIVE PARITY (the restore's second lesson — what even this dialog
 * lacked while the vendor's own was the only complete face):
 *   - the scale speaks 1×/2×/3× — the vendor's EXPORT_SCALES, all three
 *   - Embed scene and Scale answer for BOTH formats, exactly as the
 *     vendor's dialog shows them (scale sizes the SVG's width/height;
 *     embed writes the scene into the SVG's metadata)
 *   - Copy to clipboard: PNG rides as an image/png blob, SVG rides as
 *     the markup text — the vendor's own two clipboard flavors (its
 *     dialog's button + its copyAsSvg), with its 2-second "Copied" flash
 *
 * The dialog is pure UI. The exporter (gating, rendering, downloading,
 * copying, toasts) stays in surface.ts (`exportActiveDrawingImage` /
 `copyActiveDrawingImage`) — it arrives as a callback, so this module
 * never imports the vendor island and the dialog markup loads with the
 * app, not with the 1.3 MB canvas chunk.
 *
 * THE FACE: a native <dialog> on the design tokens (the confirm/prompt
 * dialog's recipe — src/ui/dialog.css), extended with the two controls
 * the options need: a segmented format/scale switch and checkbox rows.
 * Native <dialog> brings the focus trap, Escape and the top layer.
 */

import './export-dialog.css';

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
 * stays open for those, the vendor's own behavior). Answers whether the
 * export actually happened — the copy press flashes "Copied" on a `true`.
 */
export type DrawingExportInvoker = (
  choices: DrawingExportChoices,
  destination: DrawingExportDestination,
) => Promise<boolean>;

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
  formatPng: HTMLButtonElement;
  formatSvg: HTMLButtonElement;
  background: HTMLInputElement;
  dark: HTMLInputElement;
  embed: HTMLInputElement;
  scaleRow: HTMLElement;
  scaleButtons: HTMLButtonElement[];
  cancel: HTMLButtonElement;
  copy: HTMLButtonElement;
  save: HTMLButtonElement;
  onExport: ((choices: DrawingExportChoices, destination: DrawingExportDestination) => void) | null;
}

let face: ExportDialogFace | null = null;
/** The copy button's 2s "Copied" flash — the vendor's useCopyStatus. */
let copyFlashTimer: number | null = null;

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

  // The format switch — PNG / SVG, the vendor's own two types.
  const formatGroup = document.createElement('div');
  formatGroup.className = 'drawing-export-seg';
  formatGroup.setAttribute('role', 'group');
  formatGroup.setAttribute('aria-label', 'Format');
  const formatPng = segmentButton(formatGroup, 'PNG', 'Export as a PNG image');
  const formatSvg = segmentButton(formatGroup, 'SVG', 'Export as an SVG image');
  dialog.append(formatGroup);

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
    formatPng,
    formatSvg,
    background: background.input,
    dark: dark.input,
    embed: embed.input,
    scaleRow,
    scaleButtons,
    cancel,
    copy,
    save,
    onExport: null,
  };

  const pressed = (button: HTMLButtonElement, on: boolean): void => {
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  const isPressed = (button: HTMLButtonElement): boolean =>
    button.getAttribute('aria-pressed') === 'true';

  const syncFormat = (): void => {
    const png = isPressed(formatPng);
    pressed(formatPng, png);
    pressed(formatSvg, !png);
    syncClipboardButton();
  };
  formatPng.addEventListener('click', () => {
    pressed(formatPng, true);
    syncFormat();
  });
  formatSvg.addEventListener('click', () => {
    pressed(formatPng, false);
    syncFormat();
  });

  for (const button of scaleButtons) {
    button.addEventListener('click', () => {
      for (const other of scaleButtons) {
        pressed(other, false);
      }
      pressed(button, true);
    });
  }

  // The copy button's honesty: it speaks the CURRENT format's clipboard
  // flavor (PNG blob / SVG text) and stands down when the environment
  // holds neither — the vendor's own capability gates, the app's own
  // words.
  const syncClipboardButton = (): void => {
    const format: DrawingExportFormat = isPressed(formatPng) ? 'png' : 'svg';
    const supported = clipboardSupports(format);
    const current = face;
    if (!current) return;
    current.copy.hidden = !supported;
  };

  cancel.addEventListener('click', () => {
    face!.onExport = null;
    closeDialog();
  });
  dialog.addEventListener('cancel', () => {
    face!.onExport = null;
  });
  save.addEventListener('click', () => {
    const choices = readChoices();
    const handler = face!.onExport;
    face!.onExport = null;
    closeDialog();
    handler?.(choices, 'file');
  });
  copy.addEventListener('click', () => {
    const choices = readChoices();
    const handler = face!.onExport;
    // The dialog STAYS open on a copy — the vendor's own behavior: copy,
    // see the flash, keep tuning, save when ready.
    if (!handler) return;
    flashCopied();
    void handler(choices, 'clipboard');
  });

  function readChoices(): DrawingExportChoices {
    // The scale buttons are a one-pressed radio set (an open always
    // presses 1× and every click re-presses exactly one); the floor
    // guards a jsdom-grade poke that somehow left none pressed.
    const scaleIndex = Math.max(
      scaleButtons.findIndex((button) => isPressed(button)),
      0,
    );
    return {
      format: isPressed(formatPng) ? 'png' : 'svg',
      background: background.input.checked,
      dark: dark.input.checked,
      embed: embed.input.checked,
      scale: (scaleIndex + 1) as DrawingExportScale,
    };
  }

  return face;
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
 * Opens the export dialog. `invoker` runs once per Save press (on the
 * dialog's own turn, after it closed) and once per Copy press (the dialog
 * still open). `presetFormat` lands the launcher's ask (the export
 * center's PNG/SVG rows press their format before the face shows).
 */
export function openDrawingExportDialog(
  invoker: DrawingExportInvoker,
  presetFormat?: DrawingExportFormat,
): void {
  const current = dialogFace();
  // Defaults match the vendor dialog's: PNG, background on, dark off,
  // embed off, scale 1×. A previously used session's picks do not leak —
  // every open starts from the vendor's defaults, like the site's.
  const format = presetFormat ?? 'png';
  current.formatPng.setAttribute('aria-pressed', format === 'png' ? 'true' : 'false');
  current.formatSvg.setAttribute('aria-pressed', format === 'svg' ? 'true' : 'false');
  current.background.checked = true;
  current.dark.checked = false;
  current.embed.checked = false;
  for (const [index, button] of current.scaleButtons.entries()) {
    button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
  }
  current.copy.textContent = 'Copy to clipboard';

  current.onExport = (choices, destination) => invoker(choices, destination);
  if (typeof current.dialog.showModal === 'function') {
    current.dialog.showModal();
  } else {
    // jsdom-grade embeds: no native <dialog> — show() with a class guard
    // so the row stays reachable without the top-layer promise.
    current.dialog.setAttribute('open', '');
  }
}
