/**
 * The .padify file — one note, fully, as a file.
 *
 * A .padify file is a strict envelope around a note the same way a drawing
 * scene is a strict envelope around elements (editor/drawing/scene.ts): the
 * ENVELOPE is this module's to version and validate; the CONTENT is the
 * note's type's format, stored verbatim and never interpreted here. The
 * sanitized-HTML subset rides as-is for 'standard'/'rich', Markdown source
 * for 'markdown', the JSON payloads for 'tasks'/'drawing' — exactly the
 * strings the app already stores, syncs and snapshots. A file round-trips
 * through export → import without a conversion step, because there is
 * nothing to convert: the note IS the payload.
 *
 * The envelope (v1):
 *
 *   {
 *     "type": "padify-note",          // the discriminator — never optional
 *     "format": 1,                    // THIS format's version, not the app's
 *     "generator": "padify",          // informational, never branched on
 *     "exportedAt": 1732…,            // provenance, never content
 *     "note": {
 *       "name": "Groceries" | null,   // null = derive the title from content
 *       "noteType": "standard",       // EXPLICIT on the wire (never omitted)
 *       "content": "<…the type's payload…>",
 *       "createdAt": 1732…,           // provenance; import mints fresh stamps
 *       "updatedAt": 1732…
 *     }
 *   }
 *
 * Versioning discipline (the scene module's, applied to files): this build
 * refuses a NEWER `format` outright — 'newer-format' tells the caller to
 * say "update the app", the way a newer scene version renders as the
 * placeholder instead of being mangled. Unknown `noteType` ids are KEPT
 * (the note-types registry's forward-compat rule): the imported note rides
 * the app as an opaque note, placeholder surface, bytes untouched. An
 * import always MINTS a fresh note (new id, new stamps, new sync life) —
 * a file is a copy, not a move; no attempt is made to reunite it with the
 * note it came from.
 *
 * The Excalidraw bridge: a native .excalidraw file (the excalidraw.com
 * format — `{type: "excalidraw", elements: […], appState: {…}}`) is
 * recognized on open and becomes a drawing note: elements verbatim, the
 * appState whitelisted through the scene module's own discipline, the
 * envelope re-stamped as this build's scene format. Scenes carrying the
 * vendor's `files` map (embedded bitmap images) are refused honestly —
 * 'embedded-images' — because the note model has no binary attachments
 * and a silent loss is the one thing the opaque discipline forbids. The
 * reverse direction (buildExcalidrawFile) writes a drawing note back out
 * as a file excalidraw.com opens natively: the two-way door that makes
 * the canvas feel native to the pad and the pad native to the canvas.
 */

import {
  DEFAULT_NOTE_TYPE,
  contentKindFor,
  normalizeNoteType,
  type NoteType,
} from './editor/note-types';
import {
  DRAWING_SCENE_VERSION,
  parseDrawingScene,
  serializeDrawingScene,
  type DrawingScene,
} from './editor/drawing/scene';

/** The magic discriminator on the wire. */
export const PADIFY_FILE_TYPE = 'padify-note';

/** This file format's version. Bump WITH a refusal policy for older
 * readers — never one without the other. */
export const PADIFY_FORMAT_VERSION = 1;

/** Informational generator tag. The app's product name only — versioning
 * lives in `format`, so this never drifts and is never branched on. */
export const PADIFY_GENERATOR = 'padify';

export const PADIFY_FILE_EXTENSION = '.padify';
export const PADIFY_MIME_TYPE = 'application/x-padify';
export const EXCALIDRAW_FILE_EXTENSION = '.excalidraw';

/** What a .padify file carries for one note. `noteType` is explicit on
 * the wire (the exporter writes 'standard', never undefined); `name` is
 * null when the note derives its title from content. */
export interface PadifyNotePayload {
  name: string | null;
  noteType: string;
  /** The note's content in its type's own format — verbatim. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The envelope writer. Fixed key order and a JSON.stringify with no
 * whitespace — deterministic bytes, the same discipline as the scene
 * serializer (identical notes serialize identically).
 */
export function serializePadifyNoteFile(note: PadifyNotePayload, exportedAt: number): string {
  return JSON.stringify({
    type: PADIFY_FILE_TYPE,
    format: PADIFY_FORMAT_VERSION,
    generator: PADIFY_GENERATOR,
    exportedAt,
    note: {
      name: note.name,
      noteType: note.noteType === '' ? DEFAULT_NOTE_TYPE : note.noteType,
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    },
  });
}

/** The reader's answer: a note, a refusal, or "not ours". */
export type PadifyParseResult =
  { kind: 'padify'; note: PadifyNotePayload } | { kind: 'newer-format'; format: number } | null;

/**
 * Reads .padify bytes. Strict at the envelope, opaque past it:
 *  • a NEWER `format` answers 'newer-format' — the caller refuses the
 *    file honestly instead of guessing at fields it was never taught;
 *  • junk, truncated JSON, arrays, or a foreign `type` answer null;
 *  • the note's `content` is checked to be a string and nothing more —
 *    what it MEANS is the note type's business (the importer asks the
 *    content-kind registry, this module never does).
 */
export function parsePadifyFile(text: string): PadifyParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== PADIFY_FILE_TYPE) {
    return null;
  }
  const format = record.format;
  if (typeof format !== 'number' || !Number.isFinite(format)) {
    return null;
  }
  if (format > PADIFY_FORMAT_VERSION) {
    return { kind: 'newer-format', format };
  }
  const note = record.note;
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    return null;
  }
  const noteRecord = note as Record<string, unknown>;
  if (typeof noteRecord.content !== 'string') {
    return null;
  }
  return {
    kind: 'padify',
    note: {
      name: typeof noteRecord.name === 'string' ? noteRecord.name : null,
      noteType:
        typeof noteRecord.noteType === 'string' && noteRecord.noteType !== ''
          ? noteRecord.noteType
          : DEFAULT_NOTE_TYPE,
      content: noteRecord.content,
      createdAt:
        typeof noteRecord.createdAt === 'number' && Number.isFinite(noteRecord.createdAt)
          ? noteRecord.createdAt
          : 0,
      updatedAt:
        typeof noteRecord.updatedAt === 'number' && Number.isFinite(noteRecord.updatedAt)
          ? noteRecord.updatedAt
          : 0,
    },
  };
}

/** What the importer needs to mint the note: the type registry's answer,
 * plus the content — sanitized when (and only when) the type's content
 * kind is the html subset, exactly like pasted html. */
export interface PreparedPadifyNote {
  name: string | null;
  noteType: NoteType;
  content: string;
}

/**
 * Turns an envelope's note into what addBackgroundNote takes. The html
 * content kinds run through the app's sanitizer (the same boundary every
 * html input crosses — a file is no more trusted than a paste); every
 * other kind rides verbatim, including unknown ('opaque') types whose
 * bytes are a newer build's business. The type id itself is normalized
 * through the registry: well-formed unknown ids are KEPT (they import as
 * placeholder notes that round-trip untouched), malformed ids read as
 * the default.
 */
export function prepareImportedNote(
  note: PadifyNotePayload,
  sanitizeHtml: (html: string) => string,
): PreparedPadifyNote {
  const noteType = normalizeNoteType(note.noteType) ?? DEFAULT_NOTE_TYPE;
  const content = contentKindFor(noteType) === 'html' ? sanitizeHtml(note.content) : note.content;
  return {
    name: note.name !== null && note.name.trim() !== '' ? note.name : null,
    noteType,
    content,
  };
}

/** The Excalidraw bridge's reader answer. */
export type ExcalidrawParseResult =
  { kind: 'scene'; content: string } | { kind: 'embedded-images' } | null;

/**
 * Recognizes a native .excalidraw file and folds it into this build's
 * drawing-note content: elements verbatim, the appState whitelisted and
 * migrated by the scene module's own parse (legacy stroke widths and
 * all), the envelope re-stamped as scene format v1. A scene carrying the
 * vendor's `files` map answers 'embedded-images' — the note model has no
 * binary attachments, and losing bitmaps silently is the one dishonest
 * outcome. Anything else (including a bare elements array without the
 * discriminator, which could be anyone's JSON) answers null.
 */
export function parseExcalidrawFile(text: string, now: number): ExcalidrawParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'excalidraw' || !Array.isArray(record.elements)) {
    return null;
  }
  if (record.files && typeof record.files === 'object' && Object.keys(record.files).length > 0) {
    return { kind: 'embedded-images' };
  }
  const scene = parseDrawingScene(text);
  if (scene === null) {
    // type + elements passed above, so this is unreachable in practice —
    // kept honest anyway: the envelope check and the parse must agree.
    return null;
  }
  return {
    kind: 'scene',
    content: serializeDrawingScene({
      ...scene,
      version: DRAWING_SCENE_VERSION,
      savedAt: now,
    }),
  };
}

/**
 * Writes a drawing note's scene back out as a native .excalidraw file —
 * excalidraw.com opens it directly. The appState rides the scene's
 * already-whitelisted subset (the vendor's own key names), elements
 * verbatim; `files` is omitted (this build's scenes are vector-only),
 * which the vendor's loader treats as "no binary assets" — the truth.
 */
export function buildExcalidrawFile(scene: DrawingScene): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: PADIFY_GENERATOR,
    elements: scene.elements,
    appState: scene.appState,
  });
}

/**
 * A note title (or derived title) as a safe file stem: path separators,
 * control characters and the shell's rude punctuation (\" * < > | ?)
 * leave, whitespace collapses, the stem caps at 80 characters and never
 * starts or ends in a dot. An empty result falls back to the caller's
 * choice (the app's dated convention), so a download always has a name.
 */
export function noteFileStem(title: string | null, fallback: string): string {
  // Matching control characters is the point here, not an accident.
  // eslint-disable-next-line no-control-regex -- a filename must never carry them
  const stripped = (title ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ');
  const stem = stripped
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  return stem !== '' ? stem : fallback;
}

/** `<stem>.padify` — the download menu's Padify save. */
export function padifyFileName(title: string | null, fallback: string): string {
  return noteFileStem(title, fallback) + PADIFY_FILE_EXTENSION;
}

/** `<stem>.excalidraw` — the drawing note's interop save. */
export function excalidrawFileName(title: string | null, fallback: string): string {
  return noteFileStem(title, fallback) + EXCALIDRAW_FILE_EXTENSION;
}
