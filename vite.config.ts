import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as joinSafe } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Strips the shipped eval sinks — the two dependency code paths that
 * construct functions from strings:
 *
 *  1. SweetAlert2's declarative `<swal-function-param value="() => ...">`
 *     parser: `new Function(`return ${value}`)()`. Padify never renders
 *     that markup and the site CSP (`script-src` without 'unsafe-eval')
 *     already makes the call THROW — dead weight that ships a literal
 *     eval-from-attribute signature (the pattern Malwarebytes Browser
 *     Guard's heuristics flag as obfuscated malware in the deployed
 *     bundle). Replaced with `undefined`: the param is ignored, exactly
 *     how the CSP would degrade it.
 *
 *  2. The setImmediate polyfill bundled inside docx (YuzuJS):
 *     `new Function("" + task)` — its fallback when setImmediate is
 *     called with a NON-function, which docx never does. Replaced with
 *     a no-op function: same silent degradation, no eval.
 *
 * Both rewrites are id-scoped to their package so nothing else can be
 * collaterally matched, and the forbidEvalSinks() plugin fails the build
 * if any future dependency reintroduces a sink.
 *
 * Exported so a test can pin the transformations (and the not-found
 * warnings for future versions that move the lines).
 */
export function stripDependencyEvalSinks(): Plugin {
  const SWEALERT_EVAL = /new Function\(`return \$\{(\w+)\}`\)\(\)/g;
  const SETIMMEDIATE_EVAL = /new Function\(""\s*\+\s*(\w+)\)/g;
  return {
    name: 'padify-strip-dependency-eval-sinks',
    transform(code, id) {
      const isJsModule = /\.(js|mjs|cjs)$/.test(id) || id.includes('/index.mjs?');
      // SweetAlert2's parser. (The id check must skip the package's CSS
      // entry — `sweetalert2.min.css` also matches the package name but
      // carries no JavaScript.)
      if (id.includes('sweetalert2') && isJsModule) {
        if (!SWEALERT_EVAL.test(code)) {
          SWEALERT_EVAL.lastIndex = 0;
          console.warn(
            `[vite] sweetalert2 module (${id}) changed — the <swal-function-param> ` +
              'eval sink was not found to strip. Verify no new Function() ships in the bundle.',
          );
          return null;
        }
        SWEALERT_EVAL.lastIndex = 0;
        const stripped = code.replace(
          SWEALERT_EVAL,
          'undefined /* padify: eval sink stripped — <swal-function-param> is unsupported (CSP has no unsafe-eval) */',
        );
        return { code: stripped, map: null };
      }

      // docx's bundled setImmediate polyfill.
      if (id.includes('docx') && isJsModule) {
        if (!SETIMMEDIATE_EVAL.test(code)) {
          SETIMMEDIATE_EVAL.lastIndex = 0;
          return null; // docx builds without the polyfill need no patch
        }
        SETIMMEDIATE_EVAL.lastIndex = 0;
        const stripped = code.replace(
          SETIMMEDIATE_EVAL,
          'function () {} /* padify: eval sink stripped — setImmediate accepts functions only */',
        );
        return { code: stripped, map: null };
      }

      return null;
    },
  };
}

/**
 * Stubs Excalidraw's font-subsetting chunks out of the shipped bundle.
 *
 * @excalidraw/excalidraw 0.18 embeds a HarfBuzz-wasm font subsetter: the
 * vendor's `subset-shared.chunk.js` re-exports `chunk-EIO257PC.js`, whose
 * Emscripten glue constructs functions from strings (`new Function(...)`
 * — twice) — the exact CSP-incompatible eval sink forbidEvalSinks() exists
 * to keep out of dist. The subsetter only serves the "embed fonts into an
 * exported artifact" path, and the vendor's own font-manager wraps every
 * subsetting call in a try/catch whose fallback references the FULL font
 * URL instead of a base64 subset — so a stub that throws at module
 * evaluation lands in the vendor's documented degradation, not a crash:
 * exports stay valid, they just don't carry a subset font payload.
 *
 * The redirect is scoped to the vendor's internal dynamic imports of
 * `./subset-shared.chunk.js` / `./subset-worker.chunk.js`; the wasm chunk
 * behind them becomes unreachable and Rollup drops it. If a future
 * version renames the chunks the stub stops matching — and the build
 * fails loudly on the eval sink, so the miss can never ship silently.
 */
export function stubExcalidrawFontSubsetting(): Plugin {
  const STUB_ID = '\0padify-excalidraw-subset-stub';
  const STUB_CODE = [
    '// Padify stub: Excalidraw font subsetting is not shipped (eval-free',
    '// builds; the vendor falls back to referencing the full font URL).',
    "throw new Error('Padify: Excalidraw font subsetting is not shipped');",
  ].join('\n');
  /** The vendor's subsetter chunks, however the resolver spelled them. */
  const isSubsetChunk = (id: string): boolean =>
    id.includes('@excalidraw/excalidraw/dist/') &&
    /subset-(shared|worker)\.chunk\.[cm]?js/.test(id);
  return {
    name: 'padify-stub-excalidraw-font-subsetting',
    resolveId(source, importer) {
      if (
        (source === './subset-shared.chunk.js' || source === './subset-worker.chunk.js') &&
        typeof importer === 'string' &&
        importer.includes('@excalidraw/excalidraw/dist/')
      ) {
        return STUB_ID;
      }
      return null;
    },
    load(id) {
      // Rollup resolves the vendor's internal relative imports natively —
      // the resolveId hook never sees them — so the interception happens
      // at load time, on the resolved absolute path (dev keeps the
      // resolveId path above).
      if (isSubsetChunk(id)) {
        console.warn(
          `[vite] stubbed Excalidraw font subsetting (${id.split('/').pop()}) — ` +
            'exports fall back to the full font URL, no eval shipped.',
        );
        return STUB_CODE;
      }
      if (id === STUB_ID) {
        return STUB_CODE;
      }
      return null;
    },
  };
}

/**
 * Build invariant: no eval sinks in any shipped chunk. Runs after the
 * bundle is written; a reintroduced `new Function(` anywhere in dist
 * fails the build instead of shipping a scanner-detectable signature.
 */
function forbidEvalSinks(): Plugin {
  return {
    name: 'padify-forbid-eval-sinks',
    closeBundle() {
      const distDir = fileURLToPath(new URL('./dist', import.meta.url));
      const files = walkJs(distDir);
      const offenders = files.filter(
        (file) => readFileSafe(file)?.includes('new Function(') === true,
      );
      if (offenders.length > 0) {
        const names = offenders.map((file) => file.slice(distDir.length + 1));
        throw new Error(
          `[vite] eval sink(s) shipped in bundle: ${names.join(', ')} — new Function() is ` +
            "CSP-incompatible (script-src without 'unsafe-eval') and trips malware heuristics.",
        );
      }
    },
  };
}

function walkJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSyncSafe(dir)) {
    const full = joinSafe(dir, entry);
    if (isDirectorySafe(full)) {
      out.push(...walkJs(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectorySafe(full: string): boolean {
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function readFileSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse-time `<!--#include <path-relative-to-repo-root> -->` expansion for
 * index.html (works in dev and build).
 *
 * Why includes instead of JS-mounting chrome: the topbar is visible chrome
 * and the theme pre-paint script inside index.html toggles .navbar classes
 * while the document is still parsing — the markup has to be there at parse
 * time or the theme flashes and the script throws. Includes keep the DOM
 * byte-identical while giving the markup a real home (src/ui/topbar.html).
 * Only use it for markup that must exist before boot; feature markup mounts
 * through boot.ts, dialogs through src/ui/modals.
 */
function htmlIncludes(): Plugin {
  const repoRoot = fileURLToPath(new URL('./', import.meta.url));
  return {
    name: 'padify-html-includes',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<!--#include\s+(.+?)\s*-->/g, (_match, file: string) =>
          readFileSync(repoRoot + file.trim(), 'utf-8'),
        );
      },
    },
  };
}

export default defineConfig({
  // The app is location-agnostic: every emitted URL is rebased onto this.
  // Root deploys (Netlify, a bare domain) leave it at the default '/'; hosts
  // that can only hand out a subpath — alwaysdata-style shared domains —
  // build with VITE_BASE_PATH=/padify/ and everything (index.html refs,
  // asset URLs, the manifest link) moves with it.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [
    htmlIncludes(),
    stripDependencyEvalSinks(),
    stubExcalidrawFontSubsetting(),
    forbidEvalSinks(),
  ],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      // The cloud API (server/) runs separately; in dev every /api call is
      // proxied to it so the app talks same-origin, exactly like production.
      '/api': {
        target: 'http://localhost:3041',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3000,
    host: true,
  },
});
