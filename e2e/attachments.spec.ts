import { expect, test, type Page } from '@playwright/test';

/**
 * The attachment store, end to end against the real API.
 *
 * Two pins:
 *
 *  1. The server contract through a real session — upload raw bytes,
 *     download them back, the ETag/304 dance, the list, the idempotent
 *     duplicate, the 409 collision, delete, 404 — every route the unit
 *     contracts describe, this time over a real socket with a real
 *     scrypt-hashed account.
 *
 *  2. The client flush — a pending record lands in the page's real
 *     IndexedDB, the sync button fires a cycle, and the flush carries
 *     the bytes to the server and flips the record to uploaded.
 *
 * The e2e config boots the API against a throwaway SQLite file (see
 * playwright.config.ts); nothing here touches a real database.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

function freshAccount(): { email: string; password: string } {
  const stem = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { email: `${stem}@example.test`, password: 'a long enough password' };
}

async function signUp(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/');
  await page.locator('#cloudNavContainer').click();
  await expect(page.locator('#cloudModal')).toBeVisible();
  await page.locator('#cloudAuthSwitch').click();
  await expect(page.locator('#cloudAuthTitle')).toContainText(/create/i);
  await page.locator('#cloudAuthEmail').fill(account.email);
  await page.locator('#cloudAuthPassword').fill(account.password);
  await page.locator('#cloudAuthSubmit').click();
  await expect(page.locator('#cloudSignedInPane')).toBeVisible();
}

test.describe('attachments (real API)', () => {
  test('the server round trip through a real session', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    const id = `att-e2e-${Math.random().toString(36).slice(2, 14)}`.padEnd(28, '0').slice(0, 28);

    // Upload raw bytes with the app's own session token.
    const uploaded = await page.evaluate(async (attachmentId) => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const response = await fetch('/api/attachments', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-padify-id': attachmentId,
          'content-type': 'audio/webm',
          'x-padify-name': 'voice-note.webm',
        },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }, id);

    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({
      id,
      name: 'voice-note.webm',
      mime: 'audio/webm',
      size: 8,
    });
    const etag = String(uploaded.body.sha256);

    // Download them back — same bytes, typed, immutable, ETagged.
    const downloaded = await page.evaluate(async (attachmentId) => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const response = await fetch(`/api/attachments/${attachmentId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        etag: response.headers.get('etag'),
        cacheControl: response.headers.get('cache-control'),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, id);

    expect(downloaded.status).toBe(200);
    expect(downloaded.contentType).toBe('audio/webm');
    expect(downloaded.bytes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(downloaded.etag).toBe(`"${etag}"`);
    expect(downloaded.cacheControl).toContain('immutable');

    // The ETag answers If-None-Match with a 304.
    const revalidated = await page.evaluate(
      async ({ attachmentId, etag: tag }) => {
        const raw = localStorage.getItem('padifySession');
        const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
        const response = await fetch(`/api/attachments/${attachmentId}`, {
          headers: { authorization: `Bearer ${token}`, 'if-none-match': tag },
        });
        return response.status;
      },
      { attachmentId: id, etag: downloaded.etag! },
    );
    expect(revalidated).toBe(304);

    // The list carries the meta, never the bytes.
    const listed = await page.evaluate(async () => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const response = await fetch('/api/attachments', {
        headers: { authorization: `Bearer ${token}` },
      });
      return (await response.json()) as { rows: Array<Record<string, unknown>> };
    });
    const row = listed.rows.find((entry) => entry.id === id);
    expect(row).toMatchObject({ name: 'voice-note.webm', mime: 'audio/webm', size: 8 });
    expect(JSON.stringify(listed)).not.toContain('data');

    // A retried identical upload is a 200 duplicate; different bytes a 409.
    const retried = await page.evaluate(async (attachmentId) => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const response = await fetch('/api/attachments', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-padify-id': attachmentId,
          'content-type': 'audio/webm',
        },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }, id);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ duplicate: true });

    const collided = await page.evaluate(async (attachmentId) => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const response = await fetch('/api/attachments', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-padify-id': attachmentId,
          'content-type': 'audio/webm',
        },
        body: new Uint8Array([9, 9, 9]),
      });
      return response.status;
    }, id);
    expect(collided).toBe(409);

    // Delete is idempotent and the id is gone.
    const deleted = await page.evaluate(async (attachmentId) => {
      const raw = localStorage.getItem('padifySession');
      const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
      const first = await fetch(`/api/attachments/${attachmentId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      const second = await fetch(`/api/attachments/${attachmentId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      const after = await fetch(`/api/attachments/${attachmentId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return [first.status, second.status, after.status];
    }, id);
    expect(deleted).toEqual([200, 200, 404]);
  });

  test('a pending local attachment flushes up on the next sync cycle', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, freshAccount());
    const id = `att-flush-${Math.random().toString(36).slice(2, 14)}`.padEnd(28, '0').slice(0, 28);

    // Drop a pending record into the page's real IndexedDB, exactly the
    // shape storage/attachments.ts writes. (Versionless open — the app
    // already created the database at whatever version it runs.)
    await page.evaluate(async (attachmentId) => {
      const bytes = new TextEncoder().encode('flush-me');
      const open = indexedDB.open('padify');
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = (db as IDBDatabase).transaction('attachments', 'readwrite');
        tx.objectStore('attachments').put({
          id: attachmentId,
          name: 'flush.webm',
          mime: 'audio/webm',
          size: bytes.byteLength,
          createdAt: Date.now(),
          uploaded: 0,
          bytes: bytes.buffer,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      (db as IDBDatabase).close();
    }, id);

    // One manual cycle — the sync button — runs the flush after it.
    await page.locator('#cloudSyncNow').click();
    await expect
      .poll(
        async () =>
          page.evaluate(async (attachmentId) => {
            const raw = localStorage.getItem('padifySession');
            const token = raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
            const response = await fetch('/api/attachments', {
              headers: { authorization: `Bearer ${token}` },
            });
            const body = (await response.json()) as { rows: Array<{ id: string }> };
            return body.rows.some((row) => row.id === attachmentId);
          }, id),
        { message: 'the flush uploads the pending attachment' },
      )
      .toBe(true);

    // And the local record flipped to uploaded.
    const local = await page.evaluate(async (attachmentId) => {
      const open = indexedDB.open('padify');
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = (db as IDBDatabase).transaction('attachments', 'readonly');
        const request = tx.objectStore('attachments').get(attachmentId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      (db as IDBDatabase).close();
      return (record as { uploaded?: number } | undefined)?.uploaded ?? null;
    }, id);
    expect(local).toBe(1);
  });
});
