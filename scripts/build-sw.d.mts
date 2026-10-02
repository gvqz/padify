/**
 * Type declarations for scripts/build-sw.mjs, consumed by
 * src/sw-build.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

/**
 * Public assets over this size are runtime-cached on first use, never
 * precached. Does NOT apply to the app shell — shell assets referenced by
 * the entry page are precached regardless of size.
 */
export declare const MAX_PRECACHE_BYTES: number;

/** Dist-relative asset paths referenced by the entry page (the app shell). */
export declare function shellAssetPaths(distDir: string): Set<string>;

export interface ServiceWorkerBuild {
  /** Full service worker source, ready to write to dist/sw.js. */
  source: string;
  /** Content-derived cache version (app-v<hash>). */
  cacheVersion: string;
  /** Root-relative URLs that get precached at install time. */
  precacheUrls: string[];
  /**
   * Files the fetch handler runtime-caches on first use instead of
   * precaching: lazy feature chunks (not referenced by the entry page)
   * and public files over MAX_PRECACHE_BYTES.
   */
  runtimeCachedFiles: string[];
}

export declare function generateServiceWorker(distDir: string): ServiceWorkerBuild;
