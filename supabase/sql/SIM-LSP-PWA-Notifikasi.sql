-- SIM-LSP PWA: langganan notifikasi untuk perangkat Sarpras/Admin.
-- Jalankan sekali di Supabase SQL Editor setelah SIM-LSP-Supabase.sql.

create table if not exists public.simlsp_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.simlsp_push_subscriptions enable row level security;
revoke all on table public.simlsp_push_subscriptions from public, anon, authenticated;
grant all on table public.simlsp_push_subscriptions to service_role;

create table if not exists public.simlsp_push_delivery_log (
  report_id text primary key,
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed', 'no_subscribers')),
  sent_count integer not null default 0 check (sent_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.simlsp_push_delivery_log enable row level security;
revoke all on table public.simlsp_push_delivery_log from public, anon, authenticated;
grant all on table public.simlsp_push_delivery_log to service_role;

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
    where p.id = v_actor and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat mengaktifkan notifikasi laporan.' using errcode = '42501';
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

create or replace function public.simlsp_remove_push_subscription(p_endpoint text)
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
  delete from public.simlsp_push_subscriptions s
  where s.endpoint = p_endpoint and s.user_id = v_actor;
end;
$$;

revoke all on function public.simlsp_register_push_subscription(text, text, text) from public, anon;
revoke all on function public.simlsp_remove_push_subscription(text) from public, anon;
grant execute on function public.simlsp_register_push_subscription(text, text, text) to authenticated;
grant execute on function public.simlsp_remove_push_subscription(text) to authenticated;

-- Klaim atomik agar pengiriman yang gagal bisa dicoba lagi. Pengiriman sukses
-- tetap unik per laporan; klaim yang macet dapat diambil ulang setelah 2 menit.
create or replace function public.simlsp_claim_push_delivery(p_report_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if length(coalesce(p_report_id, '')) < 1 or length(p_report_id) > 100 then
    raise exception 'ID laporan tidak valid.' using errcode = '22023';
  end if;

  insert into public.simlsp_push_delivery_log as current_delivery
    (report_id, status, sent_count, created_at, updated_at)
  values (p_report_id, 'sending', 0, now(), now())
  on conflict (report_id) do update
    set status = 'sending', sent_count = 0, updated_at = now()
    where current_delivery.status <> 'sent'
      and (current_delivery.status <> 'sending'
        or current_delivery.updated_at < now() - interval '2 minutes')
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.simlsp_claim_push_delivery(text) from public, anon, authenticated;
grant execute on function public.simlsp_claim_push_delivery(text) to service_role;
