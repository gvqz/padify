-- ===========================================================================
-- Padify API — database schema (SQLite / Turso dialect)
--
-- Apply to a Turso database with:
--   turso db shell <database-name> < server/schema.sql
--
-- The API server also runs this schema automatically at startup, so manual
-- application is only needed when the database user differs from the one the
-- server uses.
--
-- Tables:
--   users     email + scrypt password hash (auth is handled by the API)
--   sessions  bearer tokens (stored hashed) — one per signed-in device
--   notes     one row per note tab (tombstoned on delete)
--   shares    read-only share links with expiry + revoke
--   attachments  user-scoped binary blobs (voice notes and future media)
-- ===========================================================================

create table if not exists users (
  id            text primary key,
  email         text not null unique,
  password_hash text not null,
  created_at    integer not null
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);

create index if not exists sessions_user_id_idx on sessions(user_id);
-- Boot-time sweep (delete from sessions where expires_at <= ?) is a full table
-- scan without this index; sessions grow by one row per login.
create index if not exists sessions_expires_at_idx on sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Notes (the tabs on the main page) — created_at/updated_at are client epoch
-- milliseconds; deleted rows are tombstones.
-- ---------------------------------------------------------------------------

create table if not exists notes (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  name       text,
  content    text not null default '',
  position   integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0,
  deleted    integer not null default 0,
  note_type  text,
  -- Sync v2: a per-user monotonic sequence, stamped by the server on every
  -- write. Ordering and incremental pulls key off it (see handlers.ts);
  -- 0 = never written by a seq-stamping build (delivered unconditionally).
  seq        integer not null default 0
);

create index if not exists notes_user_id_idx on notes(user_id);
-- Sync v2's incremental pull filters on (user_id, seq) and the position
-- convergence read walks (user_id, position).
create index if not exists notes_user_id_seq_idx on notes(user_id, seq);
create index if not exists notes_user_id_position_idx on notes(user_id, position);

-- ---------------------------------------------------------------------------
-- Sync v2's sequence source — the CAS counter the stamping build deferred.
--
-- Every PUT reserves its batch's numbers with ONE atomic statement
-- (insert … on conflict do update … returning — see handlers.ts), so two
-- racing pushes can never read the same base and hand out identical
-- numbers. Reserved numbers always advance, even if a batch's writes
-- never land: the sequence may gap, but it can never repeat — a gap is
-- invisible to a cursor, a repeat is a lie about which version is newer.
--
-- Seeded from max(notes.seq) per user by the boot migration (see
-- db.ts migrateSyncCounters); users cascade like their notes do.
-- ---------------------------------------------------------------------------
create table if not exists sync_counters (
  user_id text primary key references users(id) on delete cascade,
  value   integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Shares (read-only note links — /share/?t=<token>).
--
-- The content column is a denormalised copy of the note at share time and
-- note_type carries the note's type, so the public viewer can render by
-- kind (sanitized HTML for the classic types, raw text for everything
-- else — see public/share/share.js); the app keeps both fresh while the
-- note is edited. Viewers are anonymous: the public endpoint only ever
-- returns rows that are neither revoked nor expired.
-- ---------------------------------------------------------------------------

create table if not exists shares (
  token      text primary key,
  user_id    text not null references users(id) on delete cascade,
  note_id    text,
  title      text not null default '',
  content    text not null default '',
  note_type  text,
  created_at integer not null default 0,
  expires_at integer not null,
  revoked    integer not null default 0
);

create index if not exists shares_user_id_idx on shares(user_id);
create index if not exists shares_note_id_idx on shares(note_id);

-- ---------------------------------------------------------------------------
-- Free music stream resolutions (yt-dlp → googlevideo URLs).
--
-- Keyed by Spotify track id. The cached URL is a time-limited googlevideo
-- link (~6h lifetime), so expires_at drives both the re-resolve decision
-- and the boot-time sweep. Rows are tiny (~1 KB) and capped in practice by
-- usage + the daily cleanup in server/index.ts.
-- ---------------------------------------------------------------------------

create table if not exists music_resolutions (
  key          text primary key,
  video_id     text not null,
  url          text not null,
  duration_sec integer,
  resolved_at  integer not null default 0,
  expires_at   integer not null
);

-- ---------------------------------------------------------------------------
-- Attachments (user-scoped binary blobs — voice notes and future media).
--
-- The bytes are stored base64-encoded in a TEXT column on purpose: the
-- Turso HTTP pipeline in db.ts speaks string/number/null arguments only,
-- and base64 text provably round-trips through BOTH backends (local
-- bun:sqlite and Turso) with one code path. The 4/3 size penalty is
-- bounded by the upload cap (see attachments.ts); if native BLOB
-- arguments ever get wired into the Turso layer, migrating data → BLOB
-- is a mechanical one-off.
--
-- `id` is chosen by the CLIENT (x-padify-id) so an upload retry after a
-- dropped connection is idempotent: the server answers 200 for an
-- identical (id, sha256) pair and 409 for a collision. There is no
-- note→attachment linkage yet — features that reference attachments
-- own their garbage collection; deleting a user cascades.
-- ---------------------------------------------------------------------------

create table if not exists attachments (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  name       text not null default '',
  mime       text not null default 'application/octet-stream',
  size       integer not null,
  sha256     text not null,
  data       text not null,
  created_at integer not null
);

create index if not exists attachments_user_id_idx on attachments(user_id, created_at);
