/**
 * The note-type registry — pure data + normalization rules.
 *
 * The registry is the single source the creation menu, the rail badge and
 * type-aware editor chrome all read; these tests pin the contract that
 * makes that safe: unknown/absent/default values all normalize to
 * `undefined` (= the default note), so no storage row, cloud payload or
 * future type can accidentally change what an existing note is.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTE_TYPE,
  isNoteType,
  isRichNote,
  normalizeNoteType,
  NOTE_TYPES,
} from './note-types';

describe('note types registry', () => {
  it('the default type is standard and heads the menu list', () => {
    expect(DEFAULT_NOTE_TYPE).toBe('standard');
    expect(NOTE_TYPES[0].id).toBe('standard');
  });

  it('every type def carries the menu copy', () => {
    for (const def of NOTE_TYPES) {
      expect(def.label.trim().length).toBeGreaterThan(0);
      expect(def.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('menu ids are unique', () => {
    const ids = NOTE_TYPES.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('normalizeNoteType', () => {
  it('reads the default and unknown values as undefined (absent = standard)', () => {
    expect(normalizeNoteType(undefined)).toBeUndefined();
    expect(normalizeNoteType(null)).toBeUndefined();
    expect(normalizeNoteType('')).toBeUndefined();
    expect(normalizeNoteType('standard')).toBeUndefined();
    expect(normalizeNoteType('markdown')).toBeUndefined();
    expect(normalizeNoteType(42)).toBeUndefined();
  });

  it('keeps non-default registered types', () => {
    expect(normalizeNoteType('rich')).toBe('rich');
  });
});

describe('isNoteType / isRichNote', () => {
  it('isNoteType accepts exactly the registry ids', () => {
    for (const def of NOTE_TYPES) {
      expect(isNoteType(def.id)).toBe(true);
    }
    expect(isNoteType('markdown')).toBe(false);
    expect(isNoteType(undefined)).toBe(false);
  });

  it('isRichNote is true only for rich notes (and null-safe)', () => {
    expect(isRichNote({ noteType: 'rich' })).toBe(true);
    expect(isRichNote({ noteType: undefined })).toBe(false);
    expect(isRichNote(null)).toBe(false);
    expect(isRichNote(undefined)).toBe(false);
  });
});
