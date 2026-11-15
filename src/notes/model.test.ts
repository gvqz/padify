/**
 * The notes model's invariants — S2 tranche two's pins.
 *
 * Two rules used to be re-implemented by hand at every TabManager mutation
 * site (init's fallback block, the merge's active repair, the close paths'
 * neighbour pick, the switch guard); each was a place the next bug class
 * could grow from. They live in ONE place now, and these tests hold them
 * there: the active pointer always names a live note, and the list never
 * empties after its first seed. The manager's characterization suites
 * (tabs.characterization.test.ts) pin the orchestration AROUND the model;
 * this file pins the model itself, without a DOM.
 */

import { describe, expect, it } from 'vitest';
import { NotesModel, validatedTabFromRow, type ListMutationOutcome } from './model';
import { createTab, type NoteTab } from './domain';
import type { StoredNoteTab } from '../storage';

const tab = (id: string, content = `${id} words`): NoteTab => ({ ...createTab(content), id });

/** A model seeded with three notes; the middle one active (the position
 *  with a neighbour on each side — every policy question is answerable). */
function seededModel(): NotesModel {
  const model = new NotesModel(() => createTab('welcome'));
  const outcome = model.seed([tab('a'), tab('b'), tab('c')], 'b');
  expect(outcome.minted).toBeNull();
  return model;
}

/** Fails when the active id stops naming a live note, or the list empties. */
function expectInvariants(model: NotesModel): void {
  const list = model.all();
  expect(list.length).toBeGreaterThan(0);
  expect(model.activeTabId()).not.toBeNull();
  expect(model.has(model.activeTabId()!)).toBe(true);
}

describe('NotesModel — the seed', () => {
  it('honors the stored active preference when the note survives', () => {
    const model = seededModel();
    expect(model.activeTabId()).toBe('b');
    expect(model.activeTab()!.content).toBe('b words');
  });

  it('falls back to the first row when the stored id is unknown', () => {
    const model = new NotesModel(() => createTab('welcome'));
    model.seed([tab('a'), tab('b')], 'gone');
    expect(model.activeTabId()).toBe('a');
  });

  it('mints the welcome note when storage was empty — and reports it', () => {
    const model = new NotesModel(() => createTab('welcome'));
    const outcome = model.seed([], null);
    expect(outcome.minted).not.toBeNull();
    expect(outcome.minted!.content).toBe('welcome');
    expect(model.all()).toHaveLength(1);
    expect(model.activeTabId()).toBe(outcome.minted!.id);
    expectInvariants(model);
  });

  it('ignores a null preference — never a ghost active id', () => {
    const model = new NotesModel(() => createTab('welcome'));
    model.seed([tab('a')], null);
    expect(model.activeTabId()).toBe('a');
  });
});

describe('NotesModel — setActive (the switch state half)', () => {
  it('moves the pointer and reports it', () => {
    const model = seededModel();
    expect(model.setActive('c')).toBe(true);
    expect(model.activeTabId()).toBe('c');
  });

  it('refuses an unknown id — the pointer cannot be poisoned', () => {
    const model = seededModel();
    expect(model.setActive('ghost')).toBe(false);
    expect(model.activeTabId()).toBe('b');
    expectInvariants(model);
  });

  it('refuses a re-switch to the same note (a no-op, not an event)', () => {
    const model = seededModel();
    expect(model.setActive('b')).toBe(false);
  });
});

describe('NotesModel — append (new tab, background note, restore)', () => {
  it('append with activate puts the note at the end and on the stage', () => {
    const model = seededModel();
    const fresh = tab('fresh');
    model.append(fresh, { activate: true });
    expect(model.all().map((t) => t.id)).toEqual(['a', 'b', 'c', 'fresh']);
    expect(model.activeTabId()).toBe('fresh');
    expectInvariants(model);
  });

  it('append without activate leaves the editor alone — the background path', () => {
    const model = seededModel();
    const restored = tab('restored');
    model.append(restored);
    expect(model.all().map((t) => t.id)).toEqual(['a', 'b', 'c', 'restored']);
    expect(model.activeTabId()).toBe('b');
  });
});

describe('NotesModel — insertAfter (duplicate, conflict copy)', () => {
  it('lands the copy directly beside its source', () => {
    const model = seededModel();
    const copy = tab('copy');
    model.insertAfter('b', copy);
    expect(model.all().map((t) => t.id)).toEqual(['a', 'b', 'copy', 'c']);
  });

  it('falls back to the end on an unknown anchor (defensive — callers hold live ids)', () => {
    const model = seededModel();
    const copy = tab('copy');
    model.insertAfter('ghost', copy);
    expect(model.all().map((t) => t.id)).toEqual(['a', 'b', 'c', 'copy']);
  });

  it('inserting after the last note appends', () => {
    const model = seededModel();
    model.insertAfter('c', tab('tail'));
    expect(model.all().map((t) => t.id)).toEqual(['a', 'b', 'c', 'tail']);
  });
});

describe('NotesModel — remove (the trash flow list half)', () => {
  it('closing the active middle note activates the LEFT neighbour', () => {
    const model = seededModel();
    const outcome = model.remove('b')!;
    expectOutcome(outcome, { removedId: 'b', activeChanged: true });
    expect(model.activeTabId()).toBe('a');
    expect(model.all().map((t) => t.id)).toEqual(['a', 'c']);
    expectInvariants(model);
  });

  it('closing the FIRST note (when active) clamps to the new first', () => {
    const model = seededModel();
    model.setActive('a');
    const outcome = model.remove('a')!;
    expectOutcome(outcome, { removedId: 'a', activeChanged: true });
    expect(model.activeTabId()).toBe('b');
  });

  it('closing a background note never moves the pointer', () => {
    const model = seededModel();
    const outcome = model.remove('a')!; // 'b' is active, 'a' is not
    expect(outcome.activeChanged).toBe(false);
    expect(model.activeTabId()).toBe('b');
    expect(model.all().map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('closing the LAST note keeps the strip non-empty and reports the mint', () => {
    const model = seededModel();
    model.remove('a');
    model.remove('c');
    // The close path's mint is the EMPTY tab — the welcome would be noise
    // after a deliberate delete of the last note.
    const outcome = model.remove('b', () => createTab(''))!;
    expect(outcome.removed!.id).toBe('b');
    expect(outcome.minted).not.toBeNull();
    expect(outcome.activeChanged).toBe(true);
    expect(outcome.minted!.content).toBe('');
    expect(model.all()).toHaveLength(1);
    expect(model.activeTabId()).toBe(outcome.minted!.id);
    expectInvariants(model);
  });

  it('refuses an unknown id', () => {
    const model = seededModel();
    expect(model.remove('ghost')).toBeNull();
    expect(model.all()).toHaveLength(3);
  });

  function expectOutcome(
    outcome: ListMutationOutcome,
    expect_: { removedId: string; activeChanged: boolean },
  ): void {
    expect(outcome.removed!.id).toBe(expect_.removedId);
    expect(outcome.activeChanged).toBe(expect_.activeChanged);
    expect(outcome.minted).toBeNull();
  }
});

describe('NotesModel — replaceAll (the merge swap)', () => {
  it('keeps the active pointer when the note survived the merge (new bytes, same id)', () => {
    const model = seededModel();
    const outcome = model.replaceAll([tab('a'), tab('b', 'merged words'), tab('c')]);
    expect(outcome.activeChanged).toBe(false);
    expect(outcome.minted).toBeNull();
    expect(model.activeTabId()).toBe('b');
    expect(model.activeTab()!.content).toBe('merged words');
    expectInvariants(model);
  });

  it('falls to the first survivor when the active note merged away', () => {
    const model = seededModel();
    const outcome = model.replaceAll([tab('x'), tab('c')]);
    expect(outcome.activeChanged).toBe(true);
    expect(model.activeTabId()).toBe('x');
  });

  it('mints the welcome back when the merge empties the world', () => {
    const model = seededModel();
    const outcome = model.replaceAll([]);
    expect(outcome.activeChanged).toBe(true);
    expect(outcome.minted).not.toBeNull();
    expect(outcome.minted!.content).toBe('welcome');
    expect(model.all()).toHaveLength(1);
    expectInvariants(model);
  });
});

describe('NotesModel — the active event', () => {
  it('fires the registered listeners with the current active tab, on demand', () => {
    const model = seededModel();
    const seen: string[] = [];
    const off = model.addActiveListener((t) => seen.push(t.id));

    // The TIMING is the orchestrator's: pointer moves are silent until the
    // emit — the manager paints the editor between the two, by contract.
    model.setActive('a');
    expect(seen).toEqual([]);
    model.emitActiveChanged();
    expect(seen).toEqual(['a']);

    model.setActive('c');
    model.emitActiveChanged();
    expect(seen).toEqual(['a', 'c']);

    off();
    model.setActive('b');
    model.emitActiveChanged();
    expect(seen).toEqual(['a', 'c']);
  });
});

describe('validatedTabFromRow — the seed-side validation', () => {
  const row = (overrides: Partial<StoredNoteTab> = {}): StoredNoteTab => ({
    id: 'r1',
    name: null,
    content: '<b>words</b>',
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  });

  it('carries the sane row through, html sanitized', () => {
    const out = validatedTabFromRow(row({ content: '<b>ok</b><script>bad()</script>' }));
    expect(out).toMatchObject({ id: 'r1', name: null, createdAt: 10, updatedAt: 20 });
    expect(out.content).toBe('<b>ok</b>');
  });

  it('coerces every field a corrupt or foreign row could break', () => {
    const out = validatedTabFromRow({
      id: 'r1',
      name: 42 as unknown as string,
      content: undefined as unknown as string,
      createdAt: 'x' as unknown as number,
      updatedAt: 'y' as unknown as number,
      noteType: 42 as unknown as string,
      colorTheme: 'blue' as unknown as 'light' | 'dark',
      copyOf: '',
    });
    expect(out.name).toBeNull();
    expect(out.content).toBe('');
    expect(typeof out.createdAt).toBe('number');
    expect(typeof out.updatedAt).toBe('number');
    // normalizeNoteType: garbage falls back to the default (undefined —
    // the record's "absent means standard" spelling).
    expect(out.noteType).toBeUndefined();
    expect(out.colorTheme).toBeUndefined();
    expect(out.copyOf).toBeUndefined();
  });

  it('keeps a well-formed UNKNOWN kind verbatim — schema-light by design', () => {
    // A newer build's note type must survive this build's boot untouched
    // (the server contract's same rule): an opaque kind degrades to the
    // read-only card, never to a rewrite of its bytes.
    const out = validatedTabFromRow(row({ noteType: 'made-up-kind', content: '{"raw":1}' }));
    expect(out.noteType).toBe('made-up-kind');
    expect(out.content).toBe('{"raw":1}');
  });

  it('never sanitizes a non-html kind — the bytes cross verbatim', () => {
    const out = validatedTabFromRow(row({ noteType: 'text', content: '# <script>heading' }));
    expect(out.content).toBe('# <script>heading');
  });
});
