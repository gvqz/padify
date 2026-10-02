import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateServiceWorker, MAX_PRECACHE_BYTES } from '../scripts/build-sw.mjs';

// The SW generator is build infrastructure that has to keep working across
// the upcoming rewrites — these tests pin its structural contracts: the
// precache manifest (what gets cached at install), the three-way
// classification (shell / small public assets / runtime-cached long tail)
// and the fetch strategy (cache-first with background revalidation).

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'padify-sw-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const target = join(fixtureDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** A realistic entry page: shell assets referenced the way Vite emits
 * them (script src / link href), so the fixture exercises the real
 * classification path instead of an empty page with orphaned files. */
const shellHtml = (extraHead = ''): string =>
  `<html><head><script type="module" src="/assets/main.js"></script>` +
  `<link rel="stylesheet" href="/css/style.css" />${extraHead}</head>` +
  `<body>padify</body></html>`;

describe('precache manifest', () => {
  it('precaches both entry spellings plus the referenced shell', () => {
    write('index.html', shellHtml());
    write('assets/main.js', 'console.log("padify main");');
    write('css/style.css', 'body { margin: 0 }');

    const build = generateServiceWorker(fixtureDir);

    expect(build.precacheUrls).toEqual(
      expect.arrayContaining(['/', '/index.html', '/assets/main.js', '/css/style.css']),
    );
    expect(build.runtimeCachedFiles).toEqual([]);
  });

  it('precaches the app shell regardless of size — offline works from the first install', () => {
    // The regression this pins: the main bundle is bigger than the size
    // cap, and it used to be the ONE asset the worker refused to precache
    // — so "offline-capable" was untrue until the second controlled visit.
    write('index.html', shellHtml());
    write('assets/main.js', 'x'.repeat(MAX_PRECACHE_BYTES + 1));

    const build = generateServiceWorker(fixtureDir);

    expect(build.precacheUrls).toContain('/assets/main.js');
    expect(build.runtimeCachedFiles).toEqual([]);
  });

  it('runtime-caches lazy chunks on first use, even small ones', () => {
    // Lazy feature chunks (exports, unicode table, the music engines) are
    // NOT referenced by the entry page — under the cap or not, they wait
    // for the feature to ask for them.
    write('index.html', shellHtml());
    write('assets/main.js', 'console.log("padify main");');
    write('assets/index-lazy.js', 'console.log("lazy feature");');

    const build = generateServiceWorker(fixtureDir);

    expect(build.precacheUrls).not.toContain('/assets/index-lazy.js');
    expect(build.runtimeCachedFiles).toEqual(['assets/index-lazy.js']);
  });

  it('skips oversized public files so they runtime-cache on first use', () => {
    write('index.html', shellHtml());
    write('sounds/rain.mp3', 'x'.repeat(MAX_PRECACHE_BYTES + 1));
    write('sounds/chime.mp3', 'x'.repeat(2048));

    const build = generateServiceWorker(fixtureDir);

    expect(build.precacheUrls).toContain('/sounds/chime.mp3');
    expect(build.precacheUrls).not.toContain('/sounds/rain.mp3');
    expect(build.runtimeCachedFiles).toEqual(['sounds/rain.mp3']);
  });

  it('never precaches a stale sw.js left by a previous build', () => {
    write('index.html', shellHtml());
    write('sw.js', '/* previous build output */');

    const build = generateServiceWorker(fixtureDir);

    expect(build.precacheUrls).not.toContain('/sw.js');
    expect(build.runtimeCachedFiles).not.toContain('sw.js');
  });
});

describe('cache version', () => {
  it('changes when precached content changes', () => {
    write('index.html', shellHtml());
    write('assets/main.js', 'v1');
    const before = generateServiceWorker(fixtureDir).cacheVersion;

    write('assets/main.js', 'v2');
    const after = generateServiceWorker(fixtureDir).cacheVersion;

    expect(after).not.toEqual(before);
  });

  it('stays stable when only a runtime-cached file changes', () => {
    write('index.html', shellHtml());
    write('assets/main.js', 'console.log("padify main");');
    write('sounds/rain.mp3', 'x'.repeat(MAX_PRECACHE_BYTES + 1));
    write('assets/index-lazy.js', 'console.log("lazy v1");');
    const before = generateServiceWorker(fixtureDir).cacheVersion;

    // Runtime-cached assets (lazy chunks, oversized) live in the runtime
    // cache and are refreshed by the fetch handler's background
    // revalidation — a version bump here would needlessly drop every
    // runtime-cached sound and every lazy chunk the user already fetched.
    write('sounds/rain.mp3', 'y'.repeat(MAX_PRECACHE_BYTES + 1));
    write('assets/index-lazy.js', 'console.log("lazy v2");');
    const after = generateServiceWorker(fixtureDir).cacheVersion;

    expect(after).toEqual(before);
  });
});

describe('fetch strategy', () => {
  const fetchHandler = (source: string): string =>
    source.slice(source.indexOf("self.addEventListener('fetch'"));

  it('serves cache-first with background revalidation', () => {
    write('index.html', shellHtml());
    const handler = fetchHandler(generateServiceWorker(fixtureDir).source);

    // The cache lookup must precede the network call — this is the guard
    // against regressing to the old network-first handler.
    const cachePosition = handler.indexOf('caches.match(request)');
    const networkPosition = handler.indexOf('fetch(request)');
    expect(cachePosition).toBeGreaterThan(-1);
    expect(networkPosition).toBeGreaterThan(cachePosition);
    expect(handler).toContain('if (cached)');
  });

  it('lets range requests and cross-origin traffic bypass the worker', () => {
    write('index.html', shellHtml());
    const handler = fetchHandler(generateServiceWorker(fixtureDir).source);

    expect(handler).toContain("request.headers.has('range')");
    expect(handler).toContain('origin !== self.location.origin');
  });

  it('never answers /api from a cache — live data bypasses the worker', () => {
    write('index.html', shellHtml());
    const handler = fetchHandler(generateServiceWorker(fixtureDir).source);

    // The /api escape must fire BEFORE any respondWith — a cached note
    // list or a revoked share served from the cache is the regression
    // this pins out.
    const apiPosition = handler.indexOf("url.pathname.startsWith('/api/')");
    const respondPosition = handler.indexOf('event.respondWith');
    expect(apiPosition).toBeGreaterThan(-1);
    expect(respondPosition).toBeGreaterThan(apiPosition);
  });
});

describe('the update contract — activation waits for the page', () => {
  it('install does NOT skipWaiting: a running page must consent first', () => {
    write('index.html', shellHtml());
    const source = generateServiceWorker(fixtureDir).source;
    const installHandler = source.slice(
      source.indexOf("self.addEventListener('install'"),
      source.indexOf("self.addEventListener('message'"),
    );

    expect(installHandler).not.toContain('self.skipWaiting()');
    // The takeover happens on the page's message, never on install —
    // and the whole worker owns exactly one skipWaiting call site.
    expect(source.match(/self\.skipWaiting\(\)/g)?.length).toBe(1);
  });

  it('the worker answers { type: "SKIP_WAITING" } with self.skipWaiting()', () => {
    write('index.html', shellHtml());
    const source = generateServiceWorker(fixtureDir).source;

    const messageHandler = source.slice(
      source.indexOf("self.addEventListener('message'"),
      source.indexOf("self.addEventListener('activate'"),
    );
    expect(messageHandler).toContain("event.data.type === 'SKIP_WAITING'");
    expect(messageHandler).toContain('self.skipWaiting()');
  });
});
