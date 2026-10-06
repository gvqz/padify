/**
 * Padify API — boot and serve.
 *
 * The HTTP surface lives in routes.ts (the route table + dispatcher) and
 * the domain modules it wires; this file is deliberately the only place
 * that touches Bun, and keeps only the boot sequence: create the
 * database, apply the schema, sweep expired sessions and the music
 * cache, and answer every request through route().
 */

import { applySchema, createDb } from './db';
import { sweepMusicCache } from './music';
import { MAX_BODY_BYTES, json } from './http';
import { route } from './routes';
import { MAX_ATTACHMENT_BYTES } from './attachments';

const PORT = Number(process.env.PORT ?? 3041);

// PaaS supervisors (alwaysdata sites, the reference deployment) hand the
// listen address over as env: an IPv6 on their internal network in $IP and
// the site's assigned port in $PORT. Local runs get the previous behavior —
// every interface, the default port.
const HOSTNAME = process.env.IP ?? '0.0.0.0';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const db = await createDb();
await applySchema(db);
await db.run('delete from sessions where expires_at <= ?', [Date.now()]);
await sweepMusicCache(db);

// ---------------------------------------------------------------------------
// Serve + shutdown
// ---------------------------------------------------------------------------

// Drain bookkeeping: SIGTERM/SIGINT must not cut requests mid-flight (a
// half-finished sync push is exactly the kind of write the seq reservation
// exists to protect), so the fetch wrapper counts what is in flight and
// the shutdown path waits for the counter to hit zero before exiting.
let inFlight = 0;
let drained: (() => void) | null = null;

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
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
    inFlight++;
    try {
      return await route(db, request, pathname);
    } catch (error) {
      console.error(`[padify-api] ${request.method} ${pathname} failed:`, error);
      return json(request, { error: 'Something went wrong on the server. Try again.' }, 500);
    } finally {
      inFlight--;
      if (drained && inFlight === 0) {
        drained();
      }
    }
  }
});

/** Hard ceiling on how long a drain may take before we stop waiting. */
const DRAIN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

const shutdown = (signal: string): void => {
  // A second signal during a drain means "exit NOW" — the operator knows
  // something the graceful path does not.
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;

  console.log(`[padify-api] ${signal} received — draining ${inFlight} in-flight request(s)`);
  server.stop(); // stop accepting; active connections finish their work

  const exit = (): void => {
    db.close?.();
    process.exit(0);
  };

  if (inFlight === 0) {
    exit();
    return;
  }

  const force = setTimeout(exit, DRAIN_TIMEOUT_MS);
  force.unref();
  drained = () => {
    clearTimeout(force);
    exit();
  };
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`[padify-api] listening on http://${HOSTNAME}:${PORT}`);
