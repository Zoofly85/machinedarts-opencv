create table if not exists public.player_bots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  source_player_id text,
  display_name text not null,
  visibility text not null default 'public' check (visibility in ('public', 'private', 'club')),
  schema_version integer not null default 1,
  version integer not null default 1,
  stats_snapshot jsonb not null default '{}'::jsonb,
  bundle jsonb not null,
  bundle_hash text,
  legs_count integer not null default 0,
  average numeric,
  checkout_percentage numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists player_bots_visibility_updated_idx
  on public.player_bots (visibility, updated_at desc);

create index if not exists player_bots_owner_idx
  on public.player_bots (owner_user_id);

alter table public.player_bots enable row level security;

drop policy if exists "Public player bots are readable" on public.player_bots;
create policy "Public player bots are readable"
  on public.player_bots
  for select
  using (visibility = 'public' or auth.uid() = owner_user_id);

drop policy if exists "Players can create their own bots" on public.player_bots;
create policy "Players can create their own bots"
  on public.player_bots
  for insert
  with check (auth.uid() = owner_user_id);

drop policy if exists "Players can update their own bots" on public.player_bots;
create policy "Players can update their own bots"
  on public.player_bots
  for update
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Players can delete their own bots" on public.player_bots;
create policy "Players can delete their own bots"
  on public.player_bots
  for delete
  using (auth.uid() = owner_user_id);
