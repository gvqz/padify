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
 * The bundle-hygiene plugin, pinned: the two shipped eval sinks —
 * SweetAlert2's <swal-function-param> parser and docx's bundled
 * setImmediate polyfill — are stripped in their own modules, other code
 * passes through untouched, and the CSP already forbids what the strips
 * remove (no 'unsafe-eval' in script-src).
 */

const SWEALERT_LINE = 'result[paramName] = new Function(`return ${value}`)(); // parse the param';

const DOCX_LINE = '"function" != typeof e4 && (e4 = new Function("" + e4));';

describe('stripDependencyEvalSinks', () => {
  it('removes the eval sink from sweetalert2 modules', () => {
    const plugin = stripDependencyEvalSinks();
    const result = transformOf(plugin)(
      SWEALERT_LINE,
      '/repo/node_modules/sweetalert2/dist/sweetalert2.esm.all.js',
    );

    expect(result).not.toBeNull();
    expect(result!.code).not.toContain('new Function');
    // The call site degrades the way the CSP would: the param is ignored.
    expect(result!.code).toContain('undefined /* padify: eval sink stripped');
  });

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
    const result = transformOf(plugin)(
      SWEALERT_LINE + '\n' + DOCX_LINE,
      '/repo/src/editor/model-port.ts',
    );

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

  it('load() answers the pass-through stub for the resolved subset chunks', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const load = loadOf(plugin);
    for (const name of ['subset-shared.chunk.js', 'subset-worker.chunk.js']) {
      const code = load(`${VENDOR}/${name}`);
      expect(code, name).not.toBeNull();
      expect(code).toContain('export const subsetToBase64');
      expect(code).toContain('export const toBase64');
      expect(code).toContain('data:font/woff2;base64');
      expect(code).not.toContain('throw new Error');
    }
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
      | ((server: {
          middlewares: { use: (mount: string, handler: never) => void };
        }) => void)
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
    expect(Buffer.from(body as Uint8Array).subarray(0, 4).toString('latin1')).toBe('wOF2');
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
