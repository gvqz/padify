// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { stripDependencyEvalSinks } from '../vite.config';

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
