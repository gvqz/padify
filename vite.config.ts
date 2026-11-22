import { readFileSync, readdirSync, statSync, cpSync, existsSync } from 'node:fs';
import { join as joinSafe } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Strips the shipped eval sink — the dependency code path that constructs
 * functions from strings:
 *
 *   The setImmediate polyfill bundled inside docx (YuzuJS):
 *   `new Function("" + task)` — its fallback when setImmediate is called
 *   with a NON-function, which docx never does. Replaced with a no-op
 *   function: same silent degradation, no eval.
 *
 * The rewrite is id-scoped to the package so nothing else can be
 * collaterally matched, and the forbidEvalSinks() plugin fails the build
 * if any future dependency reintroduces a sink.
 *
 * Exported so a test can pin the transformation (and the not-found
 * warnings for future versions that move the lines).
 */
export function stripDependencyEvalSinks(): Plugin {
  const SETIMMEDIATE_EVAL = /new Function\(""\s*\+\s*(\w+)\)/g;
  return {
    name: 'padify-strip-dependency-eval-sinks',
    transform(code, id) {
      const isJsModule = /\.(js|mjs|cjs)$/.test(id) || id.includes('/index.mjs?');

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
 * Neuters Excalidraw's font-subsetting chunks out of the shipped bundle —
 * and degrades the vendor's subset pipeline GRACEFULLY.
 *
 * @excalidraw/excalidraw embeds a HarfBuzz-wasm font subsetter: the
 * vendor's `subset-shared.chunk.js` re-exports `chunk-EIO257PC.js`, whose
 * Emscripten glue constructs functions from strings (`new Function(...)`
 * — twice) — the exact CSP-incompatible eval sink forbidEvalSinks() exists
 * to keep out of dist. The subsetter only shrinks the font payload a
 * canvas text render loads to the glyphs actually used.
 *
 * WHY THE STUB ANSWERS, NOT THROWS: the vendor's font manager fetches a
 * family's woff2 from the URL list (first match wins — the same-origin
 * copy, see copyExcalidrawFonts) and then subsets it. A throwing stub
 * turns that SUCCESSFUL fetch into a failure, and the manager walks its
 * URL list to the vendor's esm.sh CDN fallback — which Padify's CSP
 * (font-src 'self' data:) blocks, leaving text on fallback metrics (the
 * upgrade audit's loudest console fire). So the stub exports the chunk's
 * own surface (Commands, subsetToBase64, subsetToBinary, toBase64) with
 * subsetting as an identity pass-through: the FULL font loads from a
 * data URL — a few hundred KB on first use per family, offline-safe,
 * CSP-clean, no CDN contact.
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
    "// builds). The chunk's own surface answers with an identity",
    '// pass-through — the full font loads un-subsetted from the',
    '// same-origin copy; no CDN, no wasm, no eval. The return shapes',
    "// mirror the vendor's own (toBase64 answers a data: URL, all three",
    "// async) so the font manager's injected @font-face rules stay valid.",
    'const PASS = (buffer) => buffer;',
    'export const Commands = { Subset: 0 };',
    'export const toBase64 = async (buffer) => {',
    '  const bytes = new Uint8Array(buffer);',
    '  let binary = "";',
    '  const step = 0x8000;',
    '  for (let i = 0; i < bytes.length; i += step) {',
    '    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));',
    '  }',
    '  return `data:font/woff2;base64,${btoa(binary)}`;',
    '};',
    'export const subsetToBase64 = async (buffer) => toBase64(PASS(buffer));',
    'export const subsetToBinary = async (buffer) => PASS(buffer);',
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
            'the subset pipeline passes fonts through un-subsetted, same-origin, no CDN.',
        );
        return STUB_CODE;
      }
      if (id === STUB_ID) {
        return STUB_CODE;
      }
      return null;
    },
    transform(code, id) {
      // The vendor's font-face builder appends the esm.sh CDN to EVERY
      // face's URL list as a last-resort fallback. Under Padify's CSP the
      // CDN is unreachable by policy — the attempts are 230 wasted loads
      // per session and 230 console errors. The same-origin copy (see
      // copyExcalidrawFonts) is the one live source, so the fallback push
      // goes away entirely; scoped to the vendor's own chunk, loud on a
      // future version that renames the line.
      const isJsModule = /\.(js|mjs|cjs)$/.test(id) || id.includes('/index.mjs?');
      if (
        isJsModule &&
        id.includes('@excalidraw/excalidraw/dist/') &&
        code.includes('ASSETS_FALLBACK_URL')
      ) {
        const stripped = code.replace(
          /\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\),?/g,
          '',
        );
        if (stripped === code) {
          console.warn(
            `[vite] ${id}: ASSETS_FALLBACK_URL present but the CDN fallback push was not found to strip — ` +
              'verify the font-face URL list still has no CDN entry.',
          );
          return null;
        }
        return { code: stripped, map: null };
      }
      return null;
    },
  };
}

/**
 * The dist-relative home of the copied canvas fonts. Shared by canvas.ts
 * (which derives EXCALIDRAW_ASSET_PATH from it) and scripts/build-sw.mjs
 * (which classifies the folder runtime-cached, never precached).
 */
export const EXCALIDRAW_FONTS_DIR = 'vendor/excalidraw';

/**
 * Copies the vendor's canvas fonts into the dist tree, same-origin.
 *
 * WHY: master's font manager resolves every FontFace through
 * `window.EXCALIDRAW_ASSET_PATH` and falls back to the esm.sh CDN
 * (`ASSETS_FALLBACK_URL`) when the host sets nothing. Padify's CSP is
 * `font-src 'self' data:` — every CDN font 404s at the policy layer and
 * canvas text renders with fallback metrics (the upgrade audit's loudest
 * console fire). Pointing the asset path at a copied
 * `dist/vendor/excalidraw/` is the vendor's own documented escape hatch,
 * no CSP loosening.
 *
 * dist-only: the repo never carries 14 MB of woff2 files (Xiaolai alone
 * is 13 MB of CJK subsets); the copy runs on every production build,
 * after the bundle is written. Dev serves the SAME fonts straight out of
 * node_modules via the configureServer middleware below — the CDN
 * fallback no longer exists to degrade to (stubExcalidrawFontSubsetting
 * strips the CDN push from the vendor chunk), so the middleware is dev's
 * one live source, and the dev twin is pinned by test (the first mount
 * double-prepended `fonts/` onto a root that already ended in it — every
 * dev font request fell through to the SPA fallback and the browser
 * decoded index.html as a woff2).
 */
export function copyExcalidrawFonts(): Plugin {
  return {
    name: 'padify-copy-excalidraw-fonts',
    configureServer(server) {
      // Dev twin of the closeBundle copy: serve the fonts straight out of
      // node_modules so canvas-assets.ts's EXCALIDRAW_ASSET_PATH is valid
      // in every mode (dev has no dist to copy into).
      //
      // The mount MUST include the /fonts segment: the vendor requests
      // every face as `${EXCALIDRAW_ASSET_PATH}fonts/<family>/<file>` —
      // connect strips the mount from req.url, so a shorter mount leaves
      // `fonts/...` in the remainder and the join below would look for
      // .../dist/prod/fonts/fonts/<family>/<file> (the double-fonts bug:
      // silently falls through to the SPA fallback, HTML bytes where a
      // woff2 belongs).
      const repoRoot = fileURLToPath(new URL('./', import.meta.url));
      const fontsRoot = joinSafe(repoRoot, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      server.middlewares.use(`/${EXCALIDRAW_FONTS_DIR}/fonts`, (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const file = joinSafe(fontsRoot, url.replace(/^\/+/, ''));
        if (!file.startsWith(fontsRoot) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'font/woff2');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      const repoRoot = fileURLToPath(new URL('./', import.meta.url));
      const source = joinSafe(repoRoot, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      const target = joinSafe(repoRoot, 'dist', EXCALIDRAW_FONTS_DIR, 'fonts');
      if (!existsSync(source)) {
        throw new Error(
          `[vite] @excalidraw/excalidraw fonts not found at ${source} — ` +
            'install the dependency before building.',
        );
      }
      cpSync(source, target, { recursive: true });
      const families = readdirSync(target).length;
      console.warn(
        `[vite] copied the canvas fonts (${families} families) to dist/${EXCALIDRAW_FONTS_DIR}/fonts — ` +
          'EXCALIDRAW_ASSET_PATH resolves them same-origin, no CDN.',
      );
    },
  };
}

/**
 * Dev-only serving of the share viewer (public/share/) for /share/ links.
 *
 * WHY: production serves dist/share/ statically — /share/?t=<token>
 * resolves to dist/share/index.html (Netlify's directory index; the box
 * host maps the subpath the same way) — but Vite's dev server runs its
 * SPA fallback before any directory-index reading, so /share/?t=…
 * answered the APP SHELL: a developer who copies a link out of a locally
 * run app got the editor instead of the read-only note, and the e2e
 * share specs' viewer leg silently asserted against the app (whose
 * editor shows the same words the note carries) instead of the viewer.
 * The middleware answers from public/share/ only — path-resolved and
 * prefix-checked like the fonts twin above — with the viewer's own
 * content types. The build/preview path needs none of this: public/ is
 * copied verbatim into dist/ and the static host does the rest.
 */
function serveShareViewerInDev(): Plugin {
  const repoRoot = fileURLToPath(new URL('./', import.meta.url));
  const shareRoot = joinSafe(repoRoot, 'public', 'share');
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  return {
    name: 'padify-serve-share-viewer-in-dev',
    configureServer(server) {
      server.middlewares.use('/share', (req, res, next) => {
        // connect strips the mount: req.url is '' | '/' | '/<file>' —
        // plus the query, which never names a file.
        const path = (req.url ?? '').split('?')[0];
        const relative = path === '' || path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        const file = joinSafe(shareRoot, relative);
        if (!file.startsWith(shareRoot) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        const mime = MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.end(readFileSync(file));
      });
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
    copyExcalidrawFonts(),
    serveShareViewerInDev(),
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
