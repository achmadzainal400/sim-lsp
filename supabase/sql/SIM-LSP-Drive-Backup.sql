-- SIM-LSP: private tables for one-time Google OAuth state and encrypted Drive token.
-- Storage quota baseline reflects the current Supabase Free project quota (1 GiB).

create table if not exists public.simlsp_drive_oauth_states (
  state text primary key,
  user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.simlsp_drive_connections (
  user_id uuid primary key,
  google_email text not null default '',
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  root_folder_id text not null default '',
  backup_folder_id text not null default '',
  last_backup_at timestamptz,
  last_backup_status text check (last_backup_status in ('sukses', 'gagal')),
  last_backup_name text not null default '',
  last_backup_folder_id text not null default '',
  last_backup_size_bytes bigint not null default 0,
  last_backup_files jsonb not null default '[]'::jsonb,
  last_backup_error text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.simlsp_drive_oauth_states enable row level security;
alter table public.simlsp_drive_connections enable row level security;
revoke all on table public.simlsp_drive_oauth_states from public, anon, authenticated;
revoke all on table public.simlsp_drive_connections from public, anon, authenticated;
grant all on table public.simlsp_drive_oauth_states to service_role;
grant all on table public.simlsp_drive_connections to service_role;

create or replace function public.simlsp_admin_storage_usage()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  used_bytes bigint;
  photos_bytes bigint;
begin
  if not exists (
    select 1 from public.simlsp_profiles p
    where p.id = (select auth.uid()) and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat melihat pemakaian Storage.' using errcode = '42501';
  end if;

  select coalesce(sum(case
      when coalesce(o.metadata ->> 'size', '') ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
      else 0
    end), 0)::bigint,
    coalesce(sum(case
      when o.bucket_id = 'report-photos' and coalesce(o.metadata ->> 'size', '') ~ '^[0-9]+$'
        then (o.metadata ->> 'size')::bigint
      else 0
    end), 0)::bigint
  into used_bytes, photos_bytes
  from storage.objects o;

  return jsonb_build_object(
    'usedBytes', used_bytes,
    'reportPhotosBytes', photos_bytes,
    'quotaBytes', 1073741824,
    'plan', 'Free'
  );
end;
$$;

revoke all on function public.simlsp_admin_storage_usage() from public, anon;
grant execute on function public.simlsp_admin_storage_usage() to authenticated;
