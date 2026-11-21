/**
 * Note images — the reference scheme and the preview resolver's lifecycle,
 * pinned.
 *
 * The capture pipeline is gone from notes (the owner's text-only call) —
 * what stays is what real data can still exercise: the scheme gate, the
 * content scan (the .padify export's embedding pass) and the resolver,
 * which runs against the real fake-indexeddb store with a remote loader
 * that simulates the cloud's lazy pull.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectAttachmentRefs,
  createNoteImageResolver,
  isPadifyAttRef,
  padifyAttId,
  padifyAttRef,
} from './note-images';
import {
  clearAttachments,
  getAttachmentBlob,
  newAttachmentId,
  putAttachment,
} from '../storage/attachments';
import { resetStorageForTests, storageReady } from '../storage';

const GOOD_ID = 'att-0123456789abcdef01234567';

describe('the reference scheme', () => {
  it('accepts exactly the store id shape', () => {
    expect(isPadifyAttRef(`padify-att:${GOOD_ID}`)).toBe(true);
    expect(isPadifyAttRef('padify-att:voice-2026-abcdef')).toBe(true);
    expect(isPadifyAttRef('padify-att:att-x')).toBe(false); // too short
    expect(isPadifyAttRef('padify-att:../../etc')).toBe(false);
    expect(isPadifyAttRef('padify-att:has:colon')).toBe(false);
    expect(isPadifyAttRef('https://example.com')).toBe(false);
    expect(isPadifyAttRef('')).toBe(false);
  });

  it('round-trips id → ref → id', () => {
    const id = newAttachmentId();
    expect(padifyAttId(padifyAttRef(id))).toBe(id);
    expect(padifyAttId('junk')).toBeNull();
  });

  it('collects inline images, definitions and raw-html img srcs', () => {
    const content = [
      'before',
      '',
      '![shot one](padify-att:att-aaaaaaaaaaaaaaaa)',
      '![ref][pic]',
      '',
      '[pic]: padify-att:att-bbbbbbbbbbbbbbbb',
      '',
      '<img src="padify-att:att-cccccccccccccccc" alt="raw">',
      "<img alt='q' src='padify-att:att-dddddddddddddddd'>",
      '![same again](padify-att:att-aaaaaaaaaaaaaaaa)',
    ].join('\n');
    expect(collectAttachmentRefs(content).sort()).toEqual([
      'att-aaaaaaaaaaaaaaaa',
      'att-bbbbbbbbbbbbbbbb',
      'att-cccccccccccccccc',
      'att-dddddddddddddddd',
    ]);
  });

  it('collects nothing from prose and junk (and never a malformed ref)', () => {
    const content = [
      'a normal note',
      '[a link](https://example.com)',
      '![x](padify-att:short)',
      '![x](padify-att:../../evil)',
      '<img src="https://example.com/i.png">',
    ].join('\n');
    expect(collectAttachmentRefs(content)).toEqual([]);
    expect(collectAttachmentRefs('')).toEqual([]);
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
