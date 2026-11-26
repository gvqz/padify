import { readFileSync, readdirSync, statSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { join as joinSafe } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** The repo root — the base every vendored-tree path below builds on. */
const REPO_ROOT = fileURLToPath(new URL('./', import.meta.url));

/**
 * The vendored Excalidraw tree — the fork's own source of the drawing
 * canvas (see vendor/ and the baseline commit's message). The aliases in
 * resolve.alias below land here; these constants spell each package's entry
 * file so the bare import never depends on a directory's index probing.
 */
const VENDOR_ROOT = joinSafe(REPO_ROOT, 'vendor/excalidraw');
const VENDOR_MAIN_ENTRY = joinSafe(VENDOR_ROOT, 'excalidraw/index.tsx');
const VENDOR_COMMON_ENTRY = joinSafe(VENDOR_ROOT, 'common/src/index.ts');
const VENDOR_ELEMENT_ENTRY = joinSafe(VENDOR_ROOT, 'element/src/index.ts');
const VENDOR_MATH_ENTRY = joinSafe(VENDOR_ROOT, 'math/src/index.ts');
const VENDOR_UTILS_ENTRY = joinSafe(VENDOR_ROOT, 'utils/src/index.ts');
const VENDOR_LASER_ENTRY = joinSafe(VENDOR_ROOT, 'laser-pointer/src/index.ts');
const VENDOR_FRACTIONAL_ENTRY = joinSafe(
  VENDOR_ROOT,
  'fractional-indexing/src/index.ts',
);
/** Prefix replacement bases — absolute, with the trailing slash kept so the
 * subpath remainder appends cleanly. */
const VENDOR_MAIN_BASE = joinSafe(VENDOR_ROOT, 'excalidraw') + '/';
const VENDOR_COMMON_BASE = joinSafe(VENDOR_ROOT, 'common/src') + '/';
const VENDOR_ELEMENT_BASE = joinSafe(VENDOR_ROOT, 'element/src') + '/';
const VENDOR_MATH_BASE = joinSafe(VENDOR_ROOT, 'math/src') + '/';
const VENDOR_UTILS_BASE = joinSafe(VENDOR_ROOT, 'utils/src') + '/';
const VENDOR_LASER_BASE = joinSafe(VENDOR_ROOT, 'laser-pointer/src') + '/';
const VENDOR_FRACTIONAL_BASE = joinSafe(VENDOR_ROOT, 'fractional-indexing/src') + '/';

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
 * Emits the identity font-subset worker the vendored stub points at.
 *
 * The dist era intercepted the vendor's COMPILED chunks here and swapped
 * them for stubs at build time — an interception nobody could review. The
 * source-vendor era moved that stub INTO the vendored tree, where it is an
 * ordinary reviewed edit: subset/subset-shared.chunk.ts answers with the
 * identity pass-through (the wasm subsetter's Emscripten glue was the exact
 * CSP-incompatible eval sink forbidEvalSinks() keeps out of dist), and
 * subset/subset-worker.chunk.ts exports a WorkerUrl pointing at the file
 * this plugin owns — the identity worker below.
 *
 * What still belongs to the BUILD (not the vendor tree): shipping the
 * worker script itself. The vendored stub module cannot be the worker
 * script — it evaluates in the main graph, and a Worker script must be a
 * plain same-origin file speaking the vendor's postMessage protocol
 * ({command, arrayBuffer, codePoints} in, the buffer transferred back).
 * So: prod emits assets/padify-subset-worker.js (the stub's URL math —
 * strip the last segment of its own chunk URL — lands on this sibling),
 * and dev's middleware answers any *padify-subset-worker.js request. The
 * buffer returns untouched: the font loads in full, a few hundred KB on
 * first use per family, offline-safe, CSP-clean, no CDN, no wasm, no eval.
 */
export function emitExcalidrawSubsetWorker(): Plugin {
  /** The worker file's leaf name — the stub's URL math + both servers agree on it. */
  const WORKER_FILE = 'padify-subset-worker.js';
  /** The emitted asset path under dist (Rollup writes fileName verbatim). */
  const WORKER_EMIT_PATH = `assets/${WORKER_FILE}`;

  /**
   * The worker itself: the vendor's protocol (post {command, arrayBuffer,
   * codePoints}, transfer the buffer in; answer postMessage(buffer),
   * transfer it back) with the identity subsetter — the buffer returns
   * untouched, and the font loads in full. Command 0 is the vendored stub's
   * Commands.Subset (subset-shared.chunk.ts owns the constant).
   */
  const WORKER_SOURCE = [
    '/* Padify font-subsetting worker — identity pass-through.',
    ' *',
    " * The vendor's subset worker would run a wasm shaper (eval-family",
    ' * APIs the CSP forbids); this stand-in speaks the same postMessage',
    ' * protocol and returns the buffer untouched — the font loads in',
    ' * full, same-origin, offline-safe. Regenerated by vite.config.ts',
    ' * (emitExcalidrawSubsetWorker); do not edit by hand.',
    ' */',
    'self.onmessage = (event) => {',
    '  const { command, arrayBuffer } = event.data;',
    "  if (command === 0 /* Commands.Subset, per the vendored stub */) {",
    '    self.postMessage(arrayBuffer, { transfer: [arrayBuffer] });',
    '  }',
    '};',
    '',
  ].join('\n');

  return {
    name: 'padify-emit-excalidraw-subset-worker',
    generateBundle() {
      // Prod: the worker file ships as a plain same-origin asset next to
      // the chunks (assets/) — the vendored stub's URL math lands here.
      this.emitFile({ type: 'asset', fileName: WORKER_EMIT_PATH, source: WORKER_SOURCE });
    },
    configureServer(server) {
      // Dev twin: answer any *padify-subset-worker.js request (the stub
      // module resolves its sibling URL wherever vite served it from, the
      // plain path covers hand-typed URLs) with the worker source, JS
      // content-type.
      server.middlewares.use((req, res, next) => {
        if (!req.url?.endsWith(WORKER_FILE)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(WORKER_SOURCE);
      });
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
 * Copies the vendored canvas fonts into the dist tree, same-origin.
 *
 * WHY: master's font manager resolves every FontFace through
 * `window.EXCALIDRAW_ASSET_PATH`. Padify's CSP is `font-src 'self' data:`
 * — a CDN font 404s at the policy layer and canvas text renders on
 * fallback metrics. Pointing the asset path at a copied
 * `dist/vendor/excalidraw/` is the vendor's own documented escape hatch,
 * no CSP loosening — and the fork's tree already carries the font families
 * (vendor/excalidraw/excalidraw/fonts), so the copy source is the tree
 * itself: no build-time resolution that can drift, and the fonts the
 * vendored family registrations name ("./fonts/<family>/<file>.woff2") are
 * byte-identical to what ships.
 *
 * dist-only: the copy runs on every production build, after the bundle is
 * written. Dev serves the SAME fonts from the vendored tree via the
 * configureServer middleware below — the CDN fallback no longer exists to
 * degrade to (the vendored ExcalidrawFontFace has no CDN entry), so this
 * middleware is dev's one live source, and the dev twin is pinned by test
 * (the first mount double-prepended `fonts/` onto a root that already
 * ended in it — every dev font request fell through to the SPA fallback
 * and the browser decoded index.html as a woff2).
 */
export function copyExcalidrawFonts(): Plugin {
  return {
    name: 'padify-copy-excalidraw-fonts',
    configureServer(server) {
      // Dev twin of the closeBundle copy: serve the fonts straight out of
      // the vendored tree so canvas-assets.ts's EXCALIDRAW_ASSET_PATH is
      // valid in every mode (dev has no dist to copy into).
      //
      // The mount MUST include the /fonts segment: the vendor requests
      // every face as `${EXCALIDRAW_ASSET_PATH}fonts/<family>/<file>` —
      // connect strips the mount from req.url, so a shorter mount leaves
      // `fonts/...` in the remainder and the join below would look for
      // .../fonts/fonts/<family>/<file> (the double-fonts bug: silently
      // falls through to the SPA fallback, HTML bytes where a woff2
      // belongs).
      const fontsRoot = joinSafe(VENDOR_ROOT, 'excalidraw/fonts');
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
      const source = joinSafe(VENDOR_ROOT, 'excalidraw/fonts');
      const target = joinSafe(REPO_ROOT, 'dist', EXCALIDRAW_FONTS_DIR, 'fonts');
      if (!existsSync(source)) {
        throw new Error(
          `[vite] the vendored canvas fonts were not found at ${source} — ` +
            'the vendor tree is part of the repo; a missing fonts/ means it was tampered with.',
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
 * Injects a `modulepreload` hint for the drawing canvas chunk into the
 * built index.html — R3's open-time lever (issue #172: "FIX how long it
 * takes to open the canvas").
 *
 * WHY: the canvas rides a lazy chunk that the idle warm (surface.ts's
 * requestIdleCallback) fetches only when the app goes idle — a user who
 * opens a drawing in the first seconds of a session pays the full chunk
 * download on the spot (the measured cold open, ~1.7 s first-ever run).
 * A modulepreload link starts the same download at HTML parse time,
 * parallel to boot, at low priority: by the time the first drawing opens,
 * the bytes are in the HTTP cache and the open is a mount, not a fetch.
 *
 * The chunk is identified by CONTENT, not name: the island is the only
 * module exporting `mountDrawingCanvas`, and the master vendor's chunk
 * graph merges the island into a vendor-shared chunk whose emitted name
 * follows Rollup's dedupe heuristics (it has already been "canvas-*" and
 * "percentages-*" across vendor bumps). Scanning the built assets for
 * that symbol finds the exact file whatever the name. No match = no
 * injection, loud in the log (a renamed chunk layout must be noticed,
 * not silently skipped).
 *
 * The link carries `data-padify-lazy-preload`: scripts/build-sw.mjs skips
 * marked links when deriving the precache manifest, so the chunk keeps
 * its RUNTIME-cached classification (fetched on demand, offline from the
 * first use) instead of being precached into every install — users who
 * never draw never download it twice.
 */
function preloadDrawingChunk(): Plugin {
  return {
    name: 'padify-preload-drawing-chunk',
    closeBundle() {
      const distDir = fileURLToPath(new URL('./dist', import.meta.url));
      const indexPath = joinSafe(distDir, 'index.html');
      if (!existsSync(indexPath)) {
        console.warn('[vite] preloadDrawingChunk: dist/index.html not found — skipped.');
        return;
      }
      let chunkName: string | null = null;
      for (const file of walkJs(distDir)) {
        // The island is content-keyed by two markers: it DEFINES
        // `mountDrawingCanvas` (the surface's main chunk merely calls it —
        // the string appears in both) AND carries the asset-path seam
        // (canvas-assets.ts, imported only by the island). Both together
        // match exactly one file, immune to the vendor's chunk-merge and
        // rename heuristics.
        const code = readFileSafe(file);
        if (code?.includes('mountDrawingCanvas') && code.includes('EXCALIDRAW_ASSET_PATH')) {
          chunkName = file.slice(distDir.length + 1);
          break;
        }
      }
      const html = readFileSync(indexPath, 'utf-8');
      if (!chunkName) {
        console.warn(
          '[vite] preloadDrawingChunk: no chunk carrying mountDrawingCanvas found in dist — ' +
            'the drawing chunk link was not injected (verify the chunk layout).',
        );
        return;
      }
      if (html.includes('data-padify-lazy-preload')) {
        return; // idempotent against a re-run into a non-empty outDir
      }
      const base = (process.env.VITE_BASE_PATH || '/').replace(/\/+$/, '');
      const href = `${base}/${chunkName}`;
      const link = `<link rel="modulepreload" crossorigin href="${href}" data-padify-lazy-preload>`;
      const withPreload = html.replace('</head>', `${link}\n  </head>`);
      if (withPreload === html) {
        console.warn('[vite] preloadDrawingChunk: no </head> to inject before — skipped.');
        return;
      }
      writeFileSyncSafe(indexPath, withPreload);
      console.warn(`[vite] injected modulepreload for the drawing chunk (${chunkName}).`);
    },
  };
}

function writeFileSyncSafe(path: string, content: string): void {
  try {
    writeFileSync(path, content);
  } catch {
    // The injection is an optimization, not a build gate — but a failure
    // to write IS worth seeing in the log.
    console.warn(`[vite] preloadDrawingChunk: could not write ${path}.`);
  }
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

/**
 * The alias table that lands every @excalidraw/* bare specifier onto the
 * vendored source tree — shared by vite.config (build + dev) and
 * vitest.config (which REPLACES vite.config when present, so it needs its
 * own copy of the table; the scene-format pin imports the vendor).
 *
 * Every @excalidraw/* bare specifier, wherever it comes from (the app's
 * canvas island or the vendor's own internals), resolves onto
 * vendor/excalidraw/<pkg>/… source. The exact-match regexes keep the bare
 * import at each package's index; the prefix regexes carry subpaths
 * (@excalidraw/excalidraw/types, @excalidraw/element/binding,
 * @excalidraw/common/utility-types, the self-referencing
 * @excalidraw/excalidraw/scene/types …) into the same tree, extensionless
 * — the resolver applies its usual extension probing on the result.
 *
 * THE POINT: this replaces the dist-patch era's npm pin + hand-written
 * patch on compiled output — every environment (bun, npm, netlify) now
 * resolves THE SAME vendor this repo carries, and every fork delta is a
 * visible source edit under vendor/. The dep that wore this name is gone
 * from package.json — nothing resolves from node_modules anymore.
 */
export const EXCALIDRAW_VENDOR_ALIASES: { find: RegExp; replacement: string }[] = [
  // The main package: bare → index.tsx, subpath → the tree root.
  { find: /^@excalidraw\/excalidraw$/, replacement: VENDOR_MAIN_ENTRY },
  { find: /^@excalidraw\/excalidraw\//, replacement: VENDOR_MAIN_BASE },
  // Workspace packages the main package reaches into.
  { find: /^@excalidraw\/common$/, replacement: VENDOR_COMMON_ENTRY },
  { find: /^@excalidraw\/common\//, replacement: VENDOR_COMMON_BASE },
  { find: /^@excalidraw\/element$/, replacement: VENDOR_ELEMENT_ENTRY },
  { find: /^@excalidraw\/element\//, replacement: VENDOR_ELEMENT_BASE },
  { find: /^@excalidraw\/math$/, replacement: VENDOR_MATH_ENTRY },
  { find: /^@excalidraw\/math\//, replacement: VENDOR_MATH_BASE },
  { find: /^@excalidraw\/utils$/, replacement: VENDOR_UTILS_ENTRY },
  { find: /^@excalidraw\/utils\//, replacement: VENDOR_UTILS_BASE },
  { find: /^@excalidraw\/laser-pointer$/, replacement: VENDOR_LASER_ENTRY },
  { find: /^@excalidraw\/laser-pointer\//, replacement: VENDOR_LASER_BASE },
  {
    find: /^@excalidraw\/fractional-indexing$/,
    replacement: VENDOR_FRACTIONAL_ENTRY,
  },
  {
    find: /^@excalidraw\/fractional-indexing\//,
    replacement: VENDOR_FRACTIONAL_BASE,
  },
];

export default defineConfig({
  // The app is location-agnostic: every emitted URL is rebased onto this.
  // Root deploys (Netlify, a bare domain) leave it at the default '/'; hosts
  // that can only hand out a subpath — alwaysdata-style shared domains —
  // build with VITE_BASE_PATH=/padify/ and everything (index.html refs,
  // asset URLs, the manifest link) moves with it.
  base: process.env.VITE_BASE_PATH || '/',
  resolve: {
    alias: EXCALIDRAW_VENDOR_ALIASES,
  },
  plugins: [
    htmlIncludes(),
    stripDependencyEvalSinks(),
    emitExcalidrawSubsetWorker(),
    copyExcalidrawFonts(),
    serveShareViewerInDev(),
    preloadDrawingChunk(),
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
