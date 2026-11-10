create or replace function public.simlsp_claim_notification_push_delivery(p_event_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claimed boolean;
begin
  if coalesce(char_length(p_event_key), 0) < 1 or char_length(p_event_key) > 180 then
    raise exception 'Kunci peristiwa notifikasi tidak valid.' using errcode = '22023';
  end if;

  insert into public.simlsp_notification_push_log(event_key, status, sent_count, updated_at)
  values (p_event_key, 'sending', 0, pg_catalog.now())
  on conflict (event_key) do update
    set status = 'sending', sent_count = 0, updated_at = pg_catalog.now()
    where public.simlsp_notification_push_log.status in ('failed', 'no_subscribers')
       or (public.simlsp_notification_push_log.status = 'sending'
           and public.simlsp_notification_push_log.updated_at < pg_catalog.now() - interval '2 minutes')
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$function$;

revoke all on function public.simlsp_claim_notification_push_delivery(text) from public, anon, authenticated;
grant execute on function public.simlsp_claim_notification_push_delivery(text) to service_role;
