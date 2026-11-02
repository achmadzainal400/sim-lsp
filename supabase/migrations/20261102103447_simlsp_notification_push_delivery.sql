alter table public.simlsp_info_posts
  add column if not exists avatar_path text;

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
  new.avatar_path := v_profile.avatar_path;
  return new;
end;
$function$;

create table if not exists public.simlsp_notification_push_log (
  event_key text primary key check (char_length(event_key) between 1 and 180),
  status text not null check (status in ('sending', 'sent', 'no_subscribers', 'failed')),
  sent_count integer not null default 0 check (sent_count >= 0),
  updated_at timestamptz not null default now()
);
alter table public.simlsp_notification_push_log enable row level security;
revoke all on public.simlsp_notification_push_log from public, anon, authenticated;
