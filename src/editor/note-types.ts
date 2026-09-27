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
    description: 'Docs-style formatting — fonts, colors, lists & links',
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
 * Presentation: the icon a type shows in the creation menu (15px) and, for
 * non-default notes, as the rail badge (10px). Kept beside the registry so
 * a type's menu entry stays one self-contained thing.
 */
export const NOTE_TYPE_ICONS: Record<NoteType, (size: number) => string> = {
  standard: (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  rich: (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 20 12 4l5.5 16"/><path d="M8.3 14.5h7.4"/><path d="M4 20h16" opacity=".45"/></svg>`,
};

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
