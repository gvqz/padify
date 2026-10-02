/**
 * Post-build step: generates dist/sw.js with a precache manifest derived
 * from the actual build output, so hashed Vite assets are always cached.
 *
 * The generated service worker serves same-origin GET requests cache-first
 * (stale-while-revalidate): precached content paints instantly and keeps
 * working offline, while a background network pass freshens the cache for
 * the next load. Range requests (audio seeking), cross-origin traffic and
 * — above all — API calls bypass the worker entirely: /api responses are
 * live data (note lists, share links that can be revoked), never cache
 * fodder.
 *
 * What gets precached is a three-way classification:
 *
 *   1. The APP SHELL — every asset the entry page references (the main
 *      bundle, the stylesheets, the icons, the manifest) — is precached
 *      regardless of size. The shell is what "offline-capable" promises;
 *      runtime-caching it instead meant offline only worked from the
 *      SECOND controlled visit, because the first visit's requests never
 *      went through the worker.
 *   2. Other public/ files (fonts, small sounds, images) up to
 *      MAX_PRECACHE_BYTES — same as before.
 *   3. Everything else — lazy feature chunks (exports, the unicode table,
 *      the music engines) and oversized files — is runtime-cached on
 *      first use: never downloaded until the feature asks for it, offline
 *      from then on.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Public assets over this size are runtime-cached on first use, never
 * precached. Does NOT apply to the app shell — see shellAssetPaths. */
export const MAX_PRECACHE_BYTES = 512 * 1024;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Assets the entry page references directly (script src / link href /
 * img src): the app shell. Root-relative, same-origin URLs only — the
 * Spotify SDK and other cross-origin references are none of the precache's
 * business.
 * @returns {Set<string>} dist-relative paths
 */
export function shellAssetPaths(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf-8');
  const paths = new Set();
  for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = m[1];
    // Root-relative (starts with a single /), not protocol-relative or
    // absolute, not an in-page anchor.
    if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/#')) continue;
    paths.add(url.slice(1));
  }
  return paths;
}

/**
 * Builds the service worker source for a build output directory.
 * Exported so tests can exercise the generator against a fixture tree;
 * the CLI wrapper at the bottom runs it against ../dist after `vite build`.
 *
 * @returns {{ source: string, cacheVersion: string, precacheUrls: string[], runtimeCachedFiles: string[] }}
 */
export function generateServiceWorker(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`[build-sw] ${distDir} not found. Run \`vite build\` first.`);
  }

  const entries = walk(distDir)
    .map((full) => ({
      rel: relative(distDir, full).split('\\').join('/'),
      size: statSync(full).size,
    }))
    .filter((entry) => entry.rel !== 'sw.js')
    // build-headers.mjs runs before this script and drops Netlify's own
    // config files (_headers, _redirects) into dist/. They are deploy
    // directives for the CDN, not site assets — the worker must not
    // precache or runtime-cache them.
    .filter((entry) => entry.rel !== '_headers' && entry.rel !== '_redirects')
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const shell = shellAssetPaths(distDir);
  const isShell = (rel) => shell.has(rel);
  const isLazyChunk = (rel) => rel.startsWith('assets/') && !shell.has(rel);

  // Precache: the shell (any size) + other public files up to the cap.
  // Runtime: lazy chunks + oversized files — cached by the fetch handler
  // the first time the feature actually asks for them.
  const precached = entries.filter(
    (entry) => !isLazyChunk(entry.rel) && (entry.size <= MAX_PRECACHE_BYTES || isShell(entry.rel)),
  );
  const runtimeCached = entries.filter(
    (entry) => isLazyChunk(entry.rel) || (entry.size > MAX_PRECACHE_BYTES && !isShell(entry.rel)),
  );

  // Cache URLs are root-relative. Directories are served with a trailing
  // slash by static hosts, so precache both spellings for the entry page.
  const precacheUrls = ['/', ...precached.map((entry) => `/${entry.rel}`)];

  // Hash the CONTENT of the precached files (not just URLs) so that edits
  // to public/ assets (css, images) bump the cache version even when their
  // URLs stay stable. Runtime-cached files (lazy chunks, oversized) are
  // deliberately excluded: they are refreshed by the fetch handler's
  // background revalidation instead.
  const hash = createHash('sha256').update(precacheUrls.join('|'));
  for (const entry of precached) {
    hash.update(readFileSync(join(distDir, entry.rel)));
  }
  const cacheVersion = `app-v${hash.digest('hex').slice(0, 10)}`;

  const source = `/* Generated by scripts/build-sw.mjs — do not edit by hand. */
const CACHE_VERSION = '${cacheVersion}';
const CACHE_FILES = ${JSON.stringify(precacheUrls, null, 4)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CACHE_FILES))
  );
  // No skipWaiting() here. Taking over mid-session swaps the running
  // page's worker and (on activate) deletes the previous build's caches —
  // deferred chunks of the RUNNING version would then 404 against the
  // NEW precache. Activation waits for the page's consent: it sends
  // { type: 'SKIP_WAITING' } only after the user accepted the update
  // prompt, and the controllerchange handler reloads into the new build.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Plain same-origin GETs only. Range requests (audio seeking) go
  // straight to the network so media playback stays byte-accurate, and
  // cross-origin traffic is none of this worker's business.
  if (request.method !== 'GET' || request.headers.has('range')) {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // The API is never the worker's business either. A cached /api/notes
  // would hand back a stale note list — and a cached /api/share/:token
  // keeps a REVOKED share readable long after its owner cancelled it.
  // API calls go straight to the network; offline means offline, which
  // the sync layer already surfaces as its own retry state.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            return caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(request, copy))
              .then(() => response);
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        // Cache-first with background revalidation: the cached copy is
        // served instantly, and the network pass (when it succeeds)
        // freshens the cache for the next load.
        event.waitUntil(network);
        return cached;
      }

      return network.then((response) => response || caches.match('/index.html'));
    })
  );
});
`;

  return {
    source,
    cacheVersion,
    precacheUrls,
    runtimeCachedFiles: runtimeCached.map((entry) => entry.rel),
  };
}

// CLI entry point — skip when the module is imported (e.g. by vitest).
if (process.argv[1] && process.argv[1].endsWith('build-sw.mjs')) {
  const distDir = new URL('../dist', import.meta.url).pathname;
  try {
    const { source, cacheVersion, precacheUrls, runtimeCachedFiles } =
      generateServiceWorker(distDir);
    writeFileSync(join(distDir, 'sw.js'), source);

    console.log(`[build-sw] wrote dist/sw.js`);
    console.log(`[build-sw] cache version: ${cacheVersion}`);
    console.log(
      `[build-sw] precached ${precacheUrls.length} entries (app shell + small public assets)`,
    );
    if (runtimeCachedFiles.length > 0) {
      console.log(
        `[build-sw] ${runtimeCachedFiles.length} lazy/oversized files runtime-cached on first use:`,
      );
      for (const file of runtimeCachedFiles) {
        console.log(`[build-sw]   ${file}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
