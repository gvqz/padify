/**
 * verify-seq-backfill.ts — end-to-end check of the migrateSeqBackfill
 * boot migration against a real local-file SQLite (bun:sqlite).
 *
 * 1. open a throwaway file db (schema applied, migrations run — nothing to backfill)
 * 2. plant a pre-v2 shape by hand: a user, sync_counter, and rows with seq=0
 * 3. REOPEN the file (boot migrations run again — the backfill fires)
 * 4. assert: every seq-0 row got stamped, above the user's max, counter parked
 */
import { applySchema, createDb } from '../server/db';

const FILE = `/tmp/padify-seq-backfill-${Date.now()}.db`;

async function open(): Promise<Awaited<ReturnType<typeof createDb>>> {
  process.env.TURSO_DATABASE_URL = `file:${FILE}`;
  process.env.TURSO_AUTH_TOKEN = '';
  return createDb();
}

// 1. First open: schema + migrations (nothing to backfill on an empty db).
const first = await open();
await applySchema(first);

// 2. Plant the pre-v2 shape directly.
await first.run(
  `insert into users (id, email, password_hash, created_at) values ('u1', 'x@y.z', 'h', 0)`,
);
await first.run(
  `insert into notes (id, user_id, name, content, position, created_at, updated_at, deleted, note_type, seq)
   values
   ('n1', 'u1', 'old one', 'c1', 0, 100, 100, 0, null, 0),
   ('n2', 'u1', 'old two', 'c2', 1, 200, 200, 0, null, 0),
   ('n3', 'u1', 'stamped', 'c3', 2, 300, 300, 0, null, 0)`,
);
// fix n3 to carry a real seq (a row that WAS stamped by a v2 build)
await first.run(`update notes set seq = 5 where id = 'n3'`);

// 3. Reopen — the boot migrations run again, the backfill should fire.
const second = await open();
await applySchema(second);

const rows = await second.all(
  `select id, seq from notes where user_id = 'u1' order by created_at asc`,
);
const counter = await second.all(`select value from sync_counters where user_id = 'u1'`);

console.log('rows after reopen:', JSON.stringify(rows));
console.log('counter after reopen:', JSON.stringify(counter));

const n1 = Number(rows.find((r) => r.id === 'n1')?.seq);
const n2 = Number(rows.find((r) => r.id === 'n2')?.seq);
const n3 = Number(rows.find((r) => r.id === 'n3')?.seq);
const counterValue = Number(counter[0]?.value);

const checks = [
  ['n1 stamped above 0', n1 > 0],
  ['n2 stamped above 0', n2 > 0],
  ['stamps sit above the user max seq', n1 > 5 && n2 > 5],
  ['stamps are unique', n1 !== n2],
  ['n3 keeps its stamp', n3 === 5],
  ['counter parked at the new max', counterValue >= Math.max(n1, n2)],
] as const;

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failed += 1;
}

// idempotency: a third open must not re-stamp.
const third = await open();
await applySchema(third);
const rows3 = await third.all(`select id, seq from notes where user_id = 'u1'`);
const stable = rows3.every((r) => Number(r.seq) === Number(rows.find((x) => x.id === r.id)?.seq));
console.log(`${stable ? 'PASS' : 'FAIL'} — idempotent on a third open`);
if (!stable) failed += 1;

process.exit(failed === 0 ? 0 : 1);
