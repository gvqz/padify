/**
 * The note-type registry — pure data + normalization rules.
 *
 * The registry is the single source the creation menu, the rail badge,
 * type-aware editor chrome and every content-handling layer read; these
 * tests pin the contracts that make that safe: absent/default values
 * normalize to `undefined` (= the default note), unknown-but-well-formed
 * ids survive verbatim (a newer Padify's note must round-trip home), and
 * every type answers a content kind that decides who may touch its
 * content — the HTML sanitizer applies to 'html' notes only.
 */
import { describe, expect, it } from 'vitest';
import {
  contentKindFor,
  DEFAULT_NOTE_TYPE,
  isHtmlContent,
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
    }
  });

  it('menu ids are unique', () => {
    const ids = NOTE_TYPES.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('normalizeNoteType', () => {
  it('reads the default and junk values as undefined (absent = standard)', () => {
    expect(normalizeNoteType(undefined)).toBeUndefined();
    expect(normalizeNoteType(null)).toBeUndefined();
    expect(normalizeNoteType('')).toBeUndefined();
    expect(normalizeNoteType('standard')).toBeUndefined();
    expect(normalizeNoteType(42)).toBeUndefined();
    // Ids that fail the slug pattern are junk, not types.
    expect(normalizeNoteType('NOT A TYPE')).toBeUndefined();
    expect(normalizeNoteType('x'.repeat(64))).toBeUndefined();
  });

  it('keeps unknown-but-well-formed ids — they belong to a newer build', () => {
    // The typed content model's forward-compat rule: a type this build has
    // never heard of survives storage and sync verbatim, so the note can
    // go home to a Padify that understands it.
    expect(normalizeNoteType('kanban')).toBe('kanban');
    expect(normalizeNoteType('teleprompter')).toBe('teleprompter');
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
    expect(isNoteType('kanban')).toBe(false);
    expect(isNoteType(undefined)).toBe(false);
  });

  it('isRichNote is true only for rich notes (and null-safe)', () => {
    expect(isRichNote({ noteType: 'rich' })).toBe(true);
    expect(isRichNote({ noteType: undefined })).toBe(false);
    expect(isRichNote(null)).toBe(false);
    expect(isRichNote(undefined)).toBe(false);
  });
});

describe('contentKindFor', () => {
  it('every registry entry declares its content kind', () => {
    for (const def of NOTE_TYPES) {
      expect(contentKindFor(def.id)).toBe(def.contentKind);
    }
  });

  it('absent and default types are html — the classic note', () => {
    expect(contentKindFor(undefined)).toBe('html');
    expect(contentKindFor(null)).toBe('html');
    expect(contentKindFor(DEFAULT_NOTE_TYPE)).toBe('html');
  });

  it('markdown notes are text — the sanitizer never touches their source', () => {
    expect(contentKindFor('markdown')).toBe('text');
  });

  it('unknown types answer opaque — stored verbatim, never sanitized, never edited', () => {
    expect(contentKindFor('kanban')).toBe('opaque');
    expect(contentKindFor('voice-note')).toBe('opaque');
    expect(contentKindFor('drawingpad')).toBe('opaque');
  });

  it('isHtmlContent is the sanitizer gate', () => {
    expect(isHtmlContent('rich')).toBe(true);
    expect(isHtmlContent(undefined)).toBe(true);
    expect(isHtmlContent('markdown')).toBe(false);
  });
});
