/**
 * Note images — the reference scheme, the capture pipeline's rules, and
 * the preview resolver's lifecycle, pinned.
 *
 * The capture pipeline's canvas re-encode is injectable (jsdom has no
 * canvas); everything around it — the type gate, the GIF passthrough,
 * the size caps, the store write, the failure vocabulary — is exercised
 * with fake compressors and stores. The resolver runs against the real
 * fake-indexeddb store with a remote loader that simulates the cloud's
 * lazy pull.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNoteImageResolver,
  imageFilesFrom,
  imageMarkdownFor,
  MAX_IMAGE_BYTES,
  prepareImageAttachment,
  type ImageCompressor,
} from './note-images';
import { padifyAttRef } from '../../shared/att-refs';
import {
  clearAttachments,
  getAttachmentBlob,
  putAttachment,
} from '../storage/attachments';
import { resetStorageForTests, storageReady } from '../storage';

const GOOD_ID = 'att-0123456789abcdef01234567';

function pngFile(name = 'Screenshot 2026-11-21.png', size = 100): File {
  const file = new File([new Uint8Array(size)], name, { type: 'image/png' });
  return file;
}

// The reference scheme's shape and the content scan live in
// shared/att-refs.test.ts — the grammar's own contract. These are the
// capture/resolver surfaces that ride it.

describe('imageMarkdownFor', () => {
  it('derives the alt from the file name, flattening construct-breakers', () => {
    const image = {
      id: GOOD_ID,
      name: 'Screenshot [1] (v2).png',
      mime: 'image/webp',
      blob: new Blob(['x'], { type: 'image/webp' }),
    };
    expect(imageMarkdownFor(image)).toBe(`![Screenshot 1 v2](${padifyAttRef(GOOD_ID)})`);
  });

  it('falls back to a bare alt when the name has nothing left', () => {
    const image = {
      id: GOOD_ID,
      name: '[].png',
      mime: 'image/png',
      blob: new Blob(['x'], { type: 'image/png' }),
    };
    expect(imageMarkdownFor(image)).toBe(`![image](${padifyAttRef(GOOD_ID)})`);
  });
});

describe('imageFilesFrom', () => {
  it('keeps only the types capture accepts, in order', () => {
    const list = [
      pngFile('a.png'),
      new File(['x'], 'doc.txt', { type: 'text/plain' }),
      new File(['x'], 'clip.gif', { type: 'image/gif' }),
    ] as unknown as FileList;
    const files = imageFilesFrom(list);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'clip.gif']);
  });

  it('answers nothing for a null or empty list', () => {
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom(undefined)).toEqual([]);
  });
});

describe('prepareImageAttachment', () => {
  const compress: ImageCompressor = vi.fn(
    async () => new Blob(['webp-bytes'], { type: 'image/webp' }),
  );

  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
    await clearAttachments();
  });

  afterEach(() => {
    resetStorageForTests();
    vi.restoreAllMocks();
  });

  it('refuses unsupported types before any decode', async () => {
    const never: ImageCompressor = vi.fn(async () => null) as ImageCompressor;
    const result = await prepareImageAttachment(
      new File(['x'], 'movie.mp4', { type: 'video/mp4' }),
      { compress: never },
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(never).not.toHaveBeenCalled();
  });

  it('compresses a png to webp and stores it offline-first', async () => {
    const result = await prepareImageAttachment(pngFile(), { compress });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mime).toBe('image/webp');
    expect(result.image.id).toMatch(/^att-[a-f0-9]{24}$/);
    expect(result.image.name).toBe('Screenshot 2026-11-21.png');

    // The store holds the bytes under the same id, pending upload.
    const stored = await getAttachmentBlob(result.image.id);
    expect(await stored?.text()).toBe('webp-bytes');
    expect(stored?.type).toBe('image/webp');
  });

  it('passes a gif through byte-exact without calling the compressor', async () => {
    const never: ImageCompressor = vi.fn(async () => null);
    const gif = new File([new Uint8Array(50)], 'clip.gif', { type: 'image/gif' });
    const result = await prepareImageAttachment(gif, { compress: never });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mime).toBe('image/gif');
    expect(never).not.toHaveBeenCalled();
    expect((await getAttachmentBlob(result.image.id))?.type).toBe('image/gif');
  });

  it('refuses an over-cap gif (the raw bytes are the only copy)', async () => {
    const gif = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.gif', {
      type: 'image/gif',
    });
    const result = await prepareImageAttachment(gif, { compress });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses when the compressor fails (a corrupt file)', async () => {
    const broken: ImageCompressor = vi.fn(async () => null) as ImageCompressor;
    const result = await prepareImageAttachment(pngFile(), { compress: broken });
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  it('refuses when the re-encode lands over the cap', async () => {
    const huge: ImageCompressor = vi.fn(
      async () => new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/webp' }),
    ) as ImageCompressor;
    const result = await prepareImageAttachment(pngFile(), { compress: huge });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports a degraded store honestly (no IndexedDB → no image)', async () => {
    resetStorageForTests(); // backend falls back to localStorage, never booted
    const result = await prepareImageAttachment(pngFile(), { compress });
    expect(result).toEqual({ ok: false, reason: 'no-storage' });
  });
});

describe('the preview resolver', () => {
  let createdUrls: string[];
  let revokedUrls: string[];
  let remoteCalls: string[];
  let remoteAvailable: Set<string>;
  let urlCounter: number;

  function resolver() {
    return createNoteImageResolver({
      createUrl: () => {
        const url = `blob:fake-${++urlCounter}`;
        createdUrls.push(url);
        return url;
      },
      revokeUrl: (url) => revokedUrls.push(url),
      loadRemote: async (id) => {
        remoteCalls.push(id);
        if (remoteAvailable.has(id)) {
          return new Blob([`remote-${id}`], { type: 'image/webp' });
        }
        return null;
      },
    });
  }

  function containerWith(refs: string[]): HTMLElement {
    const container = document.createElement('div');
    for (const ref of refs) {
      const img = document.createElement('img');
      img.setAttribute('src', ref);
      container.appendChild(img);
    }
    document.body.appendChild(container);
    return container;
  }

  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
    await clearAttachments();
    createdUrls = [];
    revokedUrls = [];
    remoteCalls = [];
    remoteAvailable = new Set();
    urlCounter = 0;
  });

  afterEach(() => {
    resetStorageForTests();
    document.body.innerHTML = '';
  });

  it('swaps a locally-stored ref to a blob URL without touching the remote', async () => {
    await putAttachment(
      { id: GOOD_ID, name: 'shot.png', mime: 'image/webp', size: 0 },
      new Blob(['local'], { type: 'image/webp' }),
    );
    const r = resolver();
    const container = containerWith([padifyAttRef(GOOD_ID)]);
    r.resolve(container);
    await vi.waitFor(() => {
      expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:fake-1');
    });
    expect(remoteCalls).toEqual([]);
    r.release();
    expect(revokedUrls).toEqual(['blob:fake-1']);
  });

  it('pulls another device\u2019s bytes from the remote and caches them into the store', async () => {
    remoteAvailable.add(GOOD_ID);
    const r = resolver();
    const container = containerWith([padifyAttRef(GOOD_ID)]);
    r.resolve(container);
    await vi.waitFor(() => {
      expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:fake-1');
    });
    expect(remoteCalls).toEqual([GOOD_ID]);
    // The pull landed in the local store — a reload (or offline open)
    // reads it there.
    const cached = await getAttachmentBlob(GOOD_ID);
    expect(await cached?.text()).toBe(`remote-${GOOD_ID}`);
    r.release();
  });

  it('marks an unresolvable ref as missing and does not re-ask on later passes', async () => {
    const r = resolver();
    const container = containerWith([padifyAttRef(GOOD_ID)]);
    r.resolve(container);
    await vi.waitFor(() => {
      expect(container.querySelector('img')!.hasAttribute('data-padify-missing')).toBe(true);
    });
    // A second render pass (fresh elements, same ref): no new remote call.
    r.resolve(container);
    await Promise.resolve();
    expect(remoteCalls).toEqual([GOOD_ID]);
    const img = container.querySelector('img')!;
    expect(img.hasAttribute('data-padify-missing')).toBe(true);
    expect(img.getAttribute('src')).toBe(padifyAttRef(GOOD_ID)); // untouched
    r.release();
  });

  it('reuses the cached URL across render passes (no refetch, no flicker)', async () => {
    await putAttachment(
      { id: GOOD_ID, name: 'shot.png', mime: 'image/webp', size: 0 },
      new Blob(['local'], { type: 'image/webp' }),
    );
    const r = resolver();
    const container = containerWith([padifyAttRef(GOOD_ID)]);
    r.resolve(container);
    await vi.waitFor(() => {
      expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:fake-1');
    });
    // The note re-rendered (the 250 ms preview debounce) — a fresh img
    // element with the raw ref, resolved synchronously from the cache.
    const fresh = containerWith([padifyAttRef(GOOD_ID)]);
    r.resolve(fresh);
    expect(fresh.querySelector('img')!.getAttribute('src')).toBe('blob:fake-1');
    expect(createdUrls).toEqual(['blob:fake-1']); // no second URL
    r.release();
    expect(revokedUrls).toEqual(['blob:fake-1']);
  });

  it('leaves a malformed ref alone (the gate would never have passed it)', () => {
    const r = resolver();
    const container = containerWith(['padify-att:short']);
    r.resolve(container);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('padify-att:short');
    r.release();
  });
});
