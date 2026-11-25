import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openExportCenter,
  type ExportCenterHost,
  type ExportCenterType,
  type ExportCenterExporterType,
} from './export-center';

/**
 * The export center's refinement pass, unit-grade (the e2e owns the
 * integrated face):
 *
 *   - the GROUPS carry their labels (Images / File types / The pad
 *     itself) — the grouping is semantics, not a mystery hairline;
 *   - the type list speaks RADIO: the selectable rows answer role=radio
 *     + aria-checked, the launcher rows carry no pressed state at all
 *     (a door is never checked);
 *   - the keyboard is native: ArrowDown/ArrowUp walk the selectable
 *     rows (selection follows focus), Enter in the name field is an
 *     Export;
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

const makeType = (
  id: string,
  over: Partial<ExportCenterExporterType> = {},
): ExportCenterExporterType =>
  ({
    id,
    label: id.toUpperCase(),
    extension: id,
    defaultStem: `note-${id}`,
    preview: vi.fn(async () => ({ text: `preview of ${id}` })),
    run: vi.fn(async () => true),
    ...over,
  }) as ExportCenterExporterType;

const pngLauncher: ExportCenterType = {
  id: 'image-png',
  label: 'PNG image',
  extension: 'png',
  hint: 'A raster image — the full options dialog opens',
  launch: vi.fn(),
};

const svgLauncher: ExportCenterType = {
  id: 'image-svg',
  label: 'SVG image',
  extension: 'svg',
  hint: 'A vector image — the full options dialog opens',
  launch: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function open(host: ExportCenterHost): void {
  openExportCenter(host);
}

describe('the export center — the refinement pass', () => {
  it('the groups carry their labels: Images, File types, The pad itself', () => {
    open({
      heading: 'Export',
      types: [
        pngLauncher,
        svgLauncher,
        makeType('excalidraw', { label: 'Excalidraw file' }),
        makeType('padify', { label: 'Padify file' }),
        makeType('workspace', { section: 'pad' }),
      ],
    });
    expect(groupLabels()).toEqual(['Images', 'This note', 'The pad itself']);
  });

  it("a text note's groups: File types, The pad itself", () => {
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

  it('the selectable rows speak radio (role + aria-checked); the launcher rows never', () => {
    open({
      heading: 'Export',
      types: [pngLauncher, makeType('excalidraw', { label: 'Excalidraw file' })],
    });
    expect(rowFor('Excalidraw file')?.getAttribute('role')).toBe('radio');
    expect(rowFor('Excalidraw file')?.getAttribute('aria-checked')).toBe('true');
    expect(rowFor('PNG image')?.getAttribute('role')).toBeNull();
    expect(rowFor('PNG image')?.getAttribute('aria-checked')).toBeNull();
    expect(rowFor('PNG image')?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('the open focuses the SELECTED row, not whichever button the UA picked first', () => {
    open({
      heading: 'Export',
      types: [
        pngLauncher,
        makeType('excalidraw', { label: 'Excalidraw file' }),
        makeType('padify', { label: 'Padify file' }),
      ],
    });
    expect(document.activeElement).toBe(rowFor('Excalidraw file'));
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

  it('ArrowDown/ArrowUp walk the SELECTABLE rows — selection follows focus, launchers skipped', () => {
    open({
      heading: 'Export',
      types: [
        pngLauncher,
        svgLauncher,
        makeType('excalidraw', { label: 'Excalidraw file' }),
        makeType('padify', { label: 'Padify file' }),
      ],
    });
    // Focus starts on the selected row (the open's discipline).
    const excalidraw = rowFor('Excalidraw file');
    expect(document.activeElement).toBe(excalidraw);

    // ArrowDown from the first selectable row wraps to the LAST (the
    // padify note file), never the launchers between.
    excalidraw.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    const padify = rowFor('Padify file');
    expect(padify.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(padify);

    // ArrowUp walks back, wrapping the other way.
    padify.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    expect(excalidraw.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(excalidraw);
  });

  it('a launcher click hands off once — the center closes its face and the door opens', () => {
    const launch = vi.fn();
    open({
      heading: 'Export',
      types: [
        {
          id: 'image-png',
          label: 'PNG image',
          extension: 'png',
          launch,
        },
      ],
    });
    rowFor('PNG image').click();
    expect(launch).toHaveBeenCalledTimes(1);
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
