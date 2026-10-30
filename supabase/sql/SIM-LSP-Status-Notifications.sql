-- Jalankan sekali untuk mengizinkan semua warga berlangganan pembaruan tiket,
-- dan untuk mencegah pengiriman push status tiket lebih dari satu kali per perubahan.

create or replace function public.simlsp_register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Silakan masuk kembali.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.simlsp_profiles p
    where p.id = v_actor and p.role in ('warga', 'sarpras_admin')
  ) then
    raise exception 'Akun SIM-LSP tidak dapat mengaktifkan notifikasi.' using errcode = '42501';
  end if;
  if length(coalesce(p_endpoint, '')) < 20 or length(p_endpoint) > 2048
     or length(coalesce(p_p256dh, '')) < 40 or length(p_p256dh) > 200
     or length(coalesce(p_auth, '')) < 10 or length(p_auth) > 100 then
    raise exception 'Data langganan notifikasi tidak valid.' using errcode = '22023';
  end if;
  insert into public.simlsp_push_subscriptions (endpoint, user_id, p256dh, auth_key)
  values (p_endpoint, v_actor, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        updated_at = now();
end;
$$;

revoke all on function public.simlsp_register_push_subscription(text, text, text) from public, anon;
grant execute on function public.simlsp_register_push_subscription(text, text, text) to authenticated;

create table if not exists public.simlsp_report_status_push_log (
  event_id text primary key,
  report_id text not null,
  status text not null check (status in ('sending', 'sent', 'failed', 'no_subscribers')),
  sent_count integer not null default 0 check (sent_count >= 0),
  updated_at timestamptz not null default now()
);
alter table public.simlsp_report_status_push_log enable row level security;
revoke all on table public.simlsp_report_status_push_log from public, anon, authenticated;
grant all on table public.simlsp_report_status_push_log to service_role;

create or replace function public.simlsp_claim_status_push_delivery(p_event_id text, p_report_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if length(coalesce(p_event_id, '')) < 1 or length(p_event_id) > 100
     or length(coalesce(p_report_id, '')) < 1 or length(p_report_id) > 100 then
    raise exception 'ID perubahan status tidak valid.' using errcode = '22023';
  end if;
  insert into public.simlsp_report_status_push_log as existing
    (event_id, report_id, status, sent_count, updated_at)
  values (p_event_id, p_report_id, 'sending', 0, now())
  on conflict (event_id) do update
    set report_id = excluded.report_id, status = 'sending', sent_count = 0, updated_at = now()
    where existing.status <> 'sent'
      and (existing.status <> 'sending' or existing.updated_at < now() - interval '2 minutes')
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;
revoke all on function public.simlsp_claim_status_push_delivery(text, text) from public, anon, authenticated;
grant execute on function public.simlsp_claim_status_push_delivery(text, text) to service_role;
-- Cap waktu status milik pelapor setelah aksi klarifikasi/pembatalan selesai.
create or replace function public.simlsp_mark_own_report_status(p_report_id text, p_event_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_data jsonb;
  v_reports jsonb;
  v_report jsonb;
  v_now timestamptz := now();
begin
  if v_actor is null or not exists (
    select 1 from public.simlsp_profiles p where p.id = v_actor and p.role = 'warga'
  ) then
    raise exception 'Aksi ini hanya tersedia untuk akun Warga Madrasah.' using errcode = '42501';
  end if;
  if length(coalesce(p_report_id, '')) < 1 or length(p_report_id) > 100
     or length(coalesce(p_event_id, '')) < 1 or length(p_event_id) > 100 then
    raise exception 'ID laporan tidak valid.' using errcode = '22023';
  end if;
  select s.data into v_data from public.simlsp_shared_data s where s.id = 1 for update;
  if v_data is null then raise exception 'Data bersama tidak tersedia.' using errcode = 'P0002'; end if;
  select item.value into v_report
  from jsonb_array_elements(coalesce(v_data -> 'reports', '[]'::jsonb)) item(value)
  where item.value ->> 'id' = p_report_id and item.value ->> 'creatorProfileId' = v_actor::text
  limit 1;
  if v_report is null then raise exception 'Laporan tidak ditemukan atau bukan milik akun ini.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(
    case when item.value ->> 'id' = p_report_id and item.value ->> 'creatorProfileId' = v_actor::text
      then item.value || jsonb_build_object(
        'statusUpdatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'statusEventId', p_event_id
      )
      else item.value end
    order by item.ordinality
  ), '[]'::jsonb) into v_reports
  from jsonb_array_elements(coalesce(v_data -> 'reports', '[]'::jsonb)) with ordinality item(value, ordinality);
  update public.simlsp_shared_data set data = jsonb_set(v_data, '{reports}', v_reports, true), revision = revision + 1 where id = 1;
end;
$$;
revoke all on function public.simlsp_mark_own_report_status(text, text) from public, anon;
grant execute on function public.simlsp_mark_own_report_status(text, text) to authenticated;
