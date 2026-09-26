/**
 * Note types — the registry of note kinds Padify can create.
 *
 * A note's type selects the editing experience shown for it; the storage
 * format is the same sanitized-HTML subset for every type (see tabs.ts).
 * The type is an OPTIONAL field on the note: anything absent (or unknown)
 * reads as the default, so existing notes and older app versions need no
 * migration — a note without `noteType` IS a standard note.
 *
 * Adding a type = one entry here + whatever editor surface it needs.
 */

export const DEFAULT_NOTE_TYPE = 'standard' as const;

export interface NoteTypeDef {
  id: NoteType;
  label: string;
  /** One-line description shown in the creation menu. */
  description: string;
}

export type NoteType = 'standard' | 'rich';

/** Menu order = menu display order; the default first. */
export const NOTE_TYPES: readonly NoteTypeDef[] = [
  {
    id: 'standard',
    label: 'Plain note',
    description: 'The classic Padify note — type and go',
  },
  {
    id: 'rich',
    label: 'Rich text note',
    description: 'Headings, lists, quotes, code & links',
  },
] as const;

export function isNoteType(value: unknown): value is NoteType {
  return NOTE_TYPES.some((def) => def.id === value);
}

/**
 * Reads a stored/unknown value into the note's type. The default type is
 * represented as `undefined` on the note (kept out of storage), so both
 * `undefined` and 'standard' normalize to `undefined`.
 */
export function normalizeNoteType(value: unknown): NoteType | undefined {
  if (value === DEFAULT_NOTE_TYPE || !isNoteType(value)) {
    return undefined;
  }
  return value;
}

/** True when the note shows the rich editing surface. */
export function isRichNote(note: { noteType?: NoteType } | null | undefined): boolean {
  return note?.noteType === 'rich';
}
