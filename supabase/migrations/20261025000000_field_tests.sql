-- Verea: 4G field tests (docs/modo-campo.md).
--
-- The team goes with a sensor to the places the coverage map marks as possible or without 4G and
-- records what really happens there. Every active team member reads all tests and records new
-- ones; each fixes or deletes only their own (admins any). Viewers see nothing. A test recorded
-- offline is uploaded later: client_id (made on the phone) keeps a retry from duplicating it.

create table public.field_tests (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null unique,
  project_id  uuid references public.projects (id) on delete set null,
  author_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  taken_at    timestamptz not null,                       -- on the phone (it may be uploaded hours later)
  created_at  timestamptz not null default now(),
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  accuracy_m  real check (accuracy_m >= 0 and accuracy_m <= 100000),
  operator    text not null default 'Telcel' check (char_length(operator) <= 40),
  predicted   text check (predicted in ('ok', 'edge', 'differentiated', 'possible', 'none')),   -- null: no signal to ask the map
  observed    text not null check (observed in ('stable', 'intermittent', 'none')),
  delivered   boolean,                                    -- did the reading reach the server? null: not known
  rssi_dbm    real check (rssi_dbm between -160 and 0),
  device      text not null default 'dragino_se0x_cs' check (char_length(device) <= 40),
  notes       text not null default '' check (char_length(notes) <= 1000)
);
create index field_tests_project on public.field_tests (project_id);

alter table public.field_tests enable row level security;

create policy "team reads field tests" on public.field_tests
  for select to authenticated using (public.is_member());
create policy "team records field tests as themselves" on public.field_tests
  for insert to authenticated with check (public.is_member() and author_id = auth.uid());
create policy "authors or admins fix field tests" on public.field_tests
  for update to authenticated
  using (public.is_member() and (author_id = auth.uid() or public.is_admin()))
  with check (public.is_member() and (author_id = auth.uid() or public.is_admin()));
create policy "authors or admins delete field tests" on public.field_tests
  for delete to authenticated using (public.is_member() and (author_id = auth.uid() or public.is_admin()));

-- Nothing for anonymous visitors (Supabase grants new tables to anon by default)
revoke all on public.field_tests from anon;
grant select, insert, update, delete on public.field_tests to authenticated;
