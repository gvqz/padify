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
 *  - `renderDrawingImage()` / `copyDrawingImage()` are the export APIs
 *    behind the drawing's export dialog (surface.ts) — the same engines
 *    the vendor's own dialogs call.
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
  MainMenu,
  WelcomeScreen,
  exportScene,
  exportToClipboard,
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
// The leak shield — loads AFTER the vendor css (import order is injection
// order, and both land after the app's <link>s: the drawing chunk's css is
// appended to the head when the chunk loads), so its order-tied rollbacks
// win against the app's global element rules while its :where() scoping
// keeps it strictly below every vendor declaration. See the file header.
import './island-shield.css';
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
    // curated build never mounted. The help teaching is gone by the
    // owner's verdict: the HelpHint arrow (it pointed at the footer's
    // "?" button — deleted at the vendor's render tree, patches/) and
    // the center menu's Help row (it opened the vendor's dialog — the
    // dialog and every path to it are deleted in the same patch, so the
    // row was an arrow to nothing too). Center, MenuHint and ToolbarHint
    // keep their own default children, so the panel renders the site's
    // composition minus every help surface.
    createElement(
      WelcomeScreen,
      undefined,
      createElement(WelcomeScreen.Center),
      createElement(WelcomeScreen.Hints.MenuHint),
      createElement(WelcomeScreen.Hints.ToolbarHint),
    ),
    // The main menu, the vendor's way: the fallback composition minus the
    // policy items. SearchMenu (Find on canvas) rides in — native chrome
    // the curated build had off. The command palette does NOT: the vendor
    // exports the component for hosts to compose (excalidraw.com mounts it
    // at its app layer; the vendor's own chrome never mounts one) and this
    // file once did the same — the mount, its menu row and every chord it
    // bound died with that composition. Its doors stay open where they
    // already lived: Find is the row below, the export/background rows and
    // the Preferences submenu keep theirs, and the sheet owns the chords.
    createElement(
      MainMenu,
      undefined,
      createElement(MainMenu.DefaultItems.LoadScene),
      createElement(MainMenu.DefaultItems.SaveToActiveFile),
      createElement(MainMenu.DefaultItems.SaveAsImage),
      createElement(MainMenu.Separator),
      createElement(MainMenu.DefaultItems.SearchMenu, {}),
      // The Help row is the app's unified shortcuts sheet — the ONE help
      // surface on the canvas: issue #179 folds the shortcut story into
      // the sheet (this pane opens on its Drawing tab). The vendor's own
      // dialog is deleted at the render tree (patches/): the footer's
      // "?" button, the "?" chord, the welcome screen's Help row and the
      // dialog component all went with it — nothing here or anywhere on
      // the canvas answers to the vendor's help anymore.
      createElement(
        MainMenu.Item,
        {
          key: 'keyboard-shortcuts',
          shortcut: 'Ctrl+K',
          children: null,
          onSelect: () => {
            // document, not window — window-dispatched events never reach
            // document-level listeners (the app's bridge lives there, the
            // same bus padify:open-link rides).
            document.dispatchEvent(
              new CustomEvent('padify:open-shortcuts', { detail: { pane: 'drawing' } }),
            );
          },
        },
        'Keyboard shortcuts',
      ),
      // The vendor’s OWN Preferences submenu — the same component the
      // site renders (MainMenu.DefaultItems.Preferences, exported by the
      // pin all along). The previous build hand-composed three inline rows
      // (snap, grid, zen) because the FALLBACK composition has no
      // Preferences section — true, but the submenu component ships with
      // the site’s full row set (tool lock, snap, grid, zen, view mode,
      // minimap, element properties, arrow binding, midpoint snapping,
      // hints). Persistence is unchanged: the toggles flip appState, the
      // change rides onChange into the surface, and the whitelist carries
      // zen + snap + grid exactly as before; the rest are session-only,
      // same as the site.
      createElement(MainMenu.DefaultItems.Preferences),
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
    // wins through the verbatim appState spread.
    root.render(
      drawingCanvasElement(
        props,
        {
          elements: options.initialScene.elements,
          appState: {
            // No appState defaults here — deliberately. The vendor's own
            // defaults ARE excalidraw.com's defaults (the site renders this
            // exact component with none either): the minimap starts closed
            // (its toggle sits in the footer), the theme follows the props.
            // Anything forced here compounds: forcing the map open made the
            // vendor reserve its 138px column clearance and CLIP the styles
            // panel (Layers/Actions rows) — measured, not guessed.
            ...options.initialScene.appState,
          },
        },
        (instance: ExcalidrawImperativeAPI | null) => {
          api = instance;
          if (instance && pendingFiles.length > 0) {
            instance.addFiles(pendingFiles as unknown as BinaryFileData[]);
            pendingFiles = [];
          }
          // No re-render here: every menu child is unconditional — the one
          // api-gated child (the command palette row) is gone, and the
          // re-render existed only for it (the instance changes nothing the
          // React tree can see). The null call is the vendor unmounting
          // (it nulls the callback from componentWillUnmount); the
          // assignment above is all the null call needs.
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
        // carries its own pick wins the spread, exactly as at mount. No
        // baseline appState of our own: the live state carries over, the
        // scene's pick (none for a fresh note) applies.
        appState: {
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
 * Renders the live scene to an image — the drawing export dialog's Save
 * press (and the share/snapshot seams). PNG answers a Blob; SVG answers
 * the serialized markup. Elements marked deleted (the undo ghost trail)
 * never reach an export. The scene's image bytes ride along (`files`, from
 * the live handle or a store hydration) — without them an image element
 * exports as the vendor's gray placeholder, so the caller always passes
 * what it holds.
 *
 * The native export options (the dialog speaks them all) map onto the
 * master exporter's own config — the same knobs its dialogs turn:
 * background (canvasBackgroundColor: false = transparent), dark mode
 * (theme), embed scene (the PNG/SVG re-opens as an editable drawing on
 * excalidraw.com), and the export scale (1×/2×/3× — the vendor's
 * EXPORT_SCALES verbatim).
 */
export interface DrawingImageExportOptions {
  /** Paint the scene's canvas background color. Off = transparent
   * backdrop. */
  background?: boolean;
  /** Render the export in the dark palette regardless of the live
   * theme. */
  dark?: boolean;
  /** Embed the scene in the file metadata — excalidraw.com re-opens it
   * as an editable drawing (PNG tEXt chunk / SVG metadata element). */
  embed?: boolean;
  /** The export scale: 1, 2 or 3. */
  scale?: 1 | 2 | 3;
}

/** The config the two export paths share — the same keys the vendor's
 * getExportConfigFromAppState turns from its dialog's switches. */
function exportConfigFrom(
  options?: DrawingImageExportOptions,
): Parameters<typeof exportScene>[0]['config'] {
  return {
    canvasBackgroundColor: options?.background === false ? (false as const) : undefined,
    theme: options?.dark === true ? ('dark' as const) : ('light' as const),
    scale: options?.scale ?? 1,
    embedScene: options?.embed ?? false,
  };
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
    config: exportConfigFrom(options),
  };
  const output = await exportScene(payload as Parameters<typeof exportScene>[0]);
  if (kind === 'svg') {
    return new XMLSerializer().serializeToString(output as unknown as SVGSVGElement);
  }
  return output as unknown as Blob;
}

/**
 * Copies the live scene to the clipboard — the drawing export dialog's
 * Copy press, on the vendor's own pipe: PNG rides as an image/png blob
 * (exportToClipboard's `png` flavor — ClipboardItem on the vendor's own
 * capability gates), SVG rides as the markup text (its `svg` flavor,
 * the same path the vendor's copyAsSvg context action speaks). Throws on
 * failure; the caller's toast answers.
 */
export async function copyDrawingImage(
  kind: 'png' | 'svg',
  scene: DrawingCanvasScene,
  files?: BinaryFiles | null,
  options?: DrawingImageExportOptions,
): Promise<void> {
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  await exportToClipboard({
    type: kind,
    data: {
      elements: elements as never,
      appState: scene.appState as never,
      files: files ?? null,
    },
    config: exportConfigFrom(options),
  } as Parameters<typeof exportToClipboard>[0]);
}
