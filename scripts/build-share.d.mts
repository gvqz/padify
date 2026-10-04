/**
 * Type declarations for scripts/build-share.mjs, consumed by
 * src/share-sanitizer.test.ts (tsc maps the `.mjs` import to this `.d.mts`).
 */

/** Absolute path of the canonical sanitizer source (src/editor/storage-subset.ts). */
export declare const SOURCE_PATH: string;

/** Absolute path of the generated module (public/share/sanitize-note.js). */
export declare const OUTPUT_PATH: string;

/** Absolute path of the canonical markdown renderer source (editor/markdown/render.ts). */
export declare const MARKDOWN_SOURCE_PATH: string;

/** Absolute path of the generated module (public/share/markdown-render.js). */
export declare const MARKDOWN_OUTPUT_PATH: string;

/**
 * Renders the generated share-sanitizer module's content from the
 * canonical source.
 *
 * @param source — the storage-subset.ts source text (read from disk when
 *   omitted).
 * @returns the full content of sanitize-note.js, banner included.
 */
export declare function renderShareSanitizer(source?: string): Promise<string>;

/**
 * Renders the generated share markdown renderer's content — render.ts
 * bundled with its pure dependencies, tree-shaken free of KaTeX.
 *
 * @returns the full content of markdown-render.js, banner included.
 */
export declare function renderShareMarkdown(): Promise<string>;
