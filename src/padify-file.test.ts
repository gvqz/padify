import { describe, expect, it } from 'vitest';
import {
  PADIFY_FILE_TYPE,
  PADIFY_FORMAT_VERSION,
  PADIFY_GENERATOR,
  base64ToBytes,
  buildExcalidrawFile,
  bytesToBase64,
  excalidrawFileName,
  noteFileStem,
  padifyFileName,
  parseExcalidrawFile,
  parsePadifyFile,
  prepareImportedNote,
  serializePadifyNoteFile,
  type PadifyFileAttachment,
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
      expect(back).toEqual({ kind: 'padify', note, attachments: [] });
    }
  });

  it('omits the attachments key entirely when the note carries no images', () => {
    // The additive v1 extension: an imageless note's envelope is
    // byte-identical to the pre-images writer's — an older build opens
    // it without ever learning the field existed.
    const parsed = JSON.parse(serializePadifyNoteFile(sampleNote(), FIXED_NOW)) as Record<
      string,
      unknown
    >;
    expect('attachments' in parsed).toBe(false);
  });

  it('round-trips embedded attachments — the note AND its bytes', () => {
    const original = new TextEncoder().encode('png-bytes-here');
    const attachments: PadifyFileAttachment[] = [
      {
        id: 'att-0123456789abcdef01234567',
        name: 'shot.png',
        mime: 'image/png',
        bytes: bytesToBase64(original),
      },
    ];
    const text = serializePadifyNoteFile(
      sampleNote({
        noteType: 'markdown',
        content: '![s](padify-att:att-0123456789abcdef01234567)',
      }),
      FIXED_NOW,
      attachments,
    );
    const back = parsePadifyFile(text);
    expect(back).not.toBeNull();
    if (back?.kind !== 'padify') return;
    expect(back.attachments).toHaveLength(1);
    expect(back.attachments[0]!.id).toBe('att-0123456789abcdef01234567');
    expect(back.attachments[0]!.name).toBe('shot.png');
    expect(back.attachments[0]!.mime).toBe('image/png');
    expect([...(base64ToBytes(back.attachments[0]!.bytes) ?? [])]).toEqual([...original]);
    // The note's content (with its references) rode untouched.
    expect(back.note.content).toBe('![s](padify-att:att-0123456789abcdef01234567)');
  });

  it('validates embedded attachments — junk entries drop, the file survives', () => {
    const envelope = JSON.stringify({
      type: PADIFY_FILE_TYPE,
      format: PADIFY_FORMAT_VERSION,
      generator: PADIFY_GENERATOR,
      exportedAt: FIXED_NOW,
      note: sampleNote(),
      attachments: [
        // valid
        {
          id: 'att-0123456789abcdef01234567',
          name: 'a.png',
          mime: 'image/png',
          bytes: bytesToBase64(new TextEncoder().encode('ok')),
        },
        // junk id (too short)
        { id: 'att-x', name: 'b', mime: 'image/png', bytes: 'aGVsbG8=' },
        // junk mime
        { id: 'att-0123456789abcdef01234568', name: 'c', mime: 'not a mime', bytes: 'aGVsbG8=' },
        // junk base64
        { id: 'att-0123456789abcdef01234569', name: 'd', mime: 'image/png', bytes: 'not base64!!' },
        // empty bytes
        { id: 'att-0123456789abcdef0123456a', name: 'e', mime: 'image/png', bytes: '' },
        // not even an object
        'junk-entry',
      ],
    });
    const back = parsePadifyFile(envelope);
    expect(back).not.toBeNull();
    if (back?.kind !== 'padify') return;
    expect(back.attachments).toHaveLength(1);
    expect(back.attachments[0]!.id).toBe('att-0123456789abcdef01234567');
  });

  it('reads an OLD file (no attachments field) as an empty set', () => {
    const legacy = JSON.stringify({
      type: PADIFY_FILE_TYPE,
      format: 1,
      generator: 'padify',
      exportedAt: FIXED_NOW,
      note: { name: null, noteType: 'markdown', content: 'plain', createdAt: 0, updatedAt: 0 },
    });
    const back = parsePadifyFile(legacy);
    expect(back).toEqual({ kind: 'padify', note: expect.anything(), attachments: [] });
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

  it('admits embedded bitmaps — well-formed entries become attachments, junk drops', () => {
    const withFiles = JSON.stringify({
      type: 'excalidraw',
      elements: [{ id: 'e1', type: 'image', fileId: 'abcdefgh1234', isDeleted: false }],
      files: {
        abcdefgh1234: {
          mimeType: 'image/png',
          dataURL: 'data:image/png;base64,AAAA',
          created: 1,
          lastRetrieved: 2,
        },
        // id too short → drop
        ij: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
        // mime not the store's shape → drop
        klmnopqrst: { mimeType: 'junk!!', dataURL: 'data:image/png;base64,AAAA' },
        // not a base64 data URL → drop
        uvwxyz1234: { mimeType: 'image/png', dataURL: 'not-a-data-url' },
        // empty payload → drop
        badempty11: { mimeType: 'image/png', dataURL: 'data:image/png;base64,' },
      },
    });
    const back = parseExcalidrawFile(withFiles, FIXED_NOW);
    expect(back?.kind).toBe('scene');
    if (back?.kind !== 'scene') return;
    expect(back.attachments).toEqual([
      { id: 'abcdefgh1234', name: 'abcdefgh1234.img', mime: 'image/png', bytes: 'AAAA' },
    ]);
  });

  it('keeps the scene even when every file entry was junk', () => {
    const allJunk = JSON.stringify({
      type: 'excalidraw',
      elements: [{ id: 'e1', type: 'image', fileId: 'ij', isDeleted: false }],
      files: { ij: { mimeType: 'image/png', dataURL: 'data:…' } },
    });
    const back = parseExcalidrawFile(allJunk, FIXED_NOW);
    expect(back?.kind).toBe('scene');
    if (back?.kind !== 'scene') return;
    expect(back.attachments).toEqual([]);
  });

  it('drops an over-cap entry and keeps the rest', () => {
    // 'A'.repeat(6_700_000) decodes to 5_025_000 bytes — over the ceiling.
    const bigPayload = 'A'.repeat(6_700_000);
    const withFiles = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      files: {
        abcdefgh1234: { mimeType: 'image/png', dataURL: `data:image/png;base64,${bigPayload}` },
        bbcdefgh1234: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
      },
    });
    const back = parseExcalidrawFile(withFiles, FIXED_NOW);
    if (back?.kind !== 'scene') return;
    expect(back.attachments.map((a) => a.id)).toEqual(['bbcdefgh1234']);
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
    const parsed = JSON.parse(native) as {
      type: string;
      elements: unknown[];
      appState: unknown;
      files?: unknown;
    };
    expect(parsed.type).toBe('excalidraw');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.appState).toEqual({ gridSize: 20 });
    // No attachments → no files field at all (the vendor's "no assets").
    expect(parsed.files).toBeUndefined();

    const back = parseExcalidrawFile(native, FIXED_NOW);
    expect(back?.kind).toBe('scene');
    if (back?.kind === 'scene') {
      expect(back.attachments).toEqual([]);
      expect(parseDrawingScene(back.content)?.elements).toHaveLength(1);
    }
  });

  it('embeds referenced bytes as the vendor files map, and they round-trip', () => {
    const scene = parseDrawingScene(
      JSON.stringify({
        version: 1,
        savedAt: 3,
        elements: [{ id: 'e', type: 'image', fileId: 'abcdefgh1234', isDeleted: false }],
        appState: {},
      }),
    )!;
    const native = buildExcalidrawFile(
      scene,
      [{ id: 'abcdefgh1234', name: 'shot.img', mime: 'image/webp', bytes: 'BBBB' }],
      FIXED_NOW,
    );
    const parsed = JSON.parse(native) as {
      files?: Record<
        string,
        { id: string; mimeType: string; dataURL: string; created: number; lastRetrieved: number }
      >;
    };
    expect(parsed.files?.abcdefgh1234).toEqual({
      id: 'abcdefgh1234',
      mimeType: 'image/webp',
      dataURL: 'data:image/webp;base64,BBBB',
      created: FIXED_NOW,
      lastRetrieved: FIXED_NOW,
    });
    const back = parseExcalidrawFile(native, FIXED_NOW);
    if (back?.kind !== 'scene') return;
    expect(back.attachments).toEqual([
      { id: 'abcdefgh1234', name: 'abcdefgh1234.img', mime: 'image/webp', bytes: 'BBBB' },
    ]);
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
