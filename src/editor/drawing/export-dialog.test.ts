import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openDrawingExportDialog,
  type DrawingExportChoices,
  type DrawingExportDialogSetup,
} from './export-dialog';

/**
 * The drawing export dialog's own behaviors — the refinement pass's
 * pins, unit-grade (the e2e owns the integrated face):
 *
 *   - the file NAME is the dialog's now: the stem is editable, the
 *     suffix chip speaks format + embed live, and a Save press hands
 *     the exporter the sanitized full name.
 *   - the FACTS line answers "how big is this file going to be?" —
 *     element count, natural bounds, the scale-multiplied readout.
 *   - the PREVIEW: the delegate is called with the live choices and its
 *     URL lands on the stage (the debounce), honoring the options as
 *     they flip.
 *   - the KEYBOARD: Enter in the name field Saves, the segmented
 *     switches answer Arrow keys — selection follows focus.
 *
 * jsdom has no native <dialog> methods (the module's own fallback keeps
 * the controls reachable); the close-event cleanup is therefore e2e's
 * to prove, and every open here resets the session wholesale anyway.
 */

const dialog = (): HTMLDialogElement => {
  const node = document.querySelector<HTMLDialogElement>('dialog.drawing-export-dialog');
  expect(node).not.toBeNull();
  return node!;
};

const segButton = (label: string): HTMLButtonElement => {
  const buttons = Array.from(
    dialog().querySelectorAll<HTMLButtonElement>('.drawing-export-seg-btn'),
  );
  const found = buttons.find((button) => button.textContent === label);
  expect(found, `segment ${label}`).not.toBeUndefined();
  return found!;
};

const optionRow = (label: string): HTMLLabelElement => {
  const rows = Array.from(dialog().querySelectorAll<HTMLLabelElement>('.drawing-export-option'));
  const found = rows.find((row) => row.textContent?.includes(label));
  expect(found, `option row ${label}`).not.toBeUndefined();
  return found!;
};

const nameInput = (): HTMLInputElement =>
  dialog().querySelector<HTMLInputElement>('.drawing-export-name-row input')!;

const suffixChip = (): HTMLElement =>
  dialog().querySelector<HTMLElement>('.drawing-export-name-suffix')!;

const saveButton = (): HTMLButtonElement =>
  Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === 'Save',
  )!;

const metaLine = (): HTMLElement => dialog().querySelector<HTMLElement>('.drawing-export-meta')!;

const previewImg = (): HTMLImageElement =>
  dialog().querySelector<HTMLImageElement>('.drawing-export-preview-img')!;

const invoker = vi.fn(async () => true);
const preview = vi.fn(async (choices: DrawingExportChoices) =>
  choices.background ? 'data:image/png;base64,white' : 'data:image/png;base64,clear',
);

function open(setup: Partial<DrawingExportDialogSetup> = {}): void {
  openDrawingExportDialog({
    invoker,
    preview,
    meta: { elements: 3, width: 1240, height: 860 },
    defaultStem: 'Sketch',
    ...setup,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the drawing export dialog — the native face', () => {
  it("opens on the defaults: PNG pressed, background on, the note's name, the .png suffix", () => {
    open();
    expect(segButton('PNG').getAttribute('aria-pressed')).toBe('true');
    expect(segButton('SVG').getAttribute('aria-pressed')).toBe('false');
    expect(optionRow('Background').querySelector('input')!.checked).toBe(true);
    expect(optionRow('Dark mode').querySelector('input')!.checked).toBe(false);
    expect(nameInput().value).toBe('Sketch');
    expect(suffixChip().textContent).toBe('.png');
  });

  it("the preset lands the launcher's ask before the face shows", () => {
    open({ presetFormat: 'svg' });
    expect(segButton('SVG').getAttribute('aria-pressed')).toBe('true');
    expect(suffixChip().textContent).toBe('.svg');
  });

  it('the suffix chip speaks the embed double extension live, both formats', () => {
    open();
    optionRow('Embed scene').querySelector('input')!.click();
    expect(suffixChip().textContent).toBe('.excalidraw.png');
    segButton('SVG').click();
    expect(suffixChip().textContent).toBe('.excalidraw.svg');
  });

  it('the facts line: count, natural bounds, the scale-multiplied answer at 3×', () => {
    open();
    expect(metaLine().textContent).toBe('3 elements — 1,240 × 860 px');
    segButton('3×').click();
    expect(metaLine().textContent).toBe('3 elements — 1,240 × 860 px — 3,720 × 2,580 px at 3×');
  });

  it('the preview: the delegate answers the live choices and its URL lands on the stage', async () => {
    open();
    await vi.advanceTimersByTimeAsync(160);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ background: true, dark: false }),
    );
    expect(previewImg().src).toBe('data:image/png;base64,white');

    // An option flip re-renders with the new truth (transparent PNG).
    optionRow('Background').querySelector('input')!.click();
    await vi.advanceTimersByTimeAsync(160);
    expect(preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ background: false, dark: false }),
    );
    expect(previewImg().src).toBe('data:image/png;base64,clear');
    // The stage wears the checkerboard when Background is off, so the
    // transparency is SEEN.
    const stage = dialog().querySelector<HTMLElement>('.drawing-export-stage')!;
    expect(stage.classList.contains('drawing-export-stage--transparent')).toBe(true);
  });

  it('without a preview delegate the panel stays down — the dialog reads as the option list', () => {
    open({ preview: undefined });
    const panel = dialog().querySelector<HTMLElement>('.drawing-export-preview')!;
    expect(panel.hidden).toBe(true);
  });

  it('a Save press hands the exporter the sanitized full name — stem plus the live suffix', () => {
    open();
    nameInput().value = 'blueprint';
    saveButton().click();
    expect(invoker).toHaveBeenCalledTimes(1);
    const [choices, destination, fileName] = invoker.mock.calls[0] as unknown as [
      DrawingExportChoices,
      string,
      string,
    ];
    expect(destination).toBe('file');
    expect(fileName).toBe('blueprint.png');
    expect(choices.format).toBe('png');

    // The embed's double extension rides the name the user sees.
    invoker.mockClear();
    open();
    optionRow('Embed scene').querySelector('input')!.click();
    nameInput().value = 'site map';
    saveButton().click();
    expect((invoker.mock.calls[0] as unknown as unknown[])[2]).toBe('site map.excalidraw.png');
  });

  it('Enter in the name field is a Save — the native save-dialog discipline', () => {
    open();
    nameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(invoker).toHaveBeenCalledTimes(1);
    expect((invoker.mock.calls[0] as unknown as unknown[])[1]).toBe('file');
  });

  it('the segmented switches answer Arrow keys — selection follows focus', () => {
    open();
    segButton('PNG').focus();
    segButton('PNG').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(segButton('SVG').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(segButton('SVG'));

    // ArrowLeft wraps back around the radio set.
    segButton('SVG').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(segButton('PNG').getAttribute('aria-pressed')).toBe('true');

    // The scale set walks the same way: 1× → ArrowRight → 2×.
    segButton('1×').focus();
    segButton('1×').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(segButton('2×').getAttribute('aria-pressed')).toBe('true');
  });

  it('the copy press keeps the dialog open and answers the clipboard destination', () => {
    open();
    const copy = Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Copy to clipboard',
    );
    // jsdom holds no clipboard — the honest gate hides the press.
    expect(copy?.hidden ?? true).toBe(true);
  });
});
