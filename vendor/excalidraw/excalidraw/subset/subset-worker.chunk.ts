/**
 * DON'T depend on anything from the outside like `promiseTry`, as this module is part of a separate lazy-loaded chunk.
 *
 * Including anything from the main chunk would include the whole chunk by default.
 * Even it it would be tree-shaken during build, it won't be tree-shaken in dev.
 *
 * In the future consider separating common utils into a separate shared chunk.
 */

// PADIFY FORK — worker-chunk stub (the CSP decision, at the source level).
//
// Upstream's version of this chunk doubles as the worker script: it exports
// the WorkerUrl AND carries the worker-side onmessage handler that runs the
// HarfBuzz-wasm subsetter (an eval-family glue the CSP forbids — see
// subset-shared.chunk's stub note). The fork keeps the export (the pool's
// one question) but the URL points at the identity pass-through worker that
// vite.config.ts emits (assets/padify-subset-worker.js in prod; the dev
// middleware answers in dev) — same-origin, CSP worker-src 'self', speaking
// the same postMessage protocol: the buffer returns untouched, and the font
// loads in full.
//
// No `new URL(x, import.meta.url)` here — Vite tries to statically rewrite
// that shape and logs a warning it cannot resolve it. The string replace
// lands on the emitted sibling file whatever the chunk's own URL is.

/**
 * Due to this export (and related dynamic import), this worker code will be included in the bundle automatically (as a separate chunk),
 * without the need for esbuild / vite /rollup plugins and special browser / server treatment.
 *
 * `import.meta.url` is undefined in nodejs
 */
export const WorkerUrl: URL | undefined = import.meta.url
  ? new URL(
      import.meta.url.replace(/[^/]*$/, "padify-subset-worker.js"),
    )
  : undefined;
