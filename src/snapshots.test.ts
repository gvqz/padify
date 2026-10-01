import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SNAPSHOTS, pruneSnapshots } from './snapshots';

/**
 * The snapshot cap, pinned against a raw database with the manager's
 * exact schema (keyPath id, autoIncrement, timestamp index): the store
 * keeps its NEWEST entries and retires the oldest ones past the cap.
 * The manager's DOM wiring is irrelevant to that contract.
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
