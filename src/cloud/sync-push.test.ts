import { describe, expect, it } from 'vitest';
import { batchRowsForPush, rowUnsyncable, type NoteRow } from './sync';
import { MAX_ROWS_PER_PUSH } from '../../shared/wire';

// The push queue must drain even when one note can never leave: the server
// caps request bodies at 2 MB AND row count at MAX_ROWS_PER_PUSH (both live
// in shared/wire.ts), so a giant note has to fail alone instead of failing
// everyone, and a huge QUEUE of tiny notes has to split on count, not just
// bytes. These tests pin the batching contract.

const row = (id: string, htmlLength: number): NoteRow => ({
  id,
  user_id: 'user',
  name: null,
  html: 'x'.repeat(htmlLength),
  position: 0,
  created_at: 0,
  updated_at: 0,
  deleted: false,
  note_type: null,
});

describe('batchRowsForPush', () => {
  it('keeps small queues as one body', () => {
    const batches = batchRowsForPush([row('a', 100), row('b', 100)]);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('splits before a row would overflow the body cap', () => {
    // ~800 KB each: three rows cannot share one 1.5 MB body.
    const batches = batchRowsForPush([row('a', 800_000), row('b', 800_000), row('c', 10)]);

    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([['a'], ['b', 'c']]);
  });

  it('isolates an oversized row so it fails alone', () => {
    const batches = batchRowsForPush([row('small', 100), row('giant', 3_000_000), row('tiny', 50)]);

    // The giant note gets a body of its own — the server will refuse it, but
    // the two small notes still leave in their own body.
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ['small'],
      ['giant'],
      ['tiny'],
    ]);
  });

  it('answers no bodies for an empty queue', () => {
    expect(batchRowsForPush([])).toEqual([]);
  });

  it('counts bytes, not characters — CJK notes do not co-assemble', () => {
    // Two rows of 550,000 CJK characters: 1.1M characters by .length —
    // comfortably inside the 1.5M cap, so the old character-counting
    // packed them into ONE body. On the wire each row is ~1.65 MB of
    // UTF-8 (3 bytes per character), past the cap on its own — and the
    // pair together would be a 3.3 MB body the server rejects outright.
    // Counted in bytes, each row gets a body of its own.
    const cjk = '語'.repeat(550_000);
    const a = { ...row('a', 10), html: cjk };
    const b = { ...row('b', 10), html: cjk };

    const batches = batchRowsForPush([a, b]);

    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([['a'], ['b']]);
  });

  it('splits on row count too — a 600-note queue never builds one 600-row body', () => {
    // The byte-only batcher packed any number of tiny rows into one body:
    // a user with 600 small notes produced one ~60 KB body that the
    // server rejected on ROW COUNT alone (parseNoteRows refuses >500) —
    // and re-assembled the same body on every 30 s cycle forever.
    const many = Array.from({ length: 600 }, (_v, index) => row(`note-${index}`, 50));

    const batches = batchRowsForPush(many);

    // Every batch respects the row cap…
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_ROWS_PER_PUSH);
    }
    // …and the queue drains completely, in order.
    expect(batches.flatMap((batch) => batch.map((entry) => entry.id))).toEqual(
      many.map((entry) => entry.id),
    );
    expect(batches.map((batch) => batch.length)).toEqual([500, 100]);
  });

  it('a full-cap batch closes exactly at the row limit', () => {
    const exact = Array.from({ length: MAX_ROWS_PER_PUSH }, (_v, index) => row(`n${index}`, 10));

    const batches = batchRowsForPush(exact);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(MAX_ROWS_PER_PUSH);
  });
});

// ---------------------------------------------------------------------------
// rowUnsyncable — the rows the server will always refuse, measured the way
// it measures: in UTF-8 bytes (its Content-Length gate) and in UTF-16
// characters (its readJson text.length gate). Such a row is filtered out of
// the push instead of 413-ing every cycle forever and drowning the queue's
// error state.
// ---------------------------------------------------------------------------

describe('rowUnsyncable', () => {
  it('a normal row is syncable', () => {
    expect(rowUnsyncable(row('a', 100_000))).toBe(false);
  });

  it('a row under both caps with margin stays syncable', () => {
    // 1.9 M characters = 1.9 M UTF-8 bytes: near the ceiling, still inside.
    expect(rowUnsyncable(row('a', 1_900_000))).toBe(false);
  });

  it('an ASCII row past the cap can never leave', () => {
    // 2.5 M characters = 2.5 M UTF-8 bytes — past the server's 2 MB cap.
    expect(rowUnsyncable(row('a', 2_500_000))).toBe(true);
  });

  it('a CJK row over the byte cap is caught even though its character count is fine', () => {
    // ~700 K CJK characters are ~2.1 M UTF-8 bytes but only ~700 K
    // characters: character-counting alone would call this syncable and
    // ship a guaranteed 413 — the byte measure is the one that tells the
    // truth. (This is the same trap the batcher's byte-counting fixed.)
    const cjk = { ...row('a', 10), html: '語'.repeat(700_000) };

    expect(rowUnsyncable(cjk)).toBe(true);
  });

  it('an oversized row is still batched by the batcher — the filter is upstream', () => {
    // The two contracts compose: the batcher isolates big rows, the
    // filter removes impossible ones before any body is built.
    const batches = batchRowsForPush([row('giant', 3_000_000), row('small', 10)]);

    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([['giant'], ['small']]);
    expect(rowUnsyncable(batches[0][0])).toBe(true);
    expect(rowUnsyncable(batches[1][0])).toBe(false);
  });
});
