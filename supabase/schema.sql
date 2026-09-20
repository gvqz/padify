-- ===========================================================================
-- Padify cloud sync — database schema
--
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query)
-- while connected to the project you configured in src/cloud/config.ts.
--
-- Two tables:
--   public.notes     one row per note tab (tombstoned on delete)
--   public.drawings  one row per user: the drawing pad scene
--
-- Row Level Security pins every row to its owner: users can only ever see
-- and change their own rows, using the public anon key.
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
