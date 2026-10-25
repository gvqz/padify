import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOTS,
  deriveSnapshotPreview,
  deriveSnapshotTitle,
  formatSnapshotClock,
  formatSnapshotDayLabel,
  formatSnapshotTimestamp,
  groupSnapshotsByType,
  isCurrentSnapshotState,
  isSameSnapshotState,
  openSnapshotsDatabase,
  pruneSnapshots,
  readSnapshotsForNote,
  snapshotChangeBadge,
  snapshotDayGroups,
  snapshotDayKey,
  snapshotHasContent,
  snapshotReadableText,
  snapshotSearchText,
  snapshotTypeBadgeLabel,
} from './snapshots';

/**
 * Three contracts live here:
 *
 *  • the STORE — the schema (openSnapshotsDatabase owns the version and
 *    the upgrade path, including pre-attribution databases), the cap
 *    (pruneSnapshots) and the per-note read (readSnapshotsForNote), all
 *    pinned against raw databases with fake-indexeddb.
 *
 *  • the decision layer — the pure helpers that make snapshots behave
 *    the same across note types: what counts as content, what counts as
 *    a duplicate, how the menu groups rows by type, and how titles,
 *    previews and search text are derived per kind.
 *
 *  • the manager's DOM wiring is not under test; e2e/snapshots.spec.ts
 *    drives the whole menu instead.
 */

const DB_NAME = 'padify-snapshots-cap-test';
const STORE = 'snapshots';

let db: IDBDatabase;

function openSnapshotsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function addSnapshot(timestamp: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE], 'readwrite');
    const request = transaction.objectStore(STORE).add({
      title: `snap-${timestamp}`,
      content: 'x',
      preview: 'x',
      timestamp,
      formattedDate: String(timestamp),
    });
    request.onsuccess = () => resolve(request.result as number);
    transaction.onabort = () => reject(transaction.error);
  });
}

function allTimestamps(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE], 'readonly');
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () =>
      resolve((request.result as { timestamp: number }[]).map((row) => row.timestamp));
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  db = await openSnapshotsDb();
});

afterEach(async () => {
  db.close();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe('pruneSnapshots — the capped history', () => {
  it('retires the OLDEST entries beyond the cap, keeps the newest', async () => {
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
      await addSnapshot(1000 + i); // ascending = later
    }

    const pruned = await pruneSnapshots(db, STORE);

    expect(pruned).toBe(5);
    const remaining = await allTimestamps();
    expect(remaining.length).toBe(MAX_SNAPSHOTS);
    // The first five (oldest) timestamps are gone; the newest MAX stay.
    expect(remaining).not.toContain(1000);
    expect(remaining).not.toContain(1004);
    expect(remaining).toContain(1005);
    expect(remaining).toContain(1000 + MAX_SNAPSHOTS + 4);
  });

  it('a store under the cap is untouched', async () => {
    for (let i = 0; i < 3; i++) {
      await addSnapshot(2000 + i);
    }

    const pruned = await pruneSnapshots(db, STORE);

    expect(pruned).toBe(0);
    expect((await allTimestamps()).length).toBe(3);
  });

  it('an empty store resolves 0 without touching anything', async () => {
    expect(await pruneSnapshots(db, STORE)).toBe(0);
  });

  it('prunes repeatedly under a smaller cap (the manager can tighten it)', async () => {
    for (let i = 0; i < 8; i++) {
      await addSnapshot(3000 + i);
    }
    expect(await pruneSnapshots(db, STORE, 5)).toBe(3);
    expect((await allTimestamps()).length).toBe(5);
    // Idempotent at the cap.
    expect(await pruneSnapshots(db, STORE, 5)).toBe(0);
  });
});

describe('openSnapshotsDatabase — the schema owner', () => {
  const UPGRADE_DB = 'padify-snapshots-upgrade-test';

  /** The version-1 schema the original build shipped: store + timestamp
   *  index, NO noteId index — what a long-lived install still holds. */
  function openLegacyDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(UPGRADE_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function put(db: IDBDatabase, value: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE], 'readwrite');
      transaction.objectStore(STORE).add(value);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(UPGRADE_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it('a fresh open creates the store with both indexes', async () => {
    const db = await openSnapshotsDatabase(UPGRADE_DB, STORE);
    const store = db.transaction([STORE], 'readonly').objectStore(STORE);
    expect(store.indexNames.contains('timestamp')).toBe(true);
    expect(store.indexNames.contains('noteId')).toBe(true);
    db.close();
  });

  it('a version-1 store upgrades in place — rows survive, the noteId index appears', async () => {
    const legacy = await openLegacyDatabase();
    await put(legacy, {
      noteId: 'tab-1',
      title: 'attributed',
      content: 'a',
      preview: 'a',
      timestamp: 1,
      formattedDate: '',
    });
    await put(legacy, {
      title: 'legacy row',
      content: 'b',
      preview: 'b',
      timestamp: 2,
      formattedDate: '',
    });
    legacy.close();

    const db = await openSnapshotsDatabase(UPGRADE_DB, STORE);
    const store = db.transaction([STORE], 'readonly').objectStore(STORE);
    expect(store.indexNames.contains('noteId')).toBe(true);

    // The pre-upgrade rows are intact — upgrading never touches data.
    const allRows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction([STORE], 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(allRows).toHaveLength(2);
    // The per-note read sees the attributed row and only it — the legacy
    // row was never this note's.
    const rows = await readSnapshotsForNote(db, STORE, 'tab-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('attributed');
    db.close();
  });
});

describe('readSnapshotsForNote — the per-note read', () => {
  const READ_DB = 'padify-snapshots-read-test';
  let db: IDBDatabase;

  function add(value: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE], 'readwrite');
      transaction.objectStore(STORE).add(value);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }

  beforeEach(async () => {
    db = await openSnapshotsDatabase(READ_DB, STORE);
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(READ_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it("returns only the note's rows, newest first", async () => {
    await add({
      noteId: 'tab-a',
      title: 'older',
      content: 'x',
      preview: 'x',
      timestamp: 100,
      formattedDate: '',
    });
    await add({
      noteId: 'tab-b',
      title: 'other',
      content: 'x',
      preview: 'x',
      timestamp: 150,
      formattedDate: '',
    });
    await add({
      noteId: 'tab-a',
      title: 'newer',
      content: 'y',
      preview: 'y',
      timestamp: 200,
      formattedDate: '',
    });

    const rows = await readSnapshotsForNote(db, STORE, 'tab-a');
    expect(rows.map((entry) => entry.timestamp)).toEqual([200, 100]);
  });

  it('a note with no snapshots answers an empty list, never other notes', async () => {
    await add({
      noteId: 'tab-b',
      title: 'other',
      content: 'x',
      preview: 'x',
      timestamp: 150,
      formattedDate: '',
    });
    expect(await readSnapshotsForNote(db, STORE, 'tab-none')).toEqual([]);
  });

  it('legacy rows (no noteId) are invisible to the per-note read', async () => {
    await add({ title: 'legacy', content: 'x', preview: 'x', timestamp: 100, formattedDate: '' });
    expect(await readSnapshotsForNote(db, STORE, 'tab-a')).toEqual([]);
  });
});

describe('snapshotHasContent — emptiness per note kind', () => {
  it('html notes count their text', () => {
    expect(snapshotHasContent('<div>hello</div>')).toBe(true);
    expect(snapshotHasContent('plain words')).toBe(true);
  });

  it('markup without words is empty — the storage subset holds words and formatting only', () => {
    // No <img> can ever be stored (the renderer's chips policy), so
    // formatting-only markup is the emptiest an html note can be.
    expect(snapshotHasContent('')).toBe(false);
    expect(snapshotHasContent('<br>')).toBe(false);
    expect(snapshotHasContent('<div></div>')).toBe(false);
    expect(snapshotHasContent('<div><b></b><u></u></div>')).toBe(false);
  });

  it('text kinds judge their raw bytes', () => {
    expect(snapshotHasContent('# Heading\n\ntext', 'markdown')).toBe(true);
    expect(snapshotHasContent('   ', 'markdown')).toBe(false);
    expect(snapshotHasContent('', 'markdown')).toBe(false);
    expect(snapshotHasContent('{"board":[]}', 'some-future-json-type')).toBe(true);
  });

  it('drawings judge their ELEMENTS — an undone-away scene is empty', () => {
    // A scene's JSON bytes are never empty; its meaning is its elements.
    // A stroke drawn then undone leaves an empty scene — nothing a
    // safety copy adds.
    expect(snapshotHasContent('{"version":1,"elements":[],"appState":{}}', 'drawing')).toBe(false);
    expect(snapshotHasContent('', 'drawing')).toBe(false);
    expect(
      snapshotHasContent(
        '{"version":1,"elements":[{"id":"a","type":"rectangle"}],"appState":{}}',
        'drawing',
      ),
    ).toBe(true);
    // The undo ghost trail is not content either.
    expect(
      snapshotHasContent(
        '{"version":1,"elements":[{"id":"g","type":"rectangle","isDeleted":true}],"appState":{}}',
        'drawing',
      ),
    ).toBe(false);
  });

  it('unparseable drawing bytes stay real content — the safety copy is the point', () => {
    // A newer build's scene: this build refuses to edit it but keeps the
    // bytes; a snapshot of exactly those bytes is what safety means.
    expect(snapshotHasContent('{"version":9,"elements":[/* opaque */]}', 'drawing')).toBe(true);
    expect(snapshotHasContent('junk bytes', 'drawing')).toBe(true);
  });

  it('task lists judge their rows — an emptied list is empty', () => {
    expect(snapshotHasContent('{"version":1,"color":"default","tasks":[]}', 'tasks')).toBe(false);
    expect(snapshotHasContent('', 'tasks')).toBe(false);
    expect(
      snapshotHasContent(
        '{"version":1,"color":"default","tasks":[{"id":"t1","title":"one thing","done":false,"sortOrder":0}]}',
        'tasks',
      ),
    ).toBe(true);
  });
});

describe('isSameSnapshotState — duplicate detection', () => {
  it('content and type must both match', () => {
    expect(
      isSameSnapshotState(
        { content: 'a', noteType: undefined },
        { content: 'a', noteType: undefined },
      ),
    ).toBe(true);
    expect(
      isSameSnapshotState(
        { content: 'a', noteType: 'markdown' },
        { content: 'a', noteType: 'markdown' },
      ),
    ).toBe(true);
    expect(
      isSameSnapshotState(
        { content: 'a', noteType: undefined },
        { content: 'b', noteType: undefined },
      ),
    ).toBe(false);
    // Same bytes, different kinds: restoring either is a different act.
    expect(
      isSameSnapshotState(
        { content: 'a', noteType: undefined },
        { content: 'a', noteType: 'markdown' },
      ),
    ).toBe(false);
  });

  it("normalizes the type — 'standard' and absent are the same note", () => {
    // The capture paths hand 'standard' and undefined around depending on
    // where the note came from; the duplicate check must not file the
    // same bytes twice over a spelling difference. Same rule as the
    // Current chip (isCurrentSnapshotState).
    expect(isSameSnapshotState({ content: 'a', noteType: 'standard' }, { content: 'a' })).toBe(
      true,
    );
    expect(isSameSnapshotState({ content: 'a' }, { content: 'a', noteType: 'standard' })).toBe(
      true,
    );
  });

  it('drawings compare CONTENT, not bytes — savedAt never makes a new version', () => {
    // The scene envelope re-stamps savedAt on every save. The undo loop
    // (draw → snapshot → undo → redo → snapshot) used to file the same
    // drawing twice, because the second save's bytes differed by the
    // stamp alone. Identity canonicalizes through the scene module.
    const scene = (savedAt: number) =>
      JSON.stringify({
        version: 1,
        savedAt,
        elements: [
          { id: 'a', type: 'rectangle' },
          { id: 'b', type: 'text', text: 'architecture sketch' },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
      });
    expect(
      isSameSnapshotState(
        { content: scene(1700000000000), noteType: 'drawing' },
        { content: scene(1790000000000), noteType: 'drawing' },
      ),
    ).toBe(true);
    // A real change — one more element — is a new version.
    const bigger = JSON.stringify({
      version: 1,
      savedAt: 1790000000000,
      elements: [
        { id: 'a', type: 'rectangle' },
        { id: 'b', type: 'text', text: 'architecture sketch' },
        { id: 'c', type: 'ellipse' },
      ],
      appState: { viewBackgroundColor: '#ffffff' },
    });
    expect(
      isSameSnapshotState(
        { content: scene(1700000000000), noteType: 'drawing' },
        {
          content: bigger,
          noteType: 'drawing',
        },
      ),
    ).toBe(false);
  });

  it('the undo ghost trail never counts — deleted elements are not content', () => {
    const withGhost = JSON.stringify({
      version: 1,
      savedAt: 1700000000000,
      elements: [
        { id: 'a', type: 'rectangle' },
        { id: 'ghost', type: 'ellipse', isDeleted: true },
      ],
      appState: {},
    });
    const withoutGhost = JSON.stringify({
      version: 1,
      savedAt: 1790000000000,
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: {},
    });
    expect(
      isSameSnapshotState(
        { content: withGhost, noteType: 'drawing' },
        { content: withoutGhost, noteType: 'drawing' },
      ),
    ).toBe(true);
  });

  it('unparseable drawing bytes stay opaque — only byte-equal junk matches', () => {
    expect(
      isSameSnapshotState(
        { content: 'not json at all', noteType: 'drawing' },
        { content: 'not json at all', noteType: 'drawing' },
      ),
    ).toBe(true);
    expect(
      isSameSnapshotState(
        { content: 'not json at all', noteType: 'drawing' },
        { content: 'other junk', noteType: 'drawing' },
      ),
    ).toBe(false);
  });
});

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 1,
    noteId: 'tab-a',
    title: 'a row',
    content: 'x',
    preview: 'x',
    timestamp: 100,
    formattedDate: '',
    ...overrides,
  }) as Parameters<typeof groupSnapshotsByType>[0][number];

describe('groupSnapshotsByType — the menu\u2019s sections', () => {
  it('sections follow the registry order, recency be damned', () => {
    // A markdown snapshot NEWER than every plain one must not float its
    // section above Notes — the menu\u2019s shape is the sort the user asked
    // for, and it stays stable between visits.
    const sections = groupSnapshotsByType([
      row({ id: 1, noteType: undefined, timestamp: 100 }),
      row({ id: 2, noteType: 'markdown', timestamp: 300 }),
      row({ id: 3, noteType: undefined, timestamp: 200 }),
    ]);
    expect(sections.map((section) => section.key)).toEqual(['standard', 'markdown']);
    expect(sections[0].label).toBe('Notes');
    expect(sections[0].rows).toHaveLength(2);
    expect(sections[1].label).toBe('Markdown');
    expect(sections[1].rows).toHaveLength(1);
  });

  it('rows inside a section are newest first', () => {
    const sections = groupSnapshotsByType([
      row({ id: 1, timestamp: 100 }),
      row({ id: 2, timestamp: 300 }),
      row({ id: 3, timestamp: 200 }),
    ]);
    expect(sections[0].rows.map((entry) => entry.id)).toEqual([2, 3, 1]);
  });

  it('a timestamp tie breaks by id — the later write leads', () => {
    // Legacy stores could land two captures in one millisecond; the
    // higher store id is the later write and must not sort below its twin.
    const sections = groupSnapshotsByType([
      row({ id: 1, timestamp: 500 }),
      row({ id: 2, timestamp: 500 }),
    ]);
    expect(sections[0].rows.map((entry) => entry.id)).toEqual([2, 1]);
  });

  it('legacy rows, junk ids and explicit standard all read as Notes', () => {
    const sections = groupSnapshotsByType([
      row({ id: 1, noteType: undefined }),
      row({ id: 2, noteType: 'standard' }),
      row({ id: 3, noteType: 'not a real id!' }),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('standard');
    expect(sections[0].rows).toHaveLength(3);
  });

  it('unknown future types trail the known ones, alphabetically', () => {
    const sections = groupSnapshotsByType([
      row({ id: 1, noteType: 'zeta' }),
      row({ id: 2, noteType: undefined }),
      row({ id: 3, noteType: 'alpha' }),
    ]);
    expect(sections.map((section) => section.key)).toEqual(['standard', 'alpha', 'zeta']);
    // Unknown ids fall back to the registry\u2019s label rule: the id itself.
    expect(sections[1].label).toBe('alpha');
  });

  it('every kind gets its section label and icon', () => {
    const sections = groupSnapshotsByType([
      row({ id: 1, noteType: 'drawing' }),
      row({ id: 2, noteType: 'tasks' }),
      row({ id: 3, noteType: 'rich' }),
    ]);
    const byKey = Object.fromEntries(sections.map((section) => [section.key, section.label]));
    expect(byKey).toMatchObject({
      rich: 'Rich Text',
      tasks: 'Task Lists',
      drawing: 'Drawings',
    });
    for (const section of sections) {
      expect(section.icon).toContain('<svg');
    }
  });
});

describe('snapshotSearchText — what a row answers to', () => {
  const row = (overrides: Partial<Parameters<typeof snapshotSearchText>[0]> = {}) =>
    ({
      id: 1,
      noteId: 'tab-a',
      title: 'Grocery list',
      content: '<div>milk &amp; eggs</div>',
      noteType: undefined,
      preview: 'milk & eggs',
      timestamp: 100,
      formattedDate: '',
      ...overrides,
    }) as Parameters<typeof snapshotSearchText>[0];

  it('matches the copy the row shows — title, preview, badge label, full text', () => {
    expect(snapshotSearchText(row())).toContain('grocery list');
    expect(snapshotSearchText(row())).toContain('milk & eggs');
    expect(snapshotSearchText(row({ noteType: 'markdown' }))).toContain('markdown');
  });

  it('html rows search the note\u2019s FULL text, not just the 100-char preview', () => {
    const long = row({
      title: 'Welcome! Padify',
      preview: 'Welcome! Padify is an offline…',
      content: `<div>Welcome! Padify</div><div>a grocery run deep in the note</div>`,
    });
    expect(snapshotSearchText(long)).toContain('grocery run');
  });

  it('html markup is NOT searched — asking for tags must not answer', () => {
    expect(snapshotSearchText(row())).not.toContain('<div>');
    expect(snapshotSearchText(row())).not.toContain('div');
  });

  it('text kinds search their raw source — the bytes are the text', () => {
    const markdown = row({
      noteType: 'markdown',
      title: 'Notes',
      content: 'a **bold** statement deep in the source',
      preview: 'a **bold** statement…',
    });
    expect(snapshotSearchText(markdown)).toContain('deep in the source');
  });

  it('matching is case-insensitive', () => {
    expect(snapshotSearchText(row({ title: 'GROCERY' })).includes('grocery')).toBe(true);
  });

  it('the source note\u2019s NAME answers the search', () => {
    expect(snapshotSearchText(row({ noteName: 'Groceries' }))).toContain('groceries');
  });

  it('deep text past the search cap is not cached — 2000 characters deep is enough', () => {
    // The cache holds one search string per row in memory; the readable
    // projection is capped so a giant note does not become a giant
    // lowercase copy of itself.
    const deep = `x`.repeat(2500) + 'needle deep in the note';
    expect(snapshotSearchText(row({ content: deep })).includes('needle')).toBe(false);
    // …while anything within the cap is fair game.
    const near = `${'x'.repeat(1000)}needle closer to the top`;
    expect(snapshotSearchText(row({ content: near })).includes('needle')).toBe(true);
  });
});

describe('snapshotTypeBadgeLabel — the row chip', () => {
  it('known non-default types use the short chip spelling', () => {
    expect(snapshotTypeBadgeLabel('markdown')).toBe('Markdown');
    expect(snapshotTypeBadgeLabel('rich')).toBe('Rich Text');
  });

  it('unknown future types fall back to the registry label', () => {
    expect(snapshotTypeBadgeLabel('board')).toBe('board');
  });
});

describe('deriveSnapshotTitle / deriveSnapshotPreview — per-kind copy', () => {
  it('html titles come from the first meaningful line', () => {
    expect(deriveSnapshotTitle('<div>first</div><div>second</div>')).toBe('first');
    expect(deriveSnapshotTitle('<div></div><br>after a blank')).toBe('after a blank');
  });

  it('long titles cap at 50 characters', () => {
    const long = 'x'.repeat(80);
    const title = deriveSnapshotTitle(`<div>${long}</div>`);
    expect(title.length).toBe(50);
    expect(title.endsWith('...')).toBe(true);
  });

  it('non-html kinds title from their readable first line — a section of type labels is a section of twins', () => {
    // Markdown: the source is the text; the leading hashes render away.
    expect(deriveSnapshotTitle('# Trail log', 'markdown')).toBe('Trail log');
    expect(deriveSnapshotTitle('## deep heading', 'markdown')).toBe('deep heading');
    expect(deriveSnapshotTitle('plain first line\nsecond', 'markdown')).toBe('plain first line');
    // Task lists: the checkbox is chrome, not the task's name.
    expect(
      deriveSnapshotTitle(
        JSON.stringify({
          version: 1,
          color: 'default',
          tasks: [{ id: 't1', title: 'call the dentist', done: false, sortOrder: 0 }],
        }),
        'tasks',
      ),
    ).toBe('call the dentist');
    // Drawings: a text element is the drawing's name; a shapes-only
    // scene answers its element count; an empty scene falls back to the
    // type's label.
    expect(
      deriveSnapshotTitle(
        JSON.stringify({
          version: 1,
          elements: [
            { id: 'a', type: 'text', text: 'architecture sketch' },
            { id: 'b', type: 'rectangle' },
          ],
          appState: {},
        }),
        'drawing',
      ),
    ).toBe('architecture sketch');
    expect(
      deriveSnapshotTitle(
        JSON.stringify({ version: 1, elements: [{ id: 'a' }, { id: 'b' }], appState: {} }),
        'drawing',
      ),
    ).toBe('Drawing — 2 elements');
    expect(deriveSnapshotTitle('{"version":1,"elements":[],"appState":{}}', 'drawing')).toBe(
      'Drawing',
    );
  });

  it('a kind whose projection is only syntax falls back to its type label', () => {
    // '- [ ]' alone grooms to nothing — the label names the row.
    expect(
      deriveSnapshotTitle(JSON.stringify({ version: 1, color: 'default', tasks: [] }), 'tasks'),
    ).toBe('Task list');
  });

  it('empty notes fall back to the untitled default', () => {
    expect(deriveSnapshotTitle('')).toBe('Untitled Snapshot');
  });

  it('html previews read as rendered text', () => {
    expect(deriveSnapshotPreview('<div>milk &amp; eggs</div>')).toBe('milk & eggs');
  });

  it('previews cap at 100 characters', () => {
    const preview = deriveSnapshotPreview(`<div>${'y'.repeat(150)}</div>`);
    expect(preview.length).toBe(100);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('markdown previews its raw source; empties say so', () => {
    expect(deriveSnapshotPreview('# Heading', 'markdown')).toBe('# Heading');
    expect(deriveSnapshotPreview('')).toBe('No content');
  });
});

describe('formatSnapshotTimestamp — dates at render time', () => {
  it('renders a non-empty, digit-bearing string for any timestamp', () => {
    const text = formatSnapshotTimestamp(1696598400000);
    expect(text.length).toBeGreaterThan(4);
    expect(text).toMatch(/\d/);
  });

  it('is derived from the timestamp — the same moment renders the same twice', () => {
    const ts = 1696598400000;
    expect(formatSnapshotTimestamp(ts)).toBe(formatSnapshotTimestamp(ts));
  });
});

describe('the timeline helpers — day groups, clocks, readable text', () => {
  // A fixed 'now' (2026-10-25T12:00:00 local) so Today/Yesterday and
  // the year-rollover cases are deterministic.
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
  const sameDay = (hoursAgo: number) => now - hoursAgo * 60 * 60 * 1000;

  it('day keys are local calendar days — midnight splits, hours do not', () => {
    const morning = new Date(2026, 9, 25, 9, 30).getTime();
    const night = new Date(2026, 9, 25, 23, 45).getTime();
    const nextDay = new Date(2026, 9, 26, 0, 5).getTime();
    expect(snapshotDayKey(morning)).toBe(snapshotDayKey(night));
    expect(snapshotDayKey(morning)).not.toBe(snapshotDayKey(nextDay));
  });

  it('labels Today, Yesterday, and calendar dates', () => {
    expect(formatSnapshotDayLabel(sameDay(3), now)).toBe('Today');
    expect(formatSnapshotDayLabel(sameDay(20), now)).toBe('Yesterday');
    // Two days back in the same year: month name and day, no year.
    expect(formatSnapshotDayLabel(new Date(2026, 9, 23, 10, 0).getTime(), now)).toBe('October 23');
  });

  it('appends the year once the date leaves the current one', () => {
    expect(formatSnapshotDayLabel(new Date(2024, 11, 31, 10, 0).getTime(), now)).toBe(
      'December 31, 2024',
    );
  });

  it('the clock is a short time string with digits', () => {
    const clock = formatSnapshotClock(now);
    expect(clock).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('day groups are suppressed when every row is from today', () => {
    // Five of-today rows under a 'TODAY' bar is a stutter — the section
    // header plus the clocks already say it.
    const todayRows = [sameDay(1), sameDay(2), sameDay(3)].map((timestamp, i) =>
      row({ id: i + 1, timestamp }),
    );
    expect(snapshotDayGroups(todayRows, now)).toEqual([]);
  });

  it('day groups return the moment a section spans beyond today', () => {
    const rows = [
      row({ id: 1, timestamp: sameDay(1) }),
      row({ id: 2, timestamp: sameDay(20) }), // yesterday
    ];
    const groups = snapshotDayGroups(rows, now);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].rows).toHaveLength(1);
  });

  it('a section of only-yesterday rows keeps its day label', () => {
    // Not today — the label is real information, not a stutter.
    const rows = [row({ id: 1, timestamp: sameDay(20) }), row({ id: 2, timestamp: sameDay(21) })];
    const groups = snapshotDayGroups(rows, now);
    expect(groups.map((group) => group.label)).toEqual(['Yesterday']);
    expect(groups[0].rows).toHaveLength(2);
  });

  it('empty rows answer no groups', () => {
    expect(snapshotDayGroups([], now)).toEqual([]);
  });
});

describe('snapshotChangeBadge — the version\u2019s diffstat', () => {
  it('text kinds count words — signed, pluralized', () => {
    expect(snapshotChangeBadge({ content: 'one two three four' }, { content: 'one two' })).toEqual({
      delta: 2,
      unit: 'words',
    });
    expect(snapshotChangeBadge({ content: 'one' }, { content: 'one two three' })).toEqual({
      delta: -2,
      unit: 'words',
    });
    // A rewording that keeps the count is an honest zero, not a pass.
    expect(
      snapshotChangeBadge({ content: 'swap the words' }, { content: 'the words swap' }),
    ).toEqual({ delta: 0, unit: 'words' });
    // Singular when the magnitude is one.
    expect(snapshotChangeBadge({ content: 'one two' }, { content: 'one' })).toEqual({
      delta: 1,
      unit: 'word',
    });
  });

  it('html kinds count the words of their text projection', () => {
    expect(
      snapshotChangeBadge(
        { content: '<div>alpha beta gamma</div>', noteType: 'rich' },
        { content: '<div>alpha</div>', noteType: 'rich' },
      ),
    ).toEqual({ delta: 2, unit: 'words' });
  });

  it('task lists count tasks', () => {
    const list = (n: number) =>
      JSON.stringify({
        version: 1,
        color: 'default',
        tasks: Array.from({ length: n }, (_, i) => ({
          id: `t${i}`,
          title: `task ${i}`,
          done: false,
          sortOrder: i,
        })),
      });
    expect(
      snapshotChangeBadge(
        { content: list(3), noteType: 'tasks' },
        { content: list(5), noteType: 'tasks' },
      ),
    ).toEqual({
      delta: -2,
      unit: 'tasks',
    });
  });

  it('drawings count shapes, ghosts and all', () => {
    const scene = (elements: unknown[]) =>
      JSON.stringify({ version: 1, savedAt: 0, elements, appState: {} });
    expect(
      snapshotChangeBadge(
        { content: scene([{ id: 'a' }, { id: 'b', isDeleted: true }]), noteType: 'drawing' },
        { content: scene([{ id: 'a' }]), noteType: 'drawing' },
      ),
    ).toEqual({ delta: 0, unit: 'shapes' });
    expect(
      snapshotChangeBadge(
        { content: scene([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), noteType: 'drawing' },
        { content: scene([{ id: 'a' }]), noteType: 'drawing' },
      ),
    ).toEqual({ delta: 2, unit: 'shapes' });
  });

  it('the baseline — a note\u2019s first snapshot — carries no badge', () => {
    expect(snapshotChangeBadge({ content: 'anything' }, null)).toBeNull();
  });
});

describe('snapshotReadableText — per-kind projections', () => {
  it('html kinds read their rendered text', () => {
    expect(snapshotReadableText('<div>milk &amp; eggs</div>')).toBe('milk & eggs');
  });

  it('markdown and unknown kinds are their raw bytes', () => {
    expect(snapshotReadableText('# Heading', 'markdown')).toBe('# Heading');
    expect(snapshotReadableText('opaque bytes', 'future-kind')).toBe('opaque bytes');
  });

  it('drawings read their text elements, not their JSON', () => {
    const scene = JSON.stringify({
      version: 1,
      elements: [{ id: 'a', type: 'text', text: 'grocery list' }],
      appState: {},
    });
    expect(snapshotReadableText(scene, 'drawing')).toBe('grocery list');
    // A shapes-only scene answers the element count, never raw braces.
    const shapes = JSON.stringify({
      version: 1,
      elements: [
        { id: 'a', type: 'rectangle' },
        { id: 'b', type: 'ellipse' },
      ],
      appState: {},
    });
    expect(snapshotReadableText(shapes, 'drawing')).toBe('Drawing — 2 elements');
    // An empty scene is empty, not '{}'.
    expect(snapshotReadableText('{"version":1,"elements":[],"appState":{}}', 'drawing')).toBe('');
  });

  it('task lists read their rows', () => {
    const list = JSON.stringify({
      version: 1,
      color: 'blue',
      tasks: [{ id: 't1', title: 'call the dentist', done: false, sortOrder: 0 }],
    });
    const text = snapshotReadableText(list, 'tasks');
    expect(text).toContain('call the dentist');
    expect(text).not.toContain('"tasks"');
  });
});

describe('isCurrentSnapshotState — the Current chip', () => {
  it('matches on identical bytes and a normalized type', () => {
    expect(
      isCurrentSnapshotState({ content: 'abc' }, { content: 'abc', noteType: 'standard' }),
    ).toBe(true);
    expect(
      isCurrentSnapshotState(
        { content: 'abc', noteType: 'markdown' },
        {
          content: 'abc',
          noteType: 'markdown',
        },
      ),
    ).toBe(true);
  });

  it('differs on bytes or on kind', () => {
    expect(isCurrentSnapshotState({ content: 'abc' }, { content: 'abcd' })).toBe(false);
    expect(
      isCurrentSnapshotState({ content: 'abc', noteType: 'markdown' }, { content: 'abc' }),
    ).toBe(false);
  });

  it('no active note answers false', () => {
    expect(isCurrentSnapshotState({ content: 'abc' }, null)).toBe(false);
  });

  it('a drawing row wears the chip across a savedAt re-stamp', () => {
    // The note's bytes carry the stamp of their last save; the snapshot's
    // carry the stamp of ITS capture. Same drawing, different stamps —
    // the chip must still say Current (same rule as duplicate detection).
    const scene = (savedAt: number) =>
      JSON.stringify({
        version: 1,
        savedAt,
        elements: [{ id: 'a', type: 'text', text: 'architecture sketch' }],
        appState: {},
      });
    expect(
      isCurrentSnapshotState(
        { content: scene(1700000000000), noteType: 'drawing' },
        { content: scene(1790000000000), noteType: 'drawing' },
      ),
    ).toBe(true);
  });
});
