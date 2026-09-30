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
        body: JSON.stringify({ requests: statements })
      });
    } catch (error) {
      throw new Error(`Turso is unreachable: ${error instanceof Error ? error.message : String(error)}`);
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
          rowObject[name] = row[index] ?? null;
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

class LocalSqliteDb implements Db {
  readonly kind = 'sqlite-file';

  constructor(private db: {
    query: (sql: string) => { all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown };
    transaction?: (fn: () => void) => () => void;
  }) {}

  private normalize(args: SqlValue[]): unknown[] {
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
  const { Database } = await import('bun:sqlite');
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
  { table: 'shares', column: 'note_type', definition: 'text' }
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
