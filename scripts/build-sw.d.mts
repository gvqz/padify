/**
 * Type declarations for scripts/build-sw.mjs, consumed by
 * src/sw-build.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

/** Assets over this size are runtime-cached on first use, never precached. */
export declare const MAX_PRECACHE_BYTES: number;

export interface ServiceWorkerBuild {
  /** Full service worker source, ready to write to dist/sw.js. */
  source: string;
  /** Content-derived cache version (app-v<hash>). */
  cacheVersion: string;
  /** Root-relative URLs that get precached at install time. */
  precacheUrls: string[];
  /** Files skipped for exceeding MAX_PRECACHE_BYTES (runtime-cached instead). */
  skippedFiles: string[];
}

export declare function generateServiceWorker(distDir: string): ServiceWorkerBuild;
