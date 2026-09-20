-- ===========================================================================
-- Padify cloud sync — database schema
--
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query)
-- while connected to the project you configured in src/cloud/config.ts.
--
-- Three tables:
--   public.notes     one row per note tab (tombstoned on delete)
--   public.drawings  one row per user: the drawing pad scene
--   public.shares    read-only share links (expiry + revoke, see below)
--
-- Row Level Security pins every row to its owner: users can only ever see
-- and change their own rows, using the public anon key. Shares additionally
-- expose their ACTIVE rows (not revoked, not expired) to anonymous viewers,
-- which is what makes /share/?t=<token> work without an account.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Notes (the tabs on the main page)
-- ---------------------------------------------------------------------------

create table if not exists public.notes (
  id         text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text,
  html       text not null default '',
  position   integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  deleted    boolean not null default false
);

comment on table public.notes is
  'Padify note tabs. created_at/updated_at are client epoch milliseconds; deleted rows are tombstones.';

-- Sync reads pull the whole list per user and filter by freshness.
create index if not exists notes_user_id_idx on public.notes (user_id);

-- ---------------------------------------------------------------------------
-- Drawings (the drawing pad scene, one row per user)
-- ---------------------------------------------------------------------------

create table if not exists public.drawings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  scene      jsonb not null,
  updated_at bigint not null default 0
);

-- ---------------------------------------------------------------------------
-- Shares (read-only note links — /share/?t=<token>)
--
-- The html column is a denormalised copy of the note at share time; the app
-- keeps it fresh while the note is edited. Viewers are anonymous, so access
-- is decided entirely by RLS: a row is readable only while it is neither
-- revoked nor expired.
-- ---------------------------------------------------------------------------

create table if not exists public.shares (
  token      text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  note_id    text,
  title      text not null default '',
  html       text not null default '',
  created_at bigint not null default 0,
  expires_at timestamptz not null,
  revoked    boolean not null default false
);

comment on table public.shares is
  'Padify share links. token is a random url-safe string; anonymous viewers may read rows that are not revoked and not expired (see RLS below).';

create index if not exists shares_user_id_idx on public.shares (user_id);
create index if not exists shares_note_id_idx on public.shares (note_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — each account only ever touches its own rows
-- ---------------------------------------------------------------------------

alter table public.notes    enable row level security;
alter table public.drawings enable row level security;

drop policy if exists "Users manage their own notes" on public.notes;
create policy "Users manage their own notes"
  on public.notes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage their own drawing" on public.drawings;
create policy "Users manage their own drawing"
  on public.drawings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Owners manage their links (list, create, cancel, refresh content).
drop policy if exists "Users manage their own shares" on public.shares;
create policy "Users manage their own shares"
  on public.shares
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Anyone holding the link may READ it — but only while it is live. Expired
-- and cancelled rows vanish from anonymous reads (the viewer page then says
-- the link is no longer available).
drop policy if exists "Anyone can view active shares" on public.shares;
create policy "Anyone can view active shares"
  on public.shares
  for select
  to anon, authenticated
  using (revoked = false and expires_at > now());
