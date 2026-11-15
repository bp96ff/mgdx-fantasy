-- MGDX Fantasy accounts: each site account is linked to one manager with a one-time claim code.
-- Paste into the Supabase SQL editor and run. Safe to run again after changes.
--
-- Who can do what:
--   anyone              read managers and season_teams (the same names the site already shows)
--   signed in           claim a code once, read their own profile
--   member              a signed-in account linked to a manager in the current season; reads every profile
--   moderator           a member whose manager has is_moderator; gets extra powers on blog tables later
-- The current season is the latest one in season_teams, so loading a new season's seed
-- (tools/build-supabase-seed.js) ends membership for managers who didn't return.

-- ---------- tables ----------
create table if not exists public.managers (
  id text primary key,                 -- lowercase name, e.g. 'hoai-nha'; stays the same every season
  name text not null,
  is_moderator boolean not null default false
);

create table if not exists public.season_teams (
  season int not null,
  league text not null,                -- league slug, e.g. 'lab-rats'
  team_id int not null,                -- ESPN team id in that league
  team_name text not null,
  manager_id text not null references public.managers (id) on update cascade,
  primary key (season, league, team_id),
  unique (season, manager_id)
);

-- One code per manager. Not readable from the site; see new_claim_codes() and supabase/README.md.
create table if not exists public.claim_codes (
  code text primary key,               -- e.g. 'LR-7KQ2XM'
  manager_id text not null unique references public.managers (id) on update cascade on delete cascade,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);

-- One account per manager, one manager per account.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  manager_id text not null unique references public.managers (id) on update cascade,
  claimed_at timestamptz not null default now()
);

-- Every code attempt, so guessing is limited to 10 tries an hour per account.
create table if not exists public.claim_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists claim_attempts_user_at on public.claim_attempts (user_id, at);

-- ---------- helpers (also used by the blog's access rules later) ----------
create or replace function public.current_season() returns int
language sql stable security definer set search_path = public as $$
  select max(season) from season_teams
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    join season_teams s on s.manager_id = p.manager_id and s.season = current_season()
    where p.user_id = auth.uid()
  )
$$;

create or replace function public.is_moderator() returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and exists (
    select 1 from profiles p join managers m on m.id = p.manager_id
    where p.user_id = auth.uid() and m.is_moderator
  )
$$;

-- The signed-in account's manager and this season's team, or null before a code is claimed.
-- league is null when the manager isn't in the current season.
create or replace function public.me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'manager_id', m.id, 'name', m.name, 'moderator', m.is_moderator, 'season', current_season(),
    'league', s.league, 'team_id', s.team_id, 'team_name', s.team_name)
  from profiles p
  join managers m on m.id = p.manager_id
  left join season_teams s on s.manager_id = m.id and s.season = current_season()
  where p.user_id = auth.uid()
$$;

-- Links the signed-in account to the code's manager. Returns me() on success or {error: ...}:
-- signed-out, already-linked, too-many, bad-code, used, not-current.
create or replace function public.claim_code(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c claim_codes;
  clean text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if uid is null then return json_build_object('error', 'signed-out'); end if;
  if exists (select 1 from profiles where user_id = uid) then return json_build_object('error', 'already-linked'); end if;
  if (select count(*) from claim_attempts where user_id = uid and at > now() - interval '1 hour') >= 10 then
    return json_build_object('error', 'too-many');
  end if;
  insert into claim_attempts (user_id) values (uid);
  select * into c from claim_codes where replace(code, '-', '') = clean;
  if not found then return json_build_object('error', 'bad-code'); end if;
  if c.used_by is not null or exists (select 1 from profiles where manager_id = c.manager_id) then
    return json_build_object('error', 'used');
  end if;
  if not exists (select 1 from season_teams where manager_id = c.manager_id and season = current_season()) then
    return json_build_object('error', 'not-current');
  end if;
  insert into profiles (user_id, manager_id) values (uid, c.manager_id);
  update claim_codes set used_by = uid, used_at = now() where code = c.code;
  return me();
end
$$;

-- Makes a code for every current manager who has neither a code nor a linked account, and returns
-- every current manager's code and whether it's been used. Run from the SQL editor only.
create or replace function public.new_claim_codes()
returns table (league text, manager text, code text, claimed boolean)
language plpgsql security definer set search_path = public, extensions as $$
-- The returned columns (league, manager, code) share names with table columns; inside queries, mean the columns.
#variable_conflict use_column
declare
  r record;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O, 1/I/L
  c text;
begin
  for r in
    select s.manager_id, s.league from season_teams s
    where s.season = current_season()
      and not exists (select 1 from claim_codes k where k.manager_id = s.manager_id)
      and not exists (select 1 from profiles p where p.manager_id = s.manager_id)
  loop
    loop
      c := (select string_agg(left(w, 1), '') from regexp_split_to_table(upper(r.league), '-') w) || '-' ||
           (select string_agg(substr(alphabet, 1 + get_byte(b, i) % length(alphabet), 1), '')
              from (select gen_random_bytes(6) b) x, generate_series(0, 5) i);
      exit when not exists (select 1 from claim_codes where code = c);
    end loop;
    insert into claim_codes (code, manager_id) values (c, r.manager_id);
  end loop;
  return query
    select s.league, m.name, k.code, (k.used_by is not null or p.user_id is not null)
    from season_teams s
    join managers m on m.id = s.manager_id
    left join claim_codes k on k.manager_id = s.manager_id
    left join profiles p on p.manager_id = s.manager_id
    where s.season = current_season()
    order by s.league, m.name;
end
$$;

-- ---------- access ----------
alter table public.managers enable row level security;
alter table public.season_teams enable row level security;
alter table public.claim_codes enable row level security;     -- no policies: never readable from the site
alter table public.profiles enable row level security;
alter table public.claim_attempts enable row level security;  -- no policies

drop policy if exists "managers are public" on public.managers;
create policy "managers are public" on public.managers for select using (true);
drop policy if exists "season teams are public" on public.season_teams;
create policy "season teams are public" on public.season_teams for select using (true);
drop policy if exists "own profile, or all for members" on public.profiles;
create policy "own profile, or all for members" on public.profiles for select
  using (user_id = auth.uid() or public.is_member());

-- What the site's roles can reach. Listed here so nothing depends on Supabase's "automatically expose new
-- tables" setting; tables not named (claim_codes, claim_attempts) stay unreachable from the site.
grant usage on schema public to anon, authenticated;
grant select on public.managers, public.season_teams to anon, authenticated;
grant select on public.profiles to authenticated;
grant execute on function public.current_season(), public.is_member(), public.is_moderator() to anon, authenticated;
revoke all on public.claim_codes, public.claim_attempts from anon, authenticated;
revoke insert, update, delete on public.managers, public.season_teams, public.profiles from anon, authenticated;

-- Functions in public can be called by anyone through the API unless revoked.
revoke execute on function public.new_claim_codes() from public, anon, authenticated;
revoke execute on function public.claim_code(text) from public, anon;
grant execute on function public.claim_code(text) to authenticated;
revoke execute on function public.me() from public, anon;
grant execute on function public.me() to authenticated;

-- ---------- custom team logos ----------
-- A manager can upload their own logo; it replaces the ESPN one wherever this season's team appears.
-- The file lives in the public team-logos bucket under <manager id>/; team_logos says which file is current.
-- A moderator (or the manager) can clear it, which brings back the ESPN logo.
create table if not exists public.team_logos (
  manager_id text primary key references public.managers (id) on update cascade on delete cascade,
  path text not null,                  -- inside the team-logos bucket, e.g. 'bryce/1763251200000.webp'
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
alter table public.team_logos enable row level security;  -- no policies: read and change through the functions below
revoke all on public.team_logos from anon, authenticated;

-- The signed-in member's manager id, or null for anyone who isn't a manager this season.
create or replace function public.my_manager_id() returns text
language sql stable security definer set search_path = public as $$
  select p.manager_id from profiles p
  join season_teams s on s.manager_id = p.manager_id and s.season = current_season()
  where p.user_id = auth.uid()
$$;

-- Every custom logo for this season's teams. Public: the site draws them for every visitor.
create or replace function public.current_team_logos()
returns table (league text, team_id int, path text)
language sql stable security definer set search_path = public as $$
  select s.league, s.team_id, l.path
  from team_logos l
  join season_teams s on s.manager_id = l.manager_id and s.season = current_season()
$$;

-- Makes an uploaded file the signed-in manager's logo. Returns the file it replaced (or null) so the
-- site can delete it.
create or replace function public.set_team_logo(p_path text) returns text
language plpgsql security definer set search_path = public as $$
declare
  mid text := my_manager_id();
  old text;
begin
  if mid is null then raise exception 'Only this season''s managers can set a logo'; end if;
  if p_path is null or left(p_path, length(mid) + 1) <> mid || '/' or p_path like '%..%' then
    raise exception 'That isn''t your logo file';
  end if;
  select path into old from team_logos where manager_id = mid;
  insert into team_logos (manager_id, path, updated_by) values (mid, p_path, auth.uid())
  on conflict (manager_id) do update set path = excluded.path, updated_at = now(), updated_by = excluded.updated_by;
  return old;
end
$$;

-- Goes back to the ESPN logo for a team this season. Its manager or any moderator can. Returns the file that
-- was in use (or null) so the site can delete it.
create or replace function public.clear_team_logo(p_league text, p_team_id int) returns text
language plpgsql security definer set search_path = public as $$
declare
  mid text;
  old text;
begin
  select manager_id into mid from season_teams
  where season = current_season() and league = p_league and team_id = p_team_id;
  if mid is null then raise exception 'No such team this season'; end if;
  if not (is_moderator() or mid = my_manager_id()) then
    raise exception 'Only the team''s manager or a moderator can do that';
  end if;
  delete from team_logos where manager_id = mid returning path into old;
  return old;
end
$$;

revoke execute on function public.my_manager_id(), public.set_team_logo(text), public.clear_team_logo(text, int) from public, anon;
grant execute on function public.my_manager_id(), public.set_team_logo(text), public.clear_team_logo(text, int) to authenticated;
grant execute on function public.current_team_logos() to anon, authenticated;

-- The bucket: anyone can view the images; the site shrinks uploads to 256px squares well under the limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-logos', 'team-logos', true, 524288, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Managers add files only in their own folder; they and moderators can list and delete them.
drop policy if exists "managers upload their own logo" on storage.objects;
create policy "managers upload their own logo" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-logos' and (storage.foldername(name))[1] = public.my_manager_id());
drop policy if exists "managers and moderators see logo files" on storage.objects;
create policy "managers and moderators see logo files" on storage.objects for select to authenticated
  using (bucket_id = 'team-logos' and ((storage.foldername(name))[1] = public.my_manager_id() or public.is_moderator()));
drop policy if exists "managers and moderators delete logo files" on storage.objects;
create policy "managers and moderators delete logo files" on storage.objects for delete to authenticated
  using (bucket_id = 'team-logos' and ((storage.foldername(name))[1] = public.my_manager_id() or public.is_moderator()));
