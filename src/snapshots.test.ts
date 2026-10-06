import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOTS,
  deriveSnapshotPreview,
  deriveSnapshotTitle,
  findLatestForNote,
  formatSnapshotTimestamp,
  isSameSnapshotState,
  pruneSnapshots,
  snapshotHasContent,
  snapshotSearchText,
  snapshotTypeBadgeLabel,
} from './snapshots';

/**
 * Two contracts live here:
 *
 *  • the snapshot CAP, pinned against a raw database with the manager's
 *    exact schema (keyPath id, autoIncrement, timestamp index): the store
 *    keeps its NEWEST entries and retires the oldest ones past the cap.
 *
 *  • the rebuild's decision layer — the pure helpers that make snapshots
 *    behave the same across note types: what counts as content, what
 *    counts as a duplicate, what a row is searched by, and how titles and
 *    previews are derived per kind. The manager's DOM wiring is not under
 *    test; e2e/snapshots.spec.ts drives the whole menu instead.
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
});

describe('findLatestForNote — the dedupe scope', () => {
  const rows = [
    {
      id: 1,
      noteId: 'tab-a',
      title: 'older',
      content: 'v1',
      preview: 'v1',
      timestamp: 100,
      formattedDate: '',
    },
    {
      id: 2,
      noteId: 'tab-b',
      title: 'other note',
      content: 'x',
      preview: 'x',
      timestamp: 150,
      formattedDate: '',
    },
    {
      id: 3,
      noteId: 'tab-a',
      title: 'newer',
      content: 'v2',
      preview: 'v2',
      timestamp: 200,
      formattedDate: '',
    },
  ];

  it('finds the newest snapshot of the note regardless of input order', () => {
    expect(findLatestForNote(rows, 'tab-a')?.title).toBe('newer');
    expect(findLatestForNote([...rows].reverse(), 'tab-a')?.title).toBe('newer');
    expect(findLatestForNote(rows, 'tab-b')?.title).toBe('other note');
  });

  it('a note with no snapshots yet answers undefined', () => {
    expect(findLatestForNote(rows, 'tab-c')).toBeUndefined();
  });

  it('legacy records (no noteId) never satisfy an attributed note', () => {
    const legacy = [
      {
        id: 9,
        title: 'from the old build',
        content: 'same bytes',
        preview: '',
        timestamp: 50,
        formattedDate: 'old',
      },
    ];
    expect(findLatestForNote(legacy, 'tab-a')).toBeUndefined();
    expect(findLatestForNote(legacy, undefined)).toBe(legacy[0]);
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

  it('non-html kinds title from their type label, not a guess at the bytes', () => {
    expect(deriveSnapshotTitle('# not a title', 'markdown')).toBe('Markdown note');
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
