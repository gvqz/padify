/**
 * Architecture fitness tests — the repo's structural rules, enforced.
 *
 * Each test encodes a decision that was made deliberately and must not
 * silently rot. When one fails, the fix is to honor the rule — not to
 * delete the test.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKUP_CONTRACT } from './ui/contract';
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

describe('bootstrap single source of truth', () => {
  // Bootstrap survives ONLY as the vendored stylesheet public/css/
  // bootstrap.min.css (the first cascade layer). The npm package and the
  // JS bundle are gone — modal/collapse/tooltip live in src/ui/behavior/.
  // The file is pinned by content hash: if this test fails, someone edited
  // a minified vendored file by hand. To bump the bootstrap version,
  // replace the file with the new dist CSS and update BOTH the hash and
  // the banner version below — deliberately, in a commit that says so.
  const VENDORED_BOOTSTRAP_SHA256 =
    '6d92dfc1700fd38cd130ad818e23bc8aef697f815b2ea5face2b5dfad22f2e11';
  const VENDORED_BOOTSTRAP_VERSION = '3.4.1';

  it('the vendored stylesheet is untouched (content-hash pin)', () => {
    const vendored = read('public/css/bootstrap.min.css');
    const digest = createHash('sha256').update(vendored).digest('hex');
    expect(digest).toBe(VENDORED_BOOTSTRAP_SHA256);
  });

  it('the vendored stylesheet banner matches the pinned version', () => {
    const banner = read('public/css/bootstrap.min.css').slice(0, 200);
    expect(banner).toContain(`Bootstrap v${VENDORED_BOOTSTRAP_VERSION}`);
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
  return [...read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('layering rules', () => {
  const srcFiles = walk(resolve(process.cwd(), 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const rel = (f: string) => f.slice(process.cwd().length + 1);

  it('features/music-player is imported only by the composition roots', () => {
    // The music feature (music-player + music/ + spotify/) is the biggest
    // module in the app; its public surface is initMusicPlayer/mountMusic-
    // Player and its only legitimate consumers are the shell (app.ts) and
    // the boot sequence (boot.ts). Everything else must go through seams.
    const allowed = new Set(['src/app.ts', 'src/boot.ts']);
    const violators: string[] = [];
    for (const file of srcFiles) {
      if (file.includes('/features/music-player/')) continue;
      const outside = importTargets(file).some((t) => t.includes('features/music-player'));
      if (outside && !allowed.has(rel(file))) violators.push(rel(file));
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
});
