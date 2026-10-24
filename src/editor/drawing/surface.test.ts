/**
 * The drawing note surface — the canvas lifecycle, pinned.
 *
 * The vendor is mocked ('./canvas' — the lazy island), so these tests pin
 * the SURFACE's half of the contract: the mount lifecycle (wrapper +
 * loading card + lazy import), the announce discipline (the 300 ms
 * trailing debounce, and the equality guard that keeps opens/pans/zooms
 * from ever writing), capture's savedAt stamping and deleted-element
 * filtering, the clear flow (empties the scene, never announces), the
 * reuse path (drawing → drawing keeps the mounted canvas, swaps the
 * scene, clears the history), the teardown (dismiss unmounts, pending
 * announces die), and the read-only refusal for scenes from a newer
 * format version.
 *
 * The registry claims carry over from the scaffold and must still hold:
 * the TYPE-keyed claim, the tasks coexistence, the unknown-type opaque
 * path. The real Excalidraw mount is pinned by the e2e suite
 * (e2e/drawing-canvas.spec.ts); the scene format by scene.test.ts and
 * the vendor pin (scene-pin.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vendor island, faked: every mount lands in the shared `mounts`
// side-channel so tests drive the vendor through its real seam (the
// handle + the options callbacks the surface owns). The one-shot
// `__failNextMount` flag simulates the island crashing mid-mount (the
// surface's .catch must answer with the honest error card).
vi.mock('./canvas', () => {
  const mounts: RecordedMount[] = [];
  let failNextMount = false;
  return {
    mounts,
    mountDrawingCanvas: (
      mount: HTMLElement,
      options: RecordedMount['options'],
    ): RecordedMount['handle'] => {
      if (failNextMount) {
        failNextMount = false;
        throw new Error('canvas island crash');
      }
      const handle: RecordedMount['handle'] = {
        updateScene: vi.fn(),
        clearHistory: vi.fn(),
        rename: vi.fn(),
        scrollToContent: vi.fn(),
        getScene: vi.fn((): { elements: Record<string, unknown>[]; appState: unknown } => ({
          elements: [],
          appState: {},
        })),
        unmount: vi.fn(),
      };
      mounts.push({ mount, options, handle });
      return handle;
    },
    renderDrawingImage: vi.fn(async (kind: 'png' | 'svg') =>
      kind === 'svg' ? '<svg xmlns="x"></svg>' : new Blob(['png-bytes'], { type: 'image/png' }),
    ),
    __resetMounts: (): void => {
      mounts.length = 0;
      failNextMount = false;
    },
    __failNextMount: (): void => {
      failNextMount = true;
    },
  };
});

vi.mock('../../ui/toast', () => ({
  showToast: vi.fn(),
}));

import { showToast } from '../../ui/toast';
// The tasks surface registers itself for the 'json' kind at import time
// — importing it here is what makes the coexistence test honest.
import '../tasks/surface';
import {
  DRAWING_ANNOUNCE_DEBOUNCE_MS,
  DrawingNoteSurface,
  exportActiveDrawingImage,
} from './surface';
import { DRAWING_SCENE_SOFT_BUDGET_BYTES, emptyDrawingScene, serializeDrawingScene } from './scene';
import { noteSurfaceFor, opaqueNoteSurface } from '../surface';

interface RecordedMount {
  mount: HTMLElement;
  options: {
    initialScene: { elements: Record<string, unknown>[]; appState: Record<string, unknown> };
    theme: string;
    name: string;
    onChange: (scene: { elements: Record<string, unknown>[]; appState: unknown }) => void;
    onImagePaste: () => void;
  };
  handle: {
    updateScene: (scene: unknown) => void;
    clearHistory: () => void;
    rename: (name: string) => void;
    scrollToContent: () => void;
    getScene: () => { elements: Record<string, unknown>[]; appState: unknown };
    unmount: () => void;
  };
}

const surface = new DrawingNoteSurface();

const sceneWithElements = serializeDrawingScene({
  version: 1,
  savedAt: 1700000000000,
  elements: [{ id: 'a', type: 'rectangle' }],
  appState: { viewBackgroundColor: '#ffffff' },
});

/** A connected host — the mount guard checks isConnected. */
function connectedHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

// The mocked canvas module, reached through the module registry so the
// test and the surface share the exact same mock instance.
import * as canvasModule from './canvas';
const canvasMock = canvasModule as unknown as {
  mounts: RecordedMount[];
  renderDrawingImage: (kind: 'png' | 'svg', scene: unknown) => Promise<unknown>;
  __resetMounts: () => void;
  __failNextMount: () => void;
};
// The mounts side-channel ships on the mocked module itself.

function lastMount(): RecordedMount {
  const last = canvasMock.mounts.at(-1);
  expect(last, 'a canvas mount happened in this test').toBeDefined();
  return last!;
}

/** Flushes the lazy import so the mount lands before assertions. */
async function canvasReady(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  canvasMock.__resetMounts();
});

afterEach(() => {
  // Real timers drop any pending announce; a cleared body detaches the
  // mounts (the next display stands the stale live down by itself).
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('the registry claim', () => {
  it('drawing notes resolve to the drawing surface (type-keyed, ahead of the json kind)', () => {
    expect(noteSurfaceFor({ content: sceneWithElements, noteType: 'drawing' })).toBeInstanceOf(
      DrawingNoteSurface,
    );
  });

  it('tasks notes keep the tasks surface — two json types coexist', () => {
    const tasks = noteSurfaceFor({ content: '{"tasks":[]}', noteType: 'tasks' });
    expect(tasks).not.toBeInstanceOf(DrawingNoteSurface);
    expect(tasks.editable).toBe(true);
  });

  it('an unknown json type stays opaque — this surface claims only ‘drawing’', () => {
    expect(noteSurfaceFor({ content: '{}', noteType: 'kanban' })).toBe(opaqueNoteSurface);
  });

  it('absent note types still resolve to the html surface (the default note)', () => {
    expect(noteSurfaceFor({ content: '<p>hi</p>' }).kind).toBe('html');
    expect(noteSurfaceFor(null).kind).toBe('html');
  });
});

describe('the canvas state', () => {
  it('is editable — the canvas writes the note (the phase-2 flip)', () => {
    expect(surface.editable).toBe(true);
    expect(surface.kind).toBe('json');
  });
});

describe('display — the mount lifecycle', () => {
  it('mounts the wrapper with a loading card, then the canvas island', async () => {
    const host = connectedHost();
    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });

    expect(host.getAttribute('contenteditable')).toBe('false');
    const wrapper = host.querySelector<HTMLElement>('[data-drawing-canvas]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('.unsupported-note')!.textContent).toContain(
      'Opening the canvas',
    );

    await canvasReady();
    const { options } = lastMount();
    expect(options.initialScene.elements).toEqual([{ id: 'a', type: 'rectangle' }]);
    expect(options.initialScene.appState).toEqual({ viewBackgroundColor: '#ffffff' });
    expect(options.theme).toBe('light');
    expect(options.name).toBe('drawing');
    expect(wrapper!.querySelector('.unsupported-note')).toBeNull(); // loading card gone
  });

  it('an empty note feeds the canvas an empty scene (the Gen-2 fresh-canvas rule)', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    expect(lastMount().options.initialScene.elements).toEqual([]);
  });

  it('junk content also opens the fresh canvas — the payload is ignored, not worshipped', async () => {
    const host = connectedHost();
    surface.display(host, { content: 'not a scene at all', noteType: 'drawing' });
    await canvasReady();
    expect(lastMount().options.initialScene.elements).toEqual([]);
  });

  it('follows the app theme at mount time', async () => {
    document.body.classList.add('dark');
    try {
      const host = connectedHost();
      surface.display(host, { content: '', noteType: 'drawing' });
      await canvasReady();
      expect(lastMount().options.theme).toBe('dark');
    } finally {
      document.body.classList.remove('dark');
    }
  });

  it('a json note of another type takes the opaque card, never the canvas', async () => {
    const host = connectedHost();
    const mountCount = canvasMock.mounts.length;
    surface.display(host, { content: '{"tasks":[]}', noteType: 'tasks' });
    await canvasReady();
    expect(host.querySelector('.unsupported-note')!.textContent).toContain("can't open it yet");
    expect(canvasMock.mounts.length).toBe(mountCount);
  });

  it('a newer format version refuses the canvas — unknown bytes are never editable', async () => {
    const host = connectedHost();
    const newer = serializeDrawingScene({
      version: 9,
      savedAt: 1,
      elements: [{ id: 'x', type: 'rectangle' }],
      appState: {},
    });
    surface.display(host, { content: newer, noteType: 'drawing' });
    await canvasReady();

    const card = host.querySelector('.unsupported-note')!;
    expect(card.textContent).toContain('newer Padify');
    // The opaque discipline for the refused scene: capture stays null, so
    // the bytes can never be rewritten by this build.
    expect(surface.capture(host)).toBeNull();
  });

  it('no note open clears the host and stands the canvas down', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    surface.display(host, null);
    expect(host.textContent).toBe('');
    expect(surface.capture(host)).toBeNull();
  });

  it('an island crash swaps the loading card for an honest error card', async () => {
    canvasMock.__failNextMount();
    const host = connectedHost();
    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });
    await vi.advanceTimersByTimeAsync(10);
    expect(host.querySelector('.unsupported-note')!.textContent).toContain('could not load');
    // The refused note stays honest: with no canvas there is nothing new
    // to save, and capture answers the fed bytes EXACTLY — a save against
    // them is a no-op, never a rewrite.
    expect(surface.capture(host)).toBe(sceneWithElements);
  });
});

describe('the announce contract — debounce + equality guard', () => {
  it('a real edit announces one input event, 300 ms after the last change', async () => {
    const host = connectedHost();
    const inputs: string[] = [];
    host.addEventListener('input', () => inputs.push('input'));

    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    const { options } = lastMount();

    // The vendor fires onChange for every pointer twitch; two rapid ones
    // coalesce into the one trailing announce.
    options.onChange({ elements: [{ id: 'a', type: 'rectangle' }], appState: {} });
    options.onChange({
      elements: [
        { id: 'a', type: 'rectangle' },
        { id: 'b', type: 'ellipse' },
      ],
      appState: {},
    });
    await vi.advanceTimersByTimeAsync(DRAWING_ANNOUNCE_DEBOUNCE_MS - 1);
    expect(inputs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(inputs).toEqual(['input']);
  });

  it('pan/zoom/selection never write — byte-identical scenes stay quiet', async () => {
    const host = connectedHost();
    const inputs: string[] = [];
    host.addEventListener('input', () => inputs.push('input'));

    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });
    await canvasReady();
    const { options } = lastMount();

    // The same scene, re-reported with view-state noise the whitelist
    // drops at serialization: serialize(feed) === fed bytes → no announce.
    options.onChange({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff', scrollX: 999, selectedElementIds: {} },
    });
    await vi.advanceTimersByTimeAsync(DRAWING_ANNOUNCE_DEBOUNCE_MS + 5);
    expect(inputs).toEqual([]);
  });

  it('a pending announce dies with the surface — no event reaches the next painter', async () => {
    const host = connectedHost();
    const inputs: string[] = [];
    host.addEventListener('input', () => inputs.push('input'));

    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    lastMount().options.onChange({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: {},
    });

    surface.dismiss(host); // the painter changes mid-debounce
    await vi.advanceTimersByTimeAsync(DRAWING_ANNOUNCE_DEBOUNCE_MS + 5);
    expect(inputs).toEqual([]);
    expect(lastMount().handle.unmount).toHaveBeenCalled();
  });
});

describe('capture — the savedAt discipline', () => {
  it('answers null before any canvas belongs to this host', () => {
    expect(surface.capture(document.createElement('div'))).toBeNull();
  });

  it('a clean note answers its own fed bytes — opening never writes', async () => {
    const host = connectedHost();
    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });
    await canvasReady();
    // Even after the vendor reports the same scene back (its mount-time
    // onChange), capture must reproduce the fed bytes exactly.
    lastMount().options.onChange({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
    });
    expect(surface.capture(host)).toBe(sceneWithElements);
  });

  it('a changed scene answers fresh bytes with a new savedAt stamp', async () => {
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    lastMount().options.onChange({
      elements: [{ id: 'a', type: 'rectangle', text: 'hi' }],
      appState: {},
    });

    const captured = surface.capture(host);
    expect(captured).not.toBeNull();
    const parsed = JSON.parse(captured!) as { savedAt: number; elements: unknown[] };
    expect(parsed.savedAt).toBe(Date.now());
    expect(parsed.elements).toEqual([{ id: 'a', type: 'rectangle', text: 'hi' }]);
  });

  it('deleted elements (the undo ghost trail) never persist', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    lastMount().options.onChange({
      elements: [
        { id: 'a', type: 'rectangle' },
        { id: 'ghost', type: 'rectangle', isDeleted: true },
      ],
      appState: {},
    });
    const parsed = JSON.parse(surface.capture(host)!) as { elements: { id: string }[] };
    expect(parsed.elements.map((element) => element.id)).toEqual(['a']);
  });

  it('warns once when a scene passes the soft byte budget, then resets', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();

    const oversizedElements = () => [
      { id: 'a', type: 'text', text: 'x'.repeat(DRAWING_SCENE_SOFT_BUDGET_BYTES) },
    ];
    lastMount().options.onChange({ elements: oversizedElements(), appState: {} });
    expect(surface.capture(host)!.length).toBeGreaterThan(DRAWING_SCENE_SOFT_BUDGET_BYTES);
    expect(showToast).toHaveBeenCalledTimes(1);

    // Back under budget the flag resets — a future trip warns again.
    lastMount().options.onChange({ elements: [{ id: 'a', type: 'rectangle' }], appState: {} });
    void surface.capture(host);
    lastMount().options.onChange({ elements: oversizedElements(), appState: {} });
    void surface.capture(host);
    expect(showToast).toHaveBeenCalledTimes(2);
  });
});

describe('commit / clear / focus — the note lifecycle', () => {
  it('commit repaints from fresh bytes through the mounted canvas', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();

    const applied = surface.commit(host, sceneWithElements);
    expect(applied).toBe(false); // the caller owns the persist
    const { handle } = lastMount();
    expect(handle.updateScene).toHaveBeenCalledWith({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
    });
    // The repaint is quiet: feeding fresh bytes never announces.
    const inputs: string[] = [];
    host.addEventListener('input', () => inputs.push('input'));
    await vi.advanceTimersByTimeAsync(DRAWING_ANNOUNCE_DEBOUNCE_MS + 5);
    expect(inputs).toEqual([]);
  });

  it('clear empties the scene without announcing — the confirmed flow owns the persist', async () => {
    const host = connectedHost();
    const inputs: string[] = [];
    host.addEventListener('input', () => inputs.push('input'));
    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });
    await canvasReady();

    surface.clear(host);
    const { handle } = lastMount();
    expect(handle.updateScene).toHaveBeenCalledWith({ elements: [], appState: {} });
    expect(handle.clearHistory).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DRAWING_ANNOUNCE_DEBOUNCE_MS + 5);
    expect(inputs).toEqual([]); // the manager wrote '' — the surface never double-writes
  });

  it('clear with no mounted canvas paints the empty state', () => {
    const host = connectedHost();
    surface.display(host, null);
    surface.clear(host);
    expect(host.querySelector('[data-drawing-canvas]')).not.toBeNull();
  });

  it('focusTarget answers the canvas wrapper (focusable while loading)', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    const wrapper = host.querySelector<HTMLElement>('[data-drawing-canvas]')!;
    expect(surface.focusTarget(host)).toBe(wrapper);
    await canvasReady();
    expect(surface.focusTarget(host)).toBe(wrapper);
  });

  it('reuse: drawing → drawing keeps the canvas, swaps the scene, clears the history', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing', id: 'n1', name: 'One' });
    await canvasReady();
    const mountCount = canvasMock.mounts.length;

    surface.display(host, {
      content: sceneWithElements,
      noteType: 'drawing',
      id: 'n2',
      name: 'Two',
    });
    expect(canvasMock.mounts.length).toBe(mountCount); // no remount
    const { handle } = lastMount();
    expect(handle.updateScene).toHaveBeenCalledWith({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
    });
    expect(handle.clearHistory).toHaveBeenCalled();
    expect(handle.rename).toHaveBeenCalledWith('Two');
  });
});

describe('visibleText — the projection stays the model’s', () => {
  it('reads text elements as the note’s words', () => {
    const scene = serializeDrawingScene({
      version: 1,
      savedAt: 1,
      elements: [{ id: 't', type: 'text', text: 'sketch of the idea' }],
      appState: {},
    });
    expect(surface.visibleText(null, { content: scene, noteType: 'drawing' })).toBe(
      'sketch of the idea',
    );
  });

  it('reads empty drawings as empty', () => {
    expect(surface.visibleText(null, { content: '', noteType: 'drawing' })).toBe('');
    expect(
      surface.visibleText(null, {
        content: serializeDrawingScene(emptyDrawingScene()),
        noteType: 'drawing',
      }),
    ).toBe('');
  });

  it('reads unparseable bytes as their raw content — never the card’s copy', () => {
    expect(surface.visibleText(null, { content: 'raw bytes', noteType: 'drawing' })).toBe(
      'raw bytes',
    );
  });
});

describe('the image-export seam', () => {
  it('refuses when no drawing is open', async () => {
    await exportActiveDrawingImage('png');
    expect(showToast).toHaveBeenCalledWith('Open the drawing note first, then export.');
  });

  it('refuses an empty canvas honestly', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing', name: 'Sketch' });
    await canvasReady();

    await exportActiveDrawingImage('svg');
    expect(showToast).toHaveBeenCalledWith('Nothing to export yet — draw something first.');
  });

  it('exports the live scene through the canvas module', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing', name: 'Sketch' });
    await canvasReady();
    const mounted = lastMount();
    mounted.handle.getScene = () => ({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: {},
    });

    await exportActiveDrawingImage('png');
    expect(canvasMock.renderDrawingImage).toHaveBeenCalledWith(
      'png',
      expect.objectContaining({ elements: [{ id: 'a', type: 'rectangle' }] }),
    );
  });

  it('the image-paste refusal toast is wired to the canvas', async () => {
    const host = connectedHost();
    surface.display(host, { content: '', noteType: 'drawing' });
    await canvasReady();
    lastMount().options.onImagePaste();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('vector'));
  });
});
