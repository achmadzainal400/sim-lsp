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

drop policy if exists "SIM-LSP authenticated read report photos" on storage.objects;
create policy "SIM-LSP authenticated read report photos"
on storage.objects for select to authenticated
using (bucket_id = 'report-photos');

drop policy if exists "SIM-LSP authenticated upload report photos" on storage.objects;
create policy "SIM-LSP authenticated upload report photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'report-photos'
  and (storage.foldername(name))[1] = 'reports'
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
set search_path = public, pg_temp
as $$
declare
    current_data jsonb;
    current_revision int;
    report_data jsonb;
    report_id text;
    report_category text;
begin
    if jsonb_typeof(p_report) is distinct from 'object' then
        raise exception 'Data laporan tidak valid.' using errcode = '22023';
    end if;

    report_data := p_report;
    report_id := btrim(coalesce(report_data ->> 'id', ''));
    report_category := lower(btrim(coalesce(report_data ->> 'category', '')));
    if report_id !~ '^[A-Za-z0-9_-]{1,100}$' then
        raise exception 'ID laporan tidak valid.' using errcode = '22023';
    end if;

    if jsonb_typeof(report_data -> 'photos') is distinct from 'array' then
        report_data := report_data || jsonb_build_object('photos', '[]'::jsonb);
    end if;

    if report_category in ('perbaikan', 'pengaduan')
       and jsonb_array_length(report_data -> 'photos') < 1 then
        raise exception 'Foto bukti wajib untuk laporan Perbaikan dan Pengaduan.' using errcode = '22023';
    end if;

    if jsonb_array_length(report_data -> 'photos') > 3 then
        raise exception 'Maksimal 3 foto bukti per laporan.' using errcode = '22023';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(report_data -> 'photos') as photo(value)
        where jsonb_typeof(photo.value) is distinct from 'object'
           or coalesce(photo.value ->> 'path', '') !~ ('^reports/' || report_id || '/[A-Za-z0-9_-]+[.]jpg$')
           or coalesce(photo.value ->> 'contentType', '') <> 'image/jpeg'
           or (case
                 when jsonb_typeof(photo.value -> 'size') = 'number'
                   then (photo.value ->> 'size')::numeric between 1 and 524288
                 else false
               end) is not true
    ) then
        raise exception 'Metadata foto tidak valid.' using errcode = '22023';
    end if;

    select data, revision
      into current_data, current_revision
      from public.simlsp_shared_data
     where id = 1
     for update;
    if not found then
        raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
    end if;

    current_data := jsonb_set(
        current_data,
        '{reports}',
        (coalesce(current_data -> 'reports', '[]'::jsonb)) || report_data,
        true
    );

    update public.simlsp_shared_data
       set data = current_data,
           revision = revision + 1
     where id = 1;

    return current_revision + 1;
end;
$$;