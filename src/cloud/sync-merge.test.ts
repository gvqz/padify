import { describe, expect, it } from 'vitest';
import type { NoteTab, TabsSyncPayload } from '../tabs';
import { mergeRemote, type NoteRow } from './sync';

// The merge decides what survives a sync cycle. These tests pin its
// data-safety contracts: a delete must remove a note, but never bury a
// newer edit; a newer remote edit must land; and the local list must stay
// untouched when nothing actually changed.

const tab = (id: string, overrides: Partial<NoteTab> = {}): NoteTab => ({
  id,
  name: null,
  html: `<p>${id}</p>`,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const row = (id: string, overrides: Partial<NoteRow> = {}): NoteRow => ({
  id,
  user_id: 'user',
  name: null,
  html: `<p>${id}</p>`,
  position: 0,
  created_at: 1_000,
  updated_at: 2_000,
  deleted: false,
  note_type: null,
  ...overrides,
});

const payloadOf = (tabs: NoteTab[]): TabsSyncPayload => ({
  tabs,
  dirty: tabs.map((entry) => entry.id),
  tombstones: [],
});

describe('mergeRemote — deletes', () => {
  it('a remote tombstone removes the local note when nothing newer is here', () => {
    const merge = mergeRemote(
      [row('a', { deleted: true, updated_at: 3_000 })],
      payloadOf([tab('a')]),
    );

    expect(merge.tabs).toEqual([]);
    expect(merge.changed).toBe(true);
  });

  it('a delete may not bury a newer local edit — the note stays and re-pushes', () => {
    // Closed on the phone at t=2000; edited here at t=5000.
    const local = tab('a', { updatedAt: 5_000, html: '<p>the newer edit</p>' });
    const remote = row('a', { deleted: true, updated_at: 2_000 });

    const merge = mergeRemote([remote], payloadOf([local]));

    expect(merge.tabs).toHaveLength(1);
    expect(merge.tabs[0].html).toBe('<p>the newer edit</p>');
    expect(merge.changed).toBe(false); // nothing local changed…
    // …but the cycle's step 3 must see it as newer-than-remote and
    // re-push it (deleted=false): the edit resurrects the note.
    expect(remote.updated_at < merge.tabs[0].updatedAt).toBe(true);
  });

  it('a tie goes to the delete — the common case, no surprise resurrects', () => {
    const merge = mergeRemote(
      [row('a', { deleted: true, updated_at: 2_000 })],
      payloadOf([tab('a', { updatedAt: 2_000 })]),
    );

    expect(merge.tabs).toEqual([]);
  });
});

describe('mergeRemote — edits and arrivals', () => {
  it('a newer remote edit lands locally', () => {
    const merge = mergeRemote(
      [row('a', { updated_at: 9_000, html: '<p>from the cloud</p>' })],
      payloadOf([tab('a')]),
    );

    expect(merge.tabs[0].html).toBe('<p>from the cloud</p>');
    expect(merge.tabs[0].updatedAt).toBe(9_000);
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
