import { describe, expect, it } from 'vitest';
import { NOTE_TYPE_ID_PATTERN, parseNoteRows, parseNoteType } from '../server/notes';

// The server's side of the note contract. The client registry owns what a
// type MEANS; the server stores any well-formed id verbatim so a note can
// round-trip to a newer build. These tests pin the border: nothing a
// client sends may change a note's type except a well-formed type id, and
// a malformed row rejects the whole batch (never a partial write).

describe('parseNoteType', () => {
  it('accepts well-formed slug ids, including unknown ones', () => {
    expect(parseNoteType('rich')).toBe('rich');
    expect(parseNoteType('kanban')).toBe('kanban');
    expect(parseNoteType('voice-note')).toBe('voice-note');
    expect(parseNoteType('a')).toBe('a');
  });

  it('reads junk, non-strings and oversized ids as null', () => {
    expect(parseNoteType(null)).toBeNull();
    expect(parseNoteType(undefined)).toBeNull();
    expect(parseNoteType(42)).toBeNull();
    expect(parseNoteType('')).toBeNull();
    expect(parseNoteType('Rich')).toBeNull(); // case matters: slugs are lower
    expect(parseNoteType('has space')).toBeNull();
    expect(parseNoteType('1starts-with-digit')).toBeNull();
    expect(parseNoteType('x'.repeat(33))).toBeNull();
    expect(parseNoteType('<script>')).toBeNull();
  });

  it('mirrors the client pattern exactly (NOTE_TYPE_ID_PATTERN)', () => {
    // The client uses the same regex (src/editor/note-types.ts); drift
    // here would silently strip types at the border.
    expect(NOTE_TYPE_ID_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,31}$');
  });
});

describe('parseNoteRows', () => {
  const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'tab-1',
    name: null,
    html: '<p>hello</p>',
    position: 0,
    created_at: 1000,
    updated_at: 2000,
    deleted: false,
    note_type: null,
    ...overrides,
  });

  it('keeps unknown note types — a newer build’s note must survive', () => {
    const rows = parseNoteRows([row({ note_type: 'kanban', content: '{"cards":[]}' })]);

    expect(rows![0].note_type).toBe('kanban');
    expect(rows![0].content).toBe('{"cards":[]}');
  });

  it('accepts the legacy html key from a pre-rename client, content wins', () => {
    // The rename transition: the server takes `content` or `html` (or
    // both, same value) so a deploy gap between site and API never
    // costs a note its body. `content` is preferred when both appear.
    const legacy = parseNoteRows([row({ html: 'legacy body' })]);
    const both = parseNoteRows([row({ content: 'new body', html: 'legacy body' })]);

    expect(legacy![0].content).toBe('legacy body');
    expect(both![0].content).toBe('new body');
  });

  it('nulls malformed note types instead of rejecting the batch', () => {
    const rows = parseNoteRows([row({ note_type: 'NOT A TYPE' })]);

    expect(rows![0].note_type).toBeNull();
  });

  it('rejects the whole batch on a malformed row — never a partial write', () => {
    expect(parseNoteRows([row(), row({ id: '' })])).toBeNull();
    expect(parseNoteRows([row(), 'not an object'])).toBeNull();
    expect(parseNoteRows([])).toBeNull();
    expect(parseNoteRows('nope')).toBeNull();
    expect(parseNoteRows(new Array(501).fill(row()))).toBeNull();
  });

  it('coerces the scalar fields the way storage expects', () => {
    const rows = parseNoteRows([
      row({ name: undefined, position: '3' as unknown, deleted: 1 as unknown }),
    ]);

    expect(rows![0].name).toBeNull();
    expect(rows![0].position).toBe(3);
    expect(rows![0].deleted).toBe(false); // only booleans count — 1 is not true
  });
});
