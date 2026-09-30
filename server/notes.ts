/**
 * Note rows — the contract between the client sync layer (src/cloud/sync.ts)
 * and storage.
 *
 * The server is deliberately schema-light about note types: it stores any
 * well-formed type id verbatim and never interprets what a type MEANS —
 * the client's registry (src/editor/note-types.ts) owns that. A type this
 * server has never heard of must survive the round trip, because the note
 * belongs to a newer build and has to arrive home intact.
 *
 * Extracted from index.ts (which boots Bun.serve at import time) so the
 * parsing rules can be pinned by tests without starting a server.
 */

/**
 * Type ids are url-safe slugs. The client enforces the same shape
 * (NOTE_TYPE_ID_PATTERN in src/editor/note-types.ts); both sides must
 * agree, or types would silently fall off notes at the border.
 */
export const NOTE_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface IncomingNoteRow {
  id: string;
  name: string | null;
  html: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  note_type: string | null;
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A well-formed note type id passes through; anything else reads as null. */
export function parseNoteType(value: unknown): string | null {
  return typeof value === 'string' && NOTE_TYPE_ID_PATTERN.test(value) ? value : null;
}

/**
 * Validates a PUT /api/notes body into storable rows. One malformed row
 * rejects the whole batch — the client batches by size, so a rejected
 * batch is retried as smaller batches, never partially applied.
 */
export function parseNoteRows(value: unknown): IncomingNoteRow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    return null;
  }
  const rows: IncomingNoteRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const id = asString(row.id);
    if (!id || id.length > 100) {
      return null;
    }
    rows.push({
      id,
      name: row.name === null || row.name === undefined ? null : asString(row.name).slice(0, 300),
      html: asString(row.html),
      position: asInt(row.position, 0),
      created_at: asInt(row.created_at, 0),
      updated_at: asInt(row.updated_at, 0),
      deleted: asBool(row.deleted),
      note_type: parseNoteType(row.note_type)
    });
  }
  return rows;
}
