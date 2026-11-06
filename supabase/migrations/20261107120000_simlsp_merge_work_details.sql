-- Keep report-level asset usage and procurement details aligned in a merged ticket group.
create or replace function simlsp_private.reconcile_report_merge_work_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reports jsonb;
  v_link record;
  v_child_index integer;
  v_parent_index integer;
  v_child jsonb;
  v_parent jsonb;
  v_field text;
  v_work_detail_fields text[] := array[
    'assetUsageId', 'assetUsageQuantity', 'assetUsageNote', 'acquisitionQuantity', 'acquisitionUnit'
  ];
begin
  if jsonb_typeof(new.data -> 'reports') is distinct from 'array' then return new; end if;
  v_reports := new.data -> 'reports';

  for v_link in
    select child_report_id, parent_report_id
      from public.simlsp_report_merge_links
     order by merged_at, child_report_id
  loop
    select item.ordinality::integer - 1, item.value into v_child_index, v_child
      from pg_catalog.jsonb_array_elements(v_reports) with ordinality as item(value, ordinality)
     where item.value ->> 'id' = v_link.child_report_id limit 1;
    if not found then continue; end if;
    select item.ordinality::integer - 1, item.value into v_parent_index, v_parent
      from pg_catalog.jsonb_array_elements(v_reports) with ordinality as item(value, ordinality)
     where item.value ->> 'id' = v_link.parent_report_id limit 1;
    if not found then continue; end if;

    foreach v_field in array v_work_detail_fields loop
      if v_parent ? v_field then v_child := jsonb_set(v_child, array[v_field], v_parent -> v_field, true);
      else v_child := v_child - v_field; end if;
    end loop;
    v_reports := jsonb_set(v_reports, array[v_child_index::text], v_child, true);
  end loop;

  new.data := jsonb_set(new.data, '{reports}', v_reports, true);
  return new;
end;
$function$;
revoke all on function simlsp_private.reconcile_report_merge_work_details() from public, anon, authenticated, service_role;
drop trigger if exists simlsp_shared_data_reconcile_report_work_details on public.simlsp_shared_data;
create trigger simlsp_shared_data_reconcile_report_work_details
  before update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.reconcile_report_merge_work_details();

notify pgrst, 'reload schema';
