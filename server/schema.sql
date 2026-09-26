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

-- ---------------------------------------------------------------------------
-- Notes (the tabs on the main page) — created_at/updated_at are client epoch
-- milliseconds; deleted rows are tombstones.
-- ---------------------------------------------------------------------------

create table if not exists notes (
  id         text primary key,
  user_id    text not null,
  name       text,
  html       text not null default '',
  position   integer not null default 0,
  created_at integer not null default 0,
  updated_at integer not null default 0,
  deleted    integer not null default 0,
  note_type  text
);

create index if not exists notes_user_id_idx on notes(user_id);

-- ---------------------------------------------------------------------------
-- Shares (read-only note links — /share/?t=<token>).
--
-- The html column is a denormalised copy of the note at share time; the app
-- keeps it fresh while the note is edited. Viewers are anonymous: the public
-- endpoint only ever returns rows that are neither revoked nor expired.
-- ---------------------------------------------------------------------------

create table if not exists shares (
  token      text primary key,
  user_id    text not null,
  note_id    text,
  title      text not null default '',
  html       text not null default '',
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
