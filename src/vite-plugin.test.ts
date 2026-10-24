// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { stripDependencyEvalSinks, stubExcalidrawFontSubsetting } from '../vite.config';

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
 * must never ship — both interception paths answer the same throwing
 * stub, scoping is id-tight (only the vendor's own subset chunks), and
 * everything else passes through to the real file. The vendor's font
 * manager wraps every subsetting call in a try/catch that falls back to
 * the full font URL, so the throw degrades embed-fonts exports without
 * breaking them — and forbidEvalSinks() keeps the whole arrangement
 * honest on every future vendor bump.
 */
describe('stubExcalidrawFontSubsetting', () => {
  const VENDOR = '/repo/node_modules/@excalidraw/excalidraw/dist/prod';

  it('load() answers the throwing stub for the resolved subset chunks', () => {
    const plugin = stubExcalidrawFontSubsetting();
    const load = loadOf(plugin);
    for (const name of ['subset-shared.chunk.js', 'subset-worker.chunk.js']) {
      const code = load(`${VENDOR}/${name}`);
      expect(code, name).not.toBeNull();
      expect(code).toContain(
        "throw new Error('Padify: Excalidraw font subsetting is not shipped')",
      );
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
    expect(loadOf(plugin)('\0padify-excalidraw-subset-stub')).toContain('throw new Error');
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
