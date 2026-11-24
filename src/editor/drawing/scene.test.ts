/**
 * The drawing scene content model — the Gen-2 persistence contract,
 * pinned.
 *
 * These tests hold the envelope to the retired Drawingpad's rules (the
 * feature reference lives in git history at
 * `f2d83e3^:legacyfeatures/drawingpad.md`): a payload missing a valid elements array
 * is ignored (fresh canvas), the appState subset is a whitelist (never a
 * dump), serialized bytes are deterministic, and elements round-trip
 * VERBATIM — this module never interprets the canvas's schema, the same
 * discipline that lets a newer build's scene arrive and go home intact.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAWING_APP_STATE_KEYS,
  DRAWING_SCENE_SOFT_BUDGET_BYTES,
  DRAWING_SCENE_VERSION,
  drawingSceneByteSize,
  drawingSceneHasContent,
  drawingScenePlainText,
  emptyDrawingScene,
  parseDrawingScene,
  serializeDrawingScene,
  type DrawingScene,
} from './scene';

const rectangle = { id: 'el-1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 };
const textElement = { id: 'el-2', type: 'text', text: 'grocery list', x: 0, y: 0 };

function sampleScene(): DrawingScene {
  return {
    version: DRAWING_SCENE_VERSION,
    savedAt: 1700000000000,
    elements: [rectangle, textElement],
    appState: { viewBackgroundColor: '#ffffff', currentItemStrokeColor: '#1e1e1e' },
  };
}

describe('parseDrawingScene — the fresh-canvas rule', () => {
  it('reads empty and whitespace content as null (a brand-new drawing note)', () => {
    expect(parseDrawingScene('')).toBeNull();
    expect(parseDrawingScene('   ')).toBeNull();
  });

  it('reads junk and truncated JSON as null — never throws', () => {
    expect(parseDrawingScene('not json')).toBeNull();
    expect(parseDrawingScene('{"version":1,"elements":[')).toBeNull();
    expect(parseDrawingScene('null')).toBeNull();
    expect(parseDrawingScene('42')).toBeNull();
    expect(parseDrawingScene('"a string"')).toBeNull();
  });

  it('ignores a payload missing a valid elements array (the Gen-2 contract)', () => {
    expect(parseDrawingScene('{"version":1,"savedAt":1}')).toBeNull();
    expect(parseDrawingScene('{"version":1,"elements":"nope"}')).toBeNull();
    expect(parseDrawingScene('{"version":1,"elements":{}}')).toBeNull();
  });

  it('parses a scene and keeps elements verbatim', () => {
    const scene = parseDrawingScene(serializeDrawingScene(sampleScene()));
    expect(scene).not.toBeNull();
    expect(scene!.elements).toEqual([rectangle, textElement]);
  });

  it('defaults a missing version to the current one and junk savedAt to 0', () => {
    const scene = parseDrawingScene('{"elements":[]}');
    expect(scene!.version).toBe(DRAWING_SCENE_VERSION);
    expect(scene!.savedAt).toBe(0);
  });

  it('passes an unknown future version through untouched — phase 2 migrates, this build stores', () => {
    const future = '{"version":7,"savedAt":9,"elements":[{"id":"x","type":"laser"}],"appState":{}}';
    const scene = parseDrawingScene(future);
    expect(scene!.version).toBe(7);
    expect(scene!.elements).toEqual([{ id: 'x', type: 'laser' }]);
  });
});

describe('the appState whitelist', () => {
  it('keeps whitelisted keys and drops everything else at parse time', () => {
    const scene = parseDrawingScene(
      JSON.stringify({
        version: 1,
        savedAt: 1,
        elements: [],
        appState: {
          viewBackgroundColor: '#ffffff',
          currentItemStrokeColor: '#000000',
          selectedElementIds: { 'el-1': true },
          scrollX: 400,
          collaborators: [],
          someFutureKey: 'kept? no',
        },
      }),
    );
    expect(scene!.appState).toEqual({
      viewBackgroundColor: '#ffffff',
      currentItemStrokeColor: '#000000',
    });
  });

  it('answers an empty record when appState is missing or not an object', () => {
    expect(parseDrawingScene('{"elements":[]}')!.appState).toEqual({});
    expect(parseDrawingScene('{"elements":[],"appState":[]}')!.appState).toEqual({});
    expect(parseDrawingScene('{"elements":[],"appState":"x"}')!.appState).toEqual({});
  });

  it('serializes through the whitelist too — a scene cannot smuggle keys out', () => {
    const out = serializeDrawingScene({
      version: 1,
      savedAt: 1,
      elements: [],
      appState: { currentItemOpacity: 100, scrollY: 999 as unknown as number },
    });
    const parsed = JSON.parse(out) as { appState: Record<string, unknown> };
    expect(parsed.appState).toEqual({ currentItemOpacity: 100 });
  });

  it('carries every Generation-2 tool-default key', () => {
    // The legacy pad's persisted app-state subset, by name: canvas
    // background, stroke/background colors, fill style, stroke width and
    // style, roughness, opacity, font family and size, text align, start
    // and end arrowheads, roundness (edge kind), grid size, grid mode.
    // The stroke width rides the vendor's NUMERIC key (the stable
    // vendor's own spelling — scene-pin pins it).
    expect(DRAWING_APP_STATE_KEYS).toContain('viewBackgroundColor');
    expect(DRAWING_APP_STATE_KEYS).toContain('currentItemStartArrowhead');
    expect(DRAWING_APP_STATE_KEYS).toContain('currentItemEndArrowhead');
    expect(DRAWING_APP_STATE_KEYS).toContain('gridSize');
    expect(DRAWING_APP_STATE_KEYS).toContain('gridModeEnabled');
  });

  it('migrates the interim build’s named strokeWidth bytes to the numeric key at parse', () => {
    // The interim master snapshot wrote scenes under the named key; the
    // stable vendor answers the numeric one (STROKE_WIDTH: thin=1,
    // bold=2, extraBold=4 — the numbers carry the same visual weight).
    // The translation runs inside parse, so the fed bytes and the live
    // appState agree canonically and "open never writes" stays true.
    for (const [name, numeric] of [
      ['thin', 1],
      ['medium', 2],
      ['bold', 4],
    ] as const) {
      const bytes = JSON.stringify({
        version: 1,
        savedAt: 1,
        elements: [],
        appState: { currentItemStrokeWidthKey: name, currentItemOpacity: 100 },
      });
      const scene = parseDrawingScene(bytes)!;
      expect(scene.appState.currentItemStrokeWidth, `interim "${name}"`).toBe(numeric);
      expect(scene.appState).not.toHaveProperty('currentItemStrokeWidthKey');
    }
  });

  it('legacy numeric strokeWidth bytes are already canonical — they parse untouched', () => {
    // Pre-master scenes carried the numeric key, and the stable vendor
    // answers the same key: no translation, byte-exact round trips.
    const bytes = JSON.stringify({
      version: 1,
      savedAt: 1,
      elements: [],
      appState: { currentItemStrokeWidth: 2, currentItemOpacity: 100 },
    });
    const scene = parseDrawingScene(bytes)!;
    expect(scene.appState.currentItemStrokeWidth).toBe(2);
    expect(serializeDrawingScene(scene)).toBe(bytes);
  });

  it('the stroke-width translation is idempotent — translated bytes parse untouched', () => {
    const interim = JSON.stringify({
      version: 1,
      savedAt: 1,
      elements: [],
      appState: { currentItemStrokeWidthKey: 'bold' },
    });
    const scene = parseDrawingScene(interim)!;
    expect(scene.appState.currentItemStrokeWidth).toBe(4);
    // And the translated scene serializes to bytes that parse back equal —
    // the named key is gone, the numeric key is the only spelling left.
    const canonical = serializeDrawingScene(scene);
    expect(canonical).not.toContain('currentItemStrokeWidthKey');
    const reparsed = parseDrawingScene(canonical)!;
    expect(reparsed.appState).toEqual(scene.appState);
  });

  it('un-mappable stroke-width values fall back by omission, never junk', () => {
    // An unknown NAMED value cannot be translated — the key stays unset
    // and the vendor applies its own default, the same degradation
    // restoreAppState performs for a null match.
    const bytes = JSON.stringify({
      version: 1,
      savedAt: 1,
      elements: [],
      appState: { currentItemStrokeWidthKey: 'ultra' },
    });
    const scene = parseDrawingScene(bytes)!;
    expect(scene.appState).not.toHaveProperty('currentItemStrokeWidthKey');
    expect(scene.appState).not.toHaveProperty('currentItemStrokeWidth');
  });
});

describe('serializeDrawingScene — deterministic bytes', () => {
  it('round-trips a scene through its own serialize/parse pair', () => {
    const scene = sampleScene();
    const out = parseDrawingScene(serializeDrawingScene(scene));
    expect(out).toEqual(scene);
  });

  it('serializes identical scenes to identical bytes', () => {
    const a = serializeDrawingScene(sampleScene());
    const b = serializeDrawingScene(sampleScene());
    expect(a).toBe(b);
  });

  it('stamps the current version when a scene carries none', () => {
    const out = serializeDrawingScene({ ...emptyDrawingScene(), version: 0 });
    expect((JSON.parse(out) as { version: number }).version).toBe(DRAWING_SCENE_VERSION);
  });

  it('serializes the empty scene as the note-content twin of parse(null)', () => {
    const out = serializeDrawingScene(emptyDrawingScene());
    expect(parseDrawingScene(out)!.elements).toEqual([]);
  });
});

describe('drawingSceneHasContent — the "anything to lose" answer', () => {
  it('is false for empty and unparseable content, true when elements exist', () => {
    expect(drawingSceneHasContent('')).toBe(false);
    expect(drawingSceneHasContent('junk')).toBe(false);
    expect(drawingSceneHasContent(serializeDrawingScene(emptyDrawingScene()))).toBe(false);
    expect(drawingSceneHasContent(serializeDrawingScene(sampleScene()))).toBe(true);
  });
});

describe('drawingScenePlainText — the plain-text projection', () => {
  it('reads text elements as the words (the pill counts annotations)', () => {
    const scene = {
      version: 1,
      savedAt: 1,
      elements: [rectangle, textElement, { id: 'el-3', type: 'text', text: 'call the dentist' }],
      appState: {},
    };
    expect(drawingScenePlainText(serializeDrawingScene(scene))).toBe(
      'grocery list\ncall the dentist',
    );
  });

  it('reads a textless scene as its element count — never as empty', () => {
    const scene = { version: 1, savedAt: 1, elements: [rectangle], appState: {} };
    expect(drawingScenePlainText(serializeDrawingScene(scene))).toBe('Drawing — 1 element');
    const two = { ...scene, elements: [rectangle, rectangle] };
    expect(drawingScenePlainText(serializeDrawingScene(two))).toBe('Drawing — 2 elements');
  });

  it('reads an empty scene as empty (prompts may treat it as safe)', () => {
    expect(drawingScenePlainText('')).toBe('');
    expect(drawingScenePlainText(serializeDrawingScene(emptyDrawingScene()))).toBe('');
  });

  it('reads unparseable-but-nonempty content as its raw bytes (the opaque discipline)', () => {
    expect(drawingScenePlainText('{"version":9,')).toBe('{"version":9,');
  });

  it('skips text elements whose text is empty or not a string', () => {
    const scene = {
      version: 1,
      savedAt: 1,
      elements: [
        { id: 'a', type: 'text', text: '   ' },
        { id: 'b', type: 'text', text: 42 },
      ],
      appState: {},
    };
    expect(drawingScenePlainText(serializeDrawingScene(scene))).toBe('Drawing — 2 elements');
  });
});

describe('drawingSceneByteSize — the budget check', () => {
  it('measures UTF-8 bytes the way the wire will', () => {
    // ASCII is 1 byte per char; the CJK note in cloud/sync.ts's size
    // notes is the reason this helper exists at all.
    expect(drawingSceneByteSize('abc')).toBe(3);
    expect(drawingSceneByteSize('図')).toBe(3);
  });

  it('keeps the soft budget three orders under the wire cap', () => {
    expect(DRAWING_SCENE_SOFT_BUDGET_BYTES).toBeLessThan(2_000_000);
  });
});
