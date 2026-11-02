-- Expand Info Madrasah posts and add a private, multi-file SOP catalog.
-- The legacy JSON SOP fields remain untouched; the new catalog starts empty.

create table if not exists public.simlsp_sop_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_by uuid references public.simlsp_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.simlsp_profiles(id) on delete set null
);

create index if not exists simlsp_sop_documents_active_order_idx
  on public.simlsp_sop_documents (active desc, sort_order, updated_at desc);

alter table public.simlsp_sop_documents enable row level security;
revoke all on public.simlsp_sop_documents from anon, authenticated;
grant select, insert, update, delete on public.simlsp_sop_documents to authenticated;
drop policy if exists "SIM-LSP managers manage SOP documents" on public.simlsp_sop_documents;
create policy "SIM-LSP managers manage SOP documents"
  on public.simlsp_sop_documents for all to authenticated
  using (simlsp_private.is_manager())
  with check (simlsp_private.is_manager());

create table if not exists public.simlsp_sop_files (
  id uuid primary key default gen_random_uuid(),
  sop_id uuid not null references public.simlsp_sop_documents(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  file_type text not null check (file_type in ('pdf', 'image', 'excel', 'word')),
  storage_path text not null unique,
  preview_path text unique,
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  preview_size_bytes bigint,
  preview_data jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references public.simlsp_profiles(id) on delete set null,
  check (storage_path like ('sop/' || sop_id::text || '/%')),
  check (preview_path is null or preview_path like ('sop/' || sop_id::text || '/%')),
  check (
    (file_type = 'word' and preview_path is not null and preview_path <> storage_path
      and preview_size_bytes between 1 and 10485760 and preview_data is null)
    or (file_type = 'excel' and preview_path is null and preview_data is not null
      and pg_column_size(preview_data) <= 2097152)
    or (file_type in ('pdf', 'image') and preview_path = storage_path
      and (preview_size_bytes is null or preview_size_bytes = size_bytes) and preview_data is null)
  )
);

create index if not exists simlsp_sop_files_document_order_idx
  on public.simlsp_sop_files (sop_id, sort_order, created_at);

alter table public.simlsp_sop_files enable row level security;
revoke all on public.simlsp_sop_files from anon, authenticated;
grant select, insert, update, delete on public.simlsp_sop_files to authenticated;
drop policy if exists "SIM-LSP managers manage SOP files" on public.simlsp_sop_files;
create policy "SIM-LSP managers manage SOP files"
  on public.simlsp_sop_files for all to authenticated
  using (simlsp_private.is_manager())
  with check (simlsp_private.is_manager());

create or replace function simlsp_private.validate_sop_file_preview()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_row jsonb;
begin
  if new.file_type = 'excel' then
    if jsonb_typeof(new.preview_data) is distinct from 'array'
       or jsonb_array_length(new.preview_data) < 1
       or jsonb_array_length(new.preview_data) > 501 then
      raise exception 'Pratinjau Excel harus berisi 1–501 baris.' using errcode = '22023';
    end if;
    for v_row in select value from jsonb_array_elements(new.preview_data)
    loop
      if jsonb_typeof(v_row) is distinct from 'array'
         or jsonb_array_length(v_row) > 30 then
        raise exception 'Pratinjau Excel maksimal 30 kolom per baris.' using errcode = '22023';
      end if;
    end loop;
  end if;
  return new;
end;
$function$;
revoke all on function simlsp_private.validate_sop_file_preview() from public, anon, authenticated;
drop trigger if exists simlsp_sop_files_validate_preview on public.simlsp_sop_files;
create trigger simlsp_sop_files_validate_preview
  before insert or update on public.simlsp_sop_files
  for each row execute function simlsp_private.validate_sop_file_preview();

create or replace function simlsp_private.list_sop_catalog()
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', d.id,
    'title', d.title,
    'description', d.description,
    'sort_order', d.sort_order,
    'active', d.active,
    'created_at', d.created_at,
    'updated_at', d.updated_at,
    'files', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', f.id,
          'title', f.title,
          'file_type', f.file_type,
          'storage_path', case when simlsp_private.is_manager() then f.storage_path else null end,
          'preview_path', f.preview_path,
          'size_bytes', f.size_bytes,
          'preview_size_bytes', f.preview_size_bytes,
          'preview_data', f.preview_data,
          'sort_order', f.sort_order,
          'created_at', f.created_at
        ) order by f.sort_order, f.created_at, f.id
      )
      from public.simlsp_sop_files f where f.sop_id = d.id
    ), '[]'::jsonb)
  )
  from public.simlsp_sop_documents d
  where d.active or simlsp_private.is_manager()
  order by d.sort_order, d.updated_at desc, d.title;
$function$;
revoke all on function simlsp_private.list_sop_catalog() from public, anon, authenticated;
grant execute on function simlsp_private.list_sop_catalog() to authenticated;

create or replace function public.simlsp_list_sop_catalog()
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from simlsp_private.list_sop_catalog();
$function$;
revoke all on function public.simlsp_list_sop_catalog() from public, anon;
grant execute on function public.simlsp_list_sop_catalog() to authenticated;

create or replace function simlsp_private.can_read_sop_preview(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.simlsp_sop_files f
      join public.simlsp_sop_documents d on d.id = f.sop_id
     where d.active and f.preview_path = p_path
  );
$function$;
revoke all on function simlsp_private.can_read_sop_preview(text) from public, anon, authenticated;
grant execute on function simlsp_private.can_read_sop_preview(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sop-files', 'sop-files', false, 10485760,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'image/jpeg', 'image/png', 'image/webp'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "SIM-LSP authenticated read SOP previews" on storage.objects;
create policy "SIM-LSP authenticated read SOP previews"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'sop-files'
    and (
      simlsp_private.is_manager()
      or simlsp_private.can_read_sop_preview(name)
    )
  );
drop policy if exists "SIM-LSP managers upload SOP files" on storage.objects;
create policy "SIM-LSP managers upload SOP files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sop-files'
    and (storage.foldername(name))[1] = 'sop'
    and simlsp_private.is_manager()
  );
drop policy if exists "SIM-LSP managers update SOP files" on storage.objects;
create policy "SIM-LSP managers update SOP files"
  on storage.objects for update to authenticated
  using (bucket_id = 'sop-files' and simlsp_private.is_manager())
  with check (
    bucket_id = 'sop-files'
    and (storage.foldername(name))[1] = 'sop'
    and simlsp_private.is_manager()
  );
drop policy if exists "SIM-LSP managers delete SOP files" on storage.objects;
create policy "SIM-LSP managers delete SOP files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'sop-files' and simlsp_private.is_manager());

alter table public.simlsp_info_posts
  add column if not exists kind text not null default 'info',
  add column if not exists sop_id uuid,
  add column if not exists gradient text not null default 'mint',
  add column if not exists notify_all boolean not null default false;

alter table public.simlsp_info_posts
  drop constraint if exists simlsp_info_posts_sop_id_fkey;
alter table public.simlsp_info_posts
  add constraint simlsp_info_posts_sop_id_fkey
  foreign key (sop_id) references public.simlsp_sop_documents(id) on delete cascade;

alter table public.simlsp_info_posts
  drop constraint if exists simlsp_info_posts_body_check,
  drop constraint if exists simlsp_info_posts_kind_check,
  drop constraint if exists simlsp_info_posts_gradient_check,
  drop constraint if exists simlsp_info_posts_sop_link_check;
alter table public.simlsp_info_posts
  add constraint simlsp_info_posts_body_check
    check (char_length(btrim(body)) <= 4000 and (kind = 'sop_link' or char_length(btrim(body)) >= 1)),
  add constraint simlsp_info_posts_kind_check check (kind in ('info', 'sop_link')),
  add constraint simlsp_info_posts_gradient_check check (gradient in ('mint', 'teal', 'blue', 'gold')),
  add constraint simlsp_info_posts_sop_link_check
    check ((kind = 'info' and sop_id is null) or (kind = 'sop_link' and sop_id is not null));

create or replace function simlsp_private.notify_new_info_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_title text;
  v_body text;
begin
  if not new.notify_all then return new; end if;
  v_title := case when new.kind = 'sop_link' then 'SOP baru: ' || new.title else new.category || ': ' || new.title end;
  v_body := case when new.kind = 'sop_link' then 'Buka Menu SOP dan Informasi untuk membaca SOP ini.' else left(btrim(new.body), 320) end;
  for v_user_id in
    select p.id from public.simlsp_profiles p where p.id is distinct from new.created_by
  loop
    perform simlsp_private.enqueue_notification(
      v_user_id, 'info', v_title, v_body,
      'info:' || new.id::text,
      null, null, new.id
    );
  end loop;
  return new;
end;
$function$;
revoke all on function simlsp_private.notify_new_info_post() from public, anon, authenticated;
