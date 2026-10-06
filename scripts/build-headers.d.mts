/**
 * Type declarations for scripts/build-headers.mjs, consumed by
 * src/headers-build.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

export interface HeadersBuildOptions {
  /**
   * The raw VITE_API_BASE value ('' = same-origin /api). Validated by the
   * generator: anything but '' or an absolute URL (https://host[:port],
   * optionally with a path — https://host/api) fails the build.
   */
  apiBase?: string;
}

export interface HeadersBuild {
  /** The full content security policy directive string. */
  csp: string;
  /** sha256 hashes of every inline script the entry page contains. */
  scriptHashes: string[];
  /** The _headers file content, ready to write to dist/_headers. */
  headersFile: string;
  /** The normalized API origin ('' = same-origin /api). */
  apiBase: string;
  /** The share viewer config, ready to write to dist/share/config.js. */
  shareConfigFile: string;
  /**
   * The Netlify _redirects content (a forced /api/* proxy to the API
   * origin), or null when the API is same-origin and no file is written.
   */
  redirectsFile: string | null;
}

export declare function generateHeadersFile(
  distDir: string,
  options?: HeadersBuildOptions,
): HeadersBuild;

export declare function normalizeApiBase(raw: string | undefined): string;
