import { describe, expect, it } from 'vitest';
import {
  PADIFY_FILE_TYPE,
  PADIFY_FORMAT_VERSION,
  PADIFY_GENERATOR,
  buildExcalidrawFile,
  excalidrawFileName,
  noteFileStem,
  padifyFileName,
  parseExcalidrawFile,
  parsePadifyFile,
  prepareImportedNote,
  serializePadifyNoteFile,
  type PadifyNotePayload,
} from './padify-file';
import { parseDrawingScene } from './editor/drawing/scene';

const FIXED_NOW = 1_737_200_000_000;

function sampleNote(overrides: Partial<PadifyNotePayload> = {}): PadifyNotePayload {
  return {
    name: 'Groceries',
    noteType: 'standard',
    content: '<p>milk &amp; eggs</p>',
    createdAt: 1_737_100_000_000,
    updatedAt: 1_737_150_000_000,
    ...overrides,
  };
}

describe('serializePadifyNoteFile', () => {
  it('writes the strict envelope with fixed key order', () => {
    const text = serializePadifyNoteFile(sampleNote(), FIXED_NOW);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['type', 'format', 'generator', 'exportedAt', 'note']);
    expect(Object.keys(parsed.note as object)).toEqual([
      'name',
      'noteType',
      'content',
      'createdAt',
      'updatedAt',
    ]);
    expect(parsed.type).toBe(PADIFY_FILE_TYPE);
    expect(parsed.format).toBe(PADIFY_FORMAT_VERSION);
    expect(parsed.generator).toBe(PADIFY_GENERATOR);
    expect(parsed.exportedAt).toBe(FIXED_NOW);
  });

  it('is deterministic — identical notes serialize to identical bytes', () => {
    const a = serializePadifyNoteFile(sampleNote(), FIXED_NOW);
    const b = serializePadifyNoteFile(sampleNote(), FIXED_NOW);
    expect(a).toBe(b);
  });

  it('round-trips every known note kind untouched', () => {
    const cases: PadifyNotePayload[] = [
      sampleNote(), // standard — the sanitized-HTML subset
      sampleNote({ noteType: 'rich', content: '<p><strong>bold</strong></p>' }),
      sampleNote({ noteType: 'markdown', content: '# Title\n\n- milk\n- eggs' }),
      sampleNote({
        noteType: 'tasks',
        content: JSON.stringify({ version: 1, rows: [{ text: 'call the dentist' }] }),
      }),
      sampleNote({
        noteType: 'drawing',
        content: JSON.stringify({
          version: 1,
          savedAt: 5,
          elements: [{ id: 'a', type: 'rectangle' }],
          appState: { viewBackgroundColor: '#ffffff' },
        }),
      }),
      // An unknown type from a newer build rides verbatim — forward compat.
      sampleNote({ noteType: 'whiteboard-3d', content: '{"future":true}' }),
    ];
    for (const note of cases) {
      const back = parsePadifyFile(serializePadifyNoteFile(note, FIXED_NOW));
      expect(back).toEqual({ kind: 'padify', note });
    }
  });
});

describe('parsePadifyFile', () => {
  it('refuses a newer format version with the honest answer', () => {
    const newer = JSON.stringify({
      type: PADIFY_FILE_TYPE,
      format: PADIFY_FORMAT_VERSION + 1,
      generator: 'padify',
      exportedAt: FIXED_NOW,
      note: { name: null, noteType: 'standard', content: 'x', createdAt: 0, updatedAt: 0 },
    });
    expect(parsePadifyFile(newer)).toEqual({
      kind: 'newer-format',
      format: PADIFY_FORMAT_VERSION + 1,
    });
  });

  it('answers null for junk, foreign files and missing parts', () => {
    expect(parsePadifyFile('')).toBe(null);
    expect(parsePadifyFile('not json at all')).toBe(null);
    expect(parsePadifyFile('[]')).toBe(null);
    expect(parsePadifyFile('42')).toBe(null);
    expect(parsePadifyFile('{"hello":"world"}')).toBe(null);
    // The vendor's file is NOT ours — it goes through the Excalidraw door.
    expect(parsePadifyFile('{"type":"excalidraw","elements":[]}')).toBe(null);
    // A note without string content is not a note this build can hold.
    expect(
      parsePadifyFile(
        JSON.stringify({
          type: PADIFY_FILE_TYPE,
          format: 1,
          note: { name: null, noteType: 'standard', content: 7, createdAt: 0, updatedAt: 0 },
        }),
      ),
    ).toBe(null);
  });

  it('defaults a missing noteType to the standard note and a bad name to null', () => {
    const handWritten = JSON.stringify({
      type: PADIFY_FILE_TYPE,
      format: 1,
      note: { content: 'just text' },
    });
    const back = parsePadifyFile(handWritten);
    expect(back).not.toBe(null);
    if (back?.kind === 'padify') {
      expect(back.note.noteType).toBe('standard');
      expect(back.note.name).toBe(null);
      expect(back.note.content).toBe('just text');
    }
  });
});

describe('prepareImportedNote', () => {
  const passthrough = (html: string): string => `<clean>${html}</clean>`;

  it('sanitizes html content kinds and only those', () => {
    const html = prepareImportedNote(sampleNote(), passthrough);
    expect(html.content).toBe('<clean><p>milk &amp; eggs</p></clean>');

    const markdown = prepareImportedNote(
      sampleNote({ noteType: 'markdown', content: '# raw <b>stays</b>' }),
      passthrough,
    );
    expect(markdown.content).toBe('# raw <b>stays</b>');

    const drawing = prepareImportedNote(
      sampleNote({ noteType: 'drawing', content: '{"elements":[]}' }),
      passthrough,
    );
    expect(drawing.content).toBe('{"elements":[]}');

    // Unknown-but-well-formed ids stay themselves; their content rides.
    const future = prepareImportedNote(
      sampleNote({ noteType: 'whiteboard-3d', content: '{"future":true}' }),
      passthrough,
    );
    expect(future.noteType).toBe('whiteboard-3d');
    expect(future.content).toBe('{"future":true}');
  });

  it('normalizes malformed type ids to the default note', () => {
    const junk = prepareImportedNote(sampleNote({ noteType: 'not a valid id!' }), passthrough);
    expect(junk.noteType).toBe('standard');
  });

  it('keeps a real name and drops a blank one', () => {
    expect(prepareImportedNote(sampleNote(), passthrough).name).toBe('Groceries');
    expect(prepareImportedNote(sampleNote({ name: '   ' }), passthrough).name).toBe(null);
    expect(prepareImportedNote(sampleNote({ name: null }), passthrough).name).toBe(null);
  });
});

describe('the Excalidraw bridge', () => {
  const nativeFile = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: false },
      { id: 'b', type: 'text', text: 'hello', isDeleted: false },
    ],
    appState: { viewBackgroundColor: '#fafafa', junkThatIsNotContent: true },
  });

  it("folds a native file into this build's scene envelope", () => {
    const back = parseExcalidrawFile(nativeFile, FIXED_NOW);
    expect(back).not.toBe(null);
    if (back?.kind !== 'scene') return;
    const scene = parseDrawingScene(back.content);
    expect(scene).not.toBe(null);
    expect(scene?.version).toBe(1);
    expect(scene?.savedAt).toBe(FIXED_NOW);
    expect(scene?.elements).toHaveLength(2);
    // The appState rode the whitelist — the junk key is gone.
    expect(scene?.appState).toEqual({ viewBackgroundColor: '#fafafa' });
  });

  it('refuses scenes with embedded bitmaps instead of losing them', () => {
    const withFiles = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      files: { blobId: { mimeType: 'image/png', dataURL: 'data:…' } },
    });
    expect(parseExcalidrawFile(withFiles, FIXED_NOW)).toEqual({ kind: 'embedded-images' });
    // An EMPTY files map is the vendor's own "no assets" shape — it passes.
    const emptyFiles = JSON.stringify({ type: 'excalidraw', elements: [], files: {} });
    expect(parseExcalidrawFile(emptyFiles, FIXED_NOW)?.kind).toBe('scene');
  });

  it('answers null for anything that is not a native file', () => {
    expect(parseExcalidrawFile('', FIXED_NOW)).toBe(null);
    expect(parseExcalidrawFile('{{', FIXED_NOW)).toBe(null);
    // Our own scene envelope (no `type: "excalidraw"`) is not a native file.
    expect(parseExcalidrawFile('{"version":1,"elements":[]}', FIXED_NOW)).toBe(null);
    expect(parseExcalidrawFile('{"type":"something-else","elements":[]}', FIXED_NOW)).toBe(null);
  });

  it('round-trips: build → parse keeps the elements and the whitelisted appState', () => {
    const scene = parseDrawingScene(
      JSON.stringify({
        version: 1,
        savedAt: 3,
        elements: [{ id: 'z', type: 'ellipse', isDeleted: false }],
        appState: { gridSize: 20 },
      }),
    )!;
    const native = buildExcalidrawFile(scene);
    const parsed = JSON.parse(native) as { type: string; elements: unknown[]; appState: unknown };
    expect(parsed.type).toBe('excalidraw');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.appState).toEqual({ gridSize: 20 });

    const back = parseExcalidrawFile(native, FIXED_NOW);
    expect(back?.kind).toBe('scene');
    if (back?.kind === 'scene') {
      expect(parseDrawingScene(back.content)?.elements).toHaveLength(1);
    }
  });
});

describe('file names', () => {
  it('sanitizes the stem and falls back when there is nothing to keep', () => {
    expect(noteFileStem('Groceries', 'Notes-21-11-2026')).toBe('Groceries');
    expect(noteFileStem('  a/b\\c:d*e?f"g<h>i|j  ', 'fb')).toBe('a b c d e f g h i j');
    expect(noteFileStem('   ', 'Notes-21-11-2026')).toBe('Notes-21-11-2026');
    expect(noteFileStem(null, 'Notes-21-11-2026')).toBe('Notes-21-11-2026');
    expect(noteFileStem('.hidden', 'fb')).toBe('hidden');
    expect(noteFileStem('.hidden.', 'fb')).toBe('hidden');
    expect(noteFileStem('x'.repeat(200), 'fb')).toHaveLength(80);
  });

  it('appends the right extension per format', () => {
    expect(padifyFileName('Groceries', 'Notes-1')).toBe('Groceries.padify');
    expect(excalidrawFileName('Sketch', 'Notes-1')).toBe('Sketch.excalidraw');
    expect(padifyFileName(null, 'Notes-21-11-2026')).toBe('Notes-21-11-2026.padify');
  });
});
