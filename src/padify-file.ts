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
 * vendor's `files` map (embedded bitmap images) are ADMITTED since the
 * attachment store learned the canvas: every well-formed entry decodes
 * into the envelope's attachment shape (same ceilings, same junk-drops
 * discipline) and re-hydrates under its ORIGINAL id — the vendor's
 * content-hashed fileIds — so the scene's references resolve without
 * rewriting a byte of content. Junk entries drop, never the file. The
 * reverse direction (buildExcalidrawFile) writes a drawing note back out
 * as a file excalidraw.com opens natively, the referenced bytes riding
 * the same `files` map — the two-way door that makes the canvas feel
 * native to the pad and the pad native to the canvas.
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
// The per-file byte ceiling, defined once where the whole wire contract
// lives — the envelope holds embedded bytes to the same cap the server's
// upload route and every capture gate enforce.
import { ATTACHMENT_ID_PATTERN, MAX_ATTACHMENT_BYTES } from '../shared/wire';

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
 * One image (or future blob) the note's content references, embedded in
 * the envelope so a .padify file stays ONE self-contained file — the
 * "everything in the envelope" rule the format opened with. Bytes ride
 * base64; ids are the attachment store's (they re-hydrate into the
 * importing device's store under the SAME id, so the note's references
 * resolve without rewriting a byte of content).
 *
 * The field is an ADDITIVE v1 extension: older builds' parsers read only
 * the fields they know, so they import such a file fine (the note opens;
 * its images render as the missing placeholder) and older writers never
 * wrote the field at all.
 */
export interface PadifyFileAttachment {
  /** The attachment store id — matches the note content's references. */
  id: string;
  name: string;
  mime: string;
  /** The bytes, base64. */
  bytes: string;
}

// ---------------------------------------------------------------------------
// Base64 — the envelope's byte encoding (pure string/arraybuffer functions,
// chunked so a multi-megabyte image cannot blow the call stack).
// ---------------------------------------------------------------------------

const BASE64_CHUNK = 0x8000;

/** Bytes → base64 (chunked String.fromCharCode + btoa). Accepts a view
 * or a bare ArrayBuffer (the attachment store hands out ArrayBuffers). */
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** Base64 → bytes, or null when the string is not base64. The backing
 * buffer is always a plain ArrayBuffer, so the result is a BlobPart. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    const binary = atob(value);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The envelope writer. Fixed key order and a JSON.stringify with no
 * whitespace — deterministic bytes, the same discipline as the scene
 * serializer (identical notes serialize identically). `attachments` is
 * the optional v1 image extension: embedded, validated blobs for the
 * references the note's content carries; omitted entirely when empty
 * (an envelope without images stays byte-identical to the old writer's).
 */
export function serializePadifyNoteFile(
  note: PadifyNotePayload,
  exportedAt: number,
  attachments: PadifyFileAttachment[] = [],
): string {
  const envelope: Record<string, unknown> = {
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
  };
  if (attachments.length > 0) {
    envelope.attachments = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      bytes: attachment.bytes,
    }));
  }
  return JSON.stringify(envelope);
}

/** The reader's answer: a note, its embedded attachments (possibly none),
 * a refusal, or "not ours". */
export type PadifyParseResult =
  | {
      kind: 'padify';
      note: PadifyNotePayload;
      /** The envelope's embedded attachments, validated (junk dropped). */
      attachments: PadifyFileAttachment[];
    }
  | { kind: 'newer-format'; format: number }
  | null;

/**
 * The envelope's attachment ceilings — the per-file byte cap from the
 * wire contract (MAX_ATTACHMENT_BYTES) and the same row count as the
 * server's per-user quota. A file beyond either is data this app would
 * refuse on upload; the envelope holds it to the same honesty. The id
 * shape is the wire's too (the id border, shared/wire.ts).
 */
const MAX_EMBEDDED_ATTACHMENTS = 500;
const ATTACHMENT_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

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
    attachments: parseEmbeddedAttachments(record.attachments),
  };
}

/**
 * The envelope's embedded attachments, validated one entry at a time —
 * malformed entries DROP (a file is data, not code; one junk entry must
 * not sink the whole file), the count and per-entry size hold the same
 * ceilings the server's upload route does, and the bytes must genuinely
 * be base64. Entries beyond the count cap drop rather than fail the file.
 */
function parseEmbeddedAttachments(raw: unknown): PadifyFileAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PadifyFileAttachment[] = [];
  for (const entry of raw.slice(0, MAX_EMBEDDED_ATTACHMENTS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const name = typeof record.name === 'string' ? record.name.slice(0, 200) : '';
    const mime = typeof record.mime === 'string' ? record.mime.slice(0, 100) : '';
    const bytes = typeof record.bytes === 'string' ? record.bytes : '';
    if (!ATTACHMENT_ID_PATTERN.test(id) || !ATTACHMENT_MIME_PATTERN.test(mime)) {
      continue;
    }
    const decoded = base64ToBytes(bytes);
    if (decoded === null || decoded.byteLength === 0 || decoded.byteLength > MAX_ATTACHMENT_BYTES) {
      continue;
    }
    out.push({ id, name, mime, bytes });
  }
  return out;
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

/** The Excalidraw bridge's reader answer: a scene (with any embedded
 * images decoded into the attachment shape) or null. */
export type ExcalidrawParseResult = {
  kind: 'scene';
  content: string;
  attachments: PadifyFileAttachment[];
} | null;

/**
 * The data-URL shape the bridge decodes: a mime and a base64 payload.
 * The vendor's own BinaryFileData.dataURL is exactly this.
 */
const DATA_URL_PATTERN =
  /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]*={0,2})$/i;

/**
 * Recognizes a native .excalidraw file and folds it into this build's
 * drawing-note content: elements verbatim, the appState whitelisted and
 * migrated by the scene module's own parse (legacy stroke widths and
 * all), the envelope re-stamped as scene format v1. A scene carrying the
 * vendor's `files` map decodes its entries into the attachment shape —
 * same ceilings as the envelope (5 MB/file, 500 files), junk entries
 * DROP (a file is data, not code; one junk image must not sink the
 * drawing it rode in on). Anything else (including a bare elements array
 * without the discriminator, which could be anyone's JSON) answers null.
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
    attachments: attachmentsFromFilesMap(record.files),
  };
}

/**
 * The vendor's `files` map → the envelope's attachment shape, one entry
 * at a time: the id and mime must be the store's shape, the dataURL must
 * genuinely be a base64 data URL whose decoded bytes fit the ceilings,
 * and anything else drops. An empty or junk map answers empty — the
 * import still succeeds, the scene's images just render as their
 * placeholders.
 */
function attachmentsFromFilesMap(raw: unknown): PadifyFileAttachment[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  const out: PadifyFileAttachment[] = [];
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>).slice(
    0,
    MAX_EMBEDDED_ATTACHMENTS,
  )) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    if (!ATTACHMENT_ID_PATTERN.test(id)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const mime = typeof record.mimeType === 'string' ? record.mimeType.slice(0, 100) : '';
    const dataURL = typeof record.dataURL === 'string' ? record.dataURL : '';
    if (!ATTACHMENT_MIME_PATTERN.test(mime)) {
      continue;
    }
    const match = DATA_URL_PATTERN.exec(dataURL);
    if (!match) {
      continue;
    }
    const decoded = base64ToBytes(match[2]!);
    if (decoded === null || decoded.byteLength === 0 || decoded.byteLength > MAX_ATTACHMENT_BYTES) {
      continue;
    }
    out.push({ id, name: `${id}.img`, mime, bytes: match[2]! });
  }
  return out;
}

/**
 * Writes a drawing note's scene back out as a native .excalidraw file —
 * excalidraw.com opens it directly. The appState rides the scene's
 * already-whitelisted subset (the vendor's own key names), elements
 * verbatim. The scene's referenced image bytes ride the vendor's `files`
 * map (`attachments`, decoded by the caller from the attachment store —
 * the same shape the .padify envelope embeds); an empty list omits the
 * field entirely, which the vendor's loader treats as "no binary
 * assets". `now` stamps the entries' created/lastRetrieved (the vendor's
 * BinaryFileData wants both).
 */
export function buildExcalidrawFile(
  scene: DrawingScene,
  attachments: PadifyFileAttachment[] = [],
  now: number = Date.now(),
): string {
  const file: Record<string, unknown> = {
    type: 'excalidraw',
    version: 2,
    source: PADIFY_GENERATOR,
    elements: scene.elements,
    appState: scene.appState,
  };
  if (attachments.length > 0) {
    const files: Record<string, unknown> = {};
    for (const attachment of attachments) {
      files[attachment.id] = {
        id: attachment.id,
        mimeType: attachment.mime,
        dataURL: `data:${attachment.mime};base64,${attachment.bytes}`,
        created: now,
        lastRetrieved: now,
      };
    }
    file.files = files;
  }
  return JSON.stringify(file);
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
