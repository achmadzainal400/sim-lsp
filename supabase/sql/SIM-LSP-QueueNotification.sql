-- SIM-LSP: public queue count for Android's persistent status notification.
-- Run after SIM-LSP-Supabase.sql has created simlsp_shared_state.

create table if not exists public.simlsp_queue_notification_state (
  id boolean primary key default true check (id = true),
  queue_count integer not null default -1 check (queue_count >= -1),
  updated_at timestamptz not null default now()
);

insert into public.simlsp_queue_notification_state (id)
values (true)
on conflict (id) do nothing;

alter table public.simlsp_queue_notification_state enable row level security;
revoke all on table public.simlsp_queue_notification_state from public, anon, authenticated;
grant all on table public.simlsp_queue_notification_state to service_role;

create or replace function public.simlsp_get_queue_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.simlsp_shared_state s
  cross join lateral pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(s.data -> 'reports') = 'array' then s.data -> 'reports'
      else '[]'::jsonb
    end
  ) as report(value)
  where s.id = true
    and report.value ->> 'status' = any (array[
      'BARU',
      'MENUNGGU_PERSETUJUAN',
      'ANTREAN',
      'DITUGASKAN',
      'DALAM_PENGERJAAN',
      'MENUNGGU_VERIFIKASI'
    ]::text[]);
$$;

revoke all on function public.simlsp_get_queue_count() from public;
grant execute on function public.simlsp_get_queue_count() to anon, authenticated;

-- Computes the latest count while locking the shared-state row, then atomically
-- claims that count so unchanged counts do not send duplicate push messages.
create or replace function public.simlsp_claim_queue_notification()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reports jsonb;
  v_count integer;
  v_previous integer;
begin
  select case
    when pg_catalog.jsonb_typeof(s.data -> 'reports') = 'array' then s.data -> 'reports'
    else '[]'::jsonb
  end
  into v_reports
  from public.simlsp_shared_state s
  where s.id = true
  for update;

  select count(*)::integer into v_count
  from pg_catalog.jsonb_array_elements(coalesce(v_reports, '[]'::jsonb)) as report(value)
  where report.value ->> 'status' = any (array[
    'BARU',
    'MENUNGGU_PERSETUJUAN',
    'ANTREAN',
    'DITUGASKAN',
    'DALAM_PENGERJAAN',
    'MENUNGGU_VERIFIKASI'
  ]::text[]);

  select state.queue_count into v_previous
  from public.simlsp_queue_notification_state state
  where state.id = true
  for update;

  if not found then
    insert into public.simlsp_queue_notification_state (id, queue_count)
    values (true, v_count);
    return pg_catalog.jsonb_build_object('changed', true, 'count', v_count);
  end if;

  if v_previous is distinct from v_count then
    update public.simlsp_queue_notification_state
    set queue_count = v_count, updated_at = pg_catalog.now()
    where id = true;
    return pg_catalog.jsonb_build_object('changed', true, 'count', v_count);
  end if;

  return pg_catalog.jsonb_build_object('changed', false, 'count', v_count);
end;
$$;

revoke all on function public.simlsp_claim_queue_notification() from public, anon, authenticated;
grant execute on function public.simlsp_claim_queue_notification() to service_role;
