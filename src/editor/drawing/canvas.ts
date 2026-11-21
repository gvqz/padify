/**
 * The Excalidraw island — the ONE module that knows the vendor exists.
 *
 * This file is loaded exclusively through `import('./canvas')` (the drawing
 * surface's lazy chunk), so React + the canvas (~1–2 MB) join the app only
 * when the first drawing note opens — the same lazy-chunk pattern as the
 * unicode table and the PDF/DOCX exporters. The chunk is runtime-cached by
 * the service worker on first use (never precached — see
 * scripts/build-sw.mjs's three-way classification), so offline works from
 * the second drawing on.
 *
 * WHAT THE HOST OWNS vs WHAT THE VENDOR OWNS: the surface (surface.ts)
 * owns the note lifecycle — what scene is fed, when saves are announced,
 * what happens on switch/commit/clear. This module only adapts the
 * Excalidraw component to that contract:
 *  - `mountDrawingCanvas()` renders the component (via a react-dom root)
 *    with the Generation-2 chrome: open/save `.excalidraw`, save as
 *    PNG/SVG, canvas background — and with the vendor's clear-canvas,
 *    full-export, theme toggle, socials OFF (the Padify confirmed flow
 *    owns clearing; the image tool is ON — its inserts are the pixels the
 *    attachment store persists, see canvas-images.ts; the pad follows the
 *    app's theme at mount, exactly like the retired Drawingpad did).
 *  - `renderDrawingImage()` is the export API behind the download menu's
 *    "Save as image" rows (PNG/SVG) — the same exporter the vendor's own
 *    "Save as image" dialog uses.
 *
 * THE SKIN. The import right after the vendor's stylesheet re-maps the
 * vendor's whole theme-variable surface onto Padify's design tokens —
 * same chunk, later in the cascade, scoped under [data-drawing-canvas].
 * Without it the canvas ships the vendor's own chrome: purple accents,
 * floating glass islands, the Assistant typeface — a design language the
 * app's monochrome never invited. See canvas-skin.css for the full map.
 *
 * NO JSX BY DESIGN: the app is a vanilla-TS codebase with no JSX tooling;
 * `createElement` keeps this island a plain .ts file (no tsconfig/eslint
 * JSX setup, no prettier JSX surprises) — the mount reads as one prop bag.
 */

// The asset path goes FIRST: the vendor's font registry is built during
// module evaluation, so window.EXCALIDRAW_ASSET_PATH must exist before
// this tree's imports run (see canvas-assets.ts — CSP blocks the vendor's
// CDN fallback, so the same-origin copy is the only live source).
import './canvas-assets';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Excalidraw,
  FONT_FAMILY,
  MainMenu,
  exportScene,
  getCommonBounds,
} from '@excalidraw/excalidraw';
// Types-only subpath (the package's exports map points "/types" at its
// d.ts tree) — no runtime cost, no phantom-module games.
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import './canvas-skin.css';
import type { CanvasImageFile } from './canvas-images';

/** The canvas's theme — the vendor's Theme, spelled without a type import
 * so this module owns its own contract ('light' | 'dark'). */
export type DrawingCanvasTheme = 'light' | 'dark';

/** One scene as the surface sees it: verbatim element records plus the
 * live appState (the whitelist is applied at serialization time, in
 * scene.ts — this module never curates what it does not own). */
export interface DrawingCanvasScene {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
}

/** The mounted canvas, from the surface's point of view. */
export interface DrawingCanvasHandle {
  /** Replaces the whole scene (a note switch or a fresh-bytes repaint). */
  updateScene(scene: DrawingCanvasScene): void;
  /** Drops the undo history (it must never cross a note boundary). */
  clearHistory(): void;
  /** Re-renders with a new file name (exports and `.excalidraw` saves). */
  rename(name: string): void;
  /** Centers the viewport on the scene's content. */
  scrollToContent(): void;
  /** Follows the app's theme switch without a remount (the vendor's theme
   * prop is a controlled value — a stale one leaves vendor JS (popovers,
   * exports) branching on the wrong mode even while the skin's tokens
   * rescue the CSS). */
  setTheme(theme: DrawingCanvasTheme): void;
  /** The live scene (non-deleted elements are the caller's business). */
  getScene(): DrawingCanvasScene;
  /** Feeds the vendor image bytes the scene's fileIds reference (the
   * hydration pass — canvas-images.ts loads them from the attachment
   * store). Calls that land before the vendor API is ready queue and
   * flush the moment it fires. The structural mirror (CanvasImageFile)
   * crosses into the vendor's BinaryFileData at this module's boundary. */
  addFiles(files: CanvasImageFile[]): void;
  /** The vendor's live files map — the flush's diff base (canvas-images.ts
   * persists the ids this device does not hold yet). */
  getFiles(): BinaryFiles;
  /** Stands the island down: unmounts React, releasing every listener. */
  unmount(): void;
}

export interface MountDrawingCanvasOptions {
  /** The scene to open with (elements + appState verbatim from the note). */
  initialScene: DrawingCanvasScene;
  /** The app's theme at mount time ('light' | 'dark'). */
  theme: DrawingCanvasTheme;
  /** The file name for exports/`.excalidraw` saves (the note's name). */
  name: string;
  /** Fires on every canvas mutation (elements, appState — and the files
   * map rides the vendor's third argument, kept for getFiles()). */
  onChange(scene: DrawingCanvasScene): void;
}

/**
 * The Gen-2 chrome, as a prop bag for the component. The curated MainMenu
 * (rendered as children) is the honest set: Open, Save, Save as image,
 * canvas background — no Clear canvas (the Padify-confirmed flow in the
 * context menu owns that), no vendor links, no search/palette, no theme
 * toggle. The deprecated Export action stays off too — "Save as image"
 * already carries PNG/SVG.
 */
function drawingCanvasElement(
  options: MountDrawingCanvasOptions,
  initialData: object,
  onApi: (api: ExcalidrawImperativeAPI | null) => void,
  onFiles: (files: BinaryFiles) => void,
): ReturnType<typeof createElement> {
  return createElement(
    Excalidraw,
    {
      initialData,
      theme: options.theme,
      name: options.name,
      autoFocus: true,
      // The canvas reacts to keys only while it is focused — the app's
      // own shortcuts (tab strip, menus) keep working around it.
      handleKeyboardGlobally: false,
      onChange: (elements: readonly object[], appState: AppState, files: BinaryFiles) => {
        onFiles(files);
        options.onChange({
          elements: elements as Record<string, unknown>[],
          appState: appState as unknown as Record<string, unknown>,
        });
      },
      UIOptions: {
        canvasActions: {
          loadScene: true,
          saveToActiveFile: true,
          saveAsImage: true,
          changeViewBackgroundColor: true,
          clearCanvas: false,
          export: false,
          toggleTheme: false,
        },
        // The image tool is ON — images are the attachment store's real
        // tenant (canvas-images.ts owns the persistence spine around
        // whatever the vendor inserts). The vendor resizes at insert and
        // refuses over-cap files; the ids it mints are content hashes,
        // so one image pasted twice is one store row.
        tools: { image: true },
      },
      // The insert-time gates: the app's own capture discipline, spoken
      // in the vendor's vocabulary — a 1920-px long edge and the server's
      // 5 MB ceiling. A file over either fails at insert, never at sync.
      imageOptions: {
        maxWidthOrHeight: 1920,
        maxFileSizeBytes: 5_000_000,
      },
      // Master's minimap stays: the pad opens on the same train as
      // excalidraw.com, map island included (its footer toggle rides the
      // zoom controls; see the minimapEnabled default below for why it is
      // on at every open).
      onExcalidrawAPI: onApi,
    },
    // Children: the curated main menu replaces the vendor default (which
    // ships search, help, "Excalidraw links" and the theme toggle).
    createElement(
      MainMenu,
      undefined,
      createElement(MainMenu.DefaultItems.LoadScene),
      createElement(MainMenu.DefaultItems.SaveToActiveFile),
      createElement(MainMenu.DefaultItems.SaveAsImage),
      createElement(MainMenu.Separator),
      createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
    ),
  );
}

/** The vendor's updateScene payload shape — the verbatim scene records
 * cross this boundary with one cast (they ARE the vendor's elements;
 * this build just refuses to interpret them on the way). */
type UpdateScenePayload = Parameters<ExcalidrawImperativeAPI['updateScene']>[0];

/**
 * Mounts the canvas island into `mount` (the surface's wrapper). The
 * handle's methods are safe against a not-yet-ready API (calls before the
 * `excalidrawAPI` callback fires queue onto the freshly mounted instance).
 */
export function mountDrawingCanvas(
  mount: HTMLElement,
  options: MountDrawingCanvasOptions,
): DrawingCanvasHandle {
  let api: ExcalidrawImperativeAPI | null = null;
  let root: Root | null = createRoot(mount);
  let props = options;
  /** The vendor's live files map, kept from every onChange — getFiles()'s
   * answer and the flush's diff base (canvas-images.ts persists what this
   * device does not hold). */
  let latestFiles: BinaryFiles = {};
  /** Hydration calls that landed before the API callback fired — flushed
   * the moment it does (the queue is small: a scene's fileIds). */
  let pendingFiles: CanvasImageFile[] = [];

  /** The master replacement for the removed scrollToContent(): navigate
   * the viewport to the scene's non-deleted bounds. The target goes in as
   * BOUNDS (not element records) so navigation works the same tick the
   * elements are fed — setViewport only resolves element records that are
   * already on the canvas, and updateScene applies on the next render. */
  const centerOnContent = (elements: readonly Record<string, unknown>[]): void => {
    if (!api) return;
    const visible = elements.filter((element) => element.isDeleted !== true);
    if (visible.length === 0) return;
    api.setViewport({
      target: getCommonBounds(visible as never),
      fit: 'none', // old scrollToContent semantics: center, keep the zoom
    });
  };

  const render = (): void => {
    if (!root) return;
    // initialData only takes effect on the FIRST render; the rename
    // re-render passes it unchanged (ignored) and swaps `name`. The font
    // default is the PADIFY choice, not the vendor's: new text speaks
    // the vendor's "normal" Nunito instead of the hand-drawn Excalifont
    // (a minimalist notepad's canvas should read like the app). A scene
    // that carries its own pick — every previously saved scene does, the
    // whitelist persists the key — overrides the default via the spread.
    root.render(
      drawingCanvasElement(
        props,
        {
          elements: options.initialScene.elements,
          appState: {
            currentItemFontFamily: FONT_FAMILY.Nunito,
            // The map opens with the pad — the vendor's own default is off,
            // and the toggle is a browser-level viewport pref the vendor
            // classifies as {browser: true, export: false, server: false}:
            // not scene content, so the appState whitelist (rightly) never
            // persists it and the vendor's localStorage home belongs to
            // excalidraw.com's app layer, not the embedded component. A
            // fresh open therefore falls back to THIS default — the
            // excalidraw.com look, map and all. The Padify settings menu is
            // the future home for the preference itself.
            minimapEnabled: true,
            ...options.initialScene.appState,
          },
        },
        (instance: ExcalidrawImperativeAPI | null) => {
          api = instance;
          if (instance && pendingFiles.length > 0) {
            instance.addFiles(pendingFiles as unknown as BinaryFileData[]);
            pendingFiles = [];
          }
        },
        (files: BinaryFiles) => {
          latestFiles = files;
        },
      ),
    );
  };
  render();

  return {
    updateScene(scene: DrawingCanvasScene): void {
      api?.updateScene({
        elements: scene.elements,
        // The same Padify defaults as initialData — the note-switch path
        // (drawing→drawing reuse) never re-runs initialData, so a fresh
        // scene (appState {}) would otherwise inherit the previous note's
        // live tool state. A scene that carries its own pick wins the
        // spread, exactly as at mount.
        appState: {
          currentItemFontFamily: FONT_FAMILY.Nunito,
          minimapEnabled: true,
          ...scene.appState,
        },
      } as unknown as UpdateScenePayload);
      if (scene.elements.length > 0) {
        centerOnContent(scene.elements);
      }
    },
    clearHistory(): void {
      api?.history.clear();
    },
    rename(name: string): void {
      props = { ...props, name };
      render();
    },
    scrollToContent(): void {
      centerOnContent(api?.getSceneElements() ?? []);
    },
    setTheme(theme: DrawingCanvasTheme): void {
      if (props.theme === theme) return;
      props = { ...props, theme };
      render();
    },
    getScene(): DrawingCanvasScene {
      const elements = (api?.getSceneElements() ?? options.initialScene.elements) as Record<
        string,
        unknown
      >[];
      const appState = (api?.getAppState() ?? options.initialScene.appState) as Record<
        string,
        unknown
      >;
      return { elements, appState };
    },
    addFiles(files: CanvasImageFile[]): void {
      if (files.length === 0) return;
      if (api) {
        // The structural mirror crosses into the vendor's type here —
        // the one cast at the vendor boundary (see canvas-images.ts's
        // docstring for why the mirror exists).
        api.addFiles(files as unknown as BinaryFileData[]);
      } else {
        pendingFiles.push(...files);
      }
    },
    getFiles(): BinaryFiles {
      return latestFiles;
    },
    unmount(): void {
      api = null;
      if (root) {
        root.unmount();
        root = null;
      }
    },
  };
}

/**
 * Renders the live scene to an image — the download menu's "Save as
 * image" rows. PNG answers a Blob; SVG answers the serialized markup.
 * Elements marked deleted (the undo ghost trail) never reach an export.
 * The scene's image bytes ride along (`files`, from the live handle or a
 * store hydration) — without them an image element exports as the
 * vendor's gray placeholder, so the caller always passes what it holds.
 *
 * Master folded exportToBlob/exportToSvg into one exportScene() with the
 * format as a discriminated member — the defaults (the scene's own
 * background, 10px padding, scale 1) match what the retired calls did.
 */
export async function renderDrawingImage(
  kind: 'png' | 'svg',
  scene: DrawingCanvasScene,
  files?: BinaryFiles | null,
): Promise<Blob | string> {
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  const appState = scene.appState as unknown as Partial<AppState>;
  if (kind === 'svg') {
    const svg = await exportScene({
      data: {
        elements: elements as never,
        appState: appState as never,
        files: files ?? null,
      },
      type: 'svg',
    });
    return new XMLSerializer().serializeToString(svg);
  }
  return exportScene({
    data: {
      elements: elements as never,
      appState: appState as never,
      files: files ?? null,
    },
    type: 'png',
    config: { embedScene: false },
  }) as Promise<Blob>;
}
