-- Keep the explicit asset reference on a report valid even when data is saved
-- through an older browser cache or a direct RPC call.
create or replace function simlsp_private.reconcile_report_asset_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reports jsonb;
  v_assets jsonb;
  v_report jsonb;
  v_index integer;
  v_asset_id text;
begin
  if jsonb_typeof(new.data -> 'reports') is distinct from 'array' then return new; end if;
  v_reports := new.data -> 'reports';
  v_assets := case when jsonb_typeof(new.data -> 'assets') = 'array' then new.data -> 'assets' else '[]'::jsonb end;

  for v_report, v_index in
    select item.value, item.ordinality::integer - 1
      from pg_catalog.jsonb_array_elements(v_reports) with ordinality as item(value, ordinality)
  loop
    v_asset_id := nullif(btrim(coalesce(v_report ->> 'relatedAssetId', '')), '');
    if v_asset_id is null then
      -- Remove an empty value so old and new clients converge on one representation.
      v_report := v_report - 'relatedAssetId';
    elsif lower(btrim(coalesce(v_report ->> 'category', ''))) not in ('perbaikan', 'pengaduan') then
      raise exception 'Aset terkait hanya dapat dipilih untuk laporan Perbaikan atau Pengaduan.' using errcode = '22023';
    elsif not exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_assets) as asset(value)
       where asset.value ->> 'id' = v_asset_id
    ) then
      raise exception 'Aset terkait tidak ditemukan. Muat ulang data aset lalu pilih kembali.' using errcode = '23503';
    end if;
    v_reports := jsonb_set(v_reports, array[v_index::text], v_report, true);
  end loop;

  new.data := jsonb_set(new.data, '{reports}', v_reports, true);
  return new;
end;
$function$;
revoke all on function simlsp_private.reconcile_report_asset_links() from public, anon, authenticated, service_role;

drop trigger if exists simlsp_shared_data_reconcile_report_asset_links on public.simlsp_shared_data;
create trigger simlsp_shared_data_reconcile_report_asset_links
  before update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.reconcile_report_asset_links();

notify pgrst, 'reload schema';
