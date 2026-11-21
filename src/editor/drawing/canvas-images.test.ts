/**
 * Canvas images — the drawing canvas's attachment spine, pinned.
 *
 * The vendor does the inserting (paste/drop/tool, resize and caps at
 * insert time); what this module owns is the two directions around the
 * store: FLUSH (the vendor's files map → attachment rows, idempotent by
 * id) and HYDRATION (fileIds → BinaryFileData-shaped files, local first,
 * the cloud's lazy pull cached on arrival). The store paths run against
 * the real fake-indexeddb store; failure paths inject spies.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blobFromDataURL,
  collectSceneFileIds,
  dataURLMime,
  flushSceneFiles,
  idsNeedingHydration,
  isImageDataURL,
  loadSceneFiles,
  type CanvasImageFiles,
} from './canvas-images';
import {
  clearAttachments,
  getAttachmentBlob,
  getAttachmentMeta,
  putAttachment,
} from '../../storage/attachments';
import { resetStorageForTests, storageReady } from '../../storage';

const ID_A = 'file-aaaabbbbccccdddd';
const ID_B = 'file-eeeeffff00001111';

function imageElement(fileId: string, isDeleted = false): Record<string, unknown> {
  return { id: `el-${fileId}`, type: 'image', fileId, isDeleted };
}

/** 'hello-bytes' in base64. */
const HELLO_B64 = 'aGVsbG8tYnl0ZXM=';
const HELLO_DATA_URL = `data:image/webp;base64,${HELLO_B64}`;

beforeEach(async () => {
  resetStorageForTests();
  await storageReady();
  await clearAttachments();
});

afterEach(() => {
  resetStorageForTests();
  vi.restoreAllMocks();
});

describe('collectSceneFileIds', () => {
  it('collects the image elements fileIds, in first-seen order', () => {
    const elements = [
      imageElement(ID_B),
      { id: 'r', type: 'rectangle', x: 0, y: 0 },
      imageElement(ID_A),
      imageElement(ID_B), // duplicate — one set entry
    ];
    expect(collectSceneFileIds(elements)).toEqual([ID_B, ID_A]);
  });

  it('ignores deleted ghosts, non-images and junk fileIds', () => {
    const elements = [
      imageElement('short'),
      imageElement('has:colon'),
      imageElement(ID_A, true), // deleted ghost
      { id: 't', type: 'text', text: 'hi' },
      { id: 'i', type: 'image' }, // no fileId at all
      null,
    ] as unknown as Record<string, unknown>[];
    expect(collectSceneFileIds(elements)).toEqual([]);
    expect(collectSceneFileIds([])).toEqual([]);
  });
});

describe('data URL decode', () => {
  it('admits exactly the base64 image data-URL shape', () => {
    expect(isImageDataURL(HELLO_DATA_URL)).toBe(true);
    expect(dataURLMime(HELLO_DATA_URL)).toBe('image/webp');
    expect(isImageDataURL('data:image/png;base64,')).toBe(true); // shape ok; empty payload drops later
    expect(isImageDataURL('not-a-data-url')).toBe(false);
    expect(isImageDataURL('data:;base64,AAAA')).toBe(false); // no mime
    expect(isImageDataURL('data:image/png,AAAA')).toBe(false); // not base64
    expect(isImageDataURL(`data:image/png;base64,${HELLO_B64}!junk`)).toBe(false);
  });

  it('decodes to a Blob carrying the mime and the exact bytes', async () => {
    const blob = blobFromDataURL(HELLO_DATA_URL);
    expect(blob).not.toBe(null);
    expect(blob?.type).toBe('image/webp');
    expect(await blob?.text()).toBe('hello-bytes');
  });

  it('answers null for junk and for an empty payload', () => {
    expect(blobFromDataURL('not-a-data-url')).toBe(null);
    expect(blobFromDataURL('data:image/png;base64,')).toBe(null);
    expect(blobFromDataURL('data:image/png;base64,!!!')).toBe(null);
  });
});

describe('flushSceneFiles', () => {
  function filesFrom(entries: Array<[string, string, string]>): CanvasImageFiles {
    const files: CanvasImageFiles = {};
    for (const [id, mime, dataURL] of entries) {
      files[id] = { id, mimeType: mime, dataURL, created: 1, lastRetrieved: 2 };
    }
    return files;
  }

  it('lands unknown ids in the store offline-first and marks them persisted', async () => {
    const persisted = new Set<string>();
    const flushed = await flushSceneFiles(
      filesFrom([[ID_A, 'image/webp', HELLO_DATA_URL]]),
      persisted,
    );
    expect(flushed).toEqual([ID_A]);
    expect(persisted.has(ID_A)).toBe(true);
    const stored = await getAttachmentBlob(ID_A);
    expect(await stored?.text()).toBe('hello-bytes');
    expect(stored?.type).toBe('image/webp');
    const meta = await getAttachmentMeta(ID_A);
    expect(meta?.mime).toBe('image/webp');
    expect(meta?.size).toBe(11);
  });

  it('is idempotent — a persisted id never writes twice', async () => {
    const persisted = new Set<string>();
    await flushSceneFiles(filesFrom([[ID_A, 'image/webp', HELLO_DATA_URL]]), persisted);
    const spy = vi.fn(async () => true);
    const flushed = await flushSceneFiles(
      filesFrom([[ID_A, 'image/webp', HELLO_DATA_URL]]),
      persisted,
      {
        store: spy,
      },
    );
    expect(flushed).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips junk ids and over-cap payloads without touching the rest', async () => {
    const persisted = new Set<string>();
    const flushed = await flushSceneFiles(
      filesFrom([
        ['short', 'image/png', HELLO_DATA_URL], // junk id
        ['over-cap-id', 'image/png', `data:image/png;base64,${'A'.repeat(6_700_000)}`], // 5.02 MB
        [ID_B, 'image/png', `data:image/png;base64,${HELLO_B64}`],
      ]),
      persisted,
    );
    expect(flushed).toEqual([ID_B]);
    expect(persisted.has('over-cap-id')).toBe(false);
  });

  it('a failed store write is not marked persisted (the next pass retries)', async () => {
    const persisted = new Set<string>();
    const flushed = await flushSceneFiles(
      filesFrom([[ID_A, 'image/webp', HELLO_DATA_URL]]),
      persisted,
      {
        store: async () => false,
      },
    );
    expect(flushed).toEqual([]);
    expect(persisted.has(ID_A)).toBe(false);
  });
});

describe('loadSceneFiles', () => {
  async function seedLocal(id: string, mime = 'image/webp'): Promise<void> {
    await putAttachment(
      { id, name: `${id}.img`, mime, size: 11 },
      new Blob(['hello-bytes'], { type: mime }),
    );
  }

  it('reads the local store first — no remote call', async () => {
    await seedLocal(ID_A);
    const remote = vi.fn(async () => null);
    const files = await loadSceneFiles([ID_A], { loadRemote: remote });
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe(ID_A);
    expect(files[0]?.mimeType).toBe('image/webp');
    expect(
      blobFromDataURL(files[0]!.dataURL) && (await blobFromDataURL(files[0]!.dataURL)!.text()),
    ).toBe('hello-bytes');
    expect(remote).not.toHaveBeenCalled();
  });

  it('pulls another device’s bytes from the remote and caches them into the store', async () => {
    const remote = vi.fn(async () => new Blob(['hello-bytes'], { type: 'image/png' }));
    const files = await loadSceneFiles([ID_B], { loadRemote: remote });
    expect(remote).toHaveBeenCalledWith(ID_B);
    expect(files[0]?.mimeType).toBe('image/png');
    // The pull landed locally — an offline reopen reads it there. The
    // cache write is fire-and-forget (the session's data URL never waits
    // on it), so the test polls like the resolver's tests do.
    await vi.waitFor(async () => {
      const cached = await getAttachmentBlob(ID_B);
      expect(await cached?.text()).toBe('hello-bytes');
      expect(cached?.type).toBe('image/png');
    });
  });

  it('answers nothing for a file neither source holds (the vendor shows its placeholder)', async () => {
    const files = await loadSceneFiles([ID_A, 'junkyjunkjunk1']);
    expect(files).toEqual([]);
  });
});

describe('idsNeedingHydration', () => {
  it('diffs the scene against what this device already persists', () => {
    const elements = [imageElement(ID_A), imageElement(ID_B)];
    expect(idsNeedingHydration(elements, new Set([ID_A]))).toEqual([ID_B]);
    expect(idsNeedingHydration(elements, new Set([ID_A, ID_B]))).toEqual([]);
    expect(idsNeedingHydration([], new Set())).toEqual([]);
  });
});
