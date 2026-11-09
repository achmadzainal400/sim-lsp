-- SIM-LSP: foto bukti laporan untuk skema produksi yang sedang aktif.
-- Membuat bucket privat, policy Storage, dan validasi pada RPC warga.
-- Batas tiap foto: 512 KiB; hanya pengguna login yang dapat mengunggah/membaca.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-photos',
  'report-photos',
  false,
  524288,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function simlsp_private.can_access_report_photo(p_report_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select simlsp_private.can_access_report(p_report_id)
    or exists (
      select 1
        from public.simlsp_report_merge_links link
       where link.child_report_id = p_report_id
         and simlsp_private.can_access_report(link.parent_report_id)
    );
$function$;
revoke all on function simlsp_private.can_access_report_photo(text) from public, anon, authenticated, service_role;
grant execute on function simlsp_private.can_access_report_photo(text) to authenticated, service_role;

-- A private Storage object is readable only by a report participant (including
-- either side of an approved merge). Uploads remain owner-bound and cannot be
-- reused in a report unless the caller owns every referenced object.
drop policy if exists "SIM-LSP authenticated read report photos" on storage.objects;
drop policy if exists "SIM-LSP report participants read report photos" on storage.objects;
create policy "SIM-LSP report participants read report photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'report-photos'
    and (
      owner_id = (select auth.uid()::text)
      or simlsp_private.can_access_report_photo((storage.foldername(name))[2])
    )
  );

drop policy if exists "SIM-LSP authenticated upload report photos" on storage.objects;
create policy "SIM-LSP authenticated upload report photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'report-photos'
  and (storage.foldername(name))[1] = 'reports'
  and coalesce((storage.foldername(name))[2], '') ~ '^[A-Za-z0-9_-]{1,100}$'
  and coalesce(owner_id, '') = (select auth.uid()::text)
);

drop policy if exists "SIM-LSP owner delete report photos" on storage.objects;
create policy "SIM-LSP owner delete report photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'report-photos'
  and owner_id = (select auth.uid()::text)
);

-- RPC produksi saat ini mengembalikan integer dan menyimpan shared_data.
-- Pertahankan kontrak tersebut sambil membatasi jumlah dan metadata foto.
create or replace function public.simlsp_submit_report(p_report jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  actor_name text;
  current_data jsonb;
  current_revision integer;
  report_data jsonb;
  report_id text;
  report_category text;
  report_unit text;
  report_location text;
  report_object text;
  report_description text;
  report_urgency text;
  report_acquisition_quantity numeric := 0;
  report_acquisition_unit text := '';
  canonical_photos jsonb := '[]'::jsonb;
  report_prefix text;
  report_year text;
  next_ticket_number bigint;
  report_code text;
  now_text text := pg_catalog.to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if actor_id is null then
    raise exception 'Sesi masuk diperlukan.' using errcode = '28000';
  end if;
  select profile.role, coalesce(nullif(btrim(profile.display_name), ''), profile.username)
    into actor_role, actor_name
    from public.simlsp_profiles profile where profile.id = actor_id;
  if actor_role is distinct from 'warga' then
    raise exception 'Hanya akun Warga Madrasah yang dapat mengirim laporan.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object' then
    raise exception 'Data laporan tidak valid.' using errcode = '22023';
  end if;
  report_unit := nullif(btrim(p_report ->> 'unit'), '');
  report_category := nullif(btrim(p_report ->> 'category'), '');
  report_location := nullif(btrim(p_report ->> 'location'), '');
  report_object := nullif(btrim(p_report ->> 'object'), '');
  report_description := nullif(btrim(p_report ->> 'description'), '');
  report_urgency := coalesce(nullif(btrim(p_report ->> 'urgency'), ''), 'NORMAL');
  if report_unit is null or report_unit not in ('MI', 'MTs', 'Lintas Unit') then
    raise exception 'Unit laporan tidak valid.' using errcode = '22023';
  end if;
  if report_category is null or report_category not in ('Perbaikan', 'Pengadaan', 'Penggantian', 'Perubahan / renovasi', 'Pengaduan', 'Lainnya') then
    raise exception 'Jenis laporan tidak valid.' using errcode = '22023';
  end if;
  if report_location is null or pg_catalog.char_length(report_location) > 100
     or report_object is null or pg_catalog.char_length(report_object) > 100
     or report_description is null or pg_catalog.char_length(report_description) > 1800 then
    raise exception 'Lokasi, objek, atau uraian laporan tidak valid.' using errcode = '22023';
  end if;
  if report_urgency not in ('NORMAL', 'TINGGI', 'KRITIS') then
    raise exception 'Tingkat urgensi tidak valid.' using errcode = '22023';
  end if;
  if report_category = 'Pengadaan' then
    if jsonb_typeof(p_report -> 'acquisitionQuantity') is distinct from 'number'
       or jsonb_typeof(p_report -> 'acquisitionUnit') is distinct from 'string' then
      raise exception 'Jumlah dan satuan pengadaan wajib diisi.' using errcode = '22023';
    end if;
    report_acquisition_quantity := (p_report ->> 'acquisitionQuantity')::numeric;
    report_acquisition_unit := nullif(btrim(p_report ->> 'acquisitionUnit'), '');
    if report_acquisition_quantity <= 0 or report_acquisition_quantity > 1000000000
       or report_acquisition_unit is null or pg_catalog.char_length(report_acquisition_unit) > 30 then
      raise exception 'Jumlah dan satuan pengadaan tidak valid.' using errcode = '22023';
    end if;
  end if;

  -- Accept only the public fields that the report form is allowed to submit.
  -- Server-managed identity, status, approval, cost, and audit fields are built
  -- below and cannot be injected by a modified client.
  select coalesce(pg_catalog.jsonb_object_agg(input_field.key, input_field.value), '{}'::jsonb)
    into report_data
    from pg_catalog.jsonb_each(p_report) input_field
   where input_field.key = any(array[
     'id', 'location', 'category', 'object', 'description', 'acquisitionQuantity',
     'acquisitionUnit', 'photos'
   ]::text[]);
  report_data := report_data || pg_catalog.jsonb_build_object(
    'unit', report_unit,
    'category', report_category,
    'location', report_location,
    'object', report_object,
    'description', report_description,
    'acquisitionQuantity', report_acquisition_quantity,
    'acquisitionUnit', report_acquisition_unit,
    'urgency', report_urgency,
    'creatorProfileId', actor_id::text,
    'creator', actor_name,
    'reporterName', actor_name,
    'createdAt', now_text,
    'updatedAt', now_text,
    'statusUpdatedAt', now_text,
    'statusEventId', '',
    'status', 'BARU',
    'executorIds', '[]'::jsonb,
    'needsApproval', false,
    'approvalStatus', 'BELUM DIPERIKSA',
    'priority', 'NORMAL',
    'pj', '',
    'executor', '',
    'approvalNote', '',
    'deferReason', '',
    'internalNote', '',
    'startedAt', '',
    'completedAt', '',
    'materialCost', 0,
    'serviceCost', 0,
    'result', '',
    'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'at', now_text, 'by', actor_name, 'role', 'Warga Madrasah',
      'message', 'Laporan dibuat dan menunggu verifikasi.', 'public', true
    ))
  );
  report_id := btrim(coalesce(report_data ->> 'id', ''));
  report_category := lower(btrim(coalesce(report_data ->> 'category', '')));
  if report_id !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'ID laporan tidak valid.' using errcode = '22023';
  end if;
  if jsonb_typeof(report_data -> 'photos') is distinct from 'array' then
    report_data := report_data || pg_catalog.jsonb_build_object('photos', '[]'::jsonb);
  end if;
  if report_category in ('perbaikan', 'pengaduan') and jsonb_array_length(report_data -> 'photos') < 1 then
    raise exception 'Foto bukti wajib untuk laporan Perbaikan dan Pengaduan.' using errcode = '22023';
  end if;
  if jsonb_array_length(report_data -> 'photos') > 3 then
    raise exception 'Maksimal 3 foto bukti per laporan.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(report_data -> 'photos') photo(value)
      left join storage.objects stored
        on stored.bucket_id = 'report-photos'
       and stored.name = photo.value ->> 'path'
       and stored.owner_id = actor_id::text
     where jsonb_typeof(photo.value) is distinct from 'object'
        or coalesce(photo.value ->> 'path', '') !~ ('^reports/' || report_id || '/[A-Za-z0-9_-]+[.]jpg$')
        or coalesce(photo.value ->> 'contentType', '') <> 'image/jpeg'
        or (case when jsonb_typeof(photo.value -> 'size') = 'number'
               then (photo.value ->> 'size')::numeric between 1 and 524288
               else false end) is not true
        or stored.id is null
  ) then
    raise exception 'Metadata foto tidak valid atau foto bukan milik akun ini.' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'kind', 'bukti',
      'path', photo.value ->> 'path',
      'size', (photo.value ->> 'size')::numeric,
      'contentType', 'image/jpeg',
      'uploadedAt', now_text,
      'name', 'Foto'
    ) order by photo.ordinality), '[]'::jsonb)
    into canonical_photos
    from pg_catalog.jsonb_array_elements(report_data -> 'photos') with ordinality photo(value, ordinality);
  report_data := pg_catalog.jsonb_set(report_data, '{photos}', canonical_photos, true);

  select state.data, state.revision into current_data, current_revision
    from public.simlsp_shared_data state where state.id = 1 for update;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(case
      when jsonb_typeof(current_data -> 'reports') = 'array' then current_data -> 'reports'
      else '[]'::jsonb end) existing(value)
    where existing.value ->> 'id' = report_id
  ) then
    raise exception 'ID laporan sudah digunakan.' using errcode = '23505';
  end if;

  -- Generate ticket numbers under the shared-state row lock so simultaneous
  -- submissions cannot receive the same visible ticket code.
  report_prefix := case report_unit when 'MI' then 'MI' when 'MTs' then 'MTs' else 'M' end;
  report_year := pg_catalog.to_char(now() at time zone 'Asia/Jakarta', 'YY');
  select coalesce(max(((pg_catalog.regexp_match(
    existing.value ->> 'code',
    '^' || report_prefix || '-' || report_year || '-([0-9]+)$'
  ))[1])::bigint), 0) + 1
    into next_ticket_number
    from pg_catalog.jsonb_array_elements(case
      when jsonb_typeof(current_data -> 'reports') = 'array' then current_data -> 'reports'
      else '[]'::jsonb end) existing(value);
  report_code := report_prefix || '-' || report_year || '-' || pg_catalog.lpad(
    next_ticket_number::text,
    greatest(3, pg_catalog.length(next_ticket_number::text)),
    '0'
  );
  report_data := report_data || pg_catalog.jsonb_build_object('code', report_code);

  current_data := pg_catalog.jsonb_set(
    current_data, '{reports}',
    (case when jsonb_typeof(current_data -> 'reports') = 'array' then current_data -> 'reports' else '[]'::jsonb end)
      || pg_catalog.jsonb_build_array(report_data), true
  );
  update public.simlsp_shared_data set data = current_data, revision = revision + 1 where id = 1;
  return current_revision + 1;
end;
$function$;
revoke all on function public.simlsp_submit_report(jsonb) from public, anon;
grant execute on function public.simlsp_submit_report(jsonb) to authenticated, service_role;
