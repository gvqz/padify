/**
 * Note types — the registry of note kinds Padify can create.
 *
 * A note is its type plus content, and the TYPE OWNS THE CONTENT FORMAT:
 * every entry declares a content kind (below), and every layer that touches
 * note content — storage, sync, sharing, snapshots, export — must ask the
 * kind before interpreting the string. The HTML sanitizer, specifically,
 * applies to 'html' notes ONLY: running it over any other format would
 * rewrite angle brackets inside data and silently corrupt the note.
 *
 * Adding a type = one entry here + the editor surface it needs (see
 * contentKindFor consumers). The type is an OPTIONAL field on the note:
 * anything absent reads as the default, so existing notes and older app
 * versions need no migration — a note without `noteType` IS a standard
 * note.
 *
 * Forward compatibility: NoteType is an OPEN string type. A note type this
 * build has never heard of (created by a newer app version, arrived via
 * sync) keeps its type id and content VERBATIM — contentKindFor answers
 * 'opaque' for it, the editor shows a placeholder instead of editing it,
 * and the note round-trips untouched. Unknown never means damaged.
 */

export const DEFAULT_NOTE_TYPE = 'standard' as const;

/**
 * How a note's content string is stored and what may interpret it:
 *  • 'html' — the sanitized formatting subset (see tabs.ts); the only kind
 *             the HTML sanitizer and the contenteditable surface touch.
 *  • 'text' — plain text with meaning (e.g. Markdown source); rendered as
 *             text, never as markup.
 *  • 'json' — structured data (e.g. a board, a task list); rendered by its
 *             own surface, serialized as JSON.
 *  • 'opaque' — not one of ours: a type id this build doesn't know. Stored
 *             and synced verbatim, never edited here.
 */
export type ContentKind = 'html' | 'text' | 'json' | 'opaque';

export interface NoteTypeDef {
  id: KnownNoteType;
  label: string;
  /** One-line description shown in the creation menu. */
  description: string;
  /** How this note's content is stored — see the ContentKind contract. */
  contentKind: Exclude<ContentKind, 'opaque'>;
}

/**
 * The types this build knows. Open on purpose: `(string & {})` keeps
 * autocomplete for known ids while letting unknown ids (from newer builds,
 * via sync) flow through the system as first-class values.
 */
export type KnownNoteType = 'standard' | 'rich';
export type NoteType = KnownNoteType | (string & {});

/** Menu order = menu display order; the default first. */
export const NOTE_TYPES: readonly NoteTypeDef[] = [
  {
    id: 'standard',
    label: 'Plain note',
    description: 'The classic Padify note — type and go',
    contentKind: 'html',
  },
  {
    id: 'rich',
    label: 'Rich text note',
    description: 'Docs-style formatting — fonts, colors, lists & links',
    contentKind: 'html',
  },
] as const;

export function isNoteType(value: unknown): value is NoteType {
  return NOTE_TYPES.some((def) => def.id === value);
}

/** The registry label ('Rich text note'), or the id when unknown. */
export function noteTypeLabel(type: NoteType): string {
  return NOTE_TYPES.find((def) => def.id === type)?.label ?? type;
}

/**
 * The storage discipline for a note of this type. Unknown ids answer
 * 'opaque': the content is someone else's format — keep it byte-exact,
 * never sanitize it, never render it as markup, never edit it here.
 */
export function contentKindFor(type: NoteType | null | undefined): ContentKind {
  if (type === null || type === undefined) {
    // Absent type = the default = a standard (html) note.
    return 'html';
  }
  return NOTE_TYPES.find((def) => def.id === type)?.contentKind ?? 'opaque';
}

/** True when the note's content is the sanitized-HTML subset. */
export function isHtmlContent(type: NoteType | null | undefined): boolean {
  return contentKindFor(type) === 'html';
}

/**
 * Presentation: the icon a type shows in the creation menu (15px) and, for
 * non-default notes, as the rail badge (10px). Kept beside the registry so
 * a type's menu entry stays one self-contained thing.
 */
export const NOTE_TYPE_ICONS: Record<KnownNoteType, (size: number) => string> = {
  standard: (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  rich: (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 20 12 4l5.5 16"/><path d="M8.3 14.5h7.4"/><path d="M4 20h16" opacity=".45"/></svg>`,
};

/** Type ids are url-safe slugs; the server enforces the same shape. */
export const NOTE_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Reads a stored/unknown value into the note's type. The default type is
 * represented as `undefined` on the note (kept out of storage), so both
 * `undefined` and 'standard' normalize to `undefined`. Unknown-but-well-
 * formed ids are KEPT AS-IS: they belong to a newer build, and dropping
 * the id here is how a note ends up edited as the wrong format on its way
 * home. Malformed ids (not matching NOTE_TYPE_ID_PATTERN) are junk, not
 * types — they read as the default.
 */
export function normalizeNoteType(value: unknown): NoteType | undefined {
  if (value === DEFAULT_NOTE_TYPE || value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !NOTE_TYPE_ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

/** True when the note shows the rich editing surface. */
export function isRichNote(note: { noteType?: NoteType } | null | undefined): boolean {
  return note?.noteType === 'rich';
}
