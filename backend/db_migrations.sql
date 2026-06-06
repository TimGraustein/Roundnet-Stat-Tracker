-- Database changes applied to Supabase for the accounts + stats + touch-type work.
-- Applied via the Supabase migration API; recorded here so the repo is self-contained.
-- All statements are idempotent and safe to re-run.

-- 1) Row Level Security: public read, authenticated write -------------------
-- Reads use the publishable (anon) key; writes use a per-request client that
-- carries the user's JWT (authenticated role). No DELETE policies => deletes
-- are denied (the app flags bad games instead of deleting).
do $$
declare t text;
begin
  foreach t in array array[
    'team','player','game','rally','rally_touch','stat','team_game','team_player','touch_type'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_public_select', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t||'_public_select', t);
  end loop;

  -- INSERT allowed for any authenticated user ("any logged-in user can record").
  foreach t in array array[
    'team','player','game','rally','rally_touch','stat','team_game','team_player'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t||'_auth_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (true)', t||'_auth_insert', t);
  end loop;
end $$;

-- UPDATE only where the app actually updates.
drop policy if exists game_auth_update on public.game;
create policy game_auth_update on public.game for update to authenticated using (true) with check (true);
drop policy if exists stat_auth_update on public.stat;
create policy stat_auth_update on public.stat for update to authenticated using (true) with check (true);

-- player UPDATE is restricted: you may only touch unclaimed or your-own rows,
-- and user_id may only be null or your own uid (prevents claim hijacking).
drop policy if exists player_auth_update on public.player;
create policy player_auth_update on public.player
  for update to authenticated
  using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());

-- 2) Touch types (rally outcome tagging) ------------------------------------
insert into public.touch_type (touch_type_name)
select v.name from (values ('kill'), ('error'), ('ace')) as v(name)
where not exists (select 1 from public.touch_type t where t.touch_type_name = v.name);

-- Note: public.player.user_id (uuid, nullable, references auth.users) is the
-- claim link and already existed prior to this work.
