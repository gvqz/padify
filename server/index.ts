/**
 * Padify API — boot and serve.
 *
 * The HTTP surface lives in routes.ts (the route table + dispatcher) and
 * the domain modules it wires; this file is deliberately the only place
 * that touches Bun, and keeps only the boot sequence: create the
 * database, apply the schema, sweep expired sessions, the music cache and
 * the trash, and answer every request through route().
 */

import { applySchema, createDb } from './db';
import { sweepMusicCache } from './music';
import { sweepOrphanAttachments } from './attachments';
import { sweepTrashedNotes } from './notes';
import { sweepStaleShares } from './shares';
import { MAX_BODY_BYTES, json, pathPrefixFromEnv, stripPathPrefix } from './http';
import { route } from './routes';
import { MAX_ATTACHMENT_BYTES } from './attachments';

const PORT = Number(process.env.PORT ?? 3041);
const PATH_PREFIX = pathPrefixFromEnv(process.env.PATH_PREFIX);

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

/**
 * The maintenance pass: expired sessions, dead music-cache rows, dead
 * share links, trash past retention, attachments no note references
 * anymore (after the shared grace window — see sweepOrphanAttachments).
 * Runs at boot AND hourly below — the boot pass alone put every one of
 * these windows on the deploy calendar (the alwaysdata box runs for
 * weeks between restarts), so each table just grew until the next
 * deploy.
 */
async function sweepAll(): Promise<void> {
  await db.run('delete from sessions where expires_at <= ?', [Date.now()]);
  await sweepMusicCache(db);
  const sweptShares = await sweepStaleShares(db);
  if (sweptShares > 0) {
    console.log(`[padify-api] share sweep: pruned ${sweptShares} dead link(s)`);
  }
  const sweptTrash = await sweepTrashedNotes(db);
  if (sweptTrash > 0) {
    console.log(`[padify-api] trash sweep: retired ${sweptTrash} note(s) past retention`);
  }
  const sweptAttachments = await sweepOrphanAttachments(db);
  if (sweptAttachments > 0) {
    console.log(`[padify-api] attachment sweep: deleted ${sweptAttachments} orphaned blob(s)`);
  }
}

await sweepAll();
// …and again periodically: hourly is far tighter than any of the windows
// needs ("30 days, then gone", 30-day sessions, a 7-day link grace) and
// cheap enough — four indexed statements — to never matter. unref'd so
// the timer never holds the process open (tests import this module's
// siblings, and supervisors own the lifecycle).
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const sweeper = setInterval(() => {
  void sweepAll().catch((error) => {
    console.warn('[padify-api] periodic sweep failed — retrying next hour', error);
  });
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

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
    const routedPath = stripPathPrefix(pathname, PATH_PREFIX);
    inFlight++;
    try {
      return await route(db, request, routedPath);
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
