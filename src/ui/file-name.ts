/**
 * file-name.ts — the download family's one file-name rule.
 *
 * Every export surface (the export center's stem field, the drawing
 * dialog's name field, the drawing exporter's note-name default) speaks
 * the same discipline: the characters the download family never allowed
 * into a name are folded to spaces, runs of whitespace collapse, and an
 * answer that lands empty falls back to the caller's word — 'export'
 * for the center, 'drawing' for the canvas's exports.
 */

/** Strips the characters no download name ever carried. */
export function sanitizeFileStem(raw: string, fallback = 'export'): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/** Drops a trailing extension equal to the given one — the user typing
 * "note.png" into a stem field must not export "note.png.png". */
export function stripExtension(stem: string, extension: string): string {
  const suffix = `.${extension.toLowerCase()}`;
  return stem.toLowerCase().endsWith(suffix) ? stem.slice(0, -suffix.length) : stem;
}
