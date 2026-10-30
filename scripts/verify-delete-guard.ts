/**
 * verify-delete-guard.ts — end-to-end check of the delete-race guard in
 * handleNotesPut against a real local-file SQLite (bun:sqlite).
 *
 * The story the user told: closing an empty tab and watching it reopen.
 * The server used to take ANY incoming row wholesale, so a live row
 * re-published after a delete (another window's stale position-drift
 * push, an offline device's wake-up flush) un-deleted the note. The guard
 * makes the upsert refuse exactly those writes:
 *
 *   1. a live write may not resurrect a tombstone unless strictly newer;
 *   2. a tombstone may not bury a strictly newer live row;
 *   3. ties go to the delete (the client merge's own tie rule);
 *   4. a refused write still answers ok — the row exists, the server's
 *      state is the truth being pushed.
 */
import { applySchema, createDb, type Db } from '../server/db';
import { handleNotesPut } from '../server/notes';
import type { SessionUser } from '../server/auth';

const FILE = `/tmp/padify-delete-guard-${Date.now()}.db`;

async function open(): Promise<Db> {
  process.env.TURSO_DATABASE_URL = `file:${FILE}`;
  process.env.TURSO_AUTH_TOKEN = '';
  return createDb();
}

const USER: SessionUser = { id: 'u1', email: 'x@y.z' };

const row = (overrides: Record<string, unknown>) => ({
  id: 'n1',
  name: 'the note',
  content: '<p>v1</p>',
  position: 0,
  created_at: 100,
  updated_at: 1_000,
  deleted: false,
  note_type: null,
  ...overrides,
});

async function put(db: Db, incoming: Record<string, unknown>): Promise<number> {
  const request = new Request('https://api.local/api/notes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 2, rows: [row(incoming)] }),
  });
  const response = await handleNotesPut(db, request, USER);
  return response.status;
}

async function state(db: Db): Promise<{ deleted: boolean; content: string }> {
  const rows = await db.all('select deleted, content from notes where id = ?', ['n1']);
  if (rows.length === 0) {
    return { deleted: false, content: '(absent)' };
  }
  return { deleted: Number(rows[0]!.deleted) === 1, content: String(rows[0]!.content ?? '') };
}

const db = await open();
await applySchema(db);
// sync_counters carries a foreign key on users — the account must exist.
await db.run(
  `insert into users (id, email, password_hash, created_at) values ('u1', 'x@y.z', 'h', 0)`,
);

let failed = 0;
const check = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failed += 1;
};

// The base: a live note, edited at t=1000.
let status = await put(db, {});
check('the base live push lands (200)', status === 200);
check('the note is live', (await state(db)).deleted === false);

// The close: a tombstone at t=2000.
status = await put(db, { deleted: true, content: '', updated_at: 2_000 });
check('the tombstone push lands (200)', status === 200);
check('the note is deleted', (await state(db)).deleted === true);

// The re-publish: another window pushes the note live again with its
// PRE-close edit time — the exact bytes the closer just deleted.
status = await put(db, { deleted: false, content: '<p>v1</p>', updated_at: 1_000 });
check('the stale re-publish still answers ok', status === 200);
check('the stale re-publish does NOT resurrect the note', (await state(db)).deleted === true);

// A tie: same clock as the tombstone.
status = await put(db, { deleted: false, content: '<p>v1</p>', updated_at: 2_000 });
check(
  'an equal-clock live push stays deleted (tie goes to the delete)',
  (await state(db)).deleted === true,
);

// A real edit made after the close: strictly newer, live.
status = await put(db, {
  deleted: false,
  content: '<p>edited after the close</p>',
  updated_at: 3_000,
});
check('the post-close edit push lands (200)', status === 200);
let now = await state(db);
check('the post-close edit resurrects the note', now.deleted === false);
check(
  'the resurrected note carries the edited bytes',
  now.content === '<p>edited after the close</p>',
);

// A stale tombstone: someone closes at t=1000, long before the t=3000 edit.
status = await put(db, { deleted: true, content: '', updated_at: 1_000 });
check('the stale tombstone still answers ok', status === 200);
check('a stale tombstone may not bury the newer edit', (await state(db)).deleted === false);

// A tie the other way: tombstone at exactly the edit's clock.
status = await put(db, { deleted: true, content: '', updated_at: 3_000 });
check(
  'an equal-clock tombstone deletes (tie goes to the delete)',
  (await state(db)).deleted === true,
);

// The pull side: after refusals and gaps, the v2 pull must still deliver
// the truth (deleted=1) to a fresh cursor, and nothing past the max seq.
const pullRequest = new Request('https://api.local/api/notes?v=2&cursor=0');
const { handleNotesGet } = await import('../server/notes');
const pull = await handleNotesGet(db, pullRequest, USER);
const payload = (await pull.json()) as {
  rows: { id: string; deleted: boolean; seq: number }[];
  order: string[];
  cursor: number;
};
check(
  'the v2 pull delivers the tombstone to a fresh cursor',
  payload.rows.some((entry) => entry.id === 'n1' && entry.deleted === true),
);
check('the deleted note is absent from the live order', !payload.order.includes('n1'));

process.exit(failed === 0 ? 0 : 1);
