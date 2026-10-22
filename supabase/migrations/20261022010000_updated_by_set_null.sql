-- Deleting an account must not be blocked by the projects it last edited: the "last edited
-- by" mark is just cleared. (Owners still block deletion on purpose: deactivate them instead,
-- `update profiles set active = false`, so their projects stay with the team.)
alter table public.projects drop constraint projects_updated_by_fkey;
alter table public.projects
  add constraint projects_updated_by_fkey foreign key (updated_by)
  references public.profiles (id) on delete set null;
