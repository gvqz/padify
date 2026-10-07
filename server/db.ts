/**
 * Padify API — database layer.
 *
 * Two interchangeable backends behind one tiny interface, both speaking the
 * same SQLite dialect (so schema and queries are identical):
 *
 *  • Turso (libSQL) over its HTTP API — used when TURSO_DATABASE_URL points
 *    at a libsql://… or https://… database. This is the production path.
 *  • A local SQLite file via bun:sqlite — used when the URL is file:… (or
 *    unset). This is the zero-setup development path; the database lives at
 *    server/local.db and is created on first boot.
 */

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/** One parameterised statement; results are ignored (write path only). */
export interface SqlStatement {
  sql: string;
  args?: SqlValue[];
}

export interface Db {
  all(sql: string, args?: SqlValue[]): Promise<Row[]>;
  run(sql: string, args?: SqlValue[]): Promise<void>;
  /**
   * Executes many statements in as few round-trips as possible — one Turso
   * pipeline request (chunked to stay under per-request statement limits),
   * one local transaction. Rows arrive in one network hop instead of one
   * per row, which matters for sync pushes on an always-on host.
   */
  runMany(statements: SqlStatement[]): Promise<void>;
  /** Human-readable kind for boot logs. */
  readonly kind: string;
  /**
   * Releases backend resources (the local file handle). Optional: the
   * HTTP backend holds nothing to release. Called by the shutdown path
   * after in-flight requests have drained.
   */
  close?(): void;
}

// ---------------------------------------------------------------------------
// Turso over HTTP (POST /v2/pipeline)
// ---------------------------------------------------------------------------

interface TursoStmt {
  type: 'execute' | 'close';
  stmt?: { sql: string; args?: unknown[] };
}

interface TursoArg {
  type: 'null' | 'integer' | 'float' | 'text';
  value?: string;
}

/**
 * A cell as the Hrana-over-HTTP pipeline actually delivers it: a typed
 * object, with numbers serialised as strings ("42"), never the bare JSON
 * scalar a naive reading of the API examples suggests. Plain scalars are
 * still accepted defensively so local mocks keep working.
 */
interface HranaCell {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string;
  base64?: string;
}

/** Hrana cell → plain SqlValue (integer/float become real numbers). */
function fromTursoCell(cell: unknown): SqlValue {
  if (cell === null || cell === undefined) {
    return null;
  }
  if (typeof cell === 'object' && 'type' in (cell as Record<string, unknown>)) {
    const typed = cell as HranaCell;
    if (typed.type === 'null') {
      return null;
    }
    if (typed.type === 'text') {
      return typeof typed.value === 'string' ? typed.value : String(typed.value ?? '');
    }
    if (typed.type === 'integer' || typed.type === 'float') {
      const parsed = Number(typed.value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typed.type === 'blob') {
      // No table stores BLOBs (attachments are base64 TEXT — see schema);
      // keep the bytes lossless in text form rather than lying with null.
      return typed.base64 ?? null;
    }
    return null;
  }
  if (typeof cell === 'string' || typeof cell === 'number') {
    return cell;
  }
  return null;
}

function toTursoArg(value: SqlValue): TursoArg {
  if (value === null) {
    return { type: 'null' };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value: String(value) };
  }
  return { type: 'text', value };
}

class TursoHttpDb implements Db {
  readonly kind = 'turso';

  /** Stay well under Turso's per-pipeline-request statement limit. */
  private static readonly CHUNK = 100;

  /**
   * Every request funnels through this one fetch. Without a deadline, a
   * wedged Turso connection hangs every request that touches the database
   * forever (Bun.serve has no per-request timeout of its own) — a panel
   * restart becomes the only recovery, and users see a dead API instead
   * of an error they can retry.
   */
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  constructor(private endpoint: string, private token: string) {}

  private async pipeline(statements: TursoStmt[]): Promise<Row[][]> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ requests: statements }),
        signal: AbortSignal.timeout(TursoHttpDb.REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      // AbortSignal.timeout aborts as a DOMException named TimeoutError
      // (older runtimes may surface AbortError) — and DOMException is not
      // an Error subclass in every runtime, so read the name without
      // instanceof. This fetch is never aborted any other way, so both
      // names mean the deadline hit.
      const name = (error as { name?: unknown } | null | undefined)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new Error(
        timedOut
          ? `Turso request timed out after ${TursoHttpDb.REQUEST_TIMEOUT_MS / 1000}s`
          : `Turso is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Turso request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      results: Array<{
        type: 'ok' | 'error';
        response?: { result?: { cols: Array<{ name: string }>; rows: unknown[][] } };
        error?: { message: string };
      }>;
    };

    const tables: Row[][] = [];
    for (const result of payload.results ?? []) {
      if (result.type === 'error') {
        throw new Error(`Turso query failed: ${result.error?.message ?? 'unknown error'}`);
      }
      const query = result.response?.result;
      if (!query) {
        tables.push([]);
        continue;
      }
      const names = query.cols.map(column => column.name);
      tables.push(query.rows.map(row => {
        const rowObject: Row = {};
        names.forEach((name, index) => {
          rowObject[name] = fromTursoCell(row[index]);
        });
        return rowObject;
      }));
    }
    return tables;
  }

  async all(sql: string, args: SqlValue[] = []): Promise<Row[]> {
    const [table] = await this.pipeline([
      { type: 'execute', stmt: { sql, args: args.map(toTursoArg) } },
      { type: 'close' }
    ]);
    return table ?? [];
  }

  async run(sql: string, args: SqlValue[] = []): Promise<void> {
    await this.pipeline([
      { type: 'execute', stmt: { sql, args: args.map(toTursoArg) } },
      { type: 'close' }
    ]);
  }

  async runMany(statements: SqlStatement[]): Promise<void> {
    for (let offset = 0; offset < statements.length; offset += TursoHttpDb.CHUNK) {
      const chunk = statements.slice(offset, offset + TursoHttpDb.CHUNK);
      const requests: TursoStmt[] = chunk.map(statement => ({
        type: 'execute',
        stmt: { sql: statement.sql, args: (statement.args ?? []).map(toTursoArg) }
      }));
      requests.push({ type: 'close' });
      await this.pipeline(requests);
    }
  }
}

// ---------------------------------------------------------------------------
// Local SQLite file (bun:sqlite)
// ---------------------------------------------------------------------------

// Type-only: the runtime import stays dynamic (see createDb) so nothing
// bun-specific loads unless the local backend is actually chosen. The
// field is typed as the real Database instead of a hand-rolled structural
// stand-in — the stand-in drifted from bun-types' signatures.
import type { Database } from 'bun:sqlite';

class LocalSqliteDb implements Db {
  readonly kind = 'sqlite-file';

  constructor(private db: Database) {}

  close(): void {
    this.db.close();
  }

  private normalize(args: SqlValue[]): import('bun:sqlite').SQLQueryBindings[] {
    return args.map(value => (value === undefined ? null : value));
  }

  async all(sql: string, args: SqlValue[] = []): Promise<Row[]> {
    return this.db.query(sql).all(...this.normalize(args)) as Row[];
  }

  async run(sql: string, args: SqlValue[] = []): Promise<void> {
    this.db.query(sql).run(...this.normalize(args));
  }

  async runMany(statements: SqlStatement[]): Promise<void> {
    const execute = (): void => {
      for (const statement of statements) {
        this.db.query(statement.sql).run(...this.normalize(statement.args ?? []));
      }
    };
    if (this.db.transaction) {
      this.db.transaction(execute)();
    } else {
      execute();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createDb(): Promise<Db> {
  const url = (process.env.TURSO_DATABASE_URL ?? '').trim();

  if (/^(libsql|https?|wss?):\/\//i.test(url)) {
    const token = (process.env.TURSO_AUTH_TOKEN ?? '').trim();
    if (!token) {
      throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a Turso database.');
    }
    const httpUrl = url.replace(/^libsql:\/\//i, 'https://').replace(/^wss:\/\//i, 'https://').replace(/\/+$/, '');
    const endpoint = /\/v2\/pipeline$/.test(httpUrl) ? httpUrl : `${httpUrl}/v2/pipeline`;
    console.log(`[padify-api] database: Turso (${httpUrl})`);
    return new TursoHttpDb(endpoint, token);
  }

  if (url && !/^file:/i.test(url)) {
    throw new Error(`Unsupported TURSO_DATABASE_URL: ${url} (expected libsql://, https:// or file:)`);
  }

  // Dev fallback: a local SQLite file next to this source file.
  // The specifier rides a variable so vite's import analysis (vitest loads
  // this module too) leaves it alone — it only resolves under Bun, where
  // this branch actually runs.
  const bunSqlite = 'bun:sqlite';
  const { Database } = await import(/* @vite-ignore */ bunSqlite);
  const file = url ? url.replace(/^file:/i, '') : new URL('./local.db', import.meta.url).pathname;
  const db = new Database(file, { create: true });
  db.exec('pragma journal_mode = wal;');
  // SQLite needs PRAGMA foreign_keys = ON per-connection to enforce the
  // `references users(id) on delete cascade` clauses on sessions/notes/shares
  // — without this, deleting a user row orphans every dependent row. Turso
  // (libSQL) enforces FKs by default; this matches the local backend to that.
  db.exec('pragma foreign_keys = on;');
  console.log(`[padify-api] database: local SQLite file (${file})`);
  return new LocalSqliteDb(db);
}

/** Applies server/schema.sql (idempotent — every statement is IF NOT EXISTS). */
export async function applySchema(db: Db): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
  const schema = readFileSync(schemaPath, 'utf8');
  // Strip comments first (they may contain semicolons), then split.
  const withoutComments = schema.replace(/--[^\n]*/g, '');
  const statements = withoutComments
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.run(statement);
  }

  await migrateColumns(db);
  await migrateRenames(db);
  await migrateSyncCounters(db);
}

/**
 * Column migrations for databases created before a column existed —
 * `create table if not exists` cannot add columns to an existing table.
 * Each entry runs an ALTER TABLE only when PRAGMA reports the column
 * missing, so startup stays idempotent on every database state.
 */
const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  // note_type carries the note kind (rich text, a future type, …); null = standard.
  { table: 'notes', column: 'note_type', definition: 'text' },
  // Shares carry the note's type alongside the denormalised content so the
  // public viewer can render by kind (see public/share/share.js).
  { table: 'shares', column: 'note_type', definition: 'text' },
  // Sync v2's per-user change sequence, stamped on every notes write; the
  // default 0 marks rows a seq-stamping build has never written.
  { table: 'notes', column: 'seq', definition: 'integer not null default 0' }
];

async function migrateColumns(db: Db): Promise<void> {
  for (const { table, column, definition } of REQUIRED_COLUMNS) {
    const rows = await db.all(`pragma table_info(${table})`);
    const exists = rows.some(row => String(row.name) === column);
    if (!exists) {
      await db.run(`alter table ${table} add column ${column} ${definition}`);
      console.log(`[padify-api] schema migration: added ${table}.${column}`);
    }
  }
}

/**
 * Column renames for databases created before a rename — `create table if
 * not exists` cannot rename, and rewriting every row through a temp table
 * would be a migration for what SQLite can do in one statement. Each entry
 * renames only when PRAGMA reports the old name present AND the new name
 * absent, so startup stays idempotent on every database state: fresh
 * installs already have the new name (nothing to do), renamed databases
 * have the new name (nothing to do), and a database that somehow ended up
 * with BOTH keeps its `content` and ignores the stale `html` — the
 * application reads by the new name only.
 */
const RENAMED_COLUMNS: Array<{ table: string; from: string; to: string }> = [
  // The note content column was born `html` (that is all the first Padify
  // stored); the typed content model made the name a lie, and it is
  // `content` now — see src/tabs.ts, NoteTab.content.
  { table: 'notes', from: 'html', to: 'content' },
  // Shares carry the same denormalised content; same story.
  { table: 'shares', from: 'html', to: 'content' }
];

async function migrateRenames(db: Db): Promise<void> {
  for (const { table, from, to } of RENAMED_COLUMNS) {
    const rows = await db.all(`pragma table_info(${table})`);
    const names = new Set(rows.map(row => String(row.name)));
    if (names.has(from) && !names.has(to)) {
      await db.run(`alter table ${table} rename column ${from} to ${to}`);
      console.log(`[padify-api] schema migration: renamed ${table}.${from} -> ${table}.${to}`);
    }
  }
}

/**
 * Seeds sync_counters from each user's highest stamped seq, once per user.
 *
 * The reservation in handleNotesPut only ever INCREASES a counter, so the
 * one thing this must guarantee is that no counter starts BELOW the seqs
 * its user already carries — otherwise a reservation could hand out a
 * number a row already owns, and two different versions would tie forever.
 * `insert or ignore` keeps it idempotent: fresh installs seed empty sets
 * (nothing to do), migrated users seed once, and already-seeded boots are
 * untouched no matter how many times it runs. Users who never wrote a
 * stamped row seed at 0 — their first reservation starts the sequence.
 */
async function migrateSyncCounters(db: Db): Promise<void> {
  await db.run(
    `insert or ignore into sync_counters (user_id, value)
     select user_id, coalesce(max(seq), 0) from notes group by user_id`
  );
}
