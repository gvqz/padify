/**
 * The canvas's asset resolution — set BEFORE the vendor module evaluates.
 *
 * WHY A SEPARATE MODULE: the vendor registers its 250+ FontFaces eagerly
 * at module evaluation, and canvas.ts's static import of
 * @excalidraw/excalidraw evaluates that whole tree BEFORE canvas.ts's own
 * body could run. The font manager resolves each FontFace through
 * window.EXCALIDRAW_ASSET_PATH and falls back to the esm.sh CDN when the
 * host sets nothing — a CDN Padify's CSP (font-src 'self' data:) blocks,
 * leaving canvas text on fallback metrics. Listing this module FIRST in
 * canvas.ts's imports guarantees the path exists before a single face is
 * built. (The CDN entries stay in every face's URL list — they are
 * unreachable by policy, never by a missing config.)
 *
 * The path target: the build copies the vendor's fonts to
 * dist/vendor/excalidraw/fonts/ (vite.config.ts's copyExcalidrawFonts,
 * defined alongside EXCALIDRAW_FONTS_DIR). BASE_URL keeps a subpath build
 * (VITE_BASE_PATH=/padify/) honest. Dev serves the same fonts from
 * node_modules through the plugin's configureServer middleware — the
 * vendor's CDN fallback was stripped from the chunk (CSP-blocked anyway),
 * so this path is the one live source in every mode.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH ??= `${import.meta.env.BASE_URL}vendor/excalidraw/`;

export {};
