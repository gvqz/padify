/**
 * Padify API — boot and serve.
 *
 * The HTTP surface (handlers, router, rate limits) lives in handlers.ts,
 * extracted so it can be imported by tests; this file is deliberately the
 * only place that touches Bun, and keeps only the boot sequence: create
 * the database, apply the schema, sweep expired sessions and the music
 * cache, and answer every request through route().
 */

import { applySchema, createDb } from './db';
import { sweepMusicCache } from './music';
import { MAX_BODY_BYTES, json, route } from './handlers';
import { MAX_ATTACHMENT_BYTES } from './attachments';

const PORT = Number(process.env.PORT ?? 3041);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const db = await createDb();
await applySchema(db);
await db.run('delete from sessions where expires_at <= ?', [Date.now()]);
await sweepMusicCache(db);

Bun.serve({
  port: PORT,
  // Memory guardrails for small always-on hosts: cap request bodies at the
  // runtime level (the default allows 128 MB to be buffered before any
  // handler runs) and keep Bun's development error pages (with stack traces)
  // out of responses. The handler already returns safe JSON errors itself.
  // The ceiling covers attachment uploads (raw bytes, capped at
  // MAX_ATTACHMENT_BYTES by the handler) plus header slack; JSON routes
  // keep their own tighter 2 MB check in readJson.
  maxRequestBodySize: MAX_ATTACHMENT_BYTES + MAX_BODY_BYTES,
  development: false,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try {
      return await route(db, request, pathname);
    } catch (error) {
      console.error(`[padify-api] ${request.method} ${pathname} failed:`, error);
      return json(request, { error: 'Something went wrong on the server. Try again.' }, 500);
    }
  }
});

console.log(`[padify-api] listening on http://localhost:${PORT}`);
