import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHeadersFile } from '../scripts/build-headers.mjs';

// The header generator is build infrastructure that has to keep working
// across the upcoming rewrites — these tests pin its security contracts:
// every inline script is hash-pinned (so script-src never needs
// 'unsafe-inline') and the _headers file carries the baseline rules.

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'padify-headers-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeEntry(html: string): void {
  writeFileSync(join(fixtureDir, 'index.html'), html);
}

describe('inline script pinning', () => {
  it('hashes every inline script and pins it in script-src', () => {
    const first = "document.body.classList.add('dark');";
    const second = 'window.__boot = 1;';
    writeEntry(
      `<html><body><script>${first}</script>` +
        `<script type="module" src="/assets/main.js"></script>` +
        `<script>${second}</script></body></html>`,
    );

    const build = generateHeadersFile(fixtureDir);

    const expectedFirst = `'sha256-${createHash('sha256').update(first, 'utf8').digest('base64')}'`;
    const expectedSecond = `'sha256-${createHash('sha256').update(second, 'utf8').digest('base64')}'`;
    expect(build.scriptHashes).toEqual([expectedFirst, expectedSecond]);
    expect(build.csp).toContain(
      `script-src 'self' https://sdk.scdn.co ${expectedFirst} ${expectedSecond}`,
    );
  });

  it('never falls back to unsafe-inline, with or without inline scripts', () => {
    writeEntry('<html><body><script type="module" src="/assets/main.js"></script></body></html>');

    const build = generateHeadersFile(fixtureDir);

    expect(build.scriptHashes).toEqual([]);
    expect(build.csp).toContain("script-src 'self' https://sdk.scdn.co");
    // script-src must stay free of inline execution — that is the point.
    const scriptSrc = build.csp.match(/script-src [^;]*/)![0];
    expect(scriptSrc).not.toContain('unsafe-inline');
    // …while inline styles stay allowed (features style the DOM directly).
    expect(build.csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('refuses to run against a missing build', () => {
    expect(() => generateHeadersFile(fixtureDir)).toThrow(/vite build/i);
  });
});

describe('the headers file', () => {
  it('carries the baseline rules for every path and the sw.js exception', () => {
    writeEntry('<html><body><script>0;</script></body></html>');

    const { headersFile } = generateHeadersFile(fixtureDir);

    expect(headersFile).toContain('/*\n  X-Content-Type-Options: nosniff');
    expect(headersFile).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headersFile).toContain('Strict-Transport-Security: max-age=63072000');
    expect(headersFile).toContain('X-Frame-Options: DENY');
    expect(headersFile).toContain('Content-Security-Policy: ');
    expect(headersFile).toContain('/sw.js\n  Cache-Control: public, max-age=0, must-revalidate');
  });
});
