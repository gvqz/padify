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
  /** The CSP for <meta> injection — identical to `csp` minus
   * frame-ancestors (the spec ignores it in a meta tag). */
  metaCsp: string;
  /** The CSP for the share viewer document (no worker-src, no hashes). */
  shareCsp: string;
  /** sha256 hashes of every inline script the entry page contains. */
  scriptHashes: string[];
  /** The _headers file content, ready to write to dist/_headers. */
  headersFile: string;
  /** The Apache .htaccess content, ready to write to dist/.htaccess. */
  htaccessFile: string;
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

/**
 * Injects (or replaces) the CSP <meta> in a built HTML document. Idempotent;
 * places the tag right after <meta charset> so it governs the whole parse.
 */
export declare function injectCspMeta(html: string, policy: string): string;

export declare function normalizeApiBase(raw: string | undefined): string;
