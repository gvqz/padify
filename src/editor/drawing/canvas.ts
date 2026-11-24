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
 * THE 2026-11-24 RESTART (issue #172): the island ships the vendor's OWN
 * chrome — the same chrome excalidraw.com renders — not a re-themed copy
 * of it. The previous build wrapped the vendor in a 483-line skin
 * (canvas-skin.css) and a curated three-item menu; the owner called that
 * "wrapped a skin over it" and wanted it to "look exactly like the native
 * one looks in its own website". So: no skin (the vendor's purple accents,
 * glass islands and hand-drawn welcome panel stand), the menu is the
 * vendor's own default composition minus the white-label policy items
 * (Socials, Excalidraw+/Sign up, Live collaboration — no backend — and the
 * theme toggle / clear-canvas / JSON-export actions, whose doors stay
 * app-owned), the hand-drawn WelcomeScreen shows on empty scenes, and the
 * AI/mermaid trigger is on (client-side, no keys). Padify keeps only what
 * integration demands: the asset path (CSP: no CDN), the image gates
 * (insert-time resize + the wire's byte ceiling), the theme follow (the
 * app's switch reaches the mounted canvas), and the attachment spine
 * around the vendor's files map (canvas-images.ts).
 *
 * WHAT THE HOST OWNS vs WHAT THE VENDOR OWNS: the surface (surface.ts)
 * owns the note lifecycle — what scene is fed, when saves are announced,
 * what happens on switch/commit/clear. This module only adapts the
 * Excalidraw component to that contract:
 *  - `mountDrawingCanvas()` renders the component with the native chrome
 *    and bridges the vendor's onChange into the surface's announce.
 *  - `renderDrawingImage()` is the export API behind the download menu's
 *    image rows — the same exporter the vendor's own dialogs call.
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
import { createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Excalidraw,
  CommandPalette,
  MainMenu,
  WelcomeScreen,
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
import type { CanvasImageFile } from './canvas-images';
// The vendor's insert-time byte gate speaks the wire contract's number
// (shared/wire.ts) — the same 5 MB every capture path and the server's
// upload route enforce.
import { MAX_ATTACHMENT_BYTES } from '../../../shared/wire';

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
   * exports) branching on the wrong mode even while the CSS follows). */
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

/** The appState keys the Preferences group toggles, with the row labels
 * the native menu speaks. All three are whitelisted (zen + snap) or
 * already persisted (grid), so a toggle rides every future save.
 * View mode stays session-only on purpose — the vendor classifies it
 * {browser: false, export: false, server: false}, and a read-only note
 * that syncs read-only to every device is a trap, not a preference. */
const PREFERENCE_ROWS: readonly { key: keyof AppState & string; label: string }[] = [
  { key: 'objectsSnapModeEnabled', label: 'Snap to objects' },
  { key: 'gridModeEnabled', label: 'Grid' },
  { key: 'zenModeEnabled', label: 'Zen mode' },
];

/**
 * The Preferences group — the native menu's checkmark rows, composed from
 * the public menu API (the vendor's own fallback has no Preferences
 * section; excalidraw.com composes this at its app layer).
 *
 * The checkmarks read the LIVE appState: the component subscribes to the
 * vendor's onChange and refreshes its state ONLY when a watched key
 * actually flips (onChange fires for every pointer twitch — the compare
 * keeps the re-render at the row cadence the toggles need). The api
 * instance arrives through a prop: the mount re-renders once when the
 * vendor's callback fires (the first render's group renders nothing).
 */
function PreferencesGroup({
  api,
}: {
  api: ExcalidrawImperativeAPI | null;
}): ReturnType<typeof createElement> | null {
  const readPrefs = (instance: ExcalidrawImperativeAPI): Record<string, boolean> => {
    const appState = instance.getAppState();
    const prefs: Record<string, boolean> = {};
    for (const row of PREFERENCE_ROWS) {
      prefs[row.key] = appState[row.key] === true;
    }
    return prefs;
  };
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (!api) {
      return;
    }
    let last = readPrefs(api);
    setPrefs(last);
    const unsubscribe = api.onChange(() => {
      const next = readPrefs(api);
      for (const row of PREFERENCE_ROWS) {
        if (next[row.key] !== last[row.key]) {
          last = next;
          setPrefs(next);
          return;
        }
      }
    });
    return () => {
      unsubscribe();
    };
  }, [api]);
  if (!api || !prefs) {
    return null;
  }
  return createElement(
    MainMenu.Group,
    // The Group type demands children in the props object; the rows pass
    // as createElement's child arguments (they win at render time).
    { title: 'Preferences', children: null },
    PREFERENCE_ROWS.map((row) =>
      createElement(
        MainMenu.Item,
        {
          key: row.key,
          selected: prefs[row.key] === true,
          children: null,
          onSelect: () => {
            const appState = api.getAppState();
            void api.updateScene({
              appState: { [row.key]: !(appState[row.key] === true) },
            } as unknown as UpdateScenePayload);
          },
        },
        row.label,
      ),
    ),
  );
}

/**
 * The native chrome, as a prop bag for the component. The canvasActions
 * gates keep the app-owned doors shut (clear-canvas — the Padify-confirmed
 * flow owns it; the JSON export dialog — the app's `.excalidraw` row is the
 * same door with the attachment spine; the theme toggle — the app's theme
 * switch is the one authority), while the vendor's own Save as image, Open
 * and canvas background stay native. The main menu children mirror the
 * vendor's own fallback composition (Open, Save to…, Export image…, Search,
 * Help, canvas background) minus the white-label policy items — see the
 * module docstring.
 */
function drawingCanvasElement(
  options: MountDrawingCanvasOptions,
  initialData: object,
  apiForMenu: ExcalidrawImperativeAPI | null,
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
      // Native keyboard parity (R2): the vendor binds at the document, so
      // the tool chords answer while a drawing note is active even before
      // the canvas takes focus — the same behavior the site has. The scope
      // IS the mount lifetime: a dismissed drawing unmounts the component
      // and the binding goes with it. The app's own chords still win: the
      // app's dispatcher registers on the same node (document, bubble)
      // at boot — before the canvas ever mounts — and answers its chords
      // with stopImmediatePropagation, so the vendor's handler (registered
      // later, same phase) never sees them (app-shortcuts.ts).
      handleKeyboardGlobally: true,
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
          // The app-owned doors (see the module docstring).
          clearCanvas: false,
          export: false,
          toggleTheme: false,
        },
        // The image tool is ON — images are the attachment store's real
        // tenant (canvas-images.ts owns the persistence spine around
        // whatever the vendor inserts). The gates ride the master-only
        // imageOptions prop: a 1920-px long edge and the wire contract's
        // byte ceiling (shared/wire.ts — the same 5 MB every capture path
        // and the server's upload route enforce). A file over either
        // fails at insert, never at sync; the ids the vendor mints are
        // content hashes, so one image pasted twice is one store row.
        tools: { image: true },
      },
      imageOptions: {
        maxWidthOrHeight: 1920,
        maxFileSizeBytes: MAX_ATTACHMENT_BYTES,
      },
      // Master's prop name for the imperative-API callback (stable renamed
      // it excalidrawAPI; the surface's queue-until-ready handle leans on
      // this firing the moment the component is mounted).
      onExcalidrawAPI: onApi,
    },
    // The hand-drawn welcome panel on empty scenes — native chrome the
    // curated build never mounted (the vendor's own default composition).
    createElement(WelcomeScreen),
    // The command palette, self-wired: the component binds its own
    // capture-phase chord (Ctrl/Cmd+Alt+Shift+P or Ctrl/Cmd+Alt+/) and
    // answers through the vendor's dialog system. The site composes its
    // menu item at its app layer; the pad reaches the same feature via
    // the chord (and the SearchMenu item next to it covers Find).
    createElement(CommandPalette),
    // The main menu, the vendor's way: the fallback composition minus the
    // policy items. SearchMenu rides along — the native menu's Find on
    // canvas, which the curated build had off. The Preferences group (the
    // native menu's checkmark rows) renders once the vendor's API callback
    // has fired — see PreferencesGroup.
    createElement(
      MainMenu,
      undefined,
      createElement(MainMenu.DefaultItems.LoadScene),
      createElement(MainMenu.DefaultItems.SaveToActiveFile),
      createElement(MainMenu.DefaultItems.SaveAsImage),
      createElement(MainMenu.Separator),
      createElement(MainMenu.DefaultItems.SearchMenu, {}),
      createElement(MainMenu.DefaultItems.Help),
      createElement(PreferencesGroup, { api: apiForMenu }),
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

  /** The master's setViewport(): navigate the viewport to the scene's
   * non-deleted bounds. The target goes in as BOUNDS (not element
   * records) so navigation works the same tick the elements are fed —
   * setViewport only resolves element records that are already on the
   * canvas, and updateScene applies on the next render. */
  const centerOnContent = (elements: readonly Record<string, unknown>[]): void => {
    if (!api) return;
    const visible = elements.filter((element) => element.isDeleted !== true);
    if (visible.length === 0) return;
    api.setViewport({
      target: getCommonBounds(visible as never),
      fit: 'none', // center on the content, keep the zoom
    });
  };

  const render = (): void => {
    if (!root) return;
    // initialData only takes effect on the FIRST render; the rename
    // re-render passes it unchanged (ignored) and swaps `name`. The font
    // default is the vendor's own: new text speaks the hand-drawn
    // Excalifont, exactly like excalidraw.com ("exactly like native"
    // includes the pen). A scene that carries its own pick — every
    // previously saved scene does, the whitelist persists the key —
    // wins through the verbatim appState spread. The api-for-menu slot
    // hands the Preferences group the live instance: null until the
    // vendor's callback fires, the instance from then on (the callback
    // re-renders once — see below).
    root.render(
      drawingCanvasElement(
        props,
        {
          elements: options.initialScene.elements,
          appState: {
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
        api,
        (instance: ExcalidrawImperativeAPI | null) => {
          api = instance;
          if (instance && pendingFiles.length > 0) {
            instance.addFiles(pendingFiles as unknown as BinaryFileData[]);
            pendingFiles = [];
          }
          // One re-render so the menu's Preferences group receives the
          // instance (its first render saw null and stood down). React
          // reconciles: same props except the children, initialData
          // already consumed — a no-op for the canvas itself. The null
          // call (the master vendor nulls the callback DURING unmount,
          // from componentWillUnmount) must NOT render — the root is
          // going away, and rendering into it throws "Cannot update an
          // unmounted root".
          if (instance) {
            render();
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
        // The note-switch path (drawing→drawing reuse) never re-runs
        // initialData, so a fresh scene (appState {}) would otherwise
        // inherit the previous note's live tool state. A scene that
        // carries its own pick wins the spread, exactly as at mount.
        appState: {
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
 * Renders the live scene to an image — the download menu's image rows and
 * (with options) the drawing export dialog. PNG answers a Blob; SVG
 * answers the serialized markup. Elements marked deleted (the undo ghost
 * trail) never reach an export. The scene's image bytes ride along
 * (`files`, from the live handle or a store hydration) — without them an
 * image element exports as the vendor's gray placeholder, so the caller
 * always passes what it holds.
 *
 * The native export options (R1's dialog speaks them all) map onto the
 * master exporter's own config — the same knobs its dialogs turn:
 * background (canvasBackgroundColor: false = transparent), dark mode
 * (theme), embed scene (the PNG/SVG re-opens as an editable drawing on
 * excalidraw.com), and the export scale.
 */
export interface DrawingImageExportOptions {
  /** Paint the scene's canvas background color. Off = transparent
   * backdrop. */
  background?: boolean;
  /** Render the export in the dark palette regardless of the live
   * theme. */
  dark?: boolean;
  /** Embed the scene in the file metadata — excalidraw.com re-opens it
   * as an editable drawing. */
  embed?: boolean;
  /** The export scale: 1 or 2. */
  scale?: 1 | 2;
}

export async function renderDrawingImage(
  kind: 'png' | 'svg',
  scene: DrawingCanvasScene,
  files?: BinaryFiles | null,
  options?: DrawingImageExportOptions,
): Promise<Blob | string> {
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  const payload = {
    data: {
      elements: elements as never,
      appState: scene.appState as never,
      files: files ?? null,
    },
    type: kind,
    config: {
      canvasBackgroundColor: options?.background === false ? (false as const) : undefined,
      theme: options?.dark === true ? ('dark' as const) : ('light' as const),
      scale: options?.scale ?? 1,
      embedScene: options?.embed ?? false,
    },
  };
  const output = await exportScene(payload as Parameters<typeof exportScene>[0]);
  if (kind === 'svg') {
    return new XMLSerializer().serializeToString(output as unknown as SVGSVGElement);
  }
  return output as unknown as Blob;
}
