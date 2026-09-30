/**
 * Type declarations for scripts/build-headers.mjs, consumed by
 * src/headers-build.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

export interface HeadersBuild {
  /** The full content security policy directive string. */
  csp: string;
  /** sha256 hashes of every inline script the entry page contains. */
  scriptHashes: string[];
  /** The _headers file content, ready to write to dist/_headers. */
  headersFile: string;
}

export declare function generateHeadersFile(distDir: string): HeadersBuild;
