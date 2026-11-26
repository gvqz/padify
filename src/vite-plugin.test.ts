// @vitest-environment node
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCALIDRAW_FONTS_DIR,
  copyExcalidrawFonts,
  emitExcalidrawSubsetWorker,
  stripDependencyEvalSinks,
} from '../vite.config';

const VENDOR_TREE = fileURLToPath(new URL('../vendor/excalidraw/', import.meta.url));

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
 * The subset-worker emission plugin, pinned — plus the vendored stubs it
 * exists to serve. The dist era swapped the vendor's COMPILED chunks for
 * stubs inside this config (an interception nobody could read); the
 * source-vendor era keeps the stubs in the vendored tree where they are
 * reviewable files, and this plugin's remaining job is the one thing the
 * tree cannot do for itself: shipping the identity worker script the
 * vendored WorkerUrl points at.
 */
describe('emitExcalidrawSubsetWorker', () => {
  it('generateBundle() emits the identity subset worker the vendored stub points at', () => {
    const plugin = emitExcalidrawSubsetWorker();
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
    // the vendor's job shape: {command, arrayBuffer, codePoints}, transfer
    // in, the buffer answers transferred back — command 0 is the vendored
    // stub's Commands.Subset.
    expect(worker).toContain('command === 0');
    expect(worker).toContain('postMessage(arrayBuffer, { transfer: [arrayBuffer] })');
  });

  it('configureServer() answers any *padify-subset-worker.js request in dev', () => {
    const plugin = emitExcalidrawSubsetWorker();
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
    // The vendored stub module resolves its sibling URL wherever vite
    // served it from — both spellings must answer, everything else
    // passes through.
    for (const url of [
      '/@id/padify-subset-worker.js',
      '/@fs/home/z/repo/vendor/excalidraw/excalidraw/subset/padify-subset-worker.js',
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
});

/**
 * The vendored subsetter stubs, pinned at the source level: the tree that
 * ships is the tree that answers. subset-shared.chunk.ts must keep the
 * identity surface (Commands/Subset = 0 — the emitted worker's protocol
 * number —, toBase64 answering a data: URL, both subset functions async
 * pass-throughs) and carry NO wasm loader import; subset-worker.chunk.ts
 * must keep the WorkerUrl that points at the emitted sibling and NOT
 * double as a worker script itself (the upstream version's onmessage ran
 * the wasm subsetter — the eval sink this whole arrangement keeps out of
 * dist).
 */
describe('the vendored subsetter stubs', () => {
  it('subset-shared.chunk.ts answers the identity pass-through surface', () => {
    const code = readFileSync(
      join(VENDOR_TREE, 'excalidraw/subset/subset-shared.chunk.ts'),
      'utf-8',
    );
    expect(code).toContain('export const Commands');
    expect(code).toContain('Subset: 0');
    expect(code).toContain('export const toBase64');
    expect(code).toContain('export const subsetToBase64');
    expect(code).toContain('export const subsetToBinary');
    expect(code).toContain('data:font/woff2;base64');
    // the wasm loaders must not come back — they were excluded from the
    // vendored tree on purpose, and their re-introduction would re-open
    // the eval-sink question forbidEvalSinks() guards.
    expect(code).not.toContain('harfbuzz-loader');
    expect(code).not.toContain('woff2-loader');
    expect(code).not.toContain('throw new Error');
  });

  it('subset-worker.chunk.ts exports the WorkerUrl at the emitted sibling', () => {
    const code = readFileSync(
      join(VENDOR_TREE, 'excalidraw/subset/subset-worker.chunk.ts'),
      'utf-8',
    );
    expect(code).toContain('export const WorkerUrl');
    expect(code).toContain('padify-subset-worker.js');
    // the onmessage handler (upstream: the wasm subsetter worker body)
    // belongs to the emitted worker FILE, not this module — the module
    // evaluates in the main graph.
    expect(code).not.toContain('self.onmessage');
  });
});

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

  /** Any family/file pair that actually ships in the vendored tree. */
  function anyShippedFont(): { family: string; file: string } {
    const fontsRoot = fileURLToPath(
      new URL('../vendor/excalidraw/excalidraw/fonts', import.meta.url),
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
