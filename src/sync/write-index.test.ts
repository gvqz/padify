import { describe, expect, it } from 'vitest';
import { WriteIndex, signatureOf, type WriteSignatureRow } from './write-index';

// The write index is S1's tranche two: the storage diff's answer to "did
// this row change since I last wrote it?" as ONE canonical signature
// instead of a ten-field hand-rolled comparison with four bespoke
// equality helpers. These tests pin the invariants that keep the diff
// honest — most importantly the field LIST: every field whose change must
// reach the database flips `changed`, and the two fields the old diff
// forgot (conflict.theirs.name/detectedAt, syncSeq) are on it now.

const row = (overrides: Partial<WriteSignatureRow> = {}): WriteSignatureRow => ({
  id: 'a',
  name: null,
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

const live = { position: 0, deleted: false, deletedAt: 0 };

describe('signatureOf — the field list is the contract', () => {
  it('includes every persistence-relevant field', () => {
    // The signature's keys ARE the list of fields whose change must
    // reach the database. This pins the list itself: adding a persisted
    // field without adding it here is the drift this module exists to
    // make impossible (there is no second list to fall out of sync with,
    // but there is also no excuse for a silent omission).
    const keys = Object.keys(signatureOf(row(), live)).sort();
    expect(keys).toEqual([
      'conflict',
      'createdAt',
      'deleted',
      'deletedAt',
      'name',
      'noteType',
      'position',
      'syncBase',
      'syncSeq',
      'unpushed',
      'unseenChange',
      'updatedAt',
    ]);
  });

  it('excludes content — the bump is the change signal, not the bytes', () => {
    // Two rows with identical metadata and different bodies read as
    // unchanged: content changes always bump updatedAt on the write
    // paths, and comparing the bytes would copy every keystroke's full
    // string into the index for nothing.
    const index = new WriteIndex();
    index.commit(row({ name: 'a' }), live);
    // content is not in WriteSignatureRow's compared set — the row shape
    // carries it, the signature does not. Same everything, new body:
    expect(index.changed(row({ name: 'a' }), live)).toBe(false);
  });
});

describe('changed — one flip per field', () => {
  const conflict = {
    kind: 'edit' as const,
    detectedAt: 3,
    mine: { name: 'Mine', content: '<p>my words</p>' },
    theirs: { name: 'Theirs', content: '<p>their words</p>', updatedAt: 9 },
  };

  const cases: Array<[string, WriteSignatureRow, WriteSignatureRow]> = [
    ['name', row(), row({ name: 'renamed' })],
    ['createdAt', row(), row({ createdAt: 101 })],
    ['updatedAt', row(), row({ updatedAt: 201 })],
    ['noteType', row(), row({ noteType: 'markdown' })],
    ['syncSeq', row(), row({ syncSeq: 7 })],
    ['syncBase', row(), row({ syncBase: { content: '<p>x</p>', name: null } })],
    ['unseenChange', row(), row({ unseenChange: { from: '<p>y</p>', fromName: null } })],
    ['conflict', row(), row({ conflict })],
    ['unpushed', row(), row({ unpushed: true })],
  ];

  it.each(cases)('%s flip reads as changed', (_label, before, after) => {
    const index = new WriteIndex();
    index.commit(before, live);
    expect(index.changed(after, live)).toBe(true);
  });

  it('layout flips read as changed (position, deleted, deletedAt)', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    expect(index.changed(row(), { position: 1, deleted: false, deletedAt: 0 })).toBe(true);
    expect(index.changed(row(), { position: 0, deleted: true, deletedAt: 5 })).toBe(true);
    expect(index.changed(row(), { position: 0, deleted: false, deletedAt: 5 })).toBe(true);
  });

  it('a grave becoming live (and back) reads as changed — the restore path', () => {
    const index = new WriteIndex();
    index.commit(row({ name: 'note' }), { position: -1, deleted: true, deletedAt: 42 });
    // Restored: same domain fields, live layout.
    expect(index.changed(row({ name: 'note' }), live)).toBe(true);
  });

  it('equal-but-distinct field objects read as unchanged (structural, not reference)', () => {
    // A merge replaced the tab wholesale; the sync fields are new objects
    // with the same values. The write must not churn.
    const index = new WriteIndex();
    index.commit(
      row({
        syncBase: { content: '<p>same</p>', name: 'Same' },
        unseenChange: { from: '<p>was</p>', fromName: null },
        conflict,
      }),
      live,
    );
    expect(
      index.changed(
        row({
          syncBase: { content: '<p>same</p>', name: 'Same' },
          unseenChange: { from: '<p>was</p>', fromName: null },
          conflict: {
            kind: 'edit',
            detectedAt: 3,
            mine: { name: 'Mine', content: '<p>my words</p>' },
            theirs: { name: 'Theirs', content: '<p>their words</p>', updatedAt: 9 },
          },
        }),
        live,
      ),
    ).toBe(false);
  });

  it('the fields the old diff forgot are compared now', () => {
    // conflict.theirs.name, conflict.detectedAt and syncSeq moved alone
    // under the hand-rolled helpers and never re-wrote — the persisted
    // record went stale (a review sheet showing an old name, a reload
    // losing the seq anchor). One flip each, one write each.
    const base = {
      kind: 'edit' as const,
      detectedAt: 3,
      mine: { name: null, content: '<p>mine</p>' },
      theirs: { name: 'Their name', content: '<p>theirs</p>', updatedAt: 9 },
    };
    const index = new WriteIndex();
    index.commit(row({ conflict: base, syncSeq: 4 }), live);
    expect(
      index.changed(
        row({
          conflict: { ...base, theirs: { ...base.theirs, name: 'A newer name' } },
          syncSeq: 4,
        }),
        live,
      ),
    ).toBe(true);
    expect(index.changed(row({ conflict: { ...base, detectedAt: 77 }, syncSeq: 4 }), live)).toBe(
      true,
    );
    expect(index.changed(row({ conflict: base, syncSeq: 5 }), live)).toBe(true);
  });

  it('nested field flips inside syncBase / unseenChange read as changed', () => {
    const index = new WriteIndex();
    index.commit(row({ syncBase: { content: '<p>a</p>', name: 'A' } }), live);
    expect(index.changed(row({ syncBase: { content: '<p>b</p>', name: 'A' } }), live)).toBe(true);
    expect(index.changed(row({ syncBase: { content: '<p>a</p>', name: 'B' } }), live)).toBe(true);

    index.commit(row({ unseenChange: { from: '<p>1</p>', fromName: null } }), live);
    expect(index.changed(row({ unseenChange: { from: '<p>2</p>', fromName: null } }), live)).toBe(
      true,
    );
    expect(index.changed(row({ unseenChange: { from: '<p>1</p>', fromName: 'X' } }), live)).toBe(
      true,
    );
  });

  it('unpushed normalizes absent and false to the same signature', () => {
    const index = new WriteIndex();
    index.commit(row(), live); // no unpushed key at all
    expect(index.changed(row({ unpushed: false }), live)).toBe(false);
  });
});

describe('forget — the failed-upsert rollback', () => {
  it('a forgotten id reads as changed again, so the next save re-writes it', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    expect(index.changed(row(), live)).toBe(false);

    index.forget(['a']);
    expect(index.changed(row(), live)).toBe(true);
  });
});

describe('retireAbsent — the delete derivation', () => {
  it('indexed ids the model no longer holds become deletes', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    index.commit(row({ id: 'b' }), live);

    const { deletes, retired } = index.retireAbsent(new Set(['a']));
    expect(deletes).toEqual(['b']);
    expect([...retired.keys()]).toEqual(['b']);
    // The entry left the index: the delete shipped (from the diff's
    // perspective) and nothing re-derives it while the model stays as is.
    const again = index.retireAbsent(new Set(['a']));
    expect(again.deletes).toEqual([]);
  });

  it('a restored retired entry re-derives the delete — the failed-write path', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    const { deletes, retired } = index.retireAbsent(new Set());
    expect(deletes).toEqual(['a']);

    // The write failed: put the entry back.
    index.restore(retired);
    const retry = index.retireAbsent(new Set());
    expect(retry.deletes).toEqual(['a']);
  });

  it('ids the model still holds never derive deletes', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    const { deletes } = index.retireAbsent(new Set(['a']));
    expect(deletes).toEqual([]);
  });
});

describe('swept trash', () => {
  it('seeded swept ids are named by sweptIds()', () => {
    const index = new WriteIndex();
    index.seed(row(), live);
    index.seed(row({ id: 'b' }), { position: -1, deleted: true, deletedAt: 1 }, { swept: true });

    expect(index.sweptIds()).toEqual(['b']);
  });

  it('swept entries still sit in the delete path (absent from the model)', () => {
    const index = new WriteIndex();
    index.seed(row(), { position: -1, deleted: true, deletedAt: 1 }, { swept: true });
    const { deletes } = index.retireAbsent(new Set());
    expect(deletes).toEqual(['a']);
  });
});

describe('the externally-deleted blacklist', () => {
  it('replaces wholesale — a restore in the other tab lifts the blacklist', () => {
    const index = new WriteIndex();
    index.replaceExternallyDeleted(['a']);
    expect(index.isExternallyDeleted('a')).toBe(true);

    // The mirror blob IS the other tab's trash: an empty blob lifts it.
    index.replaceExternallyDeleted([]);
    expect(index.isExternallyDeleted('a')).toBe(false);
  });

  it('reset clears every structure', () => {
    const index = new WriteIndex();
    index.commit(row(), live);
    index.replaceExternallyDeleted(['a']);
    index.reset();
    expect(index.isExternallyDeleted('a')).toBe(false);
    expect(index.changed(row(), live)).toBe(true); // entries gone
    expect(index.sweptIds()).toEqual([]);
  });
});
