import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageForTests, storageReady } from '../storage';
import {
  clearAttachments,
  listPendingAttachments,
  markAttachmentUploaded,
  newAttachmentId,
  putAttachment,
} from '../storage/attachments';

/**
 * The attachment flush, pinned against the real IDB store with the
 * network mocked: pending uploads leave with the right headers and
 * bytes, successes flip to uploaded, failures are skipped for the rest
 * of the session (no 5 MB request every cycle), and the lazy pull
 * shapes its answers.
 */

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {},
  apiRaw: vi.fn(),
}));

import { apiRaw } from './api';
import {
  fetchAttachment,
  flushAttachmentUploads,
  resetAttachmentFlushForTests,
} from './attachments';

const apiRawMock = vi.mocked(apiRaw);

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function status(code: number): Response {
  return new Response(JSON.stringify({ error: 'no' }), { status: code });
}

async function addPending(name: string): Promise<string> {
  const id = newAttachmentId();
  const stored = await putAttachment({ id, name, mime: 'audio/webm', size: 0 }, new Blob(['x']));
  expect(stored).toBe(true);
  return id;
}

describe('flushAttachmentUploads', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
    await clearAttachments(); // the fake DB persists within a file
    resetAttachmentFlushForTests();
    apiRawMock.mockReset();
  });

  afterEach(() => {
    resetStorageForTests();
    resetAttachmentFlushForTests();
  });

  it('uploads each pending attachment with the byte body and id headers', async () => {
    const first = await addPending('one.webm');
    const second = await addPending('two.webm');
    apiRawMock.mockResolvedValue(ok());

    const uploaded = await flushAttachmentUploads();

    expect(uploaded).toBe(2);
    expect(apiRawMock).toHaveBeenCalledTimes(2);
    const uploadedIds = apiRawMock.mock.calls.map((call) => call[1]!.headers!['x-padify-id']);
    expect(uploadedIds.sort()).toEqual([first, second].sort());
    const [path, options] = apiRawMock.mock.calls[0]!;
    expect(path).toBe('/api/attachments');
    expect(options!.method).toBe('POST');
    expect(options!.headers!['content-type']).toBe('audio/webm');
    // (byteLength, not instanceof: fake-indexeddb's clone may come from
    // another realm, where instanceof checks fail.)
    expect((options!.body as ArrayBuffer).byteLength).toBeGreaterThan(0);

    expect(await listPendingAttachments()).toEqual([]);
  });

  it('marks uploads done one at a time — already-uploaded rows never re-POST', async () => {
    await addPending('one.webm');
    apiRawMock.mockResolvedValue(ok());
    expect(await flushAttachmentUploads()).toBe(1);

    apiRawMock.mockClear();
    expect(await flushAttachmentUploads()).toBe(0); // nothing pending
    expect(apiRawMock).not.toHaveBeenCalled();
  });

  it('a rejected upload stays pending but is not retried this session', async () => {
    await addPending('poison.webm');
    apiRawMock.mockResolvedValue(status(413));

    expect(await flushAttachmentUploads()).toBe(0);
    expect((await listPendingAttachments()).length).toBe(1); // still pending

    apiRawMock.mockClear();
    expect(await flushAttachmentUploads()).toBe(0); // skipped, no request
    expect(apiRawMock).not.toHaveBeenCalled();

    // Next session (failed set cleared) it tries again.
    resetAttachmentFlushForTests();
    apiRawMock.mockResolvedValue(ok());
    expect(await flushAttachmentUploads()).toBe(1);
    expect(await listPendingAttachments()).toEqual([]);
  });

  it('a network failure is a skip, not a crash, and never blocks the rest', async () => {
    const good = await addPending('good.webm');
    const bad = await addPending('bad.webm');
    apiRawMock.mockImplementation(
      async (path: string, options?: { headers?: Record<string, string> }) => {
        if (options?.headers?.['x-padify-id'] === bad) {
          throw new Error('ECONNREFUSED');
        }
        return ok();
      },
    );

    const uploaded = await flushAttachmentUploads();
    expect(uploaded).toBe(1);
    const pending = await listPendingAttachments();
    expect(pending.map((m) => m.id)).toEqual([bad]);
    expect(good).not.toBe(bad);
  });

  it('a record that vanished mid-flush is skipped silently', async () => {
    const id = await addPending('ghost.webm');
    await markAttachmentUploaded(id); // simulate the wipe racing the flush
    apiRawMock.mockResolvedValue(ok());
    expect(await flushAttachmentUploads()).toBe(0);
  });
});

describe('fetchAttachment — the lazy pull', () => {
  beforeEach(() => {
    apiRawMock.mockReset();
  });

  it('returns the server blob for a 200', async () => {
    // (The mock body is raw bytes — undici cannot read a jsdom Blob.)
    apiRawMock.mockResolvedValue(
      new Response(new TextEncoder().encode('bytes'), {
        headers: { 'content-type': 'audio/webm' },
      }),
    );
    const blob = await fetchAttachment('att-whatever0000000000');
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('audio/webm');
    expect(await blob!.text()).toBe('bytes');
    expect(apiRawMock.mock.calls[0]![0]).toBe('/api/attachments/att-whatever0000000000');
  });

  it('answers null for anything the server refuses or the network drops', async () => {
    apiRawMock.mockResolvedValueOnce(status(404));
    expect(await fetchAttachment('att-missing000000000000')).toBeNull();

    apiRawMock.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchAttachment('att-offline000000000000')).toBeNull();
  });
});
