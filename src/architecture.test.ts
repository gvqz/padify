/**
 * Architecture fitness tests — the repo's structural rules, enforced.
 *
 * Each test encodes a decision that was made deliberately and must not
 * silently rot. When one fails, the fix is to honor the rule — not to
 * delete the test.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKUP_CONTRACT } from './ui/contract';
import { SETTING_KEYS } from './state/settings';
import type { EditorPort } from './editor/port';

// Vitest runs from the repo root; import.meta.url is not file-scheme here.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf-8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** All id= declarations across index.html, the include partials and the
 * JS-mounted feature templates. */
function declaredMarkupIds(): Set<string> {
  const files = [
    resolve(process.cwd(), 'index.html'),
    ...walk(resolve(process.cwd(), 'src/ui')).filter((f) => f.endsWith('.html')),
    ...walk(resolve(process.cwd(), 'src')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    ),
  ];
  const ids = new Set<string>();
  for (const file of files) {
    for (const m of read(file).matchAll(/id=["']([\w-]+)["']/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

/** Element ids referenced from TypeScript via the usual lookups. */
function referencedElementIds(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const pattern =
    /(?:getElementById|selectById)\(\s*["']([\w-]+)["']|querySelector(?:All)?\(\s*["']#([\w-]+)["']|\$\(\s*["']#([\w-]+)["']/g;
  for (const file of walk(resolve(process.cwd(), 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  )) {
    const rel = file.slice(process.cwd().length + 1);
    for (const m of read(file).matchAll(pattern)) {
      const id = m[1] ?? m[2] ?? m[3];
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id)!.push(rel);
    }
  }
  return refs;
}

describe('bootstrap stays out entirely', () => {
  // Bootstrap 3.4.1 shipped for years as a vendored stylesheet (the first
  // cascade layer) plus class-named markup the app kept. Phase 1 un-shipped
  // it: the ~9% of its rules the app still matched or could emit were
  // extracted mechanically (scripts/bootstrap-extract.mjs, driven by the
  // DOM cascade audit + the emit-corpus analysis) and folded into
  // vercel/02-base.css; everything else never matched and never will.
  // These pins keep it from creeping back in by accident.
  it('no vendored bootstrap stylesheet exists in public/css', () => {
    const cssDir = resolve(process.cwd(), 'public', 'css');
    const files = readdirSync(cssDir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => f.toLowerCase());
    const offenders = files.filter((f) => /bootstrap/.test(f));
    expect(offenders).toEqual([]);
  });

  it('index.html links only the vercel design system', () => {
    const links = [
      ...read(join(process.cwd(), 'index.html')).matchAll(/href="(\/css\/[^"]+\.css)"/g),
    ].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    const offenders = links.filter((href) => !href.startsWith('/css/vercel/'));
    expect(offenders).toEqual([]);
  });

  it('the bootstrap subset inside 02-base stays the extracted one (content-hash pin)', () => {
    // The extracted block is delimited by the banner the extractor writes;
    // hand edits inside it would silently fork the vendored reset. Bump the
    // hash only by re-running scripts/bootstrap-extract.mjs deliberately.
    const VENDORED_SUBSET_SHA256 =
      '740a13026bd95c8eea9655b2498f50533608d96ec42b5e83ecac3534b9e26c68';
    const base = read(join(process.cwd(), 'public', 'css', 'vercel', '02-base.css'));
    const start = base.indexOf('/* Bootstrap 3.4.1 — the surviving subset.');
    const end = base.indexOf('/* [phase-1 fold]');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const slice = base.slice(start, end);
    const digest = createHash('sha256').update(slice).digest('hex');
    expect(digest).toBe(VENDORED_SUBSET_SHA256);
  });

  it('jquery and the bootstrap JS bundle stay out of the dependency tree', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const banned = ['jquery', 'bootstrap', '@types/jquery'];
    const present = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)].filter(
      (name) => banned.includes(name),
    );
    expect(present).toEqual([]);
  });
});

describe('markup ↔ JS contract', () => {
  it('every element id referenced from TypeScript exists in the markup', () => {
    // A referenced-but-never-declared id resolves to an empty jQuery
    // collection or null — silent no-ops and "null.addEventListener"
    // crashes (this caught monospaced/dyslexic/serif dead selectors, the
    // removed #mode button writes and the whiteNoiseModal Swal target).
    // If a dynamic id legitimately can't live in markup, it goes through
    // createElement/template literals instead of a string lookup.
    const declared = declaredMarkupIds();
    const dangling: string[] = [];
    for (const [id, files] of referencedElementIds()) {
      if (!declared.has(id)) {
        dangling.push(`#${id}  <- ${[...new Set(files)].join(', ')}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('the boot-time contract ids all exist in the markup', () => {
    // MARKUP_CONTRACT lists what boot.ts dereferences before the first
    // feature init; keep it in sync with the markup by hand, deliberately.
    const declared = declaredMarkupIds();
    const missing = MARKUP_CONTRACT.flatMap((g) =>
      g.ids.filter((id) => !declared.has(id)).map((id) => `#${id} (${g.source})`),
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

function importTargets(file: string): string[] {
  // Static imports AND dynamic imports — the music engines ride a lazy
  // chunk now, and a layering rule that can't see `import(...)` is a rule
  // the next feature slips past by moving behind a dynamic import.
  const source = read(file);
  return [
    ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]!);
}

describe('layering rules', () => {
  const srcFiles = walk(resolve(process.cwd(), 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const rel = (f: string) => f.slice(process.cwd().length + 1);

  // Each feature's public surface is its init/mount pair; the shell (app.ts,
  // which may load engines as a lazy chunk) and the composition root
  // (boot.ts, which mounts markup) are the only legitimate consumers.
  // Everything else must go through seams (settings, ports, storage).
  const FEATURE_IMPORT_ALLOWLIST: Record<string, string[]> = {
    'features/music-player': ['src/app.ts', 'src/boot.ts'],
    'features/tasks': ['src/app.ts', 'src/boot.ts'],
  };

  it('features are imported only by the composition roots', () => {
    const violators: string[] = [];
    for (const file of srcFiles) {
      const relFile = rel(file);
      for (const [feature, allowed] of Object.entries(FEATURE_IMPORT_ALLOWLIST)) {
        if (file.includes(`/${feature}/`)) continue; // inside the feature itself
        if (importTargets(file).some((t) => t.includes(feature)) && !allowed.includes(relFile)) {
          violators.push(relFile);
        }
      }
    }
    expect(violators).toEqual([]);
  });

  it('features never import other features', () => {
    // Rule lands with the first feature so the second cannot wire itself
    // into the first; features talk through core seams (settings, ports).
    const featureFiles = srcFiles.filter((f) => f.includes('/features/'));
    const violators: string[] = [];
    for (const file of featureFiles) {
      const featureRoot = file.split('/features/')[1]!.split('/')[0]!;
      for (const target of importTargets(file)) {
        const m =
          target.match(/(?:\.\.\/)+features\/([\w-]+)\//) ?? target.match(/^features\/([\w-]+)\//);
        if (m && m[1] !== featureRoot) violators.push(`${rel(file)} -> ${target}`);
      }
    }
    expect(violators).toEqual([]);
  });

  it('src/ui is passive markup mounting — it never imports features or the app', () => {
    const violators: string[] = [];
    for (const file of srcFiles.filter((f) => f.includes('/ui/'))) {
      for (const target of importTargets(file)) {
        if (/features\//.test(target) || /(^|\.)\.(\/app)?$|\.\/app['"]/.test(target)) {
          violators.push(`${rel(file)} -> ${target}`);
        }
      }
    }
    expect(violators).toEqual([]);
  });

  it('the engine implementation is wired only by the shell', () => {
    // editor/port.ts is the public contract (any module may resolve the
    // port through it); editor/model-port.ts is the engine IMPLEMENTATION —
    // only app.ts (which installs the port) may touch it, so a future
    // engine swaps in one place.
    const violators: string[] = [];
    for (const file of srcFiles) {
      if (rel(file) === 'src/app.ts' || file.includes('/editor/')) continue;
      if (importTargets(file).some((t) => t.includes('editor/model-port'))) {
        violators.push(rel(file));
      }
    }
    expect(violators).toEqual([]);
  });
});

describe('module graph', () => {
  it('has no static import cycles', () => {
    // The repo carried exactly one cycle (utils ↔ tabs) for its whole
    // life: utils reached into tabs for the delete flow, tabs reached
    // back for a toast. Untangling it only stays untangled if the next
    // cycle fails CI. Static imports count — a lazy import() is a
    // legitimate cycle breaker (cloud/sync.ts, the music engines), so
    // dynamic imports are excluded on purpose.
    const srcFiles = walk(resolve(process.cwd(), 'src')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );

    const graph = new Map<string, string[]>();
    for (const file of srcFiles) {
      const targets = [...read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((t) => t.startsWith('.'))
        .map((t) => resolve(dirname(file), t) + '.ts');
      graph.set(file, targets);
    }

    const visiting = new Set<string>();
    const done = new Set<string>();
    let cycle: string[] | null = null;

    // Read through a function: the closure mutations TS cannot track would
    // otherwise narrow `cycle` to its initializer type at the assertion.
    const foundCycle = (): string[] | null => cycle;

    const visit = (file: string, path: string[]): void => {
      if (cycle !== null || done.has(file)) return;
      if (visiting.has(file)) {
        cycle = [...path.slice(path.indexOf(file)), file];
        return;
      }
      visiting.add(file);
      for (const target of graph.get(file) ?? []) {
        if (graph.has(target)) visit(target, [...path, file]);
        if (cycle !== null) return;
      }
      visiting.delete(file);
      done.add(file);
    };

    for (const file of srcFiles) {
      visit(file, []);
      if (cycle !== null) break;
    }

    const cyclePath = foundCycle();
    expect(
      cyclePath === null
        ? 'no cycles'
        : cyclePath.map((f) => relative(process.cwd(), f)).join(' -> '),
    ).toBe('no cycles');
  });

  it('no setting write bypasses the settings choke point', () => {
    // Every enumerated-key write routes through setSetting/removeSetting
    // (src/state/settings.ts) so subscribers see it — the last bypasses
    // (theme's mode, the font selection, typing-effects' reset) migrated.
    // A raw stateSet/stateRemove on a setting key persists fine but
    // silently skips notifications: exactly the drift this pins out.
    // Reads (stateGet) are exempt — they have nothing to notify.
    const exempt = (path: string): boolean =>
      path.includes('/state/') || path.includes('/storage/');
    const files = walk(resolve(process.cwd(), 'src')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !exempt(f),
    );
    const writePattern = /\bstate(?:Set|Remove)\(\s*['"]([^'"]+)['"]/g;
    const rel = (file: string): string => file.slice(process.cwd().length + 1);
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(writePattern)) {
        if (SETTING_KEYS.includes(m[1] as never)) {
          offenders.push(`${rel(file)} -> ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The editor seam — the swap contract.
//
// The editor engine is being replaced behind EditorPort. These rules pin
// the interface properties that make the swap a drop-in: handles instead
// of DOM elements, and the render/commit split that lets the manager open
// a note without writing it.
// ---------------------------------------------------------------------------

describe('the editor seam (the swap contract)', () => {
  it('the math API speaks id handles, never DOM elements', () => {
    // Type-level pins — they fail to COMPILE the moment someone reintroduces
    // an HTMLElement into the port's math surface. An engine that keeps a
    // document model cannot hand out its internal nodes; the contract is
    // "a string updateMath understands".
    type MathAtCaret = ReturnType<EditorPort['queryMathAtCaret']>;
    type UpdateTarget = Parameters<EditorPort['updateMath']>[0];

    const atCaretIsIdShaped: NonNullable<MathAtCaret> extends { latex: string; id: string }
      ? true
      : never = true;
    const atCaretHasNoElement: NonNullable<MathAtCaret> extends { element: unknown }
      ? never
      : true = true;
    const targetIsAHandle: UpdateTarget extends string ? true : never = true;

    expect(atCaretIsIdShaped).toBe(true);
    expect(atCaretHasNoElement).toBe(true);
    expect(targetIsAHandle).toBe(true);
  });

  it('render and commit are separate entries on the port', () => {
    // Opening a note paints the surface (renderHtml); replacing its content
    // persists exactly once (setHtml). One entry that does both is the bug
    // the split removed — the manager had to bypass the port to open a
    // note without writing it.
    const renders: EditorPort['renderHtml'] extends (html: string) => void ? true : never = true;
    const commits: EditorPort['setHtml'] extends (html: string) => void ? true : never = true;

    expect(renders).toBe(true);
    expect(commits).toBe(true);
  });

  it('TabManager never touches engine APIs — the port is its only editor', () => {
    // The manager owns the note MODEL; the engine owns the surface. The
    // moment tabs.ts calls execCommand or selection APIs, the engine swap
    // has two homes instead of one.
    const source = read(resolve(process.cwd(), 'src/tabs.ts'));
    expect(source).not.toMatch(/document\.execCommand/);
    expect(source).not.toMatch(/(?:window|document)\.getSelection/);
  });

  it('TabManager presents notes through the surface registry, not its own DOM dialect', () => {
    // The note-surface seam (editor/surface.ts) is what a new note kind
    // plugs into: display/capture/visibleText/commit/clear live behind
    // noteSurfaceFor(), and the manager must not grow its own per-kind
    // painting back. contenteditable, unsupported-note cards and math
    // re-rendering are surface mechanics — finding them in tabs.ts means
    // the if/else dispatch crept back in.
    const source = read(resolve(process.cwd(), 'src/tabs.ts'));
    expect(source).toContain("from './editor/surface'");
    expect(source).not.toMatch(/contenteditable/);
    expect(source).not.toMatch(/unsupported-note/);
    expect(source).not.toMatch(/renderMathIn/);
  });

  it('every note kind resolves to a surface — the registry has no holes', async () => {
    // The four content kinds, plus the fallback rule: an UNREGISTERED
    // kind must answer the opaque surface (an old build meeting a new
    // kind degrades to the read-only card, never to a crash).
    // The Markdown surface registers from its module at import time —
    // importing the registry alone would leave 'text' unregistered.
    await import('./editor/markdown/surface');
    const { noteSurfaceForKind, opaqueNoteSurface } = await import('./editor/surface');
    for (const kind of ['html', 'text', 'json', 'opaque'] as const) {
      expect(noteSurfaceForKind(kind)).toBeDefined();
    }
    expect(noteSurfaceForKind('text').editable).toBe(true); // the Markdown surface
    expect(noteSurfaceForKind('json')).toBe(opaqueNoteSurface);
    // And the registered surfaces are the editable ones today.
    expect(noteSurfaceForKind('html').editable).toBe(true);
    expect(noteSurfaceForKind('opaque').editable).toBe(false);
  });
});
