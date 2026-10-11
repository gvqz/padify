import { describe, expect, it } from 'vitest';
import { migrateNoteRecord, NOTE_RECORD_VERSION, type NoteRecord } from './notes';
import type { IncomingNoteRow } from '../../shared/wire';

// The local note-row schema version — the client twin of the server's
// PRAGMA-guarded migrations (server/db.ts). These tests pin the versioning
// contract itself:
//
//   • every row a writer emits carries the current stamp;
//   • unversioned rows (every build before the stamp existed) are v1 and
//     migrate the rename dual-read way;
//   • the version is LOCAL — it rides storage only and must never leak
//     into the wire shape (IncomingNoteRow has no v; the server ignores
//     unknown keys, but the client's own rows-to-wire mapper drops it).

const v1Row = (overrides: Partial<NoteRecord> = {}): NoteRecord =>
  ({
    id: 'tab-legacy',
    name: null,
    createdAt: 1000,
    updatedAt: 2000,
    position: 0,
    deleted: false,
    // A true v1 row has NO `content` key at all — the body lives under
    // the legacy `html` spelling.
    html: '<b>legacy body</b>',
    ...overrides,
  }) as NoteRecord;

describe('migrateNoteRecord', () => {
  it('a v1 row (body under the legacy html key) migrates into the current shape', () => {
    const migrated = migrateNoteRecord(v1Row());

    expect(migrated.content).toBe('<b>legacy body</b>');
    expect(migrated.v).toBe(NOTE_RECORD_VERSION);
  });

  it('content wins over the legacy html key when a v1 row carries both', () => {
    // The dual-read order the loaders have always used: a row with both
    // keys (the rename's write window) prefers the newer spelling.
    const migrated = migrateNoteRecord(v1Row({ content: 'new body', html: 'old body' }));

    expect(migrated.content).toBe('new body');
  });

  it('a v1 row with neither key reads an empty body, not undefined', () => {
    const migrated = migrateNoteRecord(v1Row({ html: undefined }));

    expect(migrated.content).toBe('');
  });

  it('an empty-string content on a v1 row still wins over the legacy key — the dual-read order', () => {
    // The loaders have always preferred ANY string under `content`, even
    // an empty one: an empty body is a legitimate state (a cleared note),
    // not a missing one.
    const migrated = migrateNoteRecord(v1Row({ content: '' }));

    expect(migrated.content).toBe('');
  });

  it('a current row (v stamped) passes through with only the stamp refreshed', () => {
    const row: NoteRecord = {
      id: 'tab-current',
      name: 'Named',
      content: 'current body',
      createdAt: 1,
      updatedAt: 2,
      position: 3,
      deleted: false,
      v: NOTE_RECORD_VERSION,
      noteType: 'rich',
    };

    const migrated = migrateNoteRecord(row);

    expect(migrated).toEqual(row);
  });

  it('a FUTURE version row passes through untouched — never restamped as current', () => {
    // A row written by a newer build (say v3 with a new body field) must
    // not be stamped v2 by this build: the downgrade would make the next
    // upgrade misread the row forever. Unknown fields ride along; only
    // the version stamp is sacred.
    const row: NoteRecord = {
      id: 'tab-future',
      name: null,
      content: 'future body under a v3 field',
      createdAt: 1,
      updatedAt: 2,
      position: 3,
      deleted: false,
      v: 3,
      noteType: 'rich',
      // A field only v3 builds know about:
      futureField: { anything: true },
    } as NoteRecord;

    const migrated = migrateNoteRecord(row);

    expect(migrated).toBe(row); // the exact same record — not even a copy
  });

  it('junk version values read as v1 — never as a newer-than-current shape', () => {
    // A crafted or corrupted v must not smuggle a row past the migration.
    for (const junk of [0, -1, 2.5, Number.NaN]) {
      const migrated = migrateNoteRecord(v1Row({ v: junk }));
      expect(migrated.content).toBe('<b>legacy body</b>');
      expect(migrated.v).toBe(NOTE_RECORD_VERSION);
    }
  });

  it('the version never crosses into the wire shape — NoteRecord.v is local-only', () => {
    // The strongest form of the promise: the sync layer's row mapper is
    // driven by NoteTab (which has no v field). Pin that the wire type
    // stays v-free by construction — IncomingNoteRow carries exactly the
    // wire fields, and none of them is v.
    const sample: IncomingNoteRow = {
      id: 'x',
      name: null,
      content: 'body',
      position: 0,
      created_at: 0,
      updated_at: 0,
      deleted: false,
      note_type: null,
    };

    expect(Object.keys(sample)).not.toContain('v');
    expect('v' in sample).toBe(false);
  });
});

describe('NOTE_RECORD_VERSION', () => {
  it('is 2 — the typed-content-model shape', () => {
    // Bump this WITH a case in migrateNoteRecord (see the constant's doc).
    expect(NOTE_RECORD_VERSION).toBe(2);
  });
});
