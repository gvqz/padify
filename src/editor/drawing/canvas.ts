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
 *    full-export, theme toggle, socials and image tool OFF (the Padify
 *    confirmed flow owns clearing; drawings stay vector until phase 3;
 *    the pad follows the app's theme at mount, exactly like the retired
 *    Drawingpad did).
 *  - `renderDrawingImage()` is the export API behind the download menu's
 *    "Save as image" rows (PNG/SVG) — the same exporter the vendor's own
 *    "Save as image" dialog uses.
 *
 * NO JSX BY DESIGN: the app is a vanilla-TS codebase with no JSX tooling;
 * `createElement` keeps this island a plain .ts file (no tsconfig/eslint
 * JSX setup, no prettier JSX surprises) — the mount reads as one prop bag.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Excalidraw,
  MainMenu,
  MIME_TYPES,
  exportToBlob,
  exportToSvg,
} from '@excalidraw/excalidraw';
// Types-only subpath (the package's exports map points "/types" at its
// d.ts tree) — no runtime cost, no phantom-module games.
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';

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
  /** The live scene (non-deleted elements are the caller's business). */
  getScene(): DrawingCanvasScene;
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
  /** Fires on every canvas mutation (elements, appState, files). */
  onChange(scene: DrawingCanvasScene): void;
  /**
   * Fires when a paste carries an image (file or URL) — v1 keeps scenes
   * vector (plan decision 2), so the surface answers with a toast and
   * this module blocks the paste.
   */
  onImagePaste(): void;
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
  onApi: (api: ExcalidrawImperativeAPI) => void,
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
      onChange: (elements: readonly object[], appState: AppState) => {
        options.onChange({
          elements: elements as Record<string, unknown>[],
          appState: appState as unknown as Record<string, unknown>,
        });
      },
      onPaste: (data: { files?: Record<string, unknown>; mixedContent?: { type: string }[] }) => {
        const hasFiles = data.files && Object.keys(data.files).length > 0;
        const hasImageUrls = (data.mixedContent ?? []).some((item) => item.type === 'imageUrl');
        if (hasFiles || hasImageUrls) {
          options.onImagePaste();
          return true; // handled → the vendor drops the paste
        }
        return false;
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
        tools: { image: false },
      },
      excalidrawAPI: onApi,
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

  const render = (): void => {
    if (!root) return;
    // initialData only takes effect on the FIRST render; the rename
    // re-render passes it unchanged (ignored) and swaps `name`.
    root.render(
      drawingCanvasElement(
        props,
        {
          elements: options.initialScene.elements,
          appState: options.initialScene.appState,
        },
        (instance: ExcalidrawImperativeAPI) => {
          api = instance;
        },
      ),
    );
  };
  render();

  return {
    updateScene(scene: DrawingCanvasScene): void {
      api?.updateScene({
        elements: scene.elements,
        appState: scene.appState,
      } as unknown as UpdateScenePayload);
      if (scene.elements.length > 0) {
        api?.scrollToContent();
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
      api?.scrollToContent();
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
 */
export async function renderDrawingImage(
  kind: 'png' | 'svg',
  scene: DrawingCanvasScene,
): Promise<Blob | string> {
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  const appState = scene.appState as unknown as Partial<AppState>;
  if (kind === 'svg') {
    const svg = await exportToSvg({ elements, appState });
    return new XMLSerializer().serializeToString(svg);
  }
  return exportToBlob({
    elements,
    appState,
    mimeType: MIME_TYPES.png,
  });
}
