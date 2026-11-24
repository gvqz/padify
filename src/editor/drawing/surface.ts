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
import type {
  DrawingCanvasHandle,
  DrawingCanvasScene,
  DrawingCanvasTheme,
  DrawingImageExportOptions,
} from './canvas';
// Type-only vendor import — erased at compile, no runtime cost to the
// boot payload (the vendor stays lazy behind import('./canvas')).
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import {
  flushSceneFiles,
  idsNeedingHydration,
  blobToDataURL,
  loadSceneFiles,
  type CanvasImageFile,
} from './canvas-images';

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

/**
 * The zen-mode state class the canvas paints on its host while the open
 * drawing's zen mode is ON — the vendor's Preferences toggle (and its own
 * keyboard chord) flip `zenModeEnabled`, which the whitelist already
 * persists as note content. The shell answers through CSS
 * (16-editor-shell.css, `body:has(#note.drawing-zen-mode)`): the navbar
 * and the note rail step aside so a zen drawing owns the whole window —
 * the host's half of the deal excalidraw.com's zen mode makes (the
 * vendor hides its own chrome; the navbar and the rail are OURS). The
 * class rides the host exactly like the takeover class above, so every
 * stand-down path lifts it and the shell always comes back. Named in
 * tests — surface.test.ts pins the paint/unpaint discipline,
 * drawing-canvas.spec.ts pins the shell's answer.
 */
export const DRAWING_ZEN_MODE_CLASS = 'drawing-zen-mode';

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
  /** The theme the canvas must speak — updated live from the app's
   * `padify:theme` broadcast (theme-controller.ts), so a switch while the
   * chunk is still loading is never lost to the mount-time snapshot. */
  theme: DrawingCanvasTheme;
  /** The document-level theme listener this instance registered (removed
   * in standDownLive — never left parked after the stage moves on). */
  themeListener: (event: Event) => void;
  /** Set once the lazy chunk has mounted; null while loading. */
  handle: DrawingCanvasHandle | null;
  /** The pending announce timer — cancelled on every stand-down so a
   * quieted note can never fire an input event into another surface. */
  announceTimer: ReturnType<typeof setTimeout> | null;
  /** One over-budget warning per note session (resets when back under). */
  budgetWarned: boolean;
  /** The attachment ids this device already holds for the open scene —
   * hydrated ids plus flushed ids. The flush's diff base and the
   * hydration's skip list (canvas-images.ts). */
  persistedFileIds: Set<string>;
  /** Hydration results that landed while the vendor chunk was still
   * loading — flushed into the handle the moment it mounts. */
  pendingFiles: CanvasImageFile[];
  /** True once dismiss()/standDown took this instance down. */
  disposed: boolean;
  /** The zen-mode state as last painted on the host — the flip tracker
   * that keeps the shell's classList work at toggle cadence (the vendor's
   * onChange fires for every pointer twitch; the shell must not follow
   * that, only the actual flips). */
  zenMode: boolean;
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
 * unmounted (every vendor listener goes with it), theme listener removed,
 * state dropped. */
function standDownLive(): void {
  const current = live;
  if (!current) return;
  cancelAnnounce(current);
  current.disposed = true;
  document.removeEventListener('padify:theme', current.themeListener);
  current.host.classList.remove(DRAWING_CANVAS_OPEN_CLASS, DRAWING_ZEN_MODE_CLASS);
  current.handle?.unmount();
  live = null;
}

/** Paints the zen-mode state on the host — the shell's navbar and note
 * rail answer through the `:has()` rules (16-editor-shell.css). Flips
 * only: a scene re-fed without a zen change touches nothing. */
function applyZenMode(current: LiveDrawingCanvas, on: boolean): void {
  if (current.zenMode === on) return;
  current.zenMode = on;
  current.host.classList.toggle(DRAWING_ZEN_MODE_CLASS, on);
}

/**
 * The image spine, hydration side: the scene's fileIds this device does
 * not hold yet load from the attachment store (local first, the cloud's
 * lazy pull for another device's bytes) and feed the vendor. A result
 * that lands while the chunk is still loading waits in pendingFiles —
 * the mount callback flushes it the moment the handle exists.
 */
function hydrateSceneImages(current: LiveDrawingCanvas): void {
  const needed = idsNeedingHydration(current.snapshot.elements, current.persistedFileIds);
  if (needed.length === 0) return;
  void loadSceneFiles(needed)
    .then((files) => {
      if (current.disposed) return;
      for (const file of files) {
        current.persistedFileIds.add(file.id);
      }
      if (current.handle) {
        current.handle.addFiles(files);
      } else {
        current.pendingFiles.push(...files);
      }
    })
    .catch(() => {
      /* the vendor's loading placeholder stands in; the next open retries */
    });
}

/**
 * The image spine, flush side: whatever the vendor's files map now holds
 * that this device does not persist yet lands in the store offline-first
 * (the cloud flush uploads it after the next sync cycle — the same rhythm
 * the notes ride). Idempotent by id; a failed write retries on the next
 * onChange.
 */
function flushSceneImages(current: LiveDrawingCanvas): void {
  const handle = current.handle;
  if (!handle) return;
  void flushSceneFiles(handle.getFiles(), current.persistedFileIds).catch(() => {
    /* the next onChange retries — nothing user-visible to say yet */
  });
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
  // A drawing → drawing switch re-reads the pick from the NEW note's
  // bytes (a zen-on note handing the stage to a plain one brings the
  // chrome back; the reverse hides it) — the same discipline the mount
  // path applies below.
  applyZenMode(current, scene.appState.zenModeEnabled === true);
  cancelAnnounce(current);
  current.handle?.updateScene({
    elements: scene.elements,
    appState: scene.appState,
  });
  hydrateSceneImages(current);
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
    theme: document.body.classList.contains('dark') ? 'dark' : 'light',
    themeListener: () => {},
    handle: null,
    announceTimer: null,
    budgetWarned: false,
    persistedFileIds: new Set<string>(),
    pendingFiles: [],
    disposed: false,
    // Initialized from the OPEN scene's whitelisted pick, then painted —
    // the shell's chrome answers while the vendor chunk is still loading
    // (a zen-saved note never flashes the full shell first).
    zenMode: scene.appState.zenModeEnabled === true,
  };
  if (current.zenMode) {
    host.classList.add(DRAWING_ZEN_MODE_CLASS);
  }

  // The app's one theme seam (theme-controller.ts broadcasts on every
  // switch, device mode included). The vendor's theme prop is a mount-
  // time snapshot: without this, toggling dark/light while a drawing is
  // open leaves the vendor's JS (popovers, exports) on the stale mode
  // even though the skin's tokens rescue the CSS. The listener rides the
  // instance and dies with standDownLive.
  current.themeListener = (event: Event): void => {
    const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode;
    if (mode !== 'light' && mode !== 'dark') return;
    current.theme = mode;
    current.handle?.setTheme(mode);
  };
  document.addEventListener('padify:theme', current.themeListener);

  live = current;

  // The mount path, as a promise: one import attempt, then the paint.
  // Both the retry (below) and the callback re-entrancy guard read the
  // same disposal checks the original .then body carried.
  const importAndMount = async (): Promise<void> => {
    const canvas = await import('./canvas');
    if (current.disposed || !current.mount.isConnected || live !== current) {
      return; // the stage moved on mid-download — this mount is dead
    }
    loading.remove();
    current.handle = canvas.mountDrawingCanvas(mount, {
      initialScene: {
        elements: current.snapshot.elements,
        appState: current.snapshot.appState,
      },
      theme: current.theme,
      name: current.noteName,
      onChange: (next) => {
        current.snapshot = next;
        // The live toggle: the vendor's Preferences row and its keyboard
        // chord both surface here — the shell follows the flip (the
        // tracker keeps quiet flips free).
        applyZenMode(current, next.appState.zenModeEnabled === true);
        flushSceneImages(current);
        scheduleAnnounce(current);
      },
    });
    // Hydration results that queued while the chunk traveled, then
    // the open scene's own shopping list (hydrateSceneImages marks
    // the ids it answers, so this never double-loads).
    if (current.pendingFiles.length > 0) {
      current.handle.addFiles(current.pendingFiles);
      current.pendingFiles = [];
    }
    hydrateSceneImages(current);
  };

  /** The honest failure card — the drawing is safe, and the Retry action
   * is the deterministic hard refresh: the service worker re-fetches the
   * whole precache network-first, then the page reloads into the NEW
   * build (a deploy had renamed every chunk the running tab holds — no
   * in-tab retry can ever fetch a name that no longer exists). */
  const showCanvasErrorCard = (): void => {
    host.classList.remove(DRAWING_CANVAS_OPEN_CLASS, DRAWING_ZEN_MODE_CLASS);
    try {
      mount.replaceChildren(
        buildCard(
          'The canvas could not load',
          'The drawing is safe and syncs like any other note. Retry reopens it with the latest version of the app.',
          {
            label: 'Retry',
            onClick: () => {
              void import('../../install-pwa').then(({ reloadWithFreshShell }) =>
                reloadWithFreshShell(),
              );
            },
          },
        ),
      );
    } catch {
      /* the environment beneath the mount is gone — nothing to paint */
    }
  };

  void importAndMount().catch(() => {
    // A dead mount (dismissed, or the stage moved on) stays down; the
    // isConnected check also covers a torn-down test environment — the
    // island may take longer to REJECT than its suite takes to finish.
    if (current.disposed || live !== current || !current.mount.isConnected) return;
    // The one-shot retry (R3's open-glitch work): a transient failure —
    // a racing service-worker update, one flaky fetch — recovers in
    // place after a beat. Browsers do not memoize FAILED module fetches,
    // so the second import() re-requests the chunk. A real miss (the
    // old-hash-after-a-deploy case, a corrupt install) fails again and
    // gets the card with the Retry action instead of a dead end.
    setTimeout(() => {
      if (current.disposed || live !== current || !current.mount.isConnected) return;
      void importAndMount().catch(showCanvasErrorCard);
    }, 400);
  });
}

/**
 * Warms the vendor island while the app idles — the first canvas open
 * stops paying the chunk download on the spot. The mount path (below)
 * keeps its loading card; a warmed chunk just makes the card a cameo
 * instead of a wait. One-shot by nature: module evaluation caches the
 * island for the session, and the service worker keeps the chunk
 * runtime-cached beyond it.
 */
export function warmCanvasIsland(): void {
  const warm = (): void => {
    void import('./canvas').catch(() => {
      /* offline or a corrupted chunk — the mount path owns the honest card */
    });
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => warm(), { timeout: 4_000 });
  } else {
    window.setTimeout(warm, 2_500);
  }
}

/** The load/error/read-only card — the unsupported-note look, reused.
 * An optional action row (the error card's Retry) lands below the body. */
function buildCard(
  title: string,
  body: string,
  action?: { label: string; onClick: () => void },
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'unsupported-note';
  card.dataset.noteType = 'drawing';

  const titleEl = document.createElement('p');
  titleEl.className = 'unsupported-note-title';
  titleEl.textContent = title;

  const bodyEl = document.createElement('p');
  bodyEl.className = 'unsupported-note-body';
  const text = document.createElement('span');
  text.textContent = body;
  bodyEl.append(text);

  card.append(titleEl, bodyEl);

  if (action) {
    const row = document.createElement('div');
    row.className = 'unsupported-note-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'unsupported-note-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    row.append(button);
    card.append(row);
  }
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
 * Exports the OPEN drawing as PNG or SVG — the download menu's "Export
 * image…" dialog answers this on Save, with the dialog's native options
 * (format, background, dark mode, embed scene, scale). Refuses honestly
 * when the canvas is not mounted or holds nothing: the same rules the
 * share modal applies, in the same words the app uses elsewhere.
 */
export async function exportActiveDrawingImage(
  kind: 'png' | 'svg',
  options?: DrawingImageExportOptions,
): Promise<void> {
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
  // The image bytes ride along: the live map holds whatever the vendor
  // inserted this session plus the hydration — without it an image
  // element exports as a gray placeholder.
  const files = current.handle.getFiles();
  const fileName = exportFileName(current.noteName);
  try {
    const canvas = await import('./canvas');
    if (kind === 'svg') {
      const markup = await canvas.renderDrawingImage('svg', scene, files, options);
      saveTextAsFile(markup as string, `${fileName}.svg`, 'image/svg+xml');
      return;
    }
    const blob = await canvas.renderDrawingImage('png', scene, files, options);
    if (blob instanceof Blob) {
      downloadBlob(blob, `${fileName}.png`);
    }
  } catch {
    showToast('The image export failed — try again.');
  }
}

/**
 * The unified export's drawing door (R1, the owner's first component
 * swap): the download menu's "Export image…" row lands here, the dialog
 * opens on the vendor's native option set, and each Save press answers
 * exportActiveDrawingImage with the dialog's choices. The gates (a live
 * canvas, something in it) fire BEFORE the dialog so an empty or closed
 * drawing answers with the same toast it always did.
 */
export async function openDrawingExportUI(): Promise<void> {
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
  const { openDrawingExportDialog } = await import('./export-dialog');
  openDrawingExportDialog(async (choices) => {
    await exportActiveDrawingImage(choices.format, {
      background: choices.background,
      dark: choices.dark,
      embed: choices.embed,
      scale: choices.scale,
    });
  });
}

/**
 * The share seam (R4, the plan's last unchecked phase-3 milestone): a
 * drawing shared as a link must not carry the raw scene JSON — the
 * viewer would show a wall of elements. This renders the scene to a PNG
 * data URL (scale 1, the scene's own background) and hands it to the
 * share pipeline as the link's content; the viewer's drawing branch
 * paints it as the image it is.
 *
 * The FRESH source wins: a mounted canvas for the same note answers its
 * live scene (the model lags the announce debounce); otherwise the
 * passed content parses and the scene's fileIds hydrate from the
 * attachment store (local first, the cloud's lazy pull), the same
 * shopping list an open runs. Refuses honestly (null) when nothing
 * renders: the caller keeps its previous behavior (the emptiness gate
 * never let an empty scene reach a link anyway).
 */
export async function snapshotDrawingContent(
  content: string,
  noteId: string | null,
): Promise<string | null> {
  let scene: DrawingCanvasScene;
  // Assigned on every path below (the live branch, the hydration try,
  // and its catch — a failed hydration exports with a null map, the
  // gray placeholder being the honest render).
  let files: BinaryFiles | null;
  const current = live;
  const liveMatches =
    current &&
    current.handle &&
    !current.disposed &&
    current.mount.isConnected &&
    (noteId === null || current.noteId === noteId);
  if (liveMatches && current) {
    scene = current.handle!.getScene();
    files = current.handle!.getFiles();
  } else {
    const parsed = parseDrawingScene(content);
    if (parsed === null || parsed.elements.length === 0) {
      return null;
    }
    scene = { elements: parsed.elements, appState: parsed.appState };
    try {
      const loaded = await loadSceneFiles(idsNeedingHydration(parsed.elements, new Set<string>()));
      // The structural mirror crosses into the vendor's files-map shape
      // here — the same one cast the handle's addFiles carries.
      files = Object.fromEntries(loaded.map((file) => [file.id, file])) as BinaryFiles;
    } catch {
      files = null; // an image element exports as the gray placeholder
    }
  }
  const visible = visibleElements(scene.elements as DrawingSceneElement[]);
  if (visible.length === 0) {
    return null;
  }
  try {
    const canvas = await import('./canvas');
    const blob = await canvas.renderDrawingImage('png', scene, files, {
      background: true,
      scale: 1,
    });
    if (!(blob instanceof Blob)) {
      return null;
    }
    return await blobToDataURL(blob);
  } catch {
    return null;
  }
}
