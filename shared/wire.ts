/**
 * The note-sync wire contract — the ONE place both sides of the HTTP
 * boundary read from: the client sync layer (src/cloud/sync.ts) and the
 * API (server/notes.ts, server/http.ts).
 *
 * Before this module, each side hand-copied the shapes and they drifted:
 * the client's row carried user_id (which the server's v2 pull never
 * sends and its PUT parser deliberately ignores — the owner comes from
 * the session, never the payload), and the request-body ceiling was
 * mirrored as two constants kept equal by hope.
 *
 * Rules for this file, so it compiles under BOTH tsconfigs (client: DOM
 * libs; server: Bun): types plus pure constants only — no runtime
 * behavior, no imports. The client imports the constant at runtime (Vite
 * bundles it); the server imports it at runtime too (Bun resolves the
 * path). Neither side imports the other.
 */

/**
 * A row of a PUT /api/notes body — what the server's parseNoteRows
 * accepts. The owner (user_id) is NOT a field: it comes from the session,
 * never from the payload — a client that could name its owner would be a
 * cross-user write.
 *
 * The note's body travels under `content` only. The rename transition's
 * legacy twin: v1 clients may send `html` instead; the server's parser
 * reads either and prefers `content`. Modern clients emit `content` only.
 */
export interface IncomingNoteRow {
  id: string;
  name: string | null;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  /**
   * Trash: when the note was trashed (client epoch ms), carried only by
   * deleted rows from trash-aware builds. Live rows send null/0/undefined —
   * any of the three stores null. Pre-trash clients sent nothing and their
   * deletes stay plain tombstones (content-less, swept on updated_at).
   */
  deleted_at?: number | null;
  /** The note kind; null = the default (standard). */
  note_type: string | null;
}

/** A row of a v2 pull's answer. user_id never crosses the wire. */
export interface PullRowV2 {
  id: string;
  name: string | null;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
  /** v2 answers a real boolean (v1 answered 0|1; the client normalizes). */
  deleted: boolean;
  /** Trash: when the note was trashed (epoch ms); null on live rows and
   *  on pre-trash tombstones. */
  deleted_at?: number | null;
  note_type: string | null;
  /** The server's sequence for this version of the row. */
  seq: number;
}

/** The GET /api/notes?v=2 answer: changed rows, the full order, the
 * next cursor. (See server/notes.ts handleNotesGet for the v1 shape —
 * it is the legacy transition and stays undocumented on purpose.) */
export interface NotesPullV2 {
  v: 2;
  rows: PullRowV2[];
  /** The full remote position order by id, unchanged rows included. */
  order: string[];
  /** The client's next cursor: everything at or below it has been seen. */
  cursor: number;
}

/**
 * The request-body ceiling the server enforces on JSON routes
 * (server/http.ts readJson). The client batches its pushes under it —
 * previously as a hand-mirrored constant whose sameness only e2e runs
 * would catch.
 */
export const MAX_BODY_BYTES = 2_000_000;

/**
 * The most rows one PUT /api/notes body may carry (server/notes.ts
 * parseNoteRows rejects anything over). The client's push batcher splits
 * on BOTH this cap and the byte cap: a queue of >500 small notes must
 * become several bodies, or the single oversized-count body would be
 * rejected on every sync cycle forever with no code path that shrinks it.
 */
export const MAX_ROWS_PER_PUSH = 500;

/**
 * The PUT /api/notes answer for trash-aware servers: the rows exactly as
 * they landed (id, seq, updated_at, deleted, deleted_at), so the client
 * can adopt its pushed state without waiting for the next pull to echo it
 * back. Pre-trash servers answered `{ ok: true }` — readers treat a missing
 * `rows` as "no adoption data" and fall back to the pull echo.
 */
export interface NotesPutV2 {
  ok: true;
  rows: Array<Pick<PullRowV2, 'id' | 'updated_at' | 'deleted' | 'deleted_at' | 'seq'>>;
}

/**
 * How long a trashed note stays restorable, on both sides of the wire.
 * The server sweeps its rows on boot; the client sweeps its local store the
 * same way, so a note trashed anywhere disappears everywhere after the
 * window passes — unless a device was offline the whole time, in which case
 * its local copy re-uploads on reconnect (the resurrect-on-sync edge case,
 * accepted: a 30-day-old recovery beating a clean slate is the safer tie).
 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Note type ids are url-safe slugs. Both sides enforce the same shape —
 * the client registry (src/editor/note-types.ts) and the server's border
 * parser (server/notes.ts) — or types would silently fall off notes at
 * the boundary. This constant is the one definition; the sides re-export
 * it from here.
 */
export const NOTE_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
