-- Build narrow before/after snapshots for the owner-only activity log. The
-- selected fields deliberately exclude passwords, tokens, and signed URLs.
create or replace function simlsp_private.audit_delta(p_before jsonb, p_after jsonb, p_fields text[])
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_object_agg(field_name, p_before -> field_name), '{}'::jsonb)
    from pg_catalog.unnest(p_fields) as fields(field_name)
   where p_before -> field_name is distinct from p_after -> field_name;
$function$;
revoke all on function simlsp_private.audit_delta(jsonb, jsonb, text[]) from public, anon, authenticated, service_role;

create or replace function simlsp_private.audit_shared_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_username text := '';
  v_actor_name text := 'Sistem';
  v_actor_role text := 'system';
  v_old_reports jsonb := case when jsonb_typeof(old.data -> 'reports') = 'array' then old.data -> 'reports' else '[]'::jsonb end;
  v_new_reports jsonb := case when jsonb_typeof(new.data -> 'reports') = 'array' then new.data -> 'reports' else '[]'::jsonb end;
  v_old_assets jsonb := case when jsonb_typeof(old.data -> 'assets') = 'array' then old.data -> 'assets' else '[]'::jsonb end;
  v_new_assets jsonb := case when jsonb_typeof(new.data -> 'assets') = 'array' then new.data -> 'assets' else '[]'::jsonb end;
  v_old_areas jsonb := case when jsonb_typeof(old.data -> 'assetAreas') = 'array' then old.data -> 'assetAreas' else '[]'::jsonb end;
  v_new_areas jsonb := case when jsonb_typeof(new.data -> 'assetAreas') = 'array' then new.data -> 'assetAreas' else '[]'::jsonb end;
  v_old_transactions jsonb := case when jsonb_typeof(old.data -> 'assetTransactions') = 'array' then old.data -> 'assetTransactions' else '[]'::jsonb end;
  v_new_transactions jsonb := case when jsonb_typeof(new.data -> 'assetTransactions') = 'array' then new.data -> 'assetTransactions' else '[]'::jsonb end;
  v_old_report_map jsonb := '{}'::jsonb;
  v_new_report_map jsonb := '{}'::jsonb;
  v_old_asset_map jsonb := '{}'::jsonb;
  v_new_asset_map jsonb := '{}'::jsonb;
  v_old_area_map jsonb := '{}'::jsonb;
  v_new_area_map jsonb := '{}'::jsonb;
  v_old_transaction_map jsonb := '{}'::jsonb;
  v_new_transaction_map jsonb := '{}'::jsonb;
  v_new jsonb;
  v_old jsonb;
  v_id text;
  v_label text;
  v_reason text;
  v_before jsonb;
  v_after jsonb;
  v_fields text[];
begin
  if old.data is not distinct from new.data then return new; end if;

  if v_actor_id is not null then
    select profile.username, profile.display_name,
           case when profile.is_system_owner then 'Pemilik Sistem'
                when profile.role = 'sarpras_admin' then 'Sarpras/Admin'
                else 'Warga Madrasah' end
      into v_actor_username, v_actor_name, v_actor_role
      from public.simlsp_profiles profile where profile.id = v_actor_id;
    v_actor_username := coalesce(v_actor_username, '');
    v_actor_name := coalesce(v_actor_name, 'Akun SIM-LSP');
    v_actor_role := coalesce(v_actor_role, '');
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_old_report_map
    from pg_catalog.jsonb_array_elements(v_old_reports) item(value) where nullif(item.value ->> 'id', '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_new_report_map
    from pg_catalog.jsonb_array_elements(v_new_reports) item(value) where nullif(item.value ->> 'id', '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_old_asset_map
    from pg_catalog.jsonb_array_elements(v_old_assets) item(value) where nullif(item.value ->> 'id', '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_new_asset_map
    from pg_catalog.jsonb_array_elements(v_new_assets) item(value) where nullif(item.value ->> 'id', '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(coalesce(item.value ->> 'id', item.value ->> 'name'), item.value), '{}'::jsonb) into v_old_area_map
    from pg_catalog.jsonb_array_elements(v_old_areas) item(value) where nullif(coalesce(item.value ->> 'id', item.value ->> 'name'), '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(coalesce(item.value ->> 'id', item.value ->> 'name'), item.value), '{}'::jsonb) into v_new_area_map
    from pg_catalog.jsonb_array_elements(v_new_areas) item(value) where nullif(coalesce(item.value ->> 'id', item.value ->> 'name'), '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_old_transaction_map
    from pg_catalog.jsonb_array_elements(v_old_transactions) item(value) where nullif(item.value ->> 'id', '') is not null;
  select coalesce(pg_catalog.jsonb_object_agg(item.value ->> 'id', item.value), '{}'::jsonb) into v_new_transaction_map
    from pg_catalog.jsonb_array_elements(v_new_transactions) item(value) where nullif(item.value ->> 'id', '') is not null;

  v_fields := array[
    'status', 'priority', 'unit', 'location', 'category', 'object', 'description',
    'reporterName', 'needsApproval', 'approvalStatus', 'approverName', 'pj', 'executor',
    'executorIds', 'targetDate', 'deferReason', 'result', 'startedAt', 'completedAt',
    'materialCost', 'serviceCost', 'acquisitionQuantity', 'acquisitionUnit',
    'assetUsageId', 'assetUsageQuantity', 'assetUsageNote', 'mergedIntoReportId', 'mergedReportIds'
  ];
  for v_new in select item.value from pg_catalog.jsonb_array_elements(v_new_reports) item(value) loop
    v_id := coalesce(v_new ->> 'id', '');
    v_old := v_old_report_map -> v_id;
    v_label := coalesce(v_new ->> 'code', v_id);
    if v_old is null then
      v_after := simlsp_private.audit_delta('{}'::jsonb, v_new, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Laporan dibuat', 'Laporan', v_id, v_label, v_after);
    else
      v_before := simlsp_private.audit_delta(v_old, v_new, v_fields);
      v_after := simlsp_private.audit_delta(v_new, v_old, v_fields);
      if v_before <> '{}'::jsonb or v_after <> '{}'::jsonb then
        v_reason := left(coalesce(nullif(v_new ->> 'deferReason', ''), nullif(v_new ->> 'lastChangeReason', ''), ''), 800);
        insert into public.simlsp_audit_events
          (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
        values (v_actor_id, v_actor_username, v_actor_name, v_actor_role,
                case when v_old -> 'status' is distinct from v_new -> 'status' then 'Status laporan diubah' else 'Data laporan diubah' end,
                'Laporan', v_id, v_label, v_reason, v_before, v_after);
      end if;
    end if;
    v_old := null;
  end loop;
  for v_old in select item.value from pg_catalog.jsonb_array_elements(v_old_reports) item(value) loop
    if not (v_new_report_map ? (v_old ->> 'id')) then
      v_before := simlsp_private.audit_delta(v_old, '{}'::jsonb, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Laporan dihapus', 'Laporan',
              coalesce(v_old ->> 'id', ''), coalesce(v_old ->> 'code', v_old ->> 'id', ''), v_before);
    end if;
  end loop;

  v_fields := array[
    'name', 'unit', 'quantity', 'acquisitionDate', 'area', 'status', 'condition', 'description',
    'areaSource', 'archivedAt', 'archivedBy', 'archiveReason', 'restoredAt', 'restoredBy'
  ];
  for v_new in select item.value from pg_catalog.jsonb_array_elements(v_new_assets) item(value) loop
    v_id := coalesce(v_new ->> 'id', '');
    v_old := v_old_asset_map -> v_id;
    v_label := coalesce(v_new ->> 'name', v_id);
    if v_old is null then
      v_after := simlsp_private.audit_delta('{}'::jsonb, v_new, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Aset ditambahkan', 'Aset', v_id, v_label, v_after);
    else
      v_before := simlsp_private.audit_delta(v_old, v_new, v_fields);
      v_after := simlsp_private.audit_delta(v_new, v_old, v_fields);
      if v_before <> '{}'::jsonb or v_after <> '{}'::jsonb then
        v_reason := left(coalesce(nullif(v_new ->> 'lastChangeReason', ''), nullif(v_new ->> 'archiveReason', ''), 'Perubahan inventaris melalui aplikasi.'), 800);
        insert into public.simlsp_audit_events
          (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
        values (v_actor_id, v_actor_username, v_actor_name, v_actor_role,
                case when v_old -> 'area' is distinct from v_new -> 'area' then 'Aset dipindahkan'
                     when coalesce(v_old ->> 'archivedAt', '') = '' and coalesce(v_new ->> 'archivedAt', '') <> '' then 'Aset diarsipkan'
                     when coalesce(v_old ->> 'archivedAt', '') <> '' and coalesce(v_new ->> 'archivedAt', '') = '' then 'Aset dipulihkan'
                     else 'Aset diubah' end,
                'Aset', v_id, v_label, v_reason, v_before, v_after);
      end if;
    end if;
    v_old := null;
  end loop;
  for v_old in select item.value from pg_catalog.jsonb_array_elements(v_old_assets) item(value) loop
    if not (v_new_asset_map ? (v_old ->> 'id')) then
      v_before := simlsp_private.audit_delta(v_old, '{}'::jsonb, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Aset dihapus permanen', 'Aset',
              coalesce(v_old ->> 'id', ''), coalesce(v_old ->> 'name', v_old ->> 'id', ''), v_before);
    end if;
  end loop;

  v_fields := array['name', 'deletedAt'];
  for v_new in select item.value from pg_catalog.jsonb_array_elements(v_new_areas) item(value) loop
    v_id := coalesce(v_new ->> 'id', v_new ->> 'name', '');
    v_old := v_old_area_map -> v_id;
    v_label := coalesce(v_new ->> 'name', v_id);
    if v_old is null then
      v_after := simlsp_private.audit_delta('{}'::jsonb, v_new, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Area ditambahkan', 'Area aset', v_id, v_label, v_after);
    else
      v_before := simlsp_private.audit_delta(v_old, v_new, v_fields);
      v_after := simlsp_private.audit_delta(v_new, v_old, v_fields);
      if v_before <> '{}'::jsonb or v_after <> '{}'::jsonb then
        insert into public.simlsp_audit_events
          (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data, after_data)
        values (v_actor_id, v_actor_username, v_actor_name, v_actor_role,
                case when coalesce(v_old ->> 'deletedAt', '') = '' and coalesce(v_new ->> 'deletedAt', '') <> '' then 'Area dihapus' else 'Area diubah' end,
                'Area aset', v_id, v_label, v_before, v_after);
      end if;
    end if;
    v_old := null;
  end loop;
  for v_old in select item.value from pg_catalog.jsonb_array_elements(v_old_areas) item(value) loop
    if not (v_new_area_map ? coalesce(v_old ->> 'id', v_old ->> 'name', '')) then
      v_before := simlsp_private.audit_delta(v_old, '{}'::jsonb, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Area dihapus permanen', 'Area aset',
              coalesce(v_old ->> 'id', v_old ->> 'name', ''), coalesce(v_old ->> 'name', ''), v_before);
    end if;
  end loop;

  v_fields := array['assetId', 'assetName', 'type', 'quantity', 'adjustment', 'unit', 'note', 'actor', 'source', 'at', 'fromArea', 'toArea'];
  for v_new in select item.value from pg_catalog.jsonb_array_elements(v_new_transactions) item(value) loop
    v_id := coalesce(v_new ->> 'id', '');
    v_old := v_old_transaction_map -> v_id;
    v_label := coalesce(v_new ->> 'assetName', v_new ->> 'assetId', 'Mutasi aset');
    if v_old is null then
      v_after := simlsp_private.audit_delta('{}'::jsonb, v_new, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Mutasi aset dicatat', 'Transaksi aset', v_id, v_label,
              left(coalesce(v_new ->> 'note', ''), 800), v_after);
    else
      v_before := simlsp_private.audit_delta(v_old, v_new, v_fields);
      v_after := simlsp_private.audit_delta(v_new, v_old, v_fields);
      if v_before <> '{}'::jsonb or v_after <> '{}'::jsonb then
        insert into public.simlsp_audit_events
          (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
        values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Mutasi aset dikoreksi', 'Transaksi aset', v_id, v_label,
                left(coalesce(v_new ->> 'note', ''), 800), v_before, v_after);
      end if;
    end if;
    v_old := null;
  end loop;
  for v_old in select item.value from pg_catalog.jsonb_array_elements(v_old_transactions) item(value) loop
    if not (v_new_transaction_map ? (v_old ->> 'id')) then
      v_before := simlsp_private.audit_delta(v_old, '{}'::jsonb, v_fields);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Mutasi aset dihapus', 'Transaksi aset',
              coalesce(v_old ->> 'id', ''), coalesce(v_old ->> 'assetName', v_old ->> 'assetId', 'Mutasi aset'),
              left(coalesce(v_old ->> 'note', ''), 800), v_before);
    end if;
  end loop;

  return new;
end;
$function$;

drop trigger if exists simlsp_shared_data_audit_changes on public.simlsp_shared_data;
create trigger simlsp_shared_data_audit_changes
  after update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.audit_shared_state_change();
revoke all on function simlsp_private.audit_shared_state_change() from public, anon, authenticated, service_role;
