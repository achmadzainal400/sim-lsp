-- Fix report participant checks for citizens when a merged report contains
-- photos. The merged-ticket lookup must bind the shared-state row used by its
-- lateral JSON expansion; without it, the shared-state RPC fails with
-- "missing FROM-clause entry for table state" for Warga sessions.
create or replace function simlsp_private.can_access_report(p_report_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_report jsonb;
  v_reporter text;
  v_executor_ids jsonb;
  v_executor text;
begin
  if v_user_id is null or coalesce(p_report_id, '') = '' then
    return false;
  end if;

  if simlsp_private.is_manager() then
    return true;
  end if;

  select item.value
    into v_report
    from public.simlsp_shared_data shared
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(shared.data -> 'reports') = 'array'
        then shared.data -> 'reports' else '[]'::jsonb end
    ) as item(value)
   where shared.id = 1
     and item.value ->> 'id' = p_report_id
   limit 1;

  if v_report is null then
    return false;
  end if;

  v_reporter := coalesce(v_report ->> 'creatorProfileId', v_report ->> 'creator_profile_id', '');
  if v_reporter ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and v_reporter::uuid = v_user_id then
    return true;
  end if;

  v_executor_ids := coalesce(v_report -> 'executorIds', v_report -> 'executor_ids');
  if pg_catalog.jsonb_typeof(v_executor_ids) = 'array' then
    for v_executor in select pg_catalog.jsonb_array_elements_text(v_executor_ids)
    loop
      if v_executor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and v_executor::uuid = v_user_id then
        return true;
      end if;
    end loop;
  end if;

  return exists (
    select 1
      from public.simlsp_report_merge_links link
      cross join public.simlsp_shared_data shared
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(shared.data -> 'reports') = 'array'
          then shared.data -> 'reports' else '[]'::jsonb end
      ) as member(value)
     where shared.id = 1
       and link.parent_report_id = p_report_id
       and member.value ->> 'id' = link.child_report_id
       and (
         coalesce(member.value ->> 'creatorProfileId', member.value ->> 'creator_profile_id', '') = v_user_id::text
         or exists (
           select 1
             from pg_catalog.jsonb_array_elements_text(
               case when pg_catalog.jsonb_typeof(coalesce(member.value -> 'executorIds', member.value -> 'executor_ids')) = 'array'
                 then coalesce(member.value -> 'executorIds', member.value -> 'executor_ids')
                 else '[]'::jsonb end
             ) as assignee(value)
            where assignee.value = v_user_id::text
         )
       )
  );
end;
$function$;

revoke all on function simlsp_private.can_access_report(text) from public, anon, authenticated;
grant execute on function simlsp_private.can_access_report(text) to authenticated;
