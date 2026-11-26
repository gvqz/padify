/**
 * DON'T depend on anything from the outside like `promiseTry`, as this module is part of a separate lazy-loaded chunk.
 *
 * Including anything from the main chunk would include the whole chunk by default.
 * Even it it would be tree-shaken during build, it won't be tree-shaken in dev.
 *
 * In the future consider separating common utils into a separate shared chunk.
 */

// PADIFY FORK — font-subsetting stub (the CSP decision, at the source level).
//
// Upstream's version of this chunk embeds a HarfBuzz-wasm font subsetter:
// the Emscripten glue constructs functions from strings (`new Function(...)`
// — twice) — the exact CSP-incompatible eval sink that forbidEvalSinks()
// exists to keep out of dist. The wasm binaries themselves ride upstream's
// own subset/harfbuzz + subset/woff2 directories, which this fork
// deliberately does not vendor (see the vendor baseline commit).
//
// WHY THE STUB ANSWERS, NOT THROWS: the vendor's font manager fetches a
// family's woff2 from the URL list (first match wins — the same-origin copy
// behind window.EXCALIDRAW_ASSET_PATH) and then subsets it. A throwing stub
// turns that SUCCESSFUL fetch into a failure, and the manager walks its URL
// list looking for the next source (the esm.sh CDN upstream pushes — removed
// from this fork at ExcalidrawFontFace) — which Padify's CSP
// (font-src 'self' data:) blocks, leaving text on fallback metrics. So the
// stub exports the chunk's own surface with subsetting as an identity
// pass-through: the FULL font loads as a data URL — a few hundred KB on
// first use per family, offline-safe, CSP-clean, no CDN contact.
//
// The return shapes mirror upstream's own (toBase64 answers a data: URL,
// all three async) so the font manager's injected @font-face rules stay
// valid. Signatures match upstream's (the codepoints are accepted and
// ignored — an identity subsetter has nothing to say about them), so the
// chunk's consumers typecheck unchanged.

/** Identity: the "subset" of a font is the font. */
const PASS = (buffer: ArrayBuffer): ArrayBuffer => buffer;

export const Commands = {
  Subset: 0,
} as const;

/** A full font as a data: URL, chunked so huge fonts cannot blow the stack. */
export const toBase64 = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
};

/** Upstream's main-thread path: subset → base64. Identity: base64 of the whole font. */
export const subsetToBase64 = async (
  arrayBuffer: ArrayBuffer,
  _codePoints: Array<number>,
): Promise<string> => toBase64(PASS(arrayBuffer));

/** Upstream's worker path: subset → binary. Identity: the buffer itself. */
export const subsetToBinary = async (
  arrayBuffer: ArrayBuffer,
  _codePoints: Array<number>,
): Promise<ArrayBuffer> => PASS(arrayBuffer);
