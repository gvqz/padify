/**
 * Architecture fitness tests — the repo's structural rules, enforced.
 *
 * Each test encodes a decision that was made deliberately and must not
 * silently rot. When one fails, the fix is to honor the rule — not to
 * delete the test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the repo root; import.meta.url is not file-scheme here.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf-8');

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
