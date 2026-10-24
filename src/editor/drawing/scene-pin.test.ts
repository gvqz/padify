/**
 * The format pin — the scene contract against the PINNED vendor version.
 *
 * DRAWING_APP_STATE_KEYS (scene.ts) is the one list that decides which
 * parts of Excalidraw's appState persist into a note. Its key names are
 * the vendor's, so the pin is exactly one question: does the installed
 * @excalidraw/excalidraw still spell its appState the way the whitelist
 * expects? A vendor rename (the day `currentItemFontSize` becomes
 * `defaultFontSize`) must fail HERE — at the seam — instead of silently
 * dropping the user's tool defaults from every future save.
 *
 * WHY THE IMPORT IS DEFERRED AND SHIMMED: the vendor's module probes
 * `"filter" in canvas.getContext("2d")` at import time, and jsdom has no
 * 2D canvas — the probe must see a context before the module loads. The
 * shim answers a minimal stub (the vendor's own feature flag goes to
 * "not supported", which is exactly how the real canvas behaves without
 * CSS filters); `restore`/`serializeAsJSON` themselves are pure data
 * code and never touch it. Everything imports inside beforeAll, after
 * the shim; nothing else in the suite loads the real package (the
 * surface tests meet the vendor behind the './canvas' mock).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DRAWING_APP_STATE_KEYS,
  DRAWING_SCENE_VERSION,
  drawingScenePlainText,
  parseDrawingScene,
  serializeDrawingScene,
} from './scene';

let restoreVendorDefaults: () => { appState: Record<string, unknown> };
let vendorSerialize: (elements: never[], appState: never, files: never, type: 'local') => string;

beforeAll(async () => {
  const canvasProto = HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  const originalGetContext = canvasProto.getContext.bind(
    document.createElement('canvas'),
  ) as never as (type: string) => unknown;
  canvasProto.getContext = function patched(type: string): unknown {
    const context = originalGetContext.call(this, type);
    if (context) return context;
    return type === '2d' ? { filter: 'none', canvas: this } : null;
  };

  const vendor = await import('@excalidraw/excalidraw');
  restoreVendorDefaults = () =>
    vendor.restore(null, null, null) as { appState: Record<string, unknown> };
  vendorSerialize = vendor.serializeAsJSON;
});

describe('the appState whitelist pins against the installed Excalidraw', () => {
  it('every whitelisted key exists in the vendor’s default appState', () => {
    // restore(null, …) is the vendor's "give me the defaults" entry.
    const restored = restoreVendorDefaults();
    const keys = Object.keys(restored.appState);
    const missing = DRAWING_APP_STATE_KEYS.filter((key) => !keys.includes(key));
    expect(missing, 'whitelist keys the installed Excalidraw no longer carries').toEqual([]);
  });

  it('the vendor’s default values survive the whitelist round trip verbatim', () => {
    const restored = restoreVendorDefaults();
    const whitelisted: Record<string, unknown> = {};
    for (const key of DRAWING_APP_STATE_KEYS) {
      whitelisted[key] = restored.appState[key];
    }
    const content = serializeDrawingScene({
      version: DRAWING_SCENE_VERSION,
      savedAt: 123,
      elements: [],
      appState: whitelisted,
    });
    const parsed = parseDrawingScene(content);
    expect(parsed).not.toBeNull();
    for (const key of DRAWING_APP_STATE_KEYS) {
      expect(parsed!.appState[key], `key ${key}`).toStrictEqual(whitelisted[key]);
    }
  });

  it('the vendor’s own serializer agrees on every whitelisted key it keeps', () => {
    // The surface reads the LIVE appState at save time; this cross-check
    // pins that the vendor's export path and the whitelist name the same
    // keys — the shapes cannot drift apart without this failing.
    const restored = restoreVendorDefaults();
    const vendorJson = vendorSerialize([], restored.appState as never, {} as never, 'local');
    const vendorPayload = JSON.parse(vendorJson) as {
      elements: unknown[];
      appState: Record<string, unknown>;
    };
    expect(Array.isArray(vendorPayload.elements)).toBe(true);
    const throughEnvelope = parseDrawingScene(
      serializeDrawingScene({
        version: DRAWING_SCENE_VERSION,
        savedAt: 1,
        elements: vendorPayload.elements as never,
        appState: vendorPayload.appState,
      }),
    );
    expect(throughEnvelope).not.toBeNull();
    for (const [key, value] of Object.entries(vendorPayload.appState)) {
      if (DRAWING_APP_STATE_KEYS.includes(key)) {
        expect(throughEnvelope!.appState[key]).toStrictEqual(value);
      }
    }
  });

  it('text elements the vendor spells keep projecting as the note’s words', () => {
    // The plain-text projection reads element.type === 'text' and .text —
    // the projection and the vendor's element schema must stay in step.
    const content = serializeDrawingScene({
      version: DRAWING_SCENE_VERSION,
      savedAt: 1,
      elements: [
        {
          id: 't1',
          type: 'text',
          text: 'grocery list',
          x: 0,
          y: 0,
        },
      ],
      appState: {},
    });
    expect(drawingScenePlainText(content)).toBe('grocery list');
  });
});
