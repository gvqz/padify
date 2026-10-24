/**
 * The drawing note surface — the Excalidraw canvas for noteType 'drawing'.
 *
 * WHAT THE USER SEES. A drawing note opens as a real canvas: the toolbar,
 * the shapes, the pan/zoom — the full Gen-2 chrome (see
 * docs/DRAWINGPAD_PLAN.md). The note's CONTENT is the scene envelope
 * (editor/drawing/scene.ts); the canvas that owns the elements lives in
 * canvas.ts, mounted behind a dynamic import so React + the vendor ride a
 * lazy chunk instead of the boot payload.
 *
 * HOW IT OWNS THE HOST (the tasks surface's discipline): the host is set
 * contenteditable=false and the canvas wrapper is mounted inside it; the
 * vendor's interactive canvas is the editable. The html engine stays
 * parked (ModelPort.setInert — app.ts wires it from isHtmlContent, which
 * is false for 'json' notes), so the contenteditable pipeline never sees
 * the canvas's events.
 *
 * THE ANNOUNCE CONTRACT: user edits surface as ONE bubbling `input` event
 * on the host, trailing-debounced 300 ms (the Gen-2 autosave rhythm) —
 * autosave, the word-count pill and the save indicator all follow it. The
 * debounce is not just thrift: an equality guard re-serializes the live
 * scene at announce time and stays SILENT when the bytes match what
 * display()/commit()/clear() fed in — so opening a note, panning, zooming
 * and selecting never write, and the vendor's onChange (which fires for
 * every pointer twitch) never dirties a clean note. savedAt is stamped
 * only on real saves, keeping the "open never writes" promise byte-exact.
 *
 * SURFACES ARE STATELESS SINGLETONS, so this module carries the one live
 * canvas (the app has one editor host) — the tasks surface's `live`
 * pattern. The canvas is reused across drawing→drawing switches
 * (updateScene + a cleared history — undo never crosses a note), stood
 * down when another surface paints the host (dismiss → the React root
 * unmounts, releasing every listener), and never mounted for a scene from
 * a NEWER format version (the read-only card — capture stays null so
 * unknown bytes are never rewritten; the envelope rule, not a choice).
 *
 * CLEARING keeps the Padify line: the vendor's built-in clear-canvas
 * action is off (canvas.ts), and the app's context-menu flow — with its
 * "cannot be reverted" confirm — empties the scene through clear(). The
 * caller owns that persist, exactly like the tasks surface's clear.
 */

import { registerNoteSurfaceForType, type NoteSurface, type SurfaceNote } from '../surface';
import { opaqueNoteSurface } from '../surface';
import { showToast } from '../../ui/toast';
import { saveTextAsFile } from '../../exports';
import {
  DRAWING_SCENE_SOFT_BUDGET_BYTES,
  DRAWING_SCENE_VERSION,
  drawingSceneByteSize,
  drawingScenePlainText,
  emptyDrawingScene,
  parseDrawingScene,
  serializeDrawingScene,
  type DrawingPersistedAppState,
  type DrawingScene,
  type DrawingSceneElement,
} from './scene';
import type { DrawingCanvasHandle, DrawingCanvasScene } from './canvas';

/** The Gen-2 autosave rhythm: announce 300 ms after the last change. */
export const DRAWING_ANNOUNCE_DEBOUNCE_MS = 300;

/**
 * The full-bleed state class the canvas paints on its host while a
 * drawing note owns the stage (vercel/16-editor-shell.css): the host
 * sheds the reading column's padding/border and the bottom strip steps
 * aside, so the canvas fills the editor edge to edge. Named in tests —
 * drawing-canvas.spec.ts pins the takeover and the stand-down.
 */
export const DRAWING_CANVAS_OPEN_CLASS = 'drawing-canvas-open';

// ---------------------------------------------------------------------------
// The live canvas
// ---------------------------------------------------------------------------

interface LiveDrawingCanvas {
  /** The editor host this canvas is painted into. */
  host: HTMLElement;
  /** The wrapper div ([data-drawing-canvas]) the React root renders into. */
  mount: HTMLElement;
  /** The open note's id/name (file names for exports, null when unknown). */
  noteId: string | null;
  noteName: string;
  /** The model bytes as last FED (display/commit/clear) — the announce
   * guard's equality base. Never advanced without a user-visible change. */
  content: string;
  /** The savedAt of the last fed scene (kept so re-serializing the
   * unchanged scene reproduces the fed bytes exactly). */
  savedAt: number;
  /** The live scene as the canvas last reported it (fed values until the
   * first onChange — capture works even while the chunk is loading). */
  snapshot: DrawingCanvasScene;
  /** Set once the lazy chunk has mounted; null while loading. */
  handle: DrawingCanvasHandle | null;
  /** The pending announce timer — cancelled on every stand-down so a
   * quieted note can never fire an input event into another surface. */
  announceTimer: ReturnType<typeof setTimeout> | null;
  /** One over-budget warning per note session (resets when back under). */
  budgetWarned: boolean;
  /** True once dismiss()/standDown took this instance down. */
  disposed: boolean;
}

let live: LiveDrawingCanvas | null = null;

/** The live canvas when it belongs to this host and still paints it. */
function liveFor(host: HTMLElement | null): LiveDrawingCanvas | null {
  if (!live || !host || live.host !== host) return null;
  return live.disposed || !live.mount.isConnected ? null : live;
}

/** True when the note's content is a scene THIS build refuses to edit: a
 * newer format version (the envelope passes it through verbatim — the
 * canvas must never rewrite what it cannot interpret). */
function sceneIsFromNewerBuild(content: string): boolean {
  const scene = parseDrawingScene(content);
  return scene !== null && scene.version > DRAWING_SCENE_VERSION;
}

/** Serializes the live scene exactly as it was fed (the equality base). */
function serializeAsFed(current: LiveDrawingCanvas): string {
  return serializeDrawingScene({
    version: DRAWING_SCENE_VERSION,
    savedAt: current.savedAt,
    elements: visibleElements(current.snapshot.elements),
    appState: current.snapshot.appState as DrawingPersistedAppState,
  });
}

/** The undo ghost trail never persists: deleted elements drop here. */
function visibleElements(elements: DrawingSceneElement[]): DrawingSceneElement[] {
  return elements.filter((element) => (element as { isDeleted?: boolean }).isDeleted !== true);
}

/** The current live scene bytes — the changed-scene branch of capture(),
 * with a fresh savedAt stamp (the Gen-2 "stamp at save" rule) and the
 * one-per-session over-budget warning. */
function serializeStamped(current: LiveDrawingCanvas): string {
  const serialized = serializeDrawingScene({
    version: DRAWING_SCENE_VERSION,
    savedAt: Date.now(),
    elements: visibleElements(current.snapshot.elements),
    appState: current.snapshot.appState as DrawingPersistedAppState,
  });
  if (drawingSceneByteSize(serialized) > DRAWING_SCENE_SOFT_BUDGET_BYTES && !current.budgetWarned) {
    current.budgetWarned = true;
    showToast(
      'This drawing passed the 1 MB sync budget — it stays saved on this device, but it will not sync.',
    );
  } else if (
    drawingSceneByteSize(serialized) <= DRAWING_SCENE_SOFT_BUDGET_BYTES &&
    current.budgetWarned
  ) {
    current.budgetWarned = false;
  }
  return serialized;
}

function cancelAnnounce(current: LiveDrawingCanvas): void {
  if (current.announceTimer !== null) {
    clearTimeout(current.announceTimer);
    current.announceTimer = null;
  }
}

/** Stands the live canvas down: pending announce cancelled, React root
 * unmounted (every vendor listener goes with it), state dropped. */
function standDownLive(): void {
  const current = live;
  if (!current) return;
  cancelAnnounce(current);
  current.disposed = true;
  current.host.classList.remove(DRAWING_CANVAS_OPEN_CLASS);
  current.handle?.unmount();
  live = null;
}

/** The trailing-debounce announce: quiet when the scene is byte-identical
 * to what was fed (pan/zoom/selection, or the paint itself), loud the
 * moment a real edit lands. */
function scheduleAnnounce(current: LiveDrawingCanvas): void {
  if (current.announceTimer !== null) {
    clearTimeout(current.announceTimer);
  }
  current.announceTimer = setTimeout(() => {
    current.announceTimer = null;
    if (current.disposed) return;
    const asFed = serializeAsFed(current);
    if (asFed === current.content) return;
    current.content = asFed;
    current.host.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, DRAWING_ANNOUNCE_DEBOUNCE_MS);
}

/** A new scene paints into the live canvas — the note-switch path. */
function feedLiveScene(current: LiveDrawingCanvas, scene: DrawingScene, name: string): void {
  current.noteName = name;
  current.content = serializeDrawingScene(scene);
  current.savedAt = scene.savedAt;
  current.snapshot = { elements: scene.elements, appState: scene.appState };
  current.budgetWarned = false;
  cancelAnnounce(current);
  current.handle?.updateScene({
    elements: scene.elements,
    appState: scene.appState,
  });
  // Exports and `.excalidraw` saves name files after the OPEN note — the
  // re-render swaps the prop without touching the mounted canvas.
  current.handle?.rename(name);
  current.handle?.clearHistory();
}

/** Mounts a fresh canvas island: wrapper + loading card + the lazy chunk.
 * The loading card is the honest paint while React travels; a chunk
 * failure swaps in an error card (the note's bytes are untouched). */
function mountLiveCanvas(
  host: HTMLElement,
  scene: DrawingScene,
  noteId: string | null,
  name: string,
): void {
  standDownLive();
  host.replaceChildren();
  // The full-bleed takeover starts with the wrapper (not the canvas's
  // mount — the loading card paints full-bleed too, so the stage never
  // reflows when the vendor chunk lands).
  host.classList.add(DRAWING_CANVAS_OPEN_CLASS);

  const mount = document.createElement('div');
  mount.dataset.drawingCanvas = '';
  mount.tabIndex = -1;
  mount.setAttribute('aria-label', 'Drawing canvas');
  mount.style.height = '100%';
  host.append(mount);

  const loading = buildCard(
    'Opening the canvas…',
    'The drawing tools load with the first drawing note, then stay cached for every one after it.',
  );
  mount.append(loading);

  const current: LiveDrawingCanvas = {
    host,
    mount,
    noteId,
    noteName: name,
    content: serializeDrawingScene(scene),
    savedAt: scene.savedAt,
    snapshot: { elements: scene.elements, appState: scene.appState },
    handle: null,
    announceTimer: null,
    budgetWarned: false,
    disposed: false,
  };
  live = current;

  void import('./canvas')
    .then((canvas) => {
      if (current.disposed || !current.mount.isConnected || live !== current) {
        return; // the stage moved on mid-download — this mount is dead
      }
      try {
        loading.remove();
        current.handle = canvas.mountDrawingCanvas(mount, {
          initialScene: {
            elements: current.snapshot.elements,
            appState: current.snapshot.appState,
          },
          theme: document.body.classList.contains('dark') ? 'dark' : 'light',
          name: current.noteName,
          onChange: (next) => {
            current.snapshot = next;
            scheduleAnnounce(current);
          },
          onImagePaste: () => {
            showToast('Embedded images arrive in a later Padify — drawings stay vector for now.');
          },
        });
      } catch {
        // The island crashed mid-mount (or the environment beneath it is
        // gone): the honest card replaces the loading paint when anything
        // is left to paint on. A card is not a canvas — the host goes back
        // to the padded reading column.
        host.classList.remove(DRAWING_CANVAS_OPEN_CLASS);
        try {
          mount.replaceChildren(
            buildCard(
              'The canvas could not load',
              'The drawing is safe and syncs like any other note. Check the connection and reopen the note to try again.',
            ),
          );
        } catch {
          /* the environment beneath the mount is gone — nothing to paint */
        }
      }
    })
    .catch(() => {
      // A dead mount (dismissed, or the stage moved on) stays down; the
      // isConnected check also covers a torn-down test environment — the
      // island may take longer to REJECT than its suite takes to finish.
      if (current.disposed || live !== current || !current.mount.isConnected) return;
      host.classList.remove(DRAWING_CANVAS_OPEN_CLASS);
      try {
        mount.replaceChildren(
          buildCard(
            'The canvas could not load',
            'The drawing is safe and syncs like any other note. Check the connection and reopen the note to try again.',
          ),
        );
      } catch {
        /* the environment beneath the mount is gone — nothing to paint */
      }
    });
}

/** The load/error/read-only card — the unsupported-note look, reused. */
function buildCard(title: string, body: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'unsupported-note';
  card.dataset.noteType = 'drawing';

  const titleEl = document.createElement('p');
  titleEl.className = 'unsupported-note-title';
  titleEl.textContent = title;

  const bodyEl = document.createElement('p');
  bodyEl.className = 'unsupported-note-body';
  bodyEl.textContent = body;

  card.append(titleEl, bodyEl);
  return card;
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export class DrawingNoteSurface implements NoteSurface {
  readonly kind = 'json' as const;
  /** The canvas IS the editable — this surface writes the note. */
  readonly editable = true;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    host.setAttribute('contenteditable', 'false');

    if (!note) {
      standDownLive();
      host.replaceChildren();
      host.scrollTop = 0;
      return;
    }

    // This surface claims the TYPE; a json note of any other type takes
    // the opaque card (defensive — noteSurfaceFor already routes by
    // type, but commit()/clear() feed this surface directly).
    if (note.noteType !== 'drawing') {
      standDownLive();
      opaqueNoteSurface.display(host, note);
      return;
    }

    // A newer build's format: the card, never the canvas — editing it
    // would rewrite bytes this build cannot interpret (the envelope
    // rule; capture() stays null through the read-only path below).
    if (sceneIsFromNewerBuild(note.content)) {
      standDownLive();
      host.replaceChildren(
        buildCard(
          'Drawing — a newer Padify wrote this scene',
          'The note is stored safely and syncs untouched. Open it on a device with a newer Padify to edit it.',
        ),
      );
      host.scrollTop = 0;
      return;
    }

    const scene = parseDrawingScene(note.content) ?? emptyDrawingScene();
    const name = typeof note.name === 'string' && note.name.trim() !== '' ? note.name : 'drawing';
    const noteId = typeof note.id === 'string' ? note.id : null;

    const current = liveFor(host);
    if (current) {
      // drawing → drawing: reuse the mounted canvas.
      current.noteId = noteId;
      feedLiveScene(current, scene, name);
    } else {
      mountLiveCanvas(host, scene, noteId, name);
    }
    host.scrollTop = 0;
  }

  capture(host: HTMLElement | null): string | null {
    const current = liveFor(host);
    if (!current) return null;
    const asFed = serializeAsFed(current);
    // Unchanged scenes answer the fed bytes themselves — a pre-flush
    // capture on a clean note never rewrites a single byte.
    return asFed === current.content ? current.content : serializeStamped(current);
  }

  visibleText(_host: HTMLElement | null, note: SurfaceNote): string {
    return drawingScenePlainText(note.content);
  }

  commit(host: HTMLElement | null, content: string): boolean {
    if (host) {
      // Snapshot restores repaint from the fresh bytes; the caller owns
      // the persist (no port channel exists for this kind).
      this.display(host, { content, noteType: 'drawing' });
    }
    return false;
  }

  focusTarget(host: HTMLElement): HTMLElement | null {
    const current = liveFor(host);
    // The wrapper is focusable (tabindex -1) even while the chunk loads,
    // so focusEditor's retry loop lands somewhere sane immediately.
    return current ? current.mount : null;
  }

  dismiss(_host: HTMLElement): void {
    // The stage changes hands: the React root unmounts with the wrapper,
    // and a pending announce dies here — never after another surface has
    // painted the host.
    standDownLive();
  }

  clear(host: HTMLElement): void {
    const current = liveFor(host);
    if (current) {
      // The app's confirmed destructive flow empties the scene; the
      // caller owns the persist (the model goes '' right after this).
      // The equality base follows so the vendor's onChange for the
      // repaint stays quiet — clearing must not schedule a write.
      const empty = emptyDrawingScene();
      feedLiveScene(current, empty, current.noteName);
      return;
    }
    this.display(host, { content: '', noteType: 'drawing' });
  }
}

registerNoteSurfaceForType('drawing', new DrawingNoteSurface());

// ---------------------------------------------------------------------------
// The image-export seam — the download menu's "Save as image" rows
// ---------------------------------------------------------------------------

/** Downloads a binary export without leaking the blob URL (the exports
 * module's revoke pattern, local so this module stays self-contained). */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** A file-name-safe rendering of the note's name. */
function exportFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? 'drawing' : cleaned;
}

/**
 * Exports the OPEN drawing as PNG or SVG — the download menu's rows call
 * this (app.ts gates them on the active note). Refuses honestly when the
 * canvas is not mounted or holds nothing: the same rules the share modal
 * applies, in the same words the app uses elsewhere.
 */
export async function exportActiveDrawingImage(kind: 'png' | 'svg'): Promise<void> {
  const current = live;
  if (!current || !current.handle || current.disposed || !current.mount.isConnected) {
    showToast('Open the drawing note first, then export.');
    return;
  }
  const scene = current.handle.getScene();
  const visible = visibleElements(scene.elements as DrawingSceneElement[]);
  if (visible.length === 0) {
    showToast('Nothing to export yet — draw something first.');
    return;
  }
  const fileName = exportFileName(current.noteName);
  try {
    const canvas = await import('./canvas');
    if (kind === 'svg') {
      const markup = await canvas.renderDrawingImage('svg', scene);
      saveTextAsFile(markup as string, `${fileName}.svg`, 'image/svg+xml');
      return;
    }
    const blob = await canvas.renderDrawingImage('png', scene);
    if (blob instanceof Blob) {
      downloadBlob(blob, `${fileName}.png`);
    }
  } catch {
    showToast('The image export failed — try again.');
  }
}
