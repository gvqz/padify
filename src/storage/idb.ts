/**
 * Padify storage — IndexedDB backend (low-level).
 *
 * The app owns a small database:
 *
 *   padify v2
 *     notes → { id, name, html, createdAt, updatedAt, position, deleted }
 *             keyPath 'id', index 'position'
 *     kv    → { key, value }   (localStorage-shaped string values)
 *     attachments → { id, name, mime, size, createdAt, uploaded, blob }
 *             keyPath 'id' — the blob store (voice notes and future
 *             media); deliberately NOT mirrored to localStorage, which
 *             cannot hold blobs. See storage/attachments.ts for the
 *             high-level API and its degradation rules.
 *
 * The notes record shape intentionally mirrors the cloud rows in
 * server/schema.sql (camelCase here, snake_case there) so the sync layer can
 * keep copying whole records between the two stores without adapters, and
 * deletions are tombstoned rows (deleted=true) exactly like on the server.
 *
 * Everything here is deliberately low-level: open, upgrade, and
 * promise-wrapped transactions. The higher-level semantics — the in-memory
 * mirror, the localStorage fallback, the legacy migration, the compatibility
 * write-through — live in the sibling modules (kv.ts, notes.ts, attachments.ts,
 * index.ts).
 */

export const DB_NAME = 'padify';
export const DB_VERSION = 2;
export const NOTES_STORE = 'notes';
export const KV_STORE = 'kv';
export const ATTACHMENTS_STORE = 'attachments';

/**
 * Which backend is actually serving reads/writes.
 *
 *  • 'indexeddb'     — the padify database opened fine; it is the source of
 *                      truth and localStorage is only a compatibility mirror.
 *  • 'local-storage' — IndexedDB is unavailable/blocked; the layer degrades
 *                      to localStorage with exactly the pre-migration
 *                      behaviour. Consumers never notice the difference.
 */
export type StorageBackend = 'indexeddb' | 'local-storage';

let db: IDBDatabase | null = null;
let backend: StorageBackend = 'local-storage';

/** The backend the storage layer is currently operating on. */
export function storageBackend(): StorageBackend {
  return backend;
}

/**
 * Opens (and upgrades) the padify database. Never rejects: on any failure it
 * resolves with 'local-storage' so callers can fall back instead of dying.
 */
export function openDatabase(): Promise<StorageBackend> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve('local-storage');
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Some hardened browsers throw synchronously on access.
      resolve('local-storage');
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(NOTES_STORE)) {
        const notes = database.createObjectStore(NOTES_STORE, { keyPath: 'id' });
        notes.createIndex('position', 'position', { unique: false });
      }
      if (!database.objectStoreNames.contains(KV_STORE)) {
        database.createObjectStore(KV_STORE, { keyPath: 'key' });
      }
      // v2 — the blob store. Fresh installs and upgrades share this path.
      if (!database.objectStoreNames.contains(ATTACHMENTS_STORE)) {
        database.createObjectStore(ATTACHMENTS_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      backend = 'indexeddb';

      // A future version of the app may upgrade the schema from another tab;
      // rather than operate on a stale connection, release it and degrade to
      // the fallback for the rest of this page's life.
      db.onversionchange = () => {
        db?.close();
        db = null;
        backend = 'local-storage';
      };

      resolve(backend);
    };

    request.onerror = () => resolve('local-storage');

    request.onblocked = () => {
      // Another tab holds an older connection open. Resolve with the
      // fallback; if the open eventually succeeds anyway that is harmless
      // (the promise has already settled).
      resolve('local-storage');
    };
  });
}

/** Wraps an IDBRequest into a promise. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves when the transaction commits; rejects when it aborts. */
export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Reads every row of a store. Resolves with [] outside IndexedDB mode. */
export function readAll<T>(storeName: string): Promise<T[]> {
  if (!db || backend !== 'indexeddb') {
    return Promise.resolve([]);
  }
  try {
    const transaction = db.transaction(storeName, 'readonly');
    return requestToPromise<T[]>(transaction.objectStore(storeName).getAll() as IDBRequest<T[]>);
  } catch {
    return Promise.resolve([]);
  }
}

/**
 * Reads ONE row by its key — a point lookup, not a scan. The blob store's
 * records carry whole ArrayBuffers, so readAll() here would deserialize
 * every attachment's bytes just to find one; this is the O(1) door for
 * get-by-id callers. Resolves with null outside IndexedDB mode.
 */
export function readOne<T>(storeName: string, key: string): Promise<T | null> {
  if (!db || backend !== 'indexeddb') {
    return Promise.resolve(null);
  }
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>;
    return requestToPromise<T | undefined>(request).then((row) => row ?? null);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Applies puts + deletes in ONE readwrite transaction, so a save is atomic.
 * Rejects only when the transaction actually aborts (quota, corruption);
 * resolves as a no-op outside IndexedDB mode.
 */
export function writeAll(storeName: string, puts: unknown[], deletes: string[]): Promise<void> {
  if (!db || backend !== 'indexeddb') {
    return Promise.resolve();
  }
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    puts.forEach((record) => {
      store.put(record);
    });
    deletes.forEach((key) => {
      store.delete(key);
    });
    return transactionDone(transaction);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Test hook — closes the connection and resets module state. */
export function resetBackendForTests(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  backend = 'local-storage';
}
