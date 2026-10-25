-- Verea: deleting accounts without losing work.
--
-- Everyone may delete their own account (it used to be viewers only); an admin may delete any
-- other account. The projects the account owns and the 4G field tests it recorded are handed over
-- to an admin first (the deleting admin, or for a self-deletion the longest-serving other active
-- admin), so nothing the team made disappears. The last active admin cannot delete themselves.

-- Saves from the app stamp who and when; the server's own updates (handing projects over, clearing
-- «last edited by» when an account goes) leave those marks alone: an ownership change is no edit,
-- and stamping the deleting account itself would block its deletion.
create or replace function public.stamp_project() returns trigger
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
  if tg_op = 'INSERT' or public.is_app_user() then
    new.updated_at := clock_timestamp();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

create function public.hand_over_account(target uuid, heir uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.projects set owner_id = heir where owner_id = target;
  update public.field_tests set author_id = heir where author_id = target;
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  heir uuid;
begin
  if me is null then
    raise exception 'No has iniciado sesión' using errcode = '42501';
  end if;
  select id into heir from public.profiles
    where role = 'admin' and active and id <> me order by created_at limit 1;
  if heir is null and exists (select 1 from public.profiles where id = me and role = 'admin') then
    raise exception 'Eres el único administrador: da ese rol a alguien más antes de eliminar tu cuenta' using errcode = '42501';
  end if;
  if heir is not null then
    perform public.hand_over_account(me, heir);
  elsif exists (select 1 from public.projects where owner_id = me)
     or exists (select 1 from public.field_tests where author_id = me) then
    raise exception 'No hay un administrador que reciba tus proyectos' using errcode = '42501';
  end if;
  delete from auth.users where id = me;
end $$;

create function public.admin_delete_account(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador elimina cuentas' using errcode = '42501';
  end if;
  if target = auth.uid() then
    raise exception 'Tu propia cuenta se elimina desde Configuración → Cuenta' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = target) then
    raise exception 'Esa cuenta no existe' using errcode = 'P0002';
  end if;
  perform public.hand_over_account(target, auth.uid());
  delete from auth.users where id = target;
end $$;

revoke execute on function public.hand_over_account(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_delete_account(uuid) from public, anon;
grant execute on function public.admin_delete_account(uuid) to authenticated;
