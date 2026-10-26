import { describe, expect, it } from 'vitest';
import type { NoteTab, TabsSyncPayload } from '../tabs';
import { WELCOME_HTML } from '../editor/note-content';
import { mergeRemote, type NoteRow } from './sync';

// The merge decides what survives a sync cycle. These tests pin its
// data-safety contracts: a delete must remove a note, but never bury a
// newer edit; a newer remote edit must land; and the local list must stay
// untouched when nothing actually changed.

const tab = (id: string, overrides: Partial<NoteTab> = {}): NoteTab => ({
  id,
  name: null,
  content: `<p>${id}</p>`,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const row = (id: string, overrides: Partial<NoteRow> = {}): NoteRow => ({
  id,
  user_id: 'user',
  name: null,
  content: `<p>${id}</p>`,
  position: 0,
  created_at: 1_000,
  updated_at: 2_000,
  deleted: false,
  note_type: null,
  ...overrides,
});

const payloadOf = (
  tabs: NoteTab[],
  dirty: string[] = tabs.map((entry) => entry.id),
): TabsSyncPayload => ({
  tabs,
  dirty,
  tombstones: [],
});

describe('mergeRemote — deletes', () => {
  it('a remote tombstone removes the local note when nothing newer is here', () => {
    const merge = mergeRemote(
      [row('a', { deleted: true, updated_at: 3_000 })],
      payloadOf([tab('a')], []), // clean: the local copy never changed
    );

    expect(merge.tabs).toEqual([]);
    expect(merge.changed).toBe(true);
    expect(merge.conflicts).toEqual([]);
  });

  it('a delete may not bury a newer local edit — the note stays and re-pushes', () => {
    // Closed on the phone at t=2000; edited here at t=5000.
    const local = tab('a', { updatedAt: 5_000, content: '<p>the newer edit</p>' });
    const remote = row('a', { deleted: true, updated_at: 2_000 });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>the newer edit</p>');
    expect(merge.changed).toBe(false); // nothing local changed…
    // …but the cycle's step 3 must see it as newer-than-remote and
    // re-push it (deleted=false): the edit resurrects the note.
    expect(remote.updated_at < merge.tabs[0].updatedAt).toBe(true);
  });

  it('a tie goes to the delete — the common case, no surprise resurrects', () => {
    const merge = mergeRemote(
      [row('a', { deleted: true, updated_at: 2_000 })],
      payloadOf([tab('a', { updatedAt: 2_000 })], []),
    );

    expect(merge.tabs).toEqual([]);
  });
});

describe('mergeRemote — edits and arrivals', () => {
  it('a newer remote edit lands locally', () => {
    const merge = mergeRemote(
      [row('a', { updated_at: 9_000, content: '<p>from the cloud</p>' })],
      payloadOf([tab('a')]),
    );

    expect(merge.tabs[0].content).toBe('<p>from the cloud</p>');
    expect(merge.tabs[0].updatedAt).toBe(9_000);
    expect(merge.changed).toBe(true);
  });

  it('a row from a pre-rename server (html key only) still merges', () => {
    // The rename transition: rows built before the rename carry the note
    // under `html` and nothing else; the merge must read either key.
    const legacy = {
      ...row('a', { updated_at: 9_000 }),
      content: undefined,
      html: '<p>old wire</p>',
    } as NoteRow;
    const merge = mergeRemote([legacy], payloadOf([tab('a')]));

    expect(merge.tabs[0].content).toBe('<p>old wire</p>');
    expect(merge.changed).toBe(true);
  });

  it('a remote-only note joins the strip, ordered by its stored position', () => {
    const merge = mergeRemote(
      [row('b', { position: 0 }), row('c', { position: 1 })],
      payloadOf([tab('a')]),
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('an unchanged world reports changed: false', () => {
    const merge = mergeRemote([row('a')], payloadOf([tab('a')]));

    expect(merge.changed).toBe(false);
    expect(merge.tabs).toHaveLength(1);
  });
});

describe('mergeRemote — ordering convergence', () => {
  const payloadOf = (tabs: NoteTab[], dirty: string[] = []): TabsSyncPayload => ({
    tabs,
    dirty,
    tombstones: [],
  });

  it('a clean device adopts the remote ordering', () => {
    // The cloud says [b, a]; this device holds [a, b] with nothing pending.
    const merge = mergeRemote(
      [row('b', { position: 0 }), row('a', { position: 1 })],
      payloadOf([tab('a'), tab('b')]),
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(merge.changed).toBe(true);
  });

  it('a device with pending notes keeps its own order', () => {
    const merge = mergeRemote(
      [row('b', { position: 0 }), row('a', { position: 1 })],
      payloadOf([tab('a'), tab('b')], ['a']), // a is dirty — an edit is in flight
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(merge.changed).toBe(false);
  });

  it('notes the cloud never saw sort to the end, keeping their relative order', () => {
    const merge = mergeRemote(
      [row('b', { position: 0 }), row('a', { position: 1 })],
      payloadOf([tab('local-2'), tab('a'), tab('local-1'), tab('b')]),
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['b', 'a', 'local-2', 'local-1']);
  });
});

// ---------------------------------------------------------------------------
// Sync v2 — the seq ordering. The server's sequence decides; client clocks
// only arbitrate rows that never carried one.
// ---------------------------------------------------------------------------

describe('mergeRemote — v2 seq ordering', () => {
  it('a higher seq beats a lying local clock (the skew fix)', () => {
    // The local clock is 40 minutes fast; the local row still carries the
    // seq of the version it edited FROM. The remote edit is later in
    // server order — it wins. Under the clock rule the fast device would
    // win every time, which is the bug v2 exists to fix.
    const local = tab('a', {
      updatedAt: 9_000_000,
      syncSeq: 7,
      content: '<p>stale local</p>',
    });
    const remote = row('a', {
      updated_at: 5_000,
      seq: 9,
      content: '<p>the real newer edit</p>',
    });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs[0].content).toBe('<p>the real newer edit</p>');
    expect(merge.tabs[0].syncSeq).toBe(9);
  });

  it('an equal seq with differing content keeps the local row (no churn)', () => {
    const local = tab('a', { syncSeq: 4, content: '<p>mine</p>' });
    const remote = row('a', { seq: 4, content: '<p>theirs</p>' });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs[0].content).toBe('<p>mine</p>');
    expect(merge.changed).toBe(false);
  });

  it('a local row without a seq adopts an identical remote row wholesale', () => {
    // The rollout path: a pre-upgrade install's rows have no seq. An
    // identical remote row is adopted — the seq gained, no visible change.
    const local = tab('a', { content: '<p>same words</p>' });
    const remote = row('a', { seq: 12, content: '<p>same words</p>' });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs[0].content).toBe('<p>same words</p>');
    expect(merge.tabs[0].syncSeq).toBe(12);
  });

  it('a delete loses to a newer local edit by seq, not by clock', () => {
    // Closed on the other device — its clock stamps the tombstone HUGE
    // (skewed); the local edit is older by clock but later in server
    // order (the row it edited from was already seq 7 when the delete was
    // only seq 3). The edit survives and step 3 resurrects the note.
    const local = tab('a', {
      updatedAt: 100,
      syncSeq: 7,
      content: '<p>the newer edit</p>',
    });
    const remote = row('a', { deleted: true, updated_at: 9_000_000, seq: 3 });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>the newer edit</p>');
    expect(merge.changed).toBe(false);
  });

  it('an equal-seq delete still loses to a later local edit (the v1 guard)', () => {
    // The delete replaced the very version this row edited from (equal
    // seq) — an unpushed edit that never saw the delete. The clock
    // arbitrates as in v1: the later edit survives.
    const local = tab('a', {
      updatedAt: 12_000,
      syncSeq: 3,
      content: '<p>edited after</p>',
    });
    const remote = row('a', { deleted: true, updated_at: 9_000, seq: 3 });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>edited after</p>');
  });

  it('the order array drives convergence with unchanged rows included', () => {
    const local = [tab('a', { syncSeq: 1 }), tab('b', { syncSeq: 2 })];
    // A clean device (nothing dirty): the order array alone reorders —
    // unchanged rows are not in the changed set, their place still rules.
    const merge = mergeRemote(
      [],
      { tabs: local, dirty: [], tombstones: [] },
      { order: ['b', 'a'] },
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(merge.changed).toBe(true);
  });

  it('v1 rows without a seq keep the clock rules exactly', () => {
    const local = tab('a', { updatedAt: 2_000, content: '<p>old local</p>' });
    const remote = row('a', { updated_at: 3_000, content: '<p>newer remote</p>' });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs[0].content).toBe('<p>newer remote</p>');
  });
});

// ---------------------------------------------------------------------------
// Conflict preservation — the contract that nothing is silently discarded.
// A version about to be overwritten (or buried) that the cloud never
// confirmed becomes a conflicted copy: a fresh tab that rides the next
// push, so both versions exist on every device.
// ---------------------------------------------------------------------------

describe('mergeRemote — conflict preservation', () => {
  it('a dirty local losing an edit race keeps its words as a copy', () => {
    // The two-device story: this device edited offline (dirty, never
    // pushed); the other device pushed first. The remote takes the note;
    // the local words take a copy.
    const local = tab('a', {
      name: 'Groceries',
      syncSeq: 5,
      updatedAt: 4_000,
      content: '<p>milk and eggs</p>',
    });
    const remote = row('a', {
      seq: 9,
      updated_at: 9_000,
      content: '<p>flour and sugar</p>',
    });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    // The canonical note holds the remote version.
    expect(merge.tabs[0]).toMatchObject({
      id: 'a',
      content: '<p>flour and sugar</p>',
      syncSeq: 9,
    });
    // The losing words survive as a fresh tab.
    expect(merge.tabs).toHaveLength(2);
    const copy = merge.tabs[1];
    expect(copy.id).not.toBe('a');
    expect(copy.content).toBe('<p>milk and eggs</p>');
    expect(copy.name).toBe('Groceries — conflicted copy');
    expect(copy.syncSeq).toBeUndefined(); // brand new: nothing synced yet
    expect(merge.changed).toBe(true);
    expect(merge.conflicts).toHaveLength(1);
    expect(merge.conflicts[0]).toContain('Groceries — conflicted copy');
    expect(merge.conflicts[0]).toContain('both versions');
  });

  it('a clean local losing an edit race is overwritten with no copy', () => {
    // Nothing was lost: the local content is the version the cloud
    // already holds. The copy would be noise.
    const local = tab('a', { syncSeq: 5, content: '<p>already pushed</p>' });
    const remote = row('a', { seq: 9, updated_at: 9_000, content: '<p>newer</p>' });

    const merge = mergeRemote([remote], payloadOf([local], []));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>newer</p>');
    expect(merge.conflicts).toEqual([]);
  });

  it('the copy preserves the note type exactly', () => {
    const local = tab('a', { noteType: 'markdown', content: '# kept', updatedAt: 4_000 });
    const remote = row('a', { updated_at: 9_000, content: '# winner' });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    expect(merge.tabs[1]).toMatchObject({ noteType: 'markdown', content: '# kept' });
  });

  it('a dirty local losing to a tombstone keeps its words, loses the note', () => {
    // Deleted on the phone while this device held unpushed edits: the
    // delete still takes the note (the strip removes it), but the
    // unconfirmed words leave as a copy instead of dying with the tab.
    const local = tab('a', {
      name: 'Draft',
      updatedAt: 5_000,
      content: '<p>the unsynced edit</p>',
    });
    const remote = row('a', { deleted: true, updated_at: 9_000 });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].id).not.toBe('a');
    expect(merge.tabs[0].content).toBe('<p>the unsynced edit</p>');
    expect(merge.tabs[0].name).toBe('Draft — copy (deleted elsewhere)');
    expect(merge.conflicts[0]).toContain('deleted on another device');
  });

  it('a blank dirty local losing to a tombstone leaves no copy', () => {
    // Tag-stripped emptiness does not deserve a rescue.
    const local = tab('a', { updatedAt: 5_000, content: '<p></p>' });
    const remote = row('a', { deleted: true, updated_at: 9_000 });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    expect(merge.tabs).toEqual([]);
    expect(merge.conflicts).toEqual([]);
  });

  it('the read-max race\u2019s equal-seq twin heals: clean local defers, copy keeps its words', () => {
    // Two different versions stamped with the same seq by the old racy
    // base read. A clean local is one of the twins: the remote takes the
    // canonical row, the local twin\u2019s words leave a copy. Both survive.
    const local = tab('a', { syncSeq: 4, content: '<p>mine</p>' });
    const remote = row('a', { seq: 4, content: '<p>theirs</p>' });

    const merge = mergeRemote([remote], payloadOf([local], []));

    expect(merge.tabs).toHaveLength(2);
    expect(merge.tabs[0].content).toBe('<p>theirs</p>');
    expect(merge.tabs[1].content).toBe('<p>mine</p>');
    expect(merge.conflicts).toHaveLength(1);
  });

  it('an equal-seq twin against a dirty local keeps the local, no copy', () => {
    // The dirty local edited FROM that version — it is the newer branch:
    // it keeps the note and the cycle re-pushes it.
    const local = tab('a', { syncSeq: 4, updatedAt: 12_000, content: '<p>mine, edited</p>' });
    const remote = row('a', { seq: 4, updated_at: 2_000, content: '<p>theirs</p>' });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>mine, edited</p>');
    expect(merge.conflicts).toEqual([]);
  });

  it('both devices dirty: the loser keeps a copy, the winner takes the note', () => {
    // D2 pushed first (seq 9); D1 pulls it while holding its own unsynced
    // edit from seq 5. One copy, both versions alive.
    const local = tab('a', { syncSeq: 5, updatedAt: 4_000, content: '<p>device one words</p>' });
    const remote = row('a', { seq: 9, updated_at: 9_000, content: '<p>device two words</p>' });

    const merge = mergeRemote([remote], payloadOf([local], ['a']));

    expect(merge.tabs.map((entry) => entry.content)).toEqual([
      '<p>device two words</p>',
      '<p>device one words</p>',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multiplication — one conflicted copy per note per device, ever. The old
// merge minted a fresh copy on EVERY losing cycle, so a note edited while
// two devices held it open accumulated a strip full of near-identical
// "X — conflicted copy" tabs, one per 30-second sync. The copy is now the
// note's unmerged BRANCH: the first mint creates it, later losses update
// its words in place, and a copy that loses its own race chains back to
// the base note's lineage instead of nesting names.
// ---------------------------------------------------------------------------

describe('mergeRemote — conflict multiplication guard', () => {
  it('a repeated edit race updates the existing copy in place, not a second copy', () => {
    // Cycle 1: the dirty local loses to D2's push. A copy is minted.
    const first = mergeRemote(
      [row('a', { seq: 9, updated_at: 9_000, content: '<p>v2 from device two</p>' })],
      payloadOf(
        [
          tab('a', {
            name: 'Plan',
            syncSeq: 5,
            updatedAt: 4_000,
            content: '<p>my words</p>',
          }),
        ],
        ['a'],
      ),
    );
    expect(first.tabs).toHaveLength(2);
    const copy = first.tabs[1];
    expect(copy.name).toBe('Plan — conflicted copy');

    // Cycle 2: the canonical took the remote words in cycle 1, but the
    // user's editor kept the local branch alive and kept typing (the
    // focused-editor capture), so the local is dirty again with evolved
    // words while D2 pushed ANOTHER version. The old merge minted a SECOND
    // copy here — and a third on the next cycle, and so on. The branch is
    // updated in place instead.
    const second = mergeRemote(
      [row('a', { seq: 11, updated_at: 11_000, content: '<p>v3 from device two</p>' })],
      payloadOf(
        [
          tab('a', {
            name: 'Plan',
            syncSeq: 9,
            updatedAt: 10_000,
            content: '<p>my words, still typing</p>',
          }),
          ...first.tabs.filter((entry) => entry.id !== 'a'),
        ],
        ['a'],
      ),
    );

    expect(second.tabs).toHaveLength(2); // not 3 — no second copy
    const updatedCopy = second.tabs.find((entry) => entry.id === copy.id);
    expect(updatedCopy?.content).toBe('<p>my words, still typing</p>');
    expect(second.conflicts).toEqual([]); // silent: the branch just moved
  });

  it('an identical repeated race is a no-op — the branch does not churn', () => {
    const first = mergeRemote(
      [row('a', { seq: 9, updated_at: 9_000, content: '<p>remote</p>' })],
      payloadOf([tab('a', { syncSeq: 5, updatedAt: 4_000, content: '<p>mine</p>' })], ['a']),
    );
    const copy = first.tabs[1];

    // Same losing words again (the capture raced the persist): the copy's
    // content and updatedAt must not move, or every cycle re-pushes it.
    const second = mergeRemote(
      [row('a', { seq: 9, updated_at: 9_000, content: '<p>remote</p>' })],
      payloadOf(
        [tab('a', { syncSeq: 9, updatedAt: 4_000, content: '<p>remote</p>' }), copy],
        ['a'],
      ),
    );

    const after = second.tabs.find((entry) => entry.id === copy.id);
    expect(after?.updatedAt).toBe(copy.updatedAt);
    expect(second.conflicts).toEqual([]);
  });

  it('the read-max twin arriving twice mints one copy, then updates it', () => {
    // The pre-fix server could stamp two different versions with the same
    // seq; the pull can redeliver the row when the cursor never advanced
    // past it (a crash between merge and cursor store, or a seq-0 row —
    // those are re-delivered unconditionally).
    const local = tab('a', { syncSeq: 4, content: '<p>mine</p>' });
    const first = mergeRemote(
      [row('a', { seq: 4, content: '<p>theirs</p>' })],
      payloadOf([local], []),
    );
    expect(first.tabs).toHaveLength(2);
    const copy = first.tabs[1];
    expect(copy.content).toBe('<p>mine</p>');

    // The row is redelivered with a DIFFERENT same-seq twin (the other
    // racing write finally observed): the canonical moves again, the copy
    // — not a second one — takes the local twin's words.
    const second = mergeRemote(
      [row('a', { seq: 4, content: '<p>the third version</p>' })],
      payloadOf([tab('a', { syncSeq: 4, content: '<p>theirs</p>' }), copy], []),
    );

    expect(second.tabs).toHaveLength(2);
    expect(second.tabs.find((entry) => entry.id === 'a')?.content).toBe('<p>the third version</p>');
    expect(second.tabs.find((entry) => entry.id === copy.id)?.content).toBe('<p>theirs</p>');
  });

  it('a copy losing its own race chains to the base lineage, never a nested name', () => {
    // The copy itself was edited here (dirty) and lost to a remote edit of
    // its own row. The mint names after the BASE note and reuses the same
    // lineage — the losing tab drops its branch marker (it now carries the
    // winner's content for its own row).
    const base = tab('a', { name: 'Recipe', content: '<p>base</p>' });
    const copy = tab('branch', {
      name: 'Recipe — conflicted copy',
      copyOf: 'a',
      content: '<p>branch words</p>',
    });
    const remote = row('branch', { seq: 20, updated_at: 9_000, content: '<p>winner</p>' });

    const merge = mergeRemote([remote], payloadOf([base, copy], ['branch']));

    // The losing copy takes the winner's content and stops being a branch…
    const loser = merge.tabs.find((entry) => entry.id === 'branch');
    expect(loser?.content).toBe('<p>winner</p>');
    expect(loser?.copyOf).toBeUndefined();
    // …and the losing words joined the base's existing lineage tab, or
    // minted one named after the BASE — never "— conflicted copy — conflicted copy".
    const rescued = merge.tabs.find((entry) => entry.content === '<p>branch words</p>');
    expect(rescued).toBeDefined();
    expect(rescued?.name).not.toContain('conflicted copy — conflicted copy');
    expect(rescued?.name).toContain('Recipe');
  });

  it('a copyOf tab whose content matches the loser does not mint at all', () => {
    // The words are already preserved verbatim in the branch tab: a
    // second copy would be a pure duplicate.
    const base = tab('a', { name: 'Plan', syncSeq: 5, content: '<p>the words</p>' });
    const branch = tab('branch', {
      copyOf: 'a',
      name: 'Plan — conflicted copy',
      content: '<p>the words</p>',
    });
    const remote = row('a', { seq: 9, updated_at: 9_000, content: '<p>remote words</p>' });

    const merge = mergeRemote([remote], payloadOf([base, branch], ['a']));

    expect(merge.tabs).toHaveLength(2);
    expect(merge.tabs.find((entry) => entry.id === 'branch')?.content).toBe('<p>the words</p>');
    expect(merge.conflicts).toEqual([]);
  });
});

describe('mergeRemote — own echoes', () => {
  // The push response never says which seq the server stamped, so the
  // next pull delivers the device's OWN write back with a fresh seq.
  // Without echo recognition that echo outranked the typing that followed
  // it — every burst that crossed a sync cycle minted a conflicted copy
  // of words the same device had written seconds earlier.

  it('the echo of our own push never outranks typing that followed it', () => {
    // The tab synced at seq 5, the device pushed '<p>typed more</p>' at
    // t=3_000, and the user kept typing (dirty, t=4_000). The pull hands
    // the pushed row back stamped seq 6.
    const local = tab('a', {
      syncSeq: 5,
      updatedAt: 4_000,
      content: '<p>typed even more</p>',
    });
    const echo = row('a', {
      seq: 6,
      updated_at: 3_000,
      content: '<p>typed more</p>',
    });

    const merge = mergeRemote([echo], payloadOf([local]), {
      ownEchoes: new Map([['a', { content: '<p>typed more</p>', updatedAt: 3_000 }]]),
    });

    // The typist's words stay in the note — no revert, no rescue copy.
    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].content).toBe('<p>typed even more</p>');
    expect(merge.tabs[0].updatedAt).toBe(4_000);
    expect(merge.conflicts).toEqual([]);
    // The lineage advances: the tab is now based on the version at seq 6,
    // so the NEXT echo arbitrates against a meaningful number.
    expect(merge.tabs[0].syncSeq).toBe(6);
    expect(merge.changed).toBe(true);
  });

  it('an echo whose content matches adopts cleanly and stamps the seq', () => {
    // Typing paused before the pull: the pulled row is byte-identical to
    // what was pushed. Adoption — the seq gained, nothing else moved.
    const local = tab('a', {
      syncSeq: 5,
      updatedAt: 3_000,
      content: '<p>paused words</p>',
    });
    const echo = row('a', {
      seq: 6,
      updated_at: 3_000,
      content: '<p>paused words</p>',
    });

    const merge = mergeRemote([echo], payloadOf([local], []), {
      ownEchoes: new Map([['a', { content: '<p>paused words</p>', updatedAt: 3_000 }]]),
    });

    expect(merge.tabs[0].content).toBe('<p>paused words</p>');
    expect(merge.tabs[0].syncSeq).toBe(6);
    expect(merge.conflicts).toEqual([]);
  });

  it('an echo still stamps the seq on a tab that never had one', () => {
    // The rollout path: a locally-created note pushed before any pull
    // gave it a seq. The echo is its first sight of its own row.
    const local = tab('a', {
      updatedAt: 5_000,
      content: '<p>kept typing</p>',
    });
    const echo = row('a', {
      seq: 6,
      updated_at: 3_000,
      content: '<p>pushed words</p>',
    });

    const merge = mergeRemote([echo], payloadOf([local]), {
      ownEchoes: new Map([['a', { content: '<p>pushed words</p>', updatedAt: 3_000 }]]),
    });

    expect(merge.tabs[0].content).toBe('<p>kept typing</p>');
    expect(merge.tabs[0].syncSeq).toBe(6);
    expect(merge.conflicts).toEqual([]);
  });

  it('another device\u2019s write still outranks dirty typing \u2014 both versions kept', () => {
    // Same local state as the first test, but the row is NOT this
    // device's push: no echo fingerprint matches. A genuine diverge —
    // the copy must be minted.
    const local = tab('a', {
      syncSeq: 5,
      updatedAt: 4_000,
      content: '<p>typed even more</p>',
    });
    const remote = row('a', {
      seq: 6,
      updated_at: 3_500,
      content: '<p>from the other device</p>',
    });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.conflicts).toHaveLength(1);
    const survivor = merge.tabs.find((entry) => entry.id === 'a');
    expect(survivor?.content).toBe('<p>from the other device</p>');
    const copy = merge.tabs.find((entry) => entry.id !== 'a');
    expect(copy?.content).toBe('<p>typed even more</p>');
  });

  it('a row an echo does not recognize arbitrates as before', () => {
    // The fingerprint covers (content, updated_at): another device's row
    // with different bytes or a different stamp never masquerades as ours.
    const local = tab('a', { syncSeq: 5, updatedAt: 4_000, content: '<p>typed</p>' });
    const echo = row('a', {
      seq: 6,
      updated_at: 3_000,
      content: '<p>typed more</p>',
    });

    // The map's fingerprint disagrees on content — not our echo.
    const merge = mergeRemote([echo], payloadOf([local]), {
      ownEchoes: new Map([['a', { content: '<p>something else</p>', updatedAt: 3_000 }]]),
    });

    // The clean-ish arbitration: seq 6 beats syncSeq 5, the local is
    // dirty, so both versions are kept.
    expect(merge.conflicts).toHaveLength(1);
    expect(merge.tabs.find((entry) => entry.id === 'a')?.content).toBe('<p>typed more</p>');
  });
});

describe('mergeRemote — the untouched welcome seed', () => {
  // Every fresh browser boots with the welcome note as its only tab.
  // Signing in from that browser used to upload it, so a populated
  // account gained a byte-identical "Welcome!" twin per device — each
  // twin its own note id, which broke note-id-keyed behavior (the share
  // panel's one-active-link-per-note match, for one). The merge now
  // drops the pristine seed when the pull proves the account is alive.
  const seed = (id: string): NoteTab => tab(id, { content: WELCOME_HTML });
  const otherNote = row('real', { content: '<p>years of real notes</p>' });

  it('a pristine seed is dropped when the pull delivers a live account', () => {
    const merge = mergeRemote([otherNote], payloadOf([seed('fresh-boot')]));

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['real']);
    expect(merge.droppedSeedIds).toEqual(['fresh-boot']);
    expect(merge.changed).toBe(true);
  });

  it('the seed survives an account with only tombstones — nothing live to trust yet', () => {
    // A wiped-everywhere account must still adopt its first device's
    // seed: the pull delivering no live rows means the seed is the only
    // copy of the note that exists.
    const merge = mergeRemote(
      [row('gone', { deleted: true, updated_at: 3_000 })],
      payloadOf([seed('fresh-boot')]),
    );

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['fresh-boot']);
    expect(merge.droppedSeedIds).toEqual([]);
    expect(merge.changed).toBe(false);
  });

  it("the seed survives when the pull delivered it — it is the account's own note", () => {
    // The first device uploaded its seed; on the next cycle the seed
    // comes back as a row. Same id: the normal matched path, not a twin.
    const mine = row('fresh-boot', { content: WELCOME_HTML });

    const merge = mergeRemote([mine, otherNote], payloadOf([seed('fresh-boot')], []));

    expect(merge.tabs.map((entry) => entry.id)).toContain('fresh-boot');
    expect(merge.droppedSeedIds).toEqual([]);
  });

  it('an edited seed is a real note and always stays', () => {
    const edited = tab('fresh-boot', {
      content: `${WELCOME_HTML}\n\nmy own additions now`,
    });

    const merge = mergeRemote([otherNote], payloadOf([edited]));

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['fresh-boot', 'real']);
    expect(merge.droppedSeedIds).toEqual([]);
  });

  it('a renamed seed is a real note and always stays', () => {
    const renamed = tab('fresh-boot', { content: WELCOME_HTML, name: 'Readme' });

    const merge = mergeRemote([otherNote], payloadOf([renamed]));

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['fresh-boot', 'real']);
    expect(merge.droppedSeedIds).toEqual([]);
  });

  it('a seed switched to another note type is a real note and always stays', () => {
    const switched = tab('fresh-boot', { content: WELCOME_HTML, noteType: 'markdown' });

    const merge = mergeRemote([otherNote], payloadOf([switched]));

    expect(merge.tabs.map((entry) => entry.id)).toEqual(['fresh-boot', 'real']);
    expect(merge.droppedSeedIds).toEqual([]);
  });
});
