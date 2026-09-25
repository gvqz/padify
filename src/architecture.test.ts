/**
 * Architecture fitness tests — the repo's structural rules, enforced.
 *
 * Each test encodes a decision that was made deliberately and must not
 * silently rot. When one fails, the fix is to honor the rule — not to
 * delete the test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKUP_CONTRACT } from './ui/contract';

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
  it('the vendored stylesheet is a byte copy of the installed package', () => {
    // The <link>ed public/css/bootstrap.min.css and the JS from
    // `import 'bootstrap'` (package.json) MUST be the same version — the
    // 3.3.4/3.4.1 split was a latent bug source (CSS tuned against one,
    // behavior fixes shipped only in the other). If this fails, copy
    // node_modules/bootstrap/dist/css/bootstrap.min.css over
    // public/css/bootstrap.min.css — or bump both together.
    const vendored = read('public/css/bootstrap.min.css');
    const installed = read('node_modules/bootstrap/dist/css/bootstrap.min.css');
    expect(vendored).toBe(installed);
  });

  it('the vendored stylesheet banner matches the installed package version', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: { bootstrap: string } };
    const banner = read('public/css/bootstrap.min.css').slice(0, 200);
    const version = pkg.dependencies.bootstrap.replace(/^[\^~>=<\s]+/, '');
    expect(banner).toContain(`Bootstrap v${version}`);
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
