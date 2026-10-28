-- Fase 3: status backup global + jadwal backup harian tengah malam WIB.
-- Prasyarat: jalankan SIM-LSP-Drive-Backup.sql dan buat Vault secret
-- SIMLSP_BACKUP_CRON_KEY dengan nilai sama seperti Edge Function secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.simlsp_drive_backup_runs (
  id boolean primary key default true check (id = true),
  run_at timestamptz not null default now(),
  source text not null default 'manual' check (source in ('manual', 'nightly')),
  status text not null default 'gagal' check (status in ('sukses', 'gagal')),
  backup_name text not null default '',
  folder_id text not null default '',
  size_bytes bigint not null default 0,
  files jsonb not null default '[]'::jsonb,
  photo_count integer not null default 0,
  error text not null default ''
);

alter table public.simlsp_drive_backup_runs enable row level security;
revoke all on table public.simlsp_drive_backup_runs from public, anon, authenticated;
grant all on table public.simlsp_drive_backup_runs to service_role;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'simlsp-drive-backup-nightly' limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end;
$$;

-- pg_cron memakai UTC: 17.00 UTC = 00.00 WIB pada hari berikutnya.
select cron.schedule(
  'simlsp-drive-backup-nightly',
  '0 17 * * *',
  $$
    select net.http_post(
      url := 'https://lcfqhrziveksvxuldsfa.supabase.co/functions/v1/simlsp-drive-backup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_leWZwNDP-hhyROaUnWWbNQ_f-tsmfZu',
        'x-simlsp-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'SIMLSP_BACKUP_CRON_KEY' limit 1)
      ),
      body := jsonb_build_object('action', 'nightly')
    );
  $$
);
