/**
 * Type declarations for scripts/build-share.mjs, consumed by
 * src/share-sanitizer.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

/** Absolute path of the canonical sanitizer source (src/editor/storage-subset.ts). */
export declare const SOURCE_PATH: string;

/** Absolute path of the generated module (public/share/sanitize-note.js). */
export declare const OUTPUT_PATH: string;

/**
 * Renders the generated share-sanitizer module's content from the
 * canonical source.
 *
 * @param source — the storage-subset.ts source text (read from disk when
 *   omitted).
 * @returns the full content of sanitize-note.js, banner included.
 */
export declare function renderShareSanitizer(source?: string): Promise<string>;
