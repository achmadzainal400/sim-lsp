-- Notifikasi push otomatis ketika laporan warga baru tersimpan.
-- Basis data produksi SIM-LSP menyimpan data di simlsp_shared_data.
-- Jalankan setelah tabel simlsp_shared_data, profil, dan SQL PWA dibuat.

create extension if not exists pg_net;

create table if not exists public.simlsp_report_push_events (
  event_token uuid primary key default gen_random_uuid(),
  report_id text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists simlsp_report_push_events_created_at_idx
  on public.simlsp_report_push_events (created_at);

alter table public.simlsp_report_push_events enable row level security;
revoke all on table public.simlsp_report_push_events from public, anon, authenticated;
grant all on table public.simlsp_report_push_events to service_role;

create or replace function public.simlsp_consume_report_push_event(p_event_token uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id text;
begin
  update public.simlsp_report_push_events e
  set consumed_at = now()
  where e.event_token = p_event_token
    and e.consumed_at is null
    and e.created_at >= now() - interval '10 minutes'
  returning e.report_id into v_report_id;
  return v_report_id;
end;
$$;

revoke all on function public.simlsp_consume_report_push_event(uuid) from public, anon, authenticated;
grant execute on function public.simlsp_consume_report_push_event(uuid) to service_role;

create or replace function public.simlsp_notify_new_report_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report jsonb;
  v_report_id text;
  v_creator_id uuid;
  v_event_token uuid;
begin
  delete from public.simlsp_report_push_events
  where created_at < now() - interval '1 day';

  for v_report in
    select item.value
    from jsonb_array_elements(coalesce(new.data -> 'reports', '[]'::jsonb)) as item(value)
    where coalesce(item.value ->> 'id', '') <> ''
      and item.value ->> 'status' = 'BARU'
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(old.data -> 'reports', '[]'::jsonb)) as previous(value)
        where previous.value ->> 'id' = item.value ->> 'id'
      )
  loop
    v_report_id := v_report ->> 'id';
    v_creator_id := case
      when coalesce(v_report ->> 'creatorProfileId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (v_report ->> 'creatorProfileId')::uuid
      else null
    end;

    if v_creator_id is null or not exists (
      select 1 from public.simlsp_profiles p
      where p.id = v_creator_id and p.role = 'warga'
    ) then
      continue;
    end if;

    insert into public.simlsp_report_push_events (report_id)
    values (v_report_id)
    returning event_token into v_event_token;

    perform net.http_post(
      url := 'https://lcfqhrziveksvxuldsfa.supabase.co/functions/v1/simlsp-notify-new-report',
      body := jsonb_build_object('eventToken', v_event_token),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_leWZwNDP-hhyROaUnWWbNQ_f-tsmfZu'
      ),
      timeout_milliseconds := 5000
    );
  end loop;

  return new;
exception
  when others then
    -- Kegagalan layanan push tidak boleh membatalkan penyimpanan laporan.
    raise warning 'SIM-LSP: pemicu push laporan gagal: %', sqlerrm;
    return new;
end;
$$;

drop trigger if exists simlsp_notify_new_report_rows on public.simlsp_shared_data;
create trigger simlsp_notify_new_report_rows
after update of data on public.simlsp_shared_data
for each row
when (new.data is distinct from old.data)
execute function public.simlsp_notify_new_report_rows();

comment on function public.simlsp_notify_new_report_rows() is
  'Mengirim webhook aman sekali pakai ke Edge Function untuk setiap laporan BARU dari profil warga.';
