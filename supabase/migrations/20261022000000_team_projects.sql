-- Verea: team accounts and cloud projects.
--
-- One company workspace: every active member can open and edit every project;
-- only its owner or an admin can delete it. Accounts are invite-only (public
-- sign-ups disabled in the Supabase dashboard); this file is the second lock:
-- without an active profile nobody reads or writes anything.

-- ── members ──
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'member' check (role in ('admin', 'member')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'Team members (one per invited auth user).';

-- Every new auth user (an accepted invitation) gets a member profile
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin')
$$;

-- App users (the API roles) may change their own name only; role, active and email are
-- for admins. The SQL editor / service role (not API users) can change anything.
create function public.is_app_user() returns boolean
language sql stable set search_path = '' as $$
  select current_user in ('authenticated', 'anon')
$$;

create function public.guard_profile_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if public.is_app_user() and not public.is_admin()
     and (new.role, new.active, new.email, new.id) is distinct from (old.role, old.active, old.email, old.id) then
    raise exception 'Only an admin can change role, active, email or id';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ── projects ──
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references public.profiles (id),
  name        text not null default '' check (char_length(name) <= 120),
  data        jsonb not null check (jsonb_typeof(data) = 'object'
                                    and pg_column_size(data) < 2000000),  -- the .verea.json
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid() references public.profiles (id)
);

create index projects_updated_at on public.projects (updated_at desc);

comment on table public.projects is
  'Verea projects; data has the format of core/project.py. Saves send the updated_at they '
  'loaded and fail when someone else saved in between (optimistic locking).';

-- Server-side stamps: who saved and when; the owner never changes except by an admin
create function public.stamp_project() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if public.is_app_user() then
      new.owner_id := auth.uid();
    end if;
    new.created_at := now();
  elsif new.owner_id is distinct from old.owner_id and public.is_app_user() and not public.is_admin() then
    raise exception 'Only an admin can change the owner of a project';
  end if;
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

create trigger projects_stamp before insert or update on public.projects
  for each row execute function public.stamp_project();

-- ── row level security ──
alter table public.profiles enable row level security;
alter table public.projects enable row level security;

create policy "members read profiles" on public.profiles
  for select to authenticated using (public.is_member());
create policy "members edit own profile, admins any" on public.profiles
  for update to authenticated
  using (public.is_member() and (id = auth.uid() or public.is_admin()))
  with check (public.is_member());

create policy "members read projects" on public.projects
  for select to authenticated using (public.is_member());
create policy "members create projects" on public.projects
  for insert to authenticated with check (public.is_member());
create policy "members edit projects" on public.projects
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "owner or admin deletes" on public.projects
  for delete to authenticated
  using (public.is_member() and (owner_id = auth.uid() or public.is_admin()));

-- Nothing for anonymous visitors; logged-in users go through the policies above
revoke all on public.profiles, public.projects from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
-- Functions are executable by PUBLIC by default
revoke execute on function public.is_member(), public.is_admin(), public.handle_new_user()
  from public, anon;
grant execute on function public.is_member(), public.is_admin() to authenticated;
