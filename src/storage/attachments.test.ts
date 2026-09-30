import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetStorageForTests, storageReady } from './index';
import {
  clearAttachments,
  deleteAttachment,
  getAttachmentBlob,
  getAttachmentMeta,
  listAttachmentMetas,
  listPendingAttachments,
  markAttachmentUploaded,
  newAttachmentId,
  putAttachment,
} from './attachments';

/**
 * The client blob store, pinned: offline-first writes, the pending/
 * uploaded lifecycle, and the degradation rule (no IndexedDB → the
 * module reports nothing instead of crashing). Blobs are real Blobs in
 * the dedicated IDB store and never touch localStorage.
 */

function blob(text: string, type = 'audio/webm'): Blob {
  return new Blob([text], { type });
}

async function textOf(b: Blob): Promise<string> {
  return b.text();
}

describe('newAttachmentId', () => {
  it("issues unique ids the server's shape accepts", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newAttachmentId();
      expect(id).toMatch(/^att-[a-f0-9]{24}$/);
      expect(id.length).toBeLessThanOrEqual(64);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});

describe('the attachment store (IndexedDB)', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
    await clearAttachments(); // the fake DB persists within a file
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('stores a blob offline-first as pending upload, and hands it back', async () => {
    const id = newAttachmentId();
    const stored = await putAttachment(
      { id, name: 'voice-note.webm', mime: 'audio/webm', size: 0 },
      blob('hello-bytes'),
    );
    expect(stored).toBe(true);

    const back = await getAttachmentBlob(id);
    expect(back).not.toBeNull();
    expect(await textOf(back!)).toBe('hello-bytes');
    expect(back!.type).toBe('audio/webm');

    const meta = await getAttachmentMeta(id);
    expect(meta).toMatchObject({
      id,
      name: 'voice-note.webm',
      mime: 'audio/webm',
      uploaded: 0,
    });
    expect(meta!.size).toBeGreaterThan(0); // the record carries the blob's size
  });

  it('lists metas newest-first without blobs, pending until marked', async () => {
    const first = newAttachmentId();
    const second = newAttachmentId();
    await putAttachment({ id: first, name: 'a', mime: 'audio/webm', size: 1 }, blob('a'));
    // createdAt is Date.now() — separate the two writes by a tick so
    // "newest first" is observable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await putAttachment({ id: second, name: 'b', mime: 'audio/ogg', size: 1 }, blob('b'));

    let metas = await listAttachmentMetas();
    expect(metas.map((m) => m.name)).toEqual(['b', 'a']); // newest first
    expect(JSON.stringify(metas)).not.toContain('bytes');

    expect((await listPendingAttachments()).length).toBe(2);
    await markAttachmentUploaded(first);
    metas = await listAttachmentMetas();
    expect(metas.find((m) => m.id === first)!.uploaded).toBe(1);
    expect((await listPendingAttachments()).map((m) => m.id)).toEqual([second]);

    // Idempotent: marking again changes nothing.
    await markAttachmentUploaded(first);
    expect((await listPendingAttachments()).map((m) => m.id)).toEqual([second]);
  });

  it('deletes the record and its blob', async () => {
    const id = newAttachmentId();
    await putAttachment({ id, name: 'x', mime: 'audio/webm', size: 1 }, blob('x'));
    await deleteAttachment(id);
    expect(await getAttachmentBlob(id)).toBeNull();
    expect(await getAttachmentMeta(id)).toBeNull();
  });

  it('reports unknown ids as null', async () => {
    expect(await getAttachmentBlob('att-unknown0000000000000')).toBeNull();
    expect(await getAttachmentMeta('att-unknown0000000000000')).toBeNull();
  });
});

describe('the degradation rule (no IndexedDB)', () => {
  beforeEach(() => {
    resetStorageForTests(); // backend resets to local-storage, never booted
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('writes report failure and reads report nothing — no crash', async () => {
    const stored = await putAttachment(
      { id: 'att-degrade0000000000000', name: 'x', mime: 'audio/webm', size: 1 },
      blob('x'),
    );
    expect(stored).toBe(false);
    expect(await getAttachmentBlob('att-degrade0000000000000')).toBeNull();
    expect(await listAttachmentMetas()).toEqual([]);
    expect(await listPendingAttachments()).toEqual([]);
  });
});
