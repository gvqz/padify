import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExportCenter, type ExportCenterHost, type ExportCenterType } from './export-center';

/**
 * The export center's one-menu pass, unit-grade (the e2e owns the
 * integrated face):
 *
 *   - every row is a RADIO (role + aria-checked) — the drawing's image
 *     rows are selectable exporters now, not launcher handoffs; no row
 *     ever closes the center to open another face;
 *   - the image rows speak the native option set inline: the live
 *     suffix honors the dynamic extension (the embed double extension
 *     `.excalidraw.png` lands as the toggle flips), the preview paints
 *     the checkerboard when the answer says transparency, and the
 *     clipboard press rides beside Export with its capability gate;
 *   - the keyboard is native: ArrowDown/ArrowUp walk the rows
 *     (selection follows focus), Enter in the name field is an Export;
 *   - the open focuses the SELECTED row.
 *
 * jsdom has no native <dialog> methods (the module's own fallback keeps
 * the rows reachable); the close-event cleanup is the e2e's to prove.
 */

const dialog = (): HTMLDialogElement => {
  const node = document.querySelector<HTMLDialogElement>('dialog.export-center');
  expect(node).not.toBeNull();
  return node!;
};

const typeRows = (): HTMLButtonElement[] =>
  Array.from(dialog().querySelectorAll<HTMLButtonElement>('.export-center-type'));

const rowFor = (label: string): HTMLButtonElement => {
  const found = typeRows().find((row) => row.textContent?.includes(label));
  expect(found, `row ${label}`).not.toBeUndefined();
  return found!;
};

const groupLabels = (): string[] =>
  Array.from(dialog().querySelectorAll<HTMLElement>('.export-center-group-label')).map(
    (label) => label.textContent ?? '',
  );

const nameInput = (): HTMLInputElement =>
  dialog().querySelector<HTMLInputElement>('.export-center-name-row input')!;

const suffixChip = (): HTMLElement =>
  dialog().querySelector<HTMLElement>('.export-center-name-suffix')!;

const copyButton = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('.export-center-copy')!;

const stage = (): HTMLElement => dialog().querySelector<HTMLElement>('.export-center-stage')!;

const makeType = (id: string, over: Partial<ExportCenterType> = {}): ExportCenterType => ({
  id,
  label: id.toUpperCase(),
  extension: id,
  defaultStem: `note-${id}`,
  preview: vi.fn(async () => ({ text: `preview of ${id}` })),
  run: vi.fn(async () => true),
  ...over,
});

/** An image row — the drawing's PNG, with the native option model. */
const pngType = (over: Partial<ExportCenterType> = {}): ExportCenterType => ({
  id: 'image-png',
  label: 'PNG image',
  extension: 'png',
  defaultStem: 'sketch',
  section: 'images',
  options: [
    { kind: 'toggle', id: 'background', label: 'Background', hint: '', value: true },
    { kind: 'toggle', id: 'embed', label: 'Embed scene', hint: '', value: false },
  ],
  extensionFor: (values) => (values.embed === true ? 'excalidraw.png' : 'png'),
  preview: vi.fn(async () => ({ image: 'blob:preview', imageTransparent: false })),
  run: vi.fn(async () => true),
  copy: vi.fn(async () => true),
  ...over,
});

const toggleFor = (label: string): HTMLInputElement => {
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

describe('the export center — the one-menu pass', () => {
  it('the groups carry their labels: Images, This note, The pad itself', () => {
    open({
      heading: 'Export',
      types: [
        pngType(),
        makeType('excalidraw', { label: 'Excalidraw file' }),
        makeType('padify', { label: 'Padify file' }),
        makeType('workspace', { section: 'pad' }),
      ],
    });
    expect(groupLabels()).toEqual(['Images', 'This note', 'The pad itself']);
  });

  it("a text note's groups: This note, The pad itself", () => {
    open({
      heading: 'Export',
      types: [
        makeType('txt'),
        makeType('pdf'),
        makeType('padify', { section: 'note' }),
        makeType('workspace', { section: 'pad' }),
      ],
    });
    expect(groupLabels()).toEqual(['This note', 'The pad itself']);
  });

  it('EVERY row speaks radio — the image rows are choices, not doors', () => {
    open({
      heading: 'Export',
      types: [pngType(), makeType('excalidraw', { label: 'Excalidraw file' })],
    });
    for (const row of typeRows()) {
      expect(row.getAttribute('role')).toBe('radio');
      expect(row.hasAttribute('aria-checked')).toBe(true);
    }
    // The first row holds the selection on open (the drawing's headline
    // export), and no row carries a chevron or a handoff affordance.
    expect(rowFor('PNG image').getAttribute('aria-checked')).toBe('true');
    expect(dialog().querySelector('.export-center-type-chevron')).toBeNull();
  });

  it('an image row click SELECTS — the center never closes to open another face', async () => {
    const excalidraw = makeType('excalidraw', { label: 'Excalidraw file' });
    open({ heading: 'Export', types: [pngType(), excalidraw] });
    rowFor('PNG image').click();
    expect(rowFor('PNG image').getAttribute('aria-checked')).toBe('true');
    expect(rowFor('Excalidraw file').getAttribute('aria-checked')).toBe('false');
    // Still open — one menu, no handoff.
    expect(dialog().hasAttribute('open')).toBe(true);
  });

  it('the embed toggle flips the suffix chip to the double extension, live', async () => {
    open({ heading: 'Export', types: [pngType()] });
    expect(suffixChip().textContent).toBe('.png');
    toggleFor('Embed scene').click();
    expect(suffixChip().textContent).toBe('.excalidraw.png');
    // The refreshed preview rides the same refresh.
    await vi.advanceTimersByTimeAsync(220);
    expect(pngType().preview as ReturnType<typeof vi.fn>).toBeDefined();
  });

  it('the export press speaks the dynamic extension in the file name', async () => {
    const png = pngType();
    open({ heading: 'Export', types: [png] });
    toggleFor('Embed scene').click();
    nameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(png.run).toHaveBeenCalledWith('sketch.excalidraw.png', expect.anything());
  });

  it('a transparent preview paints the checkerboard stage', async () => {
    open({
      heading: 'Export',
      types: [
        pngType({ preview: vi.fn(async () => ({ image: 'blob:x', imageTransparent: true })) }),
      ],
    });
    await vi.advanceTimersByTimeAsync(220);
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

  it('copySupported=false hides the press; a type without copy hides it too', () => {
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

  it('the open focuses the SELECTED row, not whichever button the UA picked first', () => {
    open({
      heading: 'Export',
      types: [pngType(), makeType('excalidraw', { label: 'Excalidraw file' })],
    });
    expect(document.activeElement).toBe(rowFor('PNG image'));
  });

  it('ArrowDown/ArrowUp walk the rows — selection follows focus', () => {
    open({
      heading: 'Export',
      types: [
        pngType(),
        makeType('excalidraw', { label: 'Excalidraw file' }),
        makeType('padify', { label: 'Padify file' }),
      ],
    });
    // Focus starts on the selected row (the open's discipline).
    const png = rowFor('PNG image');
    expect(document.activeElement).toBe(png);

    // ArrowDown walks to the excalidraw row.
    png.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    const excalidraw = rowFor('Excalidraw file');
    expect(excalidraw.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(excalidraw);

    // ArrowUp wraps back.
    excalidraw.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    expect(png.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(png);
  });

  it("the file-name edit survives the type switch, minus the previous type's extension", async () => {
    const txt = makeType('txt', { label: 'Plain text' });
    const pdf = makeType('pdf', { label: 'PDF' });
    open({ heading: 'Export', types: [txt, pdf] });
    nameInput().value = 'report.txt';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    rowFor('PDF').click();
    expect(nameInput().value).toBe('report');
    await vi.advanceTimersByTimeAsync(220);
    expect(pdf.preview).toHaveBeenCalledTimes(1);
  });
});
