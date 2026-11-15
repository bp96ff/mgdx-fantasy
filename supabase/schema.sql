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

-- ---------- blog posts and reactions ----------
-- Members (this season's managers) write posts on the Main Blog and react to posts, recaps, matchup cards
-- and Weekly Snapshot cards. Anyone can read both. Every change goes through the functions below.
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  manager_id text not null references public.managers (id) on update cascade on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists posts_created_at on public.posts (created_at desc);

-- A post can carry one picture: a photo or GIF the member uploaded (media_kind 'image', media = its path in the
-- post-media bucket) or a GIF picked from GIPHY's search (media_kind 'gif', media = its GIPHY address).
-- Width and height let the page save the picture's space before it loads. A post with a picture can skip the text.
alter table public.posts add column if not exists media_kind text;
alter table public.posts add column if not exists media text;
alter table public.posts add column if not exists media_w int;
alter table public.posts add column if not exists media_h int;
alter table public.posts drop constraint if exists posts_body_check;
alter table public.posts add constraint posts_body_check check (char_length(body) <= 2000);
alter table public.posts drop constraint if exists posts_media_check;
alter table public.posts add constraint posts_media_check check (
  (media_kind is null and media is null and media_w is null and media_h is null)
  or (media_kind in ('image', 'gif') and media is not null and media_w between 1 and 10000 and media_h between 1 and 10000));
alter table public.posts drop constraint if exists posts_content_check;
alter table public.posts add constraint posts_content_check check (char_length(body) > 0 or media is not null);

-- One row per manager, thing and reaction. target names what was reacted to, e.g. 'post:<id>',
-- 'recap:2026:w9', 'match:2026:lab-rats:w10:1-12', 'xmatch:2026:w10:lab-rats.1-genomic-gerbils.8',
-- 'snap:2026:w10:top-scores'.
create table if not exists public.reactions (
  target text not null check (char_length(target) <= 120),
  manager_id text not null references public.managers (id) on update cascade on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (target, manager_id, emoji)
);
alter table public.posts enable row level security;
alter table public.reactions enable row level security;
revoke all on public.posts, public.reactions from anon, authenticated;

-- Replies: a post with parent_id is a reply to that post (one level: replies can't have replies, or pictures).
-- Deleting a post deletes its replies.
alter table public.posts add column if not exists parent_id uuid references public.posts (id) on delete cascade;
create index if not exists posts_parent on public.posts (parent_id, created_at);
-- When the member last opened the Main Blog, for the unread dot and the "New" divider.
alter table public.profiles add column if not exists posts_seen_at timestamptz;

-- Newest first, posts only (not replies); pass the oldest created_at shown so far to get the next page.
-- The author's league and team are this season's (null for a manager who has left).
drop function if exists public.list_posts(timestamptz, int);
create function public.list_posts(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, manager_id text, name text, league text, team_id int, team_name text,
  body text, media_kind text, media text, media_w int, media_h int, replies int, created_at timestamptz, edited_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.manager_id, m.name, s.league, s.team_id, s.team_name, p.body,
    p.media_kind, p.media, p.media_w, p.media_h,
    (select count(*)::int from posts r where r.parent_id = p.id), p.created_at, p.edited_at
  from posts p
  join managers m on m.id = p.manager_id
  left join season_teams s on s.manager_id = p.manager_id and s.season = current_season()
  where p.parent_id is null and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

-- Every reply to the given posts (up to 50 posts), oldest first.
create or replace function public.list_replies(p_parents uuid[])
returns table (id uuid, parent_id uuid, manager_id text, name text, league text, team_id int, team_name text,
  body text, created_at timestamptz, edited_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.parent_id, p.manager_id, m.name, s.league, s.team_id, s.team_name, p.body, p.created_at, p.edited_at
  from posts p
  join managers m on m.id = p.manager_id
  left join season_teams s on s.manager_id = p.manager_id and s.season = current_season()
  where p.parent_id = any (p_parents[1:50])
  order by p.created_at
$$;

-- p_parent: the post this replies to (text only). Otherwise a post, with an optional picture:
-- p_media_kind 'image': p_media is a file the member already uploaded to their own post-media folder.
-- p_media_kind 'gif': p_media is a GIPHY image address. Leave all four media arguments null for a text post.
drop function if exists public.create_post(text);
drop function if exists public.create_post(text, text, text, int, int);
create or replace function public.create_post(p_body text, p_media_kind text default null, p_media text default null,
  p_media_w int default null, p_media_h int default null, p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  mid text := my_manager_id();
  clean text := btrim(coalesce(p_body, ''));
  new_id uuid;
begin
  if mid is null then raise exception 'Only this season''s managers can post'; end if;
  if char_length(clean) > 2000 then raise exception 'Posts can be up to 2,000 characters'; end if;
  if p_parent is not null then
    if char_length(clean) = 0 then raise exception 'Write a reply first'; end if;
    if p_media is not null or p_media_kind is not null then raise exception 'Replies can''t have pictures'; end if;
    if not exists (select 1 from posts where posts.id = p_parent and posts.parent_id is null) then
      raise exception 'That post is gone';
    end if;
    if (select count(*) from posts where manager_id = mid and parent_id is not null
        and created_at > now() - interval '10 minutes') >= 20 then
      raise exception 'That''s a lot of replies. Wait a few minutes, then try again';
    end if;
    insert into posts (manager_id, body, parent_id) values (mid, clean, p_parent) returning posts.id into new_id;
    return new_id;
  end if;
  if char_length(clean) = 0 and p_media is null then raise exception 'Write something or add a picture first'; end if;
  if p_media is not null or p_media_kind is not null then
    if p_media_w is null or p_media_h is null or p_media_w not between 1 and 10000 or p_media_h not between 1 and 10000 then
      raise exception 'That picture''s size is missing';
    end if;
    if p_media_kind = 'image' then
      if p_media is null or left(p_media, length(mid) + 1) <> mid || '/' or p_media like '%..%'
          or not exists (select 1 from storage.objects o where o.bucket_id = 'post-media' and o.name = p_media)
          or exists (select 1 from posts where media_kind = 'image' and media = p_media) then
        raise exception 'That isn''t your uploaded picture';
      end if;
    elsif p_media_kind = 'gif' then
      if p_media is null or char_length(p_media) > 600
          or p_media !~ '^https://(media[0-9]?|i)\.giphy\.com/[A-Za-z0-9._/-]+\.(gif|webp)(\?[A-Za-z0-9=&._%-]*)?$' then
        raise exception 'That GIF has to come from the GIF search';
      end if;
    else
      raise exception 'Unknown kind of picture';
    end if;
  end if;
  if (select count(*) from posts where manager_id = mid and parent_id is null
      and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'That''s a lot of posts. Wait a few minutes, then try again';
  end if;
  insert into posts (manager_id, body, media_kind, media, media_w, media_h)
  values (mid, clean, p_media_kind, p_media, p_media_w, p_media_h) returning posts.id into new_id;
  return new_id;
end
$$;

-- Changes the text only; a post's picture stays. The text can be empty when there's a picture.
create or replace function public.edit_post(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare clean text := btrim(coalesce(p_body, ''));
begin
  if char_length(clean) > 2000 then raise exception 'Posts can be up to 2,000 characters'; end if;
  update posts set body = clean, edited_at = now()
  where posts.id = p_id and manager_id = my_manager_id() and (char_length(clean) > 0 or media is not null);
  if not found then
    if char_length(clean) = 0 then raise exception 'Write something first'; end if;
    raise exception 'You can only edit your own posts';
  end if;
end
$$;

-- The author or any moderator. Its reactions and replies (and theirs) go with it. Returns the uploaded
-- picture's path (or null) so the site can delete the file.
drop function if exists public.delete_post(uuid);
create function public.delete_post(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare kind text; path text;
begin
  if not exists (select 1 from posts where posts.id = p_id and (manager_id = my_manager_id() or is_moderator())) then
    raise exception 'Only the author or a moderator can delete this post';
  end if;
  delete from reactions where target in (select 'post:' || r.id::text from posts r where r.parent_id = p_id);
  delete from reactions where target = 'post:' || p_id::text;
  delete from posts where posts.id = p_id returning media_kind, media into kind, path;
  return case when kind = 'image' then path end;
end
$$;

-- How many posts and replies other managers wrote since the member last opened the Main Blog (or, before
-- that, since they linked their team), and how many of those @mention them.
create or replace function public.unread_posts()
returns table (posts int, mentions int)
language sql stable security definer set search_path = public as $$
  with me as (
    select p.manager_id, coalesce(p.posts_seen_at, p.claimed_at) as seen,
      '(^|[^[:alnum:]_])@' || regexp_replace(m.name, '([^[:alnum:] ])', '\\\1', 'g') || '($|[^[:alnum:]_])' as pattern
    from profiles p join managers m on m.id = p.manager_id
    where p.user_id = auth.uid()
  )
  select count(x.id)::int, (count(x.id) filter (where x.body ~* me.pattern))::int
  from me left join posts x on x.manager_id <> me.manager_id and x.created_at > me.seen
  group by me.manager_id
$$;

-- Marks the Main Blog as read now. Returns when it was last read, so the page can mark what's new.
create or replace function public.mark_posts_seen() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare before timestamptz;
begin
  select coalesce(posts_seen_at, claimed_at) into before from profiles where user_id = auth.uid();
  update profiles set posts_seen_at = now() where user_id = auth.uid();
  return before;
end
$$;

-- Uploaded post pictures: anyone can view them. The site shrinks photos; GIFs go up as they are.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', true, 5242880, array['image/webp', 'image/png', 'image/jpeg', 'image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Members add files only in their own folder; they and moderators can list and delete them.
drop policy if exists "members upload their own post pictures" on storage.objects;
create policy "members upload their own post pictures" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-media' and (storage.foldername(name))[1] = public.my_manager_id());
drop policy if exists "members and moderators see post picture files" on storage.objects;
create policy "members and moderators see post picture files" on storage.objects for select to authenticated
  using (bucket_id = 'post-media' and ((storage.foldername(name))[1] = public.my_manager_id() or public.is_moderator()));
drop policy if exists "members and moderators delete post picture files" on storage.objects;
create policy "members and moderators delete post picture files" on storage.objects for delete to authenticated
  using (bucket_id = 'post-media' and ((storage.foldername(name))[1] = public.my_manager_id() or public.is_moderator()));

-- Every reaction on the given things (up to 300 at once), with the reacting manager's name.
create or replace function public.get_reactions(p_targets text[])
returns table (target text, emoji text, manager_id text, name text)
language sql stable security definer set search_path = public as $$
  select r.target, r.emoji, r.manager_id, m.name
  from reactions r join managers m on m.id = r.manager_id
  where r.target = any (p_targets[1:300])
  order by r.created_at
$$;

-- Adds the signed-in member's reaction, or takes it back if it's already there. Returns true when added.
create or replace function public.toggle_reaction(p_target text, p_emoji text) returns boolean
language plpgsql security definer set search_path = public as $$
declare mid text := my_manager_id();
begin
  if mid is null then raise exception 'Only this season''s managers can react'; end if;
  -- The same keys as REACTIONS in js/app.js
  if p_emoji is null or not (p_emoji = any (array['like', 'dislike', 'love', 'laugh', 'fire', 'goat', 'king', 'hundred',
      'cool', 'eyes', 'shocked', 'skull', 'clown', 'salt', 'fuming', 'cry', 'pray', 'lucky', 'trash'])) then
    raise exception 'Unknown reaction';
  end if;
  if p_target is null or p_target !~ ('^(post:[0-9a-f-]{36}|recap:[0-9]{4}:w[0-9]{1,2}'
      || '|match:[0-9]{4}:[a-z-]+:w[0-9]{1,2}:[0-9]+-[0-9]+'
      || '|xmatch:[0-9]{4}:w[0-9]{1,2}:[a-z-]+\.[0-9]+-[a-z-]+\.[0-9]+'
      || '|snap:[0-9]{4}:w[0-9]{1,2}:[a-z0-9-]+)$') then
    raise exception 'Can''t react to that';
  end if;
  if p_target like 'post:%' and not exists (select 1 from posts where posts.id::text = substr(p_target, 6)) then
    raise exception 'That post is gone';
  end if;
  delete from reactions r where r.target = p_target and r.manager_id = mid and r.emoji = p_emoji;
  if found then return false; end if;
  if (select count(*) from reactions r where r.manager_id = mid and r.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'Slow down a little, then try again';
  end if;
  insert into reactions (target, manager_id, emoji) values (p_target, mid, p_emoji);
  return true;
end
$$;

revoke execute on function public.create_post(text, text, text, int, int, uuid), public.edit_post(uuid, text), public.delete_post(uuid),
  public.toggle_reaction(text, text) from public, anon;
grant execute on function public.create_post(text, text, text, int, int, uuid), public.edit_post(uuid, text), public.delete_post(uuid),
  public.toggle_reaction(text, text) to authenticated;
grant execute on function public.list_posts(timestamptz, int), public.list_replies(uuid[]), public.get_reactions(text[])
  to anon, authenticated;
revoke execute on function public.unread_posts(), public.mark_posts_seen() from public, anon;
grant execute on function public.unread_posts(), public.mark_posts_seen() to authenticated;

-- ---------- Predictions: pick the winner of every game ----------
-- Members pick a winner in each in-league and cross-league game. A week's picks lock when its first NFL game
-- kicks off (pick_locks, from supabase/pick-locks-<season>.sql). Until then a member can change or clear a pick,
-- and only they can see it; after that everyone's picks are public. Scoring happens on the site: 1 point for a
-- correct favorite, 2 for a correct underdog (see data/predictions.json).
create table if not exists public.pick_locks (
  season int not null,
  week int not null,
  locks_at timestamptz not null,
  primary key (season, week)
);
-- game names the two teams, lower first: 'lab-rats:1-12' for an in-league game,
-- 'x:genomic-gerbils.8-lab-rats.1' for a cross-league one (byte order). pick is the chosen team, 'lab-rats.1'.
create table if not exists public.picks (
  season int not null,
  week int not null,
  game text not null check (char_length(game) <= 80),
  manager_id text not null references public.managers (id) on update cascade on delete cascade,
  pick text not null,
  updated_at timestamptz not null default now(),
  primary key (season, week, game, manager_id)
);
alter table public.pick_locks enable row level security;
alter table public.picks enable row level security;
revoke all on public.pick_locks, public.picks from anon, authenticated;

-- This season's lock time for each week. Public.
create or replace function public.pick_weeks()
returns table (week int, locks_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.week, l.locks_at from pick_locks l where l.season = current_season() order by l.week
$$;

-- Makes, changes or (with p_pick null) clears the signed-in member's pick, until the week locks.
create or replace function public.set_pick(p_week int, p_game text, p_pick text) returns void
language plpgsql security definer set search_path = public as $$
declare
  mid text := my_manager_id();
  yr int := current_season();
  lock_at timestamptz;
  m text[];
  a text;
  b text;
begin
  if mid is null then raise exception 'Only this season''s managers can make picks'; end if;
  select locks_at into lock_at from pick_locks where season = yr and week = p_week;
  if lock_at is null then raise exception 'Picks aren''t open for Week %', p_week; end if;
  if now() >= lock_at then raise exception 'Week % picks locked when its first game kicked off', p_week; end if;
  m := regexp_match(coalesce(p_game, ''), '^([a-z-]+):([0-9]+)-([0-9]+)$');
  if m is not null then
    if m[2]::int >= m[3]::int then raise exception 'That isn''t a game'; end if;
    a := m[1] || '.' || m[2];
    b := m[1] || '.' || m[3];
  else
    m := regexp_match(coalesce(p_game, ''), '^x:([a-z-]+\.[0-9]+)-([a-z-]+\.[0-9]+)$');
    if m is null or not (m[1] collate "C" < m[2] collate "C") then raise exception 'That isn''t a game'; end if;
    a := m[1];
    b := m[2];
  end if;
  if (select count(*) from season_teams s where s.season = yr and (s.league || '.' || s.team_id) in (a, b)) <> 2 then
    raise exception 'That isn''t a game this season';
  end if;
  if p_pick is null then
    delete from picks where season = yr and week = p_week and game = p_game and manager_id = mid;
    return;
  end if;
  if p_pick not in (a, b) then raise exception 'Pick one of the two teams in the game'; end if;
  if not exists (select 1 from picks where season = yr and week = p_week and game = p_game and manager_id = mid)
      and (select count(*) from picks where season = yr and week = p_week and manager_id = mid) >= 60 then
    raise exception 'That''s more picks than there are games';
  end if;
  insert into picks (season, week, game, manager_id, pick) values (yr, p_week, p_game, mid, p_pick)
  on conflict (season, week, game, manager_id) do update set pick = excluded.pick, updated_at = now();
end
$$;

-- The signed-in member's own picks for a week, locked or not.
create or replace function public.my_picks(p_week int)
returns table (game text, pick text)
language sql stable security definer set search_path = public as $$
  select p.game, p.pick from picks p
  where p.season = current_season() and p.week = p_week and p.manager_id = my_manager_id()
$$;

-- Everyone's picks this season, for locked weeks only: who picked each team in each game. Public.
create or replace function public.pick_tallies()
returns table (week int, game text, pick text, managers text[])
language sql stable security definer set search_path = public as $$
  select p.week, p.game, p.pick, array_agg(p.manager_id order by p.manager_id)
  from picks p join pick_locks l on l.season = p.season and l.week = p.week
  where p.season = current_season() and l.locks_at <= now()
  group by p.week, p.game, p.pick
$$;

revoke execute on function public.set_pick(int, text, text), public.my_picks(int) from public, anon;
grant execute on function public.set_pick(int, text, text), public.my_picks(int) to authenticated;
grant execute on function public.pick_weeks(), public.pick_tallies() to anon, authenticated;

-- ---------- App notifications ----------
-- Each phone or browser a member turned notifications on in (its Web Push subscription). The site saves and
-- removes its own device; only the push Edge Function (supabase/functions/push) reads them, with the service key.
create table if not exists public.push_devices (
  endpoint text primary key check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);
create index if not exists push_devices_user on public.push_devices (user_id);
alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon, authenticated;

-- Which notifications a member wants (all on until they turn one off).
alter table public.profiles add column if not exists push_mentions boolean not null default true;
alter table public.profiles add column if not exists push_replies boolean not null default true;
alter table public.profiles add column if not exists push_picks boolean not null default true;
alter table public.profiles add column if not exists push_posts boolean not null default true;
alter table public.profiles add column if not exists push_recaps boolean not null default true;

-- What has been sent, so a post or a week's reminder only goes out once.
create table if not exists public.push_sent (
  kind text not null,
  key text not null,
  at timestamptz not null default now(),
  primary key (kind, key)
);
alter table public.push_sent enable row level security;
revoke all on public.push_sent from anon, authenticated;
-- Recaps already up before recap notifications existed don't send one.
insert into public.push_sent (kind, key) select 'recap', '2026-' || w from generate_series(1, 9) w on conflict do nothing;

-- Saves this device for the signed-in member (up to 10 devices each; the oldest goes first).
create or replace function public.save_push_device(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where user_id = auth.uid()) then raise exception 'Link your team first'; end if;
  insert into push_devices (endpoint, user_id, p256dh, auth) values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  delete from push_devices where user_id = auth.uid() and endpoint in (
    select endpoint from push_devices where user_id = auth.uid() order by created_at desc offset 10);
end
$$;

create or replace function public.remove_push_device(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_devices where endpoint = p_endpoint and user_id = auth.uid()
$$;

drop function if exists public.push_settings();
create function public.push_settings()
returns table (mentions boolean, replies boolean, picks boolean, posts boolean, recaps boolean, devices int)
language sql stable security definer set search_path = public as $$
  select p.push_mentions, p.push_replies, p.push_picks, p.push_posts, p.push_recaps,
    (select count(*)::int from push_devices d where d.user_id = p.user_id)
  from profiles p where p.user_id = auth.uid()
$$;

-- Null leaves a setting as it is.
drop function if exists public.set_push_settings(boolean, boolean, boolean);
create or replace function public.set_push_settings(p_mentions boolean default null, p_replies boolean default null,
  p_picks boolean default null, p_posts boolean default null, p_recaps boolean default null) returns void
language sql security definer set search_path = public as $$
  update profiles set push_mentions = coalesce(p_mentions, push_mentions), push_replies = coalesce(p_replies, push_replies),
    push_picks = coalesce(p_picks, push_picks), push_posts = coalesce(p_posts, push_posts),
    push_recaps = coalesce(p_recaps, push_recaps)
  where user_id = auth.uid()
$$;

-- For the push function only. A new post or reply by p_user (checked: theirs, under 10 minutes old, not sent
-- before): the devices of this season's members it @mentions; for a reply, the post's author; for a new post
-- (not a reply), everyone with new-post notifications on. Each member gets one, the first that applies.
create or replace function public.push_post_recipients(p_post uuid, p_user uuid)
returns table (endpoint text, p256dh text, auth text, reason text, author text, body text, parent_id uuid)
language plpgsql security definer set search_path = public as $$
declare post record;
begin
  select x.id, x.body, x.parent_id, x.manager_id, m.name into post
  from posts x join managers m on m.id = x.manager_id
  join profiles pr on pr.manager_id = x.manager_id and pr.user_id = p_user
  where x.id = p_post and x.created_at > now() - interval '10 minutes';
  if post.id is null then return; end if;
  insert into push_sent (kind, key) values ('post', p_post::text) on conflict do nothing;
  if not found then return; end if;
  return query
  with members as (
    select pr.user_id, pr.manager_id, pr.push_mentions, pr.push_replies, pr.push_posts, m.name,
      '(^|[^[:alnum:]_])@' || regexp_replace(m.name, '([^[:alnum:] ])', '\\\1', 'g') || '($|[^[:alnum:]_])' as pattern
    from profiles pr join managers m on m.id = pr.manager_id
    join season_teams s on s.manager_id = pr.manager_id and s.season = current_season()
    where pr.manager_id <> post.manager_id
  ), why as (
    select mb.user_id, case
      when mb.push_mentions and post.body ~* mb.pattern then 'mention'
      when mb.push_replies and post.parent_id is not null
        and mb.manager_id = (select manager_id from posts where posts.id = post.parent_id) then 'reply'
      when mb.push_posts and post.parent_id is null then 'post'
    end as reason
    from members mb
  )
  select d.endpoint, d.p256dh, d.auth, w.reason, post.name, post.body, post.parent_id
  from why w join push_devices d on d.user_id = w.user_id
  where w.reason is not null;
end
$$;

-- For the push function only. When a week's Predictions lock is under an hour away and its reminder hasn't
-- gone out: every member's devices (with pick reminders on), their league and how many picks they've made.
create or replace function public.push_pick_recipients()
returns table (endpoint text, p256dh text, auth text, week int, locks_at timestamptz, league text, picks int)
language plpgsql security definer set search_path = public as $$
declare lk record;
begin
  select l.season, l.week, l.locks_at into lk from pick_locks l
  where l.season = current_season() and l.locks_at > now() and l.locks_at <= now() + interval '1 hour'
  order by l.locks_at limit 1;
  if lk.week is null then return; end if;
  insert into push_sent (kind, key) values ('picks', lk.season || '-' || lk.week) on conflict do nothing;
  if not found then return; end if;
  return query
  select d.endpoint, d.p256dh, d.auth, lk.week, lk.locks_at, s.league,
    (select count(*)::int from picks k where k.season = lk.season and k.week = lk.week and k.manager_id = pr.manager_id)
  from profiles pr
  join season_teams s on s.manager_id = pr.manager_id and s.season = lk.season
  join push_devices d on d.user_id = pr.user_id
  where pr.push_picks;
end
$$;

-- For the push function only. Once per week: when that week's recap is up, every member's devices (with recap
-- notifications on). The function reads the week from the live site's data/recaps.json.
create or replace function public.push_recap_recipients(p_week int)
returns table (endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $$
begin
  if p_week is null or p_week not between 1 and 18 then return; end if;
  insert into push_sent (kind, key) values ('recap', current_season() || '-' || p_week) on conflict do nothing;
  if not found then return; end if;
  return query
  select d.endpoint, d.p256dh, d.auth
  from profiles pr
  join season_teams s on s.manager_id = pr.manager_id and s.season = current_season()
  join push_devices d on d.user_id = pr.user_id
  where pr.push_recaps;
end
$$;

-- For the push function only: a member's own devices (the "Send a test" button), and forgetting a device the
-- push service says is gone.
create or replace function public.push_user_devices(p_user uuid)
returns table (endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select d.endpoint, d.p256dh, d.auth from push_devices d where d.user_id = p_user
$$;
create or replace function public.forget_push_device(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_devices where endpoint = p_endpoint
$$;

revoke execute on function public.save_push_device(text, text, text), public.remove_push_device(text),
  public.push_settings(), public.set_push_settings(boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.save_push_device(text, text, text), public.remove_push_device(text),
  public.push_settings(), public.set_push_settings(boolean, boolean, boolean, boolean, boolean) to authenticated;
revoke execute on function public.push_post_recipients(uuid, uuid), public.push_pick_recipients(), public.push_recap_recipients(int),
  public.push_user_devices(uuid), public.forget_push_device(text) from public, anon, authenticated;
grant execute on function public.push_post_recipients(uuid, uuid), public.push_pick_recipients(), public.push_recap_recipients(int),
  public.push_user_devices(uuid), public.forget_push_device(text) to service_role;

-- The Predictions reminder's timer: every 5 minutes, Wednesday through Friday (UTC, when every week's first
-- game is), the database checks whether a lock is under an hour away with no reminder sent yet. Only then does
-- it call the push function, which sends the reminder (so it arrives 55-60 minutes before kickoff).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.schedule('predictions-reminder', '*/5 * * * 3,4,5', $cron$
  select net.http_post(
    url := 'https://blfbdmrnrwvylvqakgck.supabase.co/functions/v1/push',
    body := '{"action":"reminders"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb)
  where exists (
    select 1 from public.pick_locks l
    where l.season = public.current_season() and l.locks_at > now() and l.locks_at <= now() + interval '1 hour'
      and not exists (select 1 from public.push_sent x where x.kind = 'picks' and x.key = l.season || '-' || l.week))
$cron$);
