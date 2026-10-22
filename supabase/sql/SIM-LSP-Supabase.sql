-- SIM-LSP: profil dan peran untuk login Supabase
-- Jalankan skrip ini di Supabase Dashboard > SQL Editor.
-- Jangan pernah memasukkan service_role/secret key ke file HTML.

create table if not exists public.simlsp_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null
    check (username ~ '^[A-Za-z0-9._-]{3,40}$'),
  display_name text not null default '',
  role text not null default 'warga'
    check (role in ('warga', 'sarpras_admin')),
  created_at timestamptz not null default now()
);

-- Usernames may preserve uppercase, but remain unique regardless of letter case.
alter table public.simlsp_profiles drop constraint if exists simlsp_profiles_username_check;
alter table public.simlsp_profiles
  add constraint simlsp_profiles_username_check check (username ~ '^[A-Za-z0-9._-]{3,40}$');
alter table public.simlsp_profiles drop constraint if exists simlsp_profiles_username_key;
create unique index if not exists simlsp_profiles_username_ci_key
  on public.simlsp_profiles (lower(username));

alter table public.simlsp_profiles enable row level security;

revoke all on table public.simlsp_profiles from anon, authenticated;
grant select on table public.simlsp_profiles to authenticated;
-- Edge Function server uses the privileged service_role; this role/key must never be placed in HTML.
grant all on table public.simlsp_profiles to service_role;

drop policy if exists "SIM-LSP user reads own profile" on public.simlsp_profiles;
create policy "SIM-LSP user reads own profile"
  on public.simlsp_profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create or replace function public.simlsp_create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
begin
  -- Keep the typed username's letter case in the profile. Auth aliases remain lowercase.
  v_username := btrim(coalesce(new.raw_user_meta_data ->> 'username', ''));
  if v_username = '' then
    v_username := split_part(coalesce(new.email, ''), '@', 1);
  end if;

  if v_username !~ '^[A-Za-z0-9._-]{3,40}$' then
    v_username := 'user_' || substring(replace(new.id::text, '-', '') from 1 for 12);
  end if;

  insert into public.simlsp_profiles (id, username, display_name, role)
  values (
    new.id,
    v_username,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), v_username),
    'warga'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.simlsp_create_profile_for_auth_user() from public, anon, authenticated;

drop trigger if exists simlsp_auth_user_created on auth.users;
create trigger simlsp_auth_user_created
  after insert on auth.users
  for each row execute function public.simlsp_create_profile_for_auth_user();

-- Hanya Sarpras/Admin yang dapat melihat daftar akun dan mengubah peran.
create or replace function public.simlsp_admin_list_profiles()
returns table(profile_id uuid, username text, display_name text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.simlsp_profiles p
    where p.id = (select auth.uid()) and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat melihat daftar akun.' using errcode = '42501';
  end if;

  return query
    select p.id, p.username, p.display_name, p.role, p.created_at
    from public.simlsp_profiles p
    order by p.username;
end;
$$;

create or replace function public.simlsp_admin_set_role(p_username text, p_role text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_target uuid;
  v_target_role text;
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_admin_count integer;
begin
  if v_actor is null or not exists (
    select 1 from public.simlsp_profiles p
    where p.id = v_actor and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat mengubah peran akun.' using errcode = '42501';
  end if;

  if v_role not in ('warga', 'sarpras_admin') then
    raise exception 'Peran hanya boleh warga atau sarpras_admin.' using errcode = '22023';
  end if;

  -- Lock current administrators so two concurrent requests cannot demote the last one.
  perform p.id
  from public.simlsp_profiles p
  where p.role = 'sarpras_admin'
  order by p.id
  for update;

  -- Recheck after locks in case this session lost admin access while waiting.
  if not exists (
    select 1 from public.simlsp_profiles p
    where p.id = v_actor and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat mengubah peran akun.' using errcode = '42501';
  end if;

  select p.id, p.role into v_target, v_target_role
  from public.simlsp_profiles p
  where lower(p.username) = lower(btrim(coalesce(p_username, '')))
  for update;

  if v_target is null then
    raise exception 'Akun tidak ditemukan.' using errcode = 'P0002';
  end if;
  if v_target = v_actor then
    raise exception 'Peran akun yang sedang digunakan tidak dapat diubah dari halaman ini.' using errcode = '42501';
  end if;

  if v_target_role = 'sarpras_admin' and v_role = 'warga' then
    select count(*) into v_admin_count
    from public.simlsp_profiles p
    where p.role = 'sarpras_admin';
    if v_admin_count <= 1 then
      raise exception 'Tidak dapat menurunkan satu-satunya akun Sarpras/Admin.' using errcode = '23514';
    end if;
  end if;

  update public.simlsp_profiles p
  set role = v_role
  where p.id = v_target;
  return true;
end;
$$;

revoke all on function public.simlsp_admin_list_profiles() from public, anon;
revoke all on function public.simlsp_admin_set_role(text, text) from public, anon;
grant execute on function public.simlsp_admin_list_profiles() to authenticated;
grant execute on function public.simlsp_admin_set_role(text, text) to authenticated;

-- Backfill accounts created before this trigger, using the project-scoped username@...
-- alias convention. Existing profiles and their roles are left untouched.
insert into public.simlsp_profiles (id, username, display_name, role)
select
  u.id,
  coalesce(nullif(btrim(u.raw_user_meta_data ->> 'username'), ''), split_part(u.email, '@', 1)),
  coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''), split_part(u.email, '@', 1)),
  'warga'
from auth.users as u
where (u.email ilike '%@lcfqhrziveksvxuldsfa.supabase.co'
   or u.email ilike '%@login.simlsp.invalid')
  and split_part(u.email, '@', 1) ~* '^[a-z0-9._-]{3,40}$'
on conflict (id) do nothing;

-- Setelah membuat akun di Authentication > Users, ubah role akun Sarpras/Admin
-- dengan menjalankan perintah ini dan mengganti username pada contoh:
-- update public.simlsp_profiles
-- set role = 'sarpras_admin'
-- where username = 'username-sarpras';

-- SIM-LSP: penyimpanan laporan, aset, transaksi, dan SOP bersama.
-- Jalankan bagian ini setelah tabel simlsp_profiles tersedia.
create table if not exists public.simlsp_shared_state (
  id boolean primary key default true check (id = true),
  data jsonb not null default '{"reports":[],"assets":[],"assetTransactions":[],"assetReportExclusions":[],"sopHtml":"","sopSourceName":"","sopUpdatedAt":""}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.simlsp_shared_state (id)
values (true)
on conflict (id) do nothing;

alter table public.simlsp_shared_state enable row level security;
revoke all on table public.simlsp_shared_state from anon, authenticated;
grant all on table public.simlsp_shared_state to service_role;

create or replace function public.simlsp_get_shared_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_row public.simlsp_shared_state%rowtype;
  v_reports jsonb;
begin
  select p.role into v_role
  from public.simlsp_profiles p
  where p.id = v_actor;
  if v_role is null then
    raise exception 'Profil pengguna tidak tersedia.' using errcode = '42501';
  end if;

  select s.* into v_row
  from public.simlsp_shared_state s
  where s.id = true;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;

  if v_role = 'sarpras_admin' then
    return jsonb_build_object('revision', v_row.revision, 'data', v_row.data);
  end if;

  -- Warga hanya menerima rincian yang memang ditampilkan sebagai informasi umum.
  select coalesce(jsonb_agg(
    (item.value - array[
      'pj','executor','startedAt','materialCost','serviceCost','result',
      'assetUsageId','assetUsageQuantity','assetUsageNote','needsApproval',
      'approvalStatus','approverName','approvalNote','previousStatus',
      'legacyStatus','internalNote','deferReason','creatorProfileId'
    ]::text[]) || jsonb_build_object(
      'events', coalesce(events.public_events, '[]'::jsonb),
      'creatorProfileId', case when item.value ->> 'creatorProfileId' = v_actor::text then v_actor::text else null end
    )
    order by item.ordinality
  ), '[]'::jsonb)
  into v_reports
  from jsonb_array_elements(coalesce(v_row.data -> 'reports', '[]'::jsonb)) with ordinality as item(value, ordinality)
  left join lateral (
    select coalesce(jsonb_agg(event.value order by event.ordinality), '[]'::jsonb) as public_events
    from jsonb_array_elements(
      case when jsonb_typeof(item.value -> 'events') = 'array' then item.value -> 'events' else '[]'::jsonb end
    ) with ordinality as event(value, ordinality)
    where event.value ->> 'public' is distinct from 'false'
  ) as events on true;

  return jsonb_build_object(
    'revision', v_row.revision,
    'data', jsonb_set(v_row.data, '{reports}', v_reports, true)
  );
end;
$$;

create or replace function public.simlsp_save_shared_state(p_data jsonb, p_expected_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_revision bigint;
  v_data jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.simlsp_profiles p
    where p.id = v_actor and p.role = 'sarpras_admin'
  ) then
    raise exception 'Hanya Sarpras/Admin yang dapat menyimpan perubahan bersama.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or jsonb_typeof(p_data -> 'reports') is distinct from 'array'
     or jsonb_typeof(p_data -> 'assets') is distinct from 'array'
     or jsonb_typeof(p_data -> 'assetTransactions') is distinct from 'array'
     or jsonb_typeof(p_data -> 'assetReportExclusions') is distinct from 'array' then
    raise exception 'Struktur data SIM-LSP tidak valid.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_data -> 'reports') e(value) where jsonb_typeof(e.value) <> 'object')
     or exists (select 1 from jsonb_array_elements(p_data -> 'assets') e(value) where jsonb_typeof(e.value) <> 'object')
     or exists (select 1 from jsonb_array_elements(p_data -> 'assetTransactions') e(value) where jsonb_typeof(e.value) <> 'object') then
    raise exception 'Data laporan atau aset berisi baris yang tidak valid.' using errcode = '22023';
  end if;

  v_data := jsonb_build_object(
    'reports', p_data -> 'reports',
    'assets', p_data -> 'assets',
    'assetTransactions', p_data -> 'assetTransactions',
    'assetReportExclusions', p_data -> 'assetReportExclusions',
    'sopHtml', case when jsonb_typeof(p_data -> 'sopHtml') = 'string' then p_data -> 'sopHtml' else '""'::jsonb end,
    'sopSourceName', case when jsonb_typeof(p_data -> 'sopSourceName') = 'string' then p_data -> 'sopSourceName' else '""'::jsonb end,
    'sopUpdatedAt', case when jsonb_typeof(p_data -> 'sopUpdatedAt') = 'string' then p_data -> 'sopUpdatedAt' else '""'::jsonb end
  );

  select s.revision into v_revision
  from public.simlsp_shared_state s
  where s.id = true
  for update;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;
  if p_expected_revision is distinct from v_revision then
    raise exception 'Data bersama berubah. Muat ulang sebelum menyimpan.' using errcode = '40001';
  end if;

  update public.simlsp_shared_state s
  set data = v_data, revision = v_revision + 1, updated_by = v_actor, updated_at = now()
  where s.id = true;
  return jsonb_build_object('revision', v_revision + 1);
end;
$$;

create or replace function public.simlsp_submit_report(p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_name text;
  v_state public.simlsp_shared_state%rowtype;
  v_report jsonb;
  v_reports jsonb;
  v_assets jsonb;
  v_asset jsonb;
  v_existing jsonb;
  v_event jsonb;
  v_now timestamptz := now();
  v_revision bigint;
  v_id text;
  v_code text;
  v_object text;
  v_area text;
  v_date text;
begin
  select p.role, p.display_name into v_role, v_name
  from public.simlsp_profiles p
  where p.id = v_actor;
  if v_actor is null or v_role is null then
    raise exception 'Profil pengguna tidak tersedia.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object' then
    raise exception 'Data laporan tidak valid.' using errcode = '22023';
  end if;
  v_id := btrim(coalesce(p_report ->> 'id', ''));
  v_code := btrim(coalesce(p_report ->> 'code', ''));
  v_object := btrim(coalesce(p_report ->> 'object', ''));
  v_area := btrim(coalesce(p_report ->> 'location', ''));
  if v_id = '' or v_code = '' or v_object = '' then
    raise exception 'Kode laporan dan nama objek wajib diisi.' using errcode = '22023';
  end if;

  select s.* into v_state
  from public.simlsp_shared_state s
  where s.id = true
  for update;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;

  select item.value into v_existing
  from jsonb_array_elements(coalesce(v_state.data -> 'reports', '[]'::jsonb)) item(value)
  where item.value ->> 'id' = v_id
  limit 1;
  if v_existing is not null then
    if v_existing ->> 'creatorProfileId' = v_actor::text then
      return jsonb_build_object('revision', v_state.revision);
    end if;
    raise exception 'Nomor laporan sudah digunakan.' using errcode = '23505';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_state.data -> 'reports', '[]'::jsonb)) item(value)
    where lower(btrim(coalesce(item.value ->> 'code', ''))) = lower(v_code)
  ) then
    raise exception 'Kode tiket sudah digunakan oleh laporan lain.' using errcode = '23505';
  end if;

  if jsonb_typeof(p_report -> 'acquisitionQuantity') not in ('number', 'null')
     and p_report ? 'acquisitionQuantity' then
    raise exception 'Jumlah pengadaan harus berupa angka.' using errcode = '22023';
  end if;
  v_event := jsonb_build_object(
    'at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'by', coalesce(nullif(btrim(v_name), ''), 'Warga Madrasah'),
    'role', case when v_role = 'sarpras_admin' then 'Sarpras / Admin' else 'Warga Madrasah' end,
    'message', 'Laporan dibuat dan menunggu verifikasi.',
    'public', true
  );
  v_report := jsonb_build_object(
    'id', v_id,
    'code', v_code,
    'createdAt', coalesce(nullif(p_report ->> 'createdAt', ''), to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'unit', coalesce(p_report ->> 'unit', ''),
    'location', v_area,
    'category', coalesce(p_report ->> 'category', 'Lainnya'),
    'object', v_object,
    'acquisitionQuantity', coalesce(p_report -> 'acquisitionQuantity', '0'::jsonb),
    'acquisitionUnit', coalesce(p_report ->> 'acquisitionUnit', ''),
    'description', coalesce(p_report ->> 'description', ''),
    'reporterName', coalesce(nullif(btrim(v_name), ''), 'Warga Madrasah'),
    'creator', coalesce(nullif(btrim(v_name), ''), 'Warga Madrasah'),
    'creatorProfileId', v_actor::text,
    'urgency', case when p_report ->> 'urgency' = 'KRITIS' then 'KRITIS' else 'NORMAL' end,
    'priority', 'NORMAL',
    'status', 'BARU',
    'needsApproval', false,
    'approvalStatus', 'BELUM DIPERIKSA',
    'pj', '', 'executor', '', 'materialCost', 0, 'serviceCost', 0,
    'result', '', 'assetUsageId', '', 'assetUsageQuantity', 0,
    'assetUsageNote', '',
    'events', jsonb_build_array(v_event)
  );
  v_reports := coalesce(v_state.data -> 'reports', '[]'::jsonb) || jsonb_build_array(v_report);
  v_assets := coalesce(v_state.data -> 'assets', '[]'::jsonb);
  v_date := ((coalesce(nullif(p_report ->> 'createdAt', '')::timestamptz, v_now) at time zone 'Asia/Jakarta')::date)::text;

  select item.value into v_asset
  from jsonb_array_elements(v_assets) item(value)
  where lower(regexp_replace(btrim(coalesce(item.value ->> 'name', '')), '\s+', ' ', 'g')) = lower(regexp_replace(v_object, '\s+', ' ', 'g'))
    and lower(regexp_replace(btrim(coalesce(item.value ->> 'area', '')), '\s+', ' ', 'g')) = lower(regexp_replace(v_area, '\s+', ' ', 'g'))
    and (coalesce(item.value ->> 'acquisitionDate', '') = '' or left(item.value ->> 'acquisitionDate', 10) = v_date)
    and lower(coalesce(item.value ->> 'status', 'aktif')) = 'aktif'
  limit 1;
  if v_asset is null then
    v_asset := jsonb_build_object(
      'id', 'a_' || replace(gen_random_uuid()::text, '-', ''),
      'name', v_object, 'unit', '', 'quantity', 0, 'area', v_area,
      'status', 'Aktif', 'acquisitionDate', v_date, 'description', '',
      'areaSource', case when v_area = '' then '' else 'report' end,
      'areaReportId', v_id,
      'createdAt', v_report ->> 'createdAt',
      'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    v_assets := v_assets || jsonb_build_array(v_asset);
  end if;

  update public.simlsp_shared_state s
  set data = jsonb_set(jsonb_set(v_state.data, '{reports}', v_reports, true), '{assets}', v_assets, true),
      revision = v_state.revision + 1, updated_by = v_actor, updated_at = v_now
  where s.id = true;
  return jsonb_build_object('revision', v_state.revision + 1);
end;
$$;

create or replace function public.simlsp_update_own_report(p_report_id text, p_action text, p_detail text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_name text;
  v_state public.simlsp_shared_state%rowtype;
  v_report jsonb;
  v_reports jsonb;
  v_event jsonb;
  v_events jsonb;
  v_now timestamptz := now();
  v_ordinal bigint;
  v_revision bigint;
  v_status text;
  v_message text;
begin
  select p.role, p.display_name into v_role, v_name
  from public.simlsp_profiles p
  where p.id = v_actor;
  if v_actor is null or v_role <> 'warga' then
    raise exception 'Aksi ini hanya tersedia untuk akun Warga Madrasah.' using errcode = '42501';
  end if;
  select s.* into v_state
  from public.simlsp_shared_state s
  where s.id = true
  for update;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;
  select item.value, item.ordinality into v_report, v_ordinal
  from jsonb_array_elements(coalesce(v_state.data -> 'reports', '[]'::jsonb)) with ordinality item(value, ordinality)
  where item.value ->> 'id' = p_report_id
  limit 1;
  if v_report is null or v_report ->> 'creatorProfileId' is distinct from v_actor::text then
    raise exception 'Laporan tidak ditemukan atau bukan milik akun ini.' using errcode = '42501';
  end if;
  v_status := coalesce(v_report ->> 'status', '');
  v_events := case when jsonb_typeof(v_report -> 'events') = 'array' then v_report -> 'events' else '[]'::jsonb end;
  if p_action = 'cancel' then
    if v_status not in ('BARU', 'PERLU_DILENGKAPI', 'ANTREAN', 'MENUNGGU_PERSETUJUAN') then
      raise exception 'Status laporan ini tidak dapat dibatalkan.' using errcode = '42501';
    end if;
    v_report := v_report || jsonb_build_object('status', 'DIBATALKAN');
    v_message := 'Laporan dibatalkan oleh pelapor.';
  elsif p_action = 'clarify' then
    if v_status <> 'PERLU_DILENGKAPI' or btrim(coalesce(p_detail, '')) = '' then
      raise exception 'Laporan tidak sedang menunggu informasi tambahan atau keterangan kosong.' using errcode = '22023';
    end if;
    v_report := v_report || jsonb_build_object(
      'description', coalesce(v_report ->> 'description', '') || E'\n\nInformasi tambahan: ' || btrim(p_detail),
      'status', 'BARU'
    );
    v_message := 'Pelapor melengkapi informasi; laporan kembali menunggu verifikasi.';
  else
    raise exception 'Aksi laporan tidak dikenal.' using errcode = '22023';
  end if;
  v_event := jsonb_build_object(
    'at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'by', coalesce(nullif(btrim(v_name), ''), 'Warga Madrasah'),
    'role', 'Warga Madrasah', 'message', v_message, 'public', true
  );
  v_report := v_report || jsonb_build_object(
    'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'events', jsonb_build_array(v_event) || v_events
  );
  select coalesce(jsonb_agg(case when item.ordinality = v_ordinal then v_report else item.value end order by item.ordinality), '[]'::jsonb)
  into v_reports
  from jsonb_array_elements(coalesce(v_state.data -> 'reports', '[]'::jsonb)) with ordinality item(value, ordinality);
  update public.simlsp_shared_state s
  set data = jsonb_set(v_state.data, '{reports}', v_reports, true),
      revision = v_state.revision + 1, updated_by = v_actor, updated_at = v_now
  where s.id = true;
  return jsonb_build_object('revision', v_state.revision + 1);
end;
$$;

revoke all on function public.simlsp_get_shared_state() from public, anon;
revoke all on function public.simlsp_save_shared_state(jsonb, bigint) from public, anon;
revoke all on function public.simlsp_submit_report(jsonb) from public, anon;
revoke all on function public.simlsp_update_own_report(text, text, text) from public, anon;
grant execute on function public.simlsp_get_shared_state() to authenticated;
grant execute on function public.simlsp_save_shared_state(jsonb, bigint) to authenticated;
grant execute on function public.simlsp_submit_report(jsonb) to authenticated;
grant execute on function public.simlsp_update_own_report(text, text, text) to authenticated;
