-- Minimal stand-in for what Supabase provides, to test the migrations on a plain
-- PostgreSQL: the API roles, auth.users and auth.uid() (the caller's JWT "sub").
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}',
  invited_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants every new public table to the API roles; RLS is what protects them
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
