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

/** Dist-relative asset paths referenced by the entry page (the app
 * shell), recognized under the given base path ('' = site root). */
export declare function shellAssetPaths(distDir: string, basePath?: string): Set<string>;

/** Normalizes VITE_BASE_PATH to '' (site root) or '/segment' without a
 * trailing slash; anything that is not an absolute path throws. */
export declare function normalizeBasePath(raw: string | undefined): string;

/** The pathname prefixes the worker's fetch handler must never answer
 * from a cache: the API's mount points, including a path-bearing
 * VITE_API_BASE when one is configured. */
export declare function apiBypassPrefixes(apiBase?: string): string[];

export interface ServiceWorkerBuild {
  /** Full service worker source, ready to write to dist/sw.js. */
  source: string;
  /** Content-derived cache version (app-v<hash>). */
  cacheVersion: string;
  /** Root- or base-relative URLs that get precached at install time. */
  precacheUrls: string[];
  /**
   * Files the fetch handler runtime-caches on first use instead of
   * precaching: lazy feature chunks (not referenced by the entry page)
   * and public files over MAX_PRECACHE_BYTES.
   */
  runtimeCachedFiles: string[];
}

export interface ServiceWorkerBuildOptions {
  /** Normalized VITE_BASE_PATH ('' = site root, '/padify' = subpath). */
  basePath?: string;
  /** Raw VITE_API_BASE ('' = same-origin /api). */
  apiBase?: string;
}

export declare function generateServiceWorker(
  distDir: string,
  options?: ServiceWorkerBuildOptions,
): ServiceWorkerBuild;
