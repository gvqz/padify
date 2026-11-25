/**
 * The drawing export dialog — the native options, spoken in the app's own
 * modal face.
 *
 * WHY THIS EXISTS (the R1 unified export, the owner's first component
 * swap): the download menu's drawing rows used to export with fixed
 * defaults baked in (scale 1, background on, no embed) — options the
 * vendor's own export dialog offers were unreachable from the app side.
 * This dialog is the one surface for the drawing's image exports: format
 * (PNG/SVG), background, dark mode, embed scene, scale — the same knobs
 * the vendor's dialog turns, named the way it names them.
 *
 * The dialog is pure UI. The exporter (gating, rendering, download,
 * toasts) stays in surface.ts (`exportActiveDrawingImage`) — it arrives
 * as a callback, so this module never imports the vendor island and the
 * dialog markup loads with the app, not with the 1.3 MB canvas chunk.
 *
 * THE FACE: a native <dialog> on the design tokens (the confirm/prompt
 * dialog's recipe — src/ui/dialog.css), extended with the two controls
 * the options need: a segmented format/scale switch and checkbox rows.
 * Native <dialog> brings the focus trap, Escape and the top layer.
 */

import './export-dialog.css';

/** The chosen format — the vendor's own two image types. */
export type DrawingExportFormat = 'png' | 'svg';

/** One dialog session's answers. */
export interface DrawingExportChoices {
  format: DrawingExportFormat;
  background: boolean;
  dark: boolean;
  embed: boolean;
  scale: 1 | 2;
}

/** The exporter surface.ts hands in — one call per Export press. */
export type DrawingExportInvoker = (choices: DrawingExportChoices) => Promise<void>;

interface ExportDialogFace {
  dialog: HTMLDialogElement;
  formatPng: HTMLButtonElement;
  formatSvg: HTMLButtonElement;
  backgroundRow: HTMLLabelElement;
  background: HTMLInputElement;
  darkRow: HTMLLabelElement;
  dark: HTMLInputElement;
  embedRow: HTMLLabelElement;
  embed: HTMLInputElement;
  scaleRow: HTMLElement;
  scaleOne: HTMLButtonElement;
  scaleTwo: HTMLButtonElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
  onExport: ((choices: DrawingExportChoices) => void) | null;
}

let face: ExportDialogFace | null = null;

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

  // The option rows — the vendor dialog's own labels and semantics.
  const background = checkboxRow(
    'Background',
    'Paint the canvas background color; off leaves a transparent backdrop',
  );
  const dark = checkboxRow('Dark mode', 'Render the export in the dark palette');
  const embed = checkboxRow(
    'Embed scene',
    'Carry the editable scene inside the PNG — excalidraw.com re-opens it',
  );
  dialog.append(background.row, dark.row, embed.row);

  // The scale switch — PNG only (SVG is vector; the vendor hides scale
  // there too).
  const scaleRow = document.createElement('div');
  scaleRow.className = 'drawing-export-scale-row';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'drawing-export-scale-label';
  scaleLabel.textContent = 'Scale';
  const scaleGroup = document.createElement('div');
  scaleGroup.className = 'drawing-export-seg';
  scaleGroup.setAttribute('role', 'group');
  scaleGroup.setAttribute('aria-label', 'Export scale');
  const scaleOne = segmentButton(scaleGroup, '1×', 'Export at 1× size');
  const scaleTwo = segmentButton(scaleGroup, '2×', 'Export at double size');
  scaleRow.append(scaleLabel, scaleGroup);
  dialog.append(scaleRow);

  const actions = document.createElement('div');
  actions.className = 'vz-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vz-dialog-cancel';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'vz-dialog-confirm';
  save.textContent = 'Save';
  actions.append(cancel, save);
  dialog.append(actions);

  document.body.append(dialog);
  face = {
    dialog,
    formatPng,
    formatSvg,
    backgroundRow: background.row,
    background: background.input,
    darkRow: dark.row,
    dark: dark.input,
    embedRow: embed.row,
    embed: embed.input,
    scaleRow,
    scaleOne,
    scaleTwo,
    save,
    cancel,
    onExport: null,
  };

  const pressed = (button: HTMLButtonElement, on: boolean): void => {
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  const isPressed = (button: HTMLButtonElement): boolean =>
    button.getAttribute('aria-pressed') === 'true';

  // The format switch flips the SVG-only rows with it (scale and embed
  // are PNG semantics — the vendor's dialog hides both for SVG).
  const syncFormat = (): void => {
    const png = isPressed(formatPng);
    pressed(formatPng, png);
    pressed(formatSvg, !png);
    scaleRow.hidden = !png;
    embed.row.hidden = !png;
  };
  formatPng.addEventListener('click', () => {
    pressed(formatPng, true);
    syncFormat();
  });
  formatSvg.addEventListener('click', () => {
    pressed(formatPng, false);
    syncFormat();
  });

  face.scaleOne.addEventListener('click', () => {
    pressed(scaleOne, true);
    pressed(scaleTwo, false);
  });
  face.scaleTwo.addEventListener('click', () => {
    pressed(scaleOne, false);
    pressed(scaleTwo, true);
  });

  cancel.addEventListener('click', () => {
    face!.onExport = null;
    closeDialog();
  });
  dialog.addEventListener('cancel', () => {
    face!.onExport = null;
  });
  save.addEventListener('click', () => {
    const choices: DrawingExportChoices = {
      format: isPressed(formatPng) ? 'png' : 'svg',
      background: background.input.checked,
      dark: dark.input.checked,
      embed: embed.input.checked && isPressed(formatPng),
      scale: isPressed(scaleTwo) ? 2 : 1,
    };
    const handler = face!.onExport;
    face!.onExport = null;
    closeDialog();
    handler?.(choices);
  });

  return face;
}

function closeDialog(): void {
  const current = face;
  if (current && typeof current.dialog.close === 'function' && current.dialog.open) {
    current.dialog.close();
  }
}

/**
 * Opens the export dialog. `invoker` runs once per Save press, on the
 * dialog's own turn (after it closed — the export may take a beat, and a
 * closed dialog never covers the toasts that answer it).
 */
export function openDrawingExportDialog(invoker: DrawingExportInvoker): void {
  const current = dialogFace();
  // Defaults match the vendor dialog's: PNG, background on, dark off,
  // embed off, scale 1×. A previously used session's picks do not leak —
  // every open starts from the vendor's defaults, like the site's.
  const isPng = current.formatPng.getAttribute('aria-pressed') === 'true';
  current.background.checked = true;
  current.dark.checked = false;
  current.embed.checked = false;
  current.scaleOne.setAttribute('aria-pressed', 'true');
  current.scaleTwo.setAttribute('aria-pressed', 'false');
  current.formatPng.setAttribute('aria-pressed', isPng ? 'true' : 'true');
  current.formatSvg.setAttribute('aria-pressed', 'false');

  current.onExport = (choices) => {
    void invoker(choices);
  };
  if (typeof current.dialog.showModal === 'function') {
    current.dialog.showModal();
  } else {
    // jsdom-grade embeds: no native <dialog> — show() with a class guard
    // so the row stays reachable without the top-layer promise.
    current.dialog.setAttribute('open', '');
  }
}
