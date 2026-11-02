-- Shared data is available only to signed-in SIM-LSP profiles.
create or replace function public.simlsp_get_shared_state()
returns json
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result json;
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Sesi masuk diperlukan.' using errcode = '28000';
  end if;
  if not exists (
    select 1
      from public.simlsp_profiles profile
     where profile.id = actor_id
       and profile.role in ('warga', 'sarpras_admin')
  ) then
    raise exception 'Profil akun SIM-LSP tidak aktif.' using errcode = '42501';
  end if;

  select pg_catalog.json_build_object('revision', revision, 'data', data)
    into result
    from public.simlsp_shared_data
   where id = 1;
  return result;
end;
$function$;
revoke all on function public.simlsp_get_shared_state() from public, anon;
grant execute on function public.simlsp_get_shared_state() to authenticated, service_role;
