-- Verea: viewers and shared links.
--
-- Anyone may sign in (Google); a new account is a *viewer* unless it came from an invitation.
-- Viewers see only the projects whose link they opened, through the functions below (never
-- the projects table, the team's list or other people's profiles), and keep their own
-- what-if changes (node height / environment) in project_viewers.overrides. The team
-- (admin / member) works as before; an admin turns a viewer into a member.

-- ── profiles: viewer role, phone and company ──
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'member', 'viewer'));
alter table public.profiles alter column role set default 'viewer';
alter table public.profiles
  add column phone   text not null default '' check (char_length(phone) <= 40),
  add column company text not null default '' check (char_length(company) <= 120),
  add constraint profiles_full_name_length check (char_length(full_name) <= 120);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, coalesce(new.email, ''),
          left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 120),
          case when new.invited_at is not null then 'member' else 'viewer' end);
  return new;
end $$;

-- "Member" now means the team: viewers are left out of every policy on projects
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role in ('admin', 'member'))
$$;

create function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

create policy "users read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());
drop policy "members edit own profile, admins any" on public.profiles;
create policy "users edit own profile, admins any" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ── shared links ──
create table public.project_shares (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  token            text not null unique default replace(gen_random_uuid()::text, '-', ''),
  show_owner_info  boolean not null default false,       -- owners (titulares), areas and plots
  created_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);

create index project_shares_project on public.project_shares (project_id);

comment on table public.project_shares is
  'Links to a project for people outside the team (viewers). A revoked link gives no new access.';

-- ── what each viewer can open ──
create table public.project_viewers (
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  share_id      uuid references public.project_shares (id) on delete set null,
  overrides     jsonb not null default '{}' check (jsonb_typeof(overrides) = 'object'
                                                   and pg_column_size(overrides) < 200000),
  first_opened  timestamptz not null default now(),
  last_opened   timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_viewers_user on public.project_viewers (user_id);

comment on table public.project_viewers is
  'Viewers of a project (one row per opened link). overrides = {node name: {height, environment}}: '
  'the viewer''s own what-if changes; the project itself never changes.';

alter table public.project_shares enable row level security;
alter table public.project_viewers enable row level security;

create policy "members read links" on public.project_shares
  for select to authenticated using (public.is_member());
create policy "members create links" on public.project_shares
  for insert to authenticated with check (public.is_member());
create policy "members change links" on public.project_shares
  for update to authenticated using (public.is_member()) with check (public.is_member());

create policy "viewers and members read access" on public.project_viewers
  for select to authenticated using (user_id = auth.uid() or public.is_member());
create policy "viewers keep their changes" on public.project_viewers
  for update to authenticated using (user_id = auth.uid() and public.is_active())
  with check (user_id = auth.uid());
create policy "members remove access, viewers leave" on public.project_viewers
  for delete to authenticated using (user_id = auth.uid() or public.is_member());

revoke all on public.project_shares, public.project_viewers from anon, authenticated;
-- The token is always the server's random one; a link is only switched or revoked
grant select on public.project_shares to authenticated;
grant insert (project_id, show_owner_info) on public.project_shares to authenticated;
grant update (show_owner_info, revoked_at) on public.project_shares to authenticated;
grant select, delete on public.project_viewers to authenticated;
grant update (overrides, last_opened) on public.project_viewers to authenticated;

-- ── functions for viewers ──

-- A node name without the owner it carries ("AGU-D0311 Alfonso Maciel" -> "AGU-D0311"); the
-- same rule as nodeShortName in frontend/src/project.ts (the owner may be cut short).
create function public.node_short_name(name text, owner text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  n text := btrim(coalesce(name, ''));
  o text := lower(btrim(coalesce(owner, '')));
  rest text;
begin
  if o = '' then return name; end if;
  for i in 2 .. char_length(n) loop
    if substr(n, i, 1) = ' ' then
      rest := lower(btrim(substr(n, i + 1)));
      if char_length(rest) >= 3 and left(o, char_length(rest)) = rest then
        return btrim(left(n, i - 1));
      end if;
    end if;
  end loop;
  return n;
end $$;

-- The project data for a link without owner info: no owners, areas, plots or owners in names
create function public.without_owner_info(d jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select (d - 'plots') || jsonb_build_object('nodes', coalesce((
    select jsonb_agg((n - 'owner' - 'area_ha' - 'plot')
                     || jsonb_build_object('name', public.node_short_name(n ->> 'name', n ->> 'owner'))
                     order by ord)
    from jsonb_array_elements(case jsonb_typeof(d -> 'nodes') when 'array' then d -> 'nodes' else '[]' end)
         with ordinality as t(n, ord)), '[]'::jsonb))
$$;

-- Open a link: the viewer gets access to its project (members just get the project id).
create function public.claim_share(share_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.project_shares;
begin
  if not public.is_active() then
    raise exception 'Cuenta no activa' using errcode = '42501';
  end if;
  select * into s from public.project_shares where token = share_token and revoked_at is null;
  if not found then
    raise exception 'El link no existe o fue revocado' using errcode = 'P0002';
  end if;
  if not public.is_member() then
    insert into public.project_viewers (project_id, user_id, share_id)
    values (s.project_id, auth.uid(), s.id)
    on conflict (project_id, user_id) do update set share_id = excluded.share_id, last_opened = now();
  end if;
  return s.project_id;
end $$;

-- A viewer's project: name, data (owner info removed unless the link shows it), their own
-- changes and the link they came by (for the PDF; null once revoked).
create function public.viewer_project(pid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  select p.name, p.data, p.updated_at, v.overrides, coalesce(s.show_owner_info, false) as full_info,
         case when s.revoked_at is null then s.token end as token
    into r
    from public.project_viewers v
    join public.projects p on p.id = v.project_id
    left join public.project_shares s on s.id = v.share_id
   where v.project_id = pid and v.user_id = auth.uid() and public.is_active();
  if not found then
    raise exception 'No tienes acceso a este proyecto' using errcode = '42501';
  end if;
  update public.project_viewers set last_opened = now() where project_id = pid and user_id = auth.uid();
  return jsonb_build_object(
    'name', r.name, 'updated_at', r.updated_at, 'overrides', r.overrides, 'token', r.token,
    'show_owner_info', r.full_info,
    'data', case when r.full_info then r.data else public.without_owner_info(r.data) end);
end $$;

-- The viewer's files: the projects whose link they opened, latest first.
create function public.my_files() returns table (project_id uuid, name text, updated_at timestamptz, last_opened timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.updated_at, v.last_opened
    from public.project_viewers v join public.projects p on p.id = v.project_id
   where v.user_id = auth.uid() and public.is_active()
   order by v.last_opened desc
$$;

-- A viewer deletes their own account (profile, access and changes go with it). Team
-- accounts are deactivated by an admin instead, so their projects stay with the team.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'No has iniciado sesión' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'member')) then
    raise exception 'Las cuentas del equipo las da de baja un administrador' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.is_active(), public.claim_share(text), public.viewer_project(uuid),
  public.my_files(), public.delete_my_account(), public.node_short_name(text, text),
  public.without_owner_info(jsonb) from public, anon;
grant execute on function public.is_active(), public.claim_share(text), public.viewer_project(uuid),
  public.my_files(), public.delete_my_account() to authenticated;
