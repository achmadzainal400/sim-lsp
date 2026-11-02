alter table public.simlsp_info_posts
  add column if not exists by text,
  add column if not exists role text;

create or replace function simlsp_private.populate_info_post_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile public.simlsp_profiles%rowtype;
begin
  if auth.uid() is null or new.created_by is distinct from auth.uid() then
    raise exception 'Penulis informasi tidak valid.' using errcode = '42501';
  end if;
  select * into v_profile from public.simlsp_profiles p where p.id = auth.uid();
  if not found then
    raise exception 'Profil akun tidak ditemukan.' using errcode = 'P0002';
  end if;
  new.by := coalesce(nullif(btrim(v_profile.display_name), ''), v_profile.username);
  new.role := case when v_profile.role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end;
  return new;
end;
$function$;
revoke all on function simlsp_private.populate_info_post_author() from public, anon, authenticated;
drop trigger if exists simlsp_info_posts_author on public.simlsp_info_posts;
create trigger simlsp_info_posts_author
  before insert on public.simlsp_info_posts
  for each row execute function simlsp_private.populate_info_post_author();

create or replace function simlsp_private.list_admin_directory()
returns table(
  profile_id uuid,
  username text,
  display_name text,
  role text,
  unit text,
  avatar_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select p.id, p.username, p.display_name, p.role, m.unit, p.avatar_path, p.created_at
    from public.simlsp_profiles p
    left join public.simlsp_member_registry m on m.id = p.member_registry_id
   where simlsp_private.is_manager()
   order by p.display_name, p.username;
$function$;
revoke all on function simlsp_private.list_admin_directory() from public, anon, authenticated;
grant execute on function simlsp_private.list_admin_directory() to authenticated;

create or replace function public.simlsp_admin_list_directory()
returns table(
  profile_id uuid,
  username text,
  display_name text,
  role text,
  unit text,
  avatar_path text,
  created_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from simlsp_private.list_admin_directory();
$function$;
revoke all on function public.simlsp_admin_list_directory() from public, anon;
grant execute on function public.simlsp_admin_list_directory() to authenticated;
