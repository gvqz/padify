// @vitest-environment node
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCALIDRAW_FONTS_DIR,
  copyExcalidrawFonts,
  stripDependencyEvalSinks,
  stubExcalidrawFontSubsetting,
} from '../vite.config';

type TransformFn = (code: string, id: string) => { code: string; map: unknown } | null;

/** Resolves the plugin's transform hook to a plain callable. */
function transformOf(plugin: ReturnType<typeof stripDependencyEvalSinks>): TransformFn {
  const hook = plugin.transform;
  if (typeof hook === 'function') {
    return hook as unknown as TransformFn;
  }
  return ((code: string, id: string) =>
    (hook as { handler: TransformFn }).handler(code, id)) as TransformFn;
}

type LoadFn = (id: string) => string | null;
type ResolveFn = (source: string, importer: string | undefined) => string | null;

/** The stub plugin's load hook, as a plain callable. */
function loadOf(plugin: ReturnType<typeof stubExcalidrawFontSubsetting>): LoadFn {
  const hook = plugin.load;
  if (typeof hook === 'function') {
    return hook as unknown as LoadFn;
  }
  return ((id: string) => (hook as { handler: LoadFn }).handler(id)) as LoadFn;
}

/** The stub plugin's resolveId hook, as a plain callable. */
function resolveOf(plugin: ReturnType<typeof stubExcalidrawFontSubsetting>): ResolveFn {
  const hook = plugin.resolveId;
  if (typeof hook === 'function') {
    return hook as unknown as ResolveFn;
  }
  return ((source: string, importer: string | undefined) =>
    (hook as { handler: ResolveFn }).handler(source, importer)) as ResolveFn;
}

/**
 * The bundle-hygiene plugin, pinned: the shipped eval sink — docx's
 * bundled setImmediate polyfill — is stripped in its own module, other
 * code passes through untouched, and the CSP already forbids what the
 * strip removes (no 'unsafe-eval' in script-src). (The old sweetalert2
 * arm died with the dependency itself — the app owns its dialogs.)
 */

const DOCX_LINE = '"function" != typeof e4 && (e4 = new Function("" + e4));';

describe('stripDependencyEvalSinks', () => {
  it('replaces docx\u2019s setImmediate fallback with a no-op function', () => {
    const plugin = stripDependencyEvalSinks();
    const result = transformOf(plugin)(DOCX_LINE, '/repo/node_modules/docx/build/index.mjs');

    expect(result).not.toBeNull();
    expect(result!.code).not.toContain('new Function');
    // setImmediate still accepts its argument; the non-function fallback
    // becomes a silent no-op instead of an eval.
    expect(result!.code).toContain('function () {}');
  });

  it('leaves every other module alone', () => {
    const plugin = stripDependencyEvalSinks();
    const result = transformOf(plugin)(DOCX_LINE, '/repo/src/editor/model-port.ts');

    expect(result).toBeNull();
  });

  it('a docx module without the polyfill passes through (no warn-worthy sink)', () => {
    const plugin = stripDependencyEvalSinks();
    const result = transformOf(plugin)(
      'export const Packer = {};',
      '/repo/node_modules/docx/build/index.mjs',
    );

    expect(result).toBeNull();
  });
});

/**
 * The Excalidraw font-subsetting stub, pinned: the vendor's wasm
 * subsetter (an Emscripten blob that constructs functions from strings)
 * must never ship — both interception paths answer the same pass-through
 * stub, scoping is id-tight (only the vendor's own subset chunks), and
 * everything else passes through to the real file. The stub answers with
 * the chunk's own export surface and subsetting as an identity: a
 * THROWING stub would turn the font manager's successful same-origin
 * fetch into a failure and walk it onto the CDN (CSP-blocked), so the
 * pass-through is what keeps text on the real fonts — and
 * forbidEvalSinks() keeps the whole arrangement honest on every future
 * vendor bump.
 */
describe('stubExcalidrawFontSubsetting', () => {
  const VENDOR = '/repo/node_modules/@excalidraw/excalidraw/dist/prod';

  it('load() answers the subsetter stub for the shared chunk', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const load = loadOf(plugin);
    const code = load(`${VENDOR}/subset-shared.chunk.js`);
    expect(code).not.toBeNull();
    expect(code).toContain('export const subsetToBase64');
    expect(code).toContain('export const toBase64');
    expect(code).toContain('data:font/woff2;base64');
    expect(code).not.toContain('throw new Error');
  });

  it('load() answers the worker chunk with a WorkerUrl export — the pool\u2019s one question', () => {
    // The vendor destructures { WorkerUrl } from this chunk and hands it to
    // WorkerPool.create; undefined made create throw WorkerUrlNotDefinedError
    // on every export-dialog open (console.error — audited 2026-11-24). The
    // stub answers with a URL derived from its own module URL: in prod the
    // stub is inlined into the vendor's assets/ chunk, so stripping the last
    // segment lands on the emitted padify-subset-worker.js sibling.
    const plugin = stubExcalidrawFontSubsetting();
    const code = loadOf(plugin)(`${VENDOR}/subset-worker.chunk.js`);
    expect(code).not.toBeNull();
    expect(code).toContain('export const WorkerUrl');
    expect(code).toContain('padify-subset-worker.js');
    expect(code).not.toContain('export const subsetToBase64');
    expect(code).not.toContain('throw new Error');
  });

  it('generateBundle() emits the identity subset worker the WorkerUrl points at', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const hook = plugin.generateBundle;
    if (typeof hook !== 'function') throw new Error('generateBundle hook missing');
    const emitted: Record<string, string> = {};
    (
      hook as unknown as (this: {
        emitFile(file: { type: string; fileName: string; source: string }): void;
      }) => void
    ).call({
      emitFile(file: { type: string; fileName: string; source: string }) {
        emitted[file.fileName] = file.source;
      },
    });
    const worker = emitted['assets/padify-subset-worker.js'];
    expect(worker).toBeDefined();
    expect(worker).toContain('self.onmessage');
    // the vendor's job shape: {command, arrayBuffer, codePoints}, transfer in,
    // the buffer answers transferred back — command 0 is the stub's Subset.
    expect(worker).toContain('command === 0');
    expect(worker).toContain('postMessage(arrayBuffer, { transfer: [arrayBuffer] })');
  });

  it('configureServer() answers any *padify-subset-worker.js request in dev', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const hook = plugin.configureServer as unknown as
      ((server: unknown) => void) | { handler: (server: unknown) => void };
    const configure = typeof hook === 'function' ? hook : hook.handler;
    let registered: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
    configure({
      middlewares: {
        use: (handler: (req: { url?: string }, res: unknown, next: () => void) => void) => {
          registered = handler;
        },
      },
    });
    if (!registered) throw new Error('no dev middleware registered');
    const answer = registered;
    // The virtual stub resolves the sibling under /@id/… — both spellings
    // must answer, everything else passes through.
    for (const url of [
      '/@id/padify-subset-worker.js',
      '/assets/padify-subset-worker.js',
      '/padify-subset-worker.js',
    ]) {
      const headers: Record<string, string> = {};
      let body: unknown = null;
      let passed = false;
      registered(
        { url },
        {
          setHeader: (name: string, value: string) => (headers[name] = value),
          end: (buf: unknown) => (body = buf),
        },
        () => {
          passed = true;
        },
      );
      expect(passed, url).toBe(false);
      expect(headers['Content-Type'], url).toBe('text/javascript');
      expect(String(body), url).toContain('self.onmessage');
    }
    let passed = false;
    answer(
      { url: '/src/editor/drawing/canvas.ts' },
      { setHeader: () => undefined, end: () => undefined },
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });

  it('resolveId() claims the vendor\u2019s internal dynamic imports (the dev path)', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const resolve = resolveOf(plugin);
    expect(resolve('./subset-shared.chunk.js', `${VENDOR}/chunk-K2UTITRG.js`)).toBe(
      '\0padify-excalidraw-subset-stub',
    );
    expect(resolve('./subset-worker.chunk.js', `${VENDOR}/chunk-K2UTITRG.js`)).toBe(
      '\0padify-excalidraw-subset-stub',
    );
  });

  it('the stub id itself loads (the resolveId arm and the load arm agree)', () => {
    const plugin = stubExcalidrawFontSubsetting();
    expect(loadOf(plugin)('\0padify-excalidraw-subset-stub')).toContain('export const Commands');
  });

  it('nothing else is claimed or stubbed — scope is the vendor\u2019s subsetter only', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const load = loadOf(plugin);
    const resolve = resolveOf(plugin);
    expect(resolve('./subset-shared.chunk.js', '/repo/src/editor/drawing/canvas.ts')).toBeNull();
    expect(resolve('./main.js', VENDOR)).toBeNull();
    expect(load(`${VENDOR}/chunk-EIO257PC.js`)).toBeNull();
    expect(load('/repo/src/editor/drawing/canvas.ts')).toBeNull();
  });
});

/**
 * The canvas fonts' dev twin, pinned: the configureServer middleware is
 * dev's ONE live font source (the vendor's CDN fallback was stripped from
 * the chunk — see stubExcalidrawFontSubsetting), so the mount must line up
 * with the URL the vendor actually requests,
 * `${EXCALIDRAW_ASSET_PATH}fonts/<family>/<file>`. The first mount
 * stopped one segment short: connect left `fonts/...` in req.url, the
 * join looked for .../fonts/fonts/<family>/<file>, every dev font request
 * fell through to the SPA fallback, and the browser decoded index.html as
 * a woff2 (OTS errors, canvas text on fallback metrics) — silently, until
 * a console-noise sweep caught it.
 */
describe('copyExcalidrawFonts (the dev twin)', () => {
  /** The middleware the plugin registers, as { mount, handler }. */
  function devMiddleware(): {
    mount: string;
    handler: (
      req: { url?: string },
      res: { setHeader(name: string, value: string): void; end(body: unknown): void },
      next: () => void,
    ) => void;
  } {
    const plugin = copyExcalidrawFonts();
    const hook = plugin.configureServer as unknown as
      | ((server: { middlewares: { use: (mount: string, handler: never) => void } }) => void)
      | {
          handler: (server: {
            middlewares: { use: (mount: string, handler: never) => void };
          }) => void;
        };
    const configure = typeof hook === 'function' ? hook : hook.handler;
    let mounted: { mount: string; handler: never } | null = null;
    configure({
      middlewares: {
        use: (mount: string, handler: never) => {
          mounted = { mount, handler };
        },
      },
    });
    if (mounted === null) throw new Error('the plugin registered no dev middleware');
    return mounted as unknown as ReturnType<typeof devMiddleware>;
  }

  /** Any family/file pair that actually ships in the vendor package. */
  function anyShippedFont(): { family: string; file: string } {
    const fontsRoot = fileURLToPath(
      new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url),
    );
    const family = readdirSync(fontsRoot).find((entry) =>
      statSync(join(fontsRoot, entry)).isDirectory(),
    );
    if (!family) throw new Error('no font family found in the vendor package');
    const file = readdirSync(join(fontsRoot, family)).find((entry) => entry.endsWith('.woff2'));
    if (!file) throw new Error(`no woff2 found for ${family}`);
    return { family, file };
  }

  it('mounts under /vendor/excalidraw/fonts — the full URL prefix the vendor requests', () => {
    const { mount } = devMiddleware();
    // A mount that stops at /vendor/excalidraw leaves `fonts/...` in the
    // stripped remainder and double-prepends it onto the fonts root.
    expect(mount).toBe(`/${EXCALIDRAW_FONTS_DIR}/fonts`);
  });

  it('answers a mounted remainder with the real woff2 bytes off disk', () => {
    const { handler } = devMiddleware();
    const { family, file } = anyShippedFont();
    const headers: Record<string, string> = {};
    let body: unknown = null;
    handler(
      { url: `/${family}/${file}` },
      { setHeader: (name, value) => (headers[name] = value), end: (buf) => (body = buf) },
      () => {
        throw new Error('next() must not run for a shipped font');
      },
    );
    expect(headers['Content-Type']).toBe('font/woff2');
    expect(
      Buffer.from(body as Uint8Array)
        .subarray(0, 4)
        .toString('latin1'),
    ).toBe('wOF2');
  });

  it('passes unknown files to the next middleware (the SPA fallback\u2019s job)', () => {
    const { handler } = devMiddleware();
    let passed = false;
    handler(
      { url: '/Nunito/not-a-real-glyph-subset.woff2' },
      { setHeader: () => undefined, end: () => undefined },
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });
});
