import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExportCenter, type ExportCenterHost, type ExportCenterType } from './export-center';

/**
 * The export center's restart, unit-grade (the e2e owns the integrated
 * face):
 *
 *   - every format is a CHIP in one radio group — one wrapped row, the
 *     selected chip aria-checked, no group labels, no handoffs;
 *   - the selected format speaks ONCE — the description line under the
 *     chips;
 *   - the drawing-style rows speak the native option set inline: the
 *     live suffix honors the dynamic extension (the embed double
 *     extension `.excalidraw.png` lands as the toggle flips), the
 *     option's write-through fires, the preview paints the canvas
 *     element and the checkerboard when the answer says transparency,
 *     and the clipboard press rides beside Export with its capability
 *     gate;
 *   - keepOpen — the native image dialogs' own behavior: an export is
 *     not a dismissal;
 *   - the keyboard is native: the arrows walk the chips (selection
 *     follows focus), Enter in the name field is an Export;
 *   - the × closes; the open focuses the SELECTED chip.
 *
 * jsdom has no native <dialog> methods (the module's own fallback keeps
 * the chips reachable); the close-event cleanup is the e2e's to prove.
 */

const dialog = (): HTMLDialogElement => {
  const node = document.querySelector<HTMLDialogElement>('dialog.export-center');
  expect(node).not.toBeNull();
  return node!;
};

const chips = (): HTMLButtonElement[] =>
  Array.from(dialog().querySelectorAll<HTMLButtonElement>('.export-center-chip'));

const chipFor = (label: string): HTMLButtonElement => {
  const found = chips().find((chip) => chip.textContent?.includes(label));
  expect(found, `chip ${label}`).not.toBeUndefined();
  return found!;
};

const description = (): HTMLElement => dialog().querySelector<HTMLElement>('.export-center-desc')!;

const nameInput = (): HTMLInputElement =>
  dialog().querySelector<HTMLInputElement>('.export-center-name-row input')!;

const suffixChip = (): HTMLElement =>
  dialog().querySelector<HTMLElement>('.export-center-name-suffix')!;

const copyButton = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('.export-center-copy')!;

const exportButton = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('.export-center-export')!;

const closeButton = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('.export-center-close')!;

const stage = (): HTMLElement => dialog().querySelector<HTMLElement>('.export-center-stage')!;

const makeType = (id: string, over: Partial<ExportCenterType> = {}): ExportCenterType => ({
  id,
  label: id.toUpperCase(),
  extension: id,
  defaultStem: `note-${id}`,
  hint: `the ${id} description`,
  preview: vi.fn(async () => ({ text: `preview of ${id}` })),
  run: vi.fn(async () => true),
  ...over,
});

/** The drawing's PNG row — the native option model, shared with SVG. */
const pngType = (over: Partial<ExportCenterType> = {}): ExportCenterType => ({
  id: 'png',
  label: 'PNG',
  extension: 'png',
  defaultStem: 'sketch',
  hint: 'a lossless image of the scene',
  options: [
    { kind: 'toggle', id: 'background', label: 'Background', value: true },
    { kind: 'toggle', id: 'embed', label: 'Embed scene', value: false },
  ],
  extensionFor: (values) => (values.embed === true ? 'excalidraw.png' : 'png'),
  preview: vi.fn(async () => ({ text: 'rendered' })),
  run: vi.fn(async () => true),
  copy: vi.fn(async () => true),
  keepOpen: true,
  ...over,
});

const switchFor = (label: string): HTMLInputElement => {
  const rows = Array.from(dialog().querySelectorAll<HTMLLabelElement>('.export-center-option'));
  const found = rows.find((row) => row.textContent?.includes(label));
  expect(found, `option ${label}`).not.toBeUndefined();
  const input = found!.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input).not.toBeNull();
  return input!;
};

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no object-URL machinery — the image previews answer
  // blob: URLs, and the center's revoke discipline must not explode the
  // suite for the runtime's sake (the real browser owns the truth).
  URL.createObjectURL = vi.fn((): string => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

function open(host: ExportCenterHost): void {
  openExportCenter(host);
}

describe('the export center — the restarted ONE face', () => {
  it('every format is a chip in one radio group — no group labels, one row', () => {
    open({
      heading: 'Export',
      types: [
        pngType(),
        makeType('svg'),
        makeType('excalidraw'),
        makeType('padify'),
        makeType('workspace'),
      ],
    });
    expect(chips()).toHaveLength(5);
    for (const chip of chips()) {
      expect(chip.getAttribute('role')).toBe('radio');
      expect(chip.hasAttribute('aria-checked')).toBe(true);
    }
    expect(dialog().querySelector('.export-center-group-label')).toBeNull();
  });

  it('the selected chip fills the selection; a chip click SELECTS, never hands off', () => {
    const svg = makeType('svg');
    open({ heading: 'Export', types: [pngType(), svg] });
    expect(chipFor('PNG').getAttribute('aria-checked')).toBe('true');
    expect(chipFor('SVG').getAttribute('aria-checked')).toBe('false');
    chipFor('SVG').click();
    expect(chipFor('SVG').getAttribute('aria-checked')).toBe('true');
    expect(chipFor('PNG').getAttribute('aria-checked')).toBe('false');
    // Still open — one dialog, no handoff.
    expect(dialog().hasAttribute('open')).toBe(true);
  });

  it('the selected format speaks ONCE — the description line under the chips', () => {
    open({ heading: 'Export', types: [pngType(), makeType('svg')] });
    expect(description().textContent).toBe('a lossless image of the scene');
    chipFor('SVG').click();
    expect(description().textContent).toBe('the svg description');
  });

  it('the embed switch flips the suffix chip to the double extension, live', () => {
    open({ heading: 'Export', types: [pngType()] });
    expect(suffixChip().textContent).toBe('.png');
    switchFor('Embed scene').click();
    expect(suffixChip().textContent).toBe('.excalidraw.png');
  });

  it("the option's write-through fires — the native switch actions' delegation", () => {
    const onFlip = vi.fn();
    const png = pngType({
      options: [{ kind: 'toggle', id: 'background', label: 'Background', value: true, onFlip }],
    });
    open({ heading: 'Export', types: [png] });
    switchFor('Background').click();
    expect(onFlip).toHaveBeenCalledWith(false);
  });

  it("the name field's keystrokes write through — the drawing rows' scene-name parity", () => {
    const onNameChange = vi.fn();
    open({ heading: 'Export', types: [pngType({ onNameChange })] });
    nameInput().value = 'renamed sketch';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    expect(onNameChange).toHaveBeenCalledWith('renamed sketch');
  });

  it('the export press speaks the dynamic extension in the file name', async () => {
    const png = pngType();
    open({ heading: 'Export', types: [png] });
    switchFor('Embed scene').click();
    nameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(png.run).toHaveBeenCalledWith('sketch.excalidraw.png', expect.anything());
  });

  it('keepOpen — the native image dialogs’ own behavior: an export is not a dismissal', async () => {
    const txt = makeType('txt');
    open({ heading: 'Export', types: [pngType()] });
    exportButton().click();
    await vi.advanceTimersByTimeAsync(0);
    // The drawing's image row stays standing.
    expect(dialog().hasAttribute('open')).toBe(true);

    // A plain row (keepOpen absent) closes on its success.
    open({ heading: 'Export', types: [txt] });
    exportButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('the × closes the dialog', () => {
    open({ heading: 'Export', types: [pngType()] });
    closeButton().click();
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('a backdrop click closes — the one dismiss rule every popup speaks', () => {
    open({ heading: 'Export', types: [pngType()] });
    const d = dialog();
    // jsdom's 0×0 box makes (−40,−40) honestly outside — the browser owns
    // the real coordinates; this pins the press-on-shell + outside rule.
    d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -40, clientY: -40 }));
    expect(d.hasAttribute('open')).toBe(false);
  });

  it('a drag from the surface never dismisses — the press must begin on the backdrop', () => {
    open({ heading: 'Export', types: [pngType()] });
    const d = dialog();
    // The press begins on a child (a selection drag on the stage), the
    // click lands on the dialog element after leaving the box — the room
    // stays standing, the render stays put.
    chips()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -40, clientY: -40 }));
    expect(d.hasAttribute('open')).toBe(true);
  });

  it('the canvas preview rides the stage — the live drawing render itself', async () => {
    const canvas = document.createElement('canvas');
    const png = pngType({ preview: vi.fn(async () => ({ canvas, transparent: true })) });
    open({ heading: 'Export', types: [png] });
    await vi.advanceTimersByTimeAsync(160);
    expect(stage().querySelector('canvas')).toBe(canvas);
    // Transparency is SEEN — the checkerboard rides the stage.
    expect(stage().classList.contains('export-center-stage--transparent')).toBe(true);
  });

  it('a transparent preview paints the checkerboard stage', async () => {
    open({
      heading: 'Export',
      types: [pngType({ preview: vi.fn(async () => ({ text: 'x', transparent: true })) })],
    });
    await vi.advanceTimersByTimeAsync(160);
    expect(stage().classList.contains('export-center-stage--transparent')).toBe(true);
  });

  it('the clipboard press: capability-gated, dialog stays open, "Copied" flash', async () => {
    const copy = vi.fn(async () => true);
    open({ heading: 'Export', types: [pngType({ copy })] });
    expect(copyButton().hidden).toBe(false);
    copyButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copyButton().textContent).toBe('Copied');
    // A copy is not a save — the dialog stays open.
    expect(dialog().hasAttribute('open')).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(copyButton().textContent).toBe('Copy to clipboard');
  });

  it('copySupported=false hides the press; a format without copy hides it too', () => {
    open({ heading: 'Export', types: [pngType({ copySupported: () => false })] });
    expect(copyButton().hidden).toBe(true);
    open({ heading: 'Export', types: [makeType('txt')] });
    expect(copyButton().hidden).toBe(true);
  });

  it('a copy that fails keeps the label (no "Copied" lie), the toast owns the words', async () => {
    open({ heading: 'Export', types: [pngType({ copy: vi.fn(async () => false) })] });
    copyButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copyButton().textContent).toBe('Copy to clipboard');
  });

  it("Enter in the name field is an Export — the field's stem plus the live suffix", async () => {
    const txt = makeType('txt');
    open({ heading: 'Export', types: [txt] });
    nameInput().value = 'quarterly review';
    nameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(txt.run).toHaveBeenCalledTimes(1);
    expect(txt.run).toHaveBeenCalledWith('quarterly review.txt', {});
  });

  it('the open focuses the SELECTED chip, not whichever button the UA picked first', () => {
    open({ heading: 'Export', types: [pngType(), makeType('svg')] });
    expect(document.activeElement).toBe(chipFor('PNG'));
  });

  it('the arrows walk the chips — selection follows focus', () => {
    open({
      heading: 'Export',
      types: [pngType(), makeType('svg'), makeType('excalidraw')],
    });
    // Focus starts on the selected chip (the open's discipline).
    const png = chipFor('PNG');
    expect(document.activeElement).toBe(png);

    // ArrowRight walks to the svg chip.
    png.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    const svg = chipFor('svg'.toUpperCase());
    expect(svg.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(svg);

    // ArrowLeft wraps back.
    svg.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(png.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(png);
  });

  it("the file-name edit survives the format switch, minus the previous format's extension", async () => {
    const txt = makeType('txt');
    const pdf = makeType('pdf');
    open({ heading: 'Export', types: [txt, pdf] });
    nameInput().value = 'report.txt';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    chipFor('pdf'.toUpperCase()).click();
    expect(nameInput().value).toBe('report');
    await vi.advanceTimersByTimeAsync(160);
    expect(pdf.preview).toHaveBeenCalledTimes(1);
  });

  it('the initialTypeId picks the chip the door named (the canvas menu rows)', () => {
    open({
      heading: 'Export',
      types: [pngType(), makeType('excalidraw')],
      initialTypeId: 'excalidraw',
    });
    expect(chipFor('excalidraw'.toUpperCase()).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(chipFor('excalidraw'.toUpperCase()));
  });
});
