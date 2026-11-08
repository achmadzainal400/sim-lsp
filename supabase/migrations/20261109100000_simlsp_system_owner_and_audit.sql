-- One named Pemilik Sistem account, protected account operations, and owner-only logs.

alter table public.simlsp_profiles
  add column if not exists is_system_owner boolean not null default false;

do $owner$
declare
  v_owner_id uuid;
  v_matches integer;
begin
  select count(*)
    into v_matches
    from public.simlsp_profiles
   where lower(username) = lower('Achmadzainalarifin')
     and lower(display_name) like lower('Ahmad Zainal Arifin%');
  if v_matches <> 1 then
    raise exception 'Expected exactly one Ahmad Zainal Arifin profile; found %.', v_matches;
  end if;
  select id into v_owner_id
    from public.simlsp_profiles
   where lower(username) = lower('Achmadzainalarifin')
     and lower(display_name) like lower('Ahmad Zainal Arifin%');
  update public.simlsp_profiles set is_system_owner = (id = v_owner_id);
end;
$owner$;

create unique index if not exists simlsp_profiles_single_system_owner_idx
  on public.simlsp_profiles ((is_system_owner)) where is_system_owner;

create or replace function simlsp_private.is_system_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.simlsp_profiles p
     where p.id = (select auth.uid()) and p.is_system_owner
  );
$function$;
revoke all on function simlsp_private.is_system_owner() from public, anon;
grant execute on function simlsp_private.is_system_owner() to authenticated, service_role;

create table if not exists public.simlsp_audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.simlsp_profiles(id) on delete set null,
  actor_username text not null default '',
  actor_name text not null default '',
  actor_role text not null default 'system',
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id text not null default '',
  entity_label text not null default '',
  reason text not null default '' check (char_length(reason) <= 800),
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists simlsp_audit_events_created_idx
  on public.simlsp_audit_events (created_at desc, id desc);
create table if not exists public.simlsp_login_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.simlsp_profiles(id) on delete set null,
  username text not null default '',
  display_name text not null default '',
  role text not null default '',
  client_label text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists simlsp_login_events_created_idx
  on public.simlsp_login_events (created_at desc, id desc);

insert into public.simlsp_audit_events
  (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, after_data)
select p.id, p.username, p.display_name, 'Pemilik Sistem', 'Pemilik Sistem ditetapkan', 'Akun', p.id::text,
       p.username, 'Penetapan awal Pemilik Sistem untuk SIM-LSP.',
       jsonb_build_object('peranKhusus', 'Pemilik Sistem')
  from public.simlsp_profiles p
 where p.is_system_owner
   and not exists (
     select 1 from public.simlsp_audit_events e
      where e.action = 'Pemilik Sistem ditetapkan' and e.entity_id = p.id::text
   );

alter table public.simlsp_audit_events enable row level security;
alter table public.simlsp_login_events enable row level security;
revoke all on public.simlsp_audit_events, public.simlsp_login_events from public, anon, authenticated;
grant all on public.simlsp_audit_events, public.simlsp_login_events to service_role;

create or replace function public.simlsp_record_login_event(p_client_label text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_profile public.simlsp_profiles%rowtype;
begin
  if v_user_id is null then raise exception 'Sesi masuk diperlukan.' using errcode = '28000'; end if;
  select * into v_profile from public.simlsp_profiles p where p.id = v_user_id;
  if not found then raise exception 'Profil SIM-LSP tidak ditemukan.' using errcode = '42501'; end if;
  insert into public.simlsp_login_events (user_id, username, display_name, role, client_label)
  values (v_user_id, v_profile.username, v_profile.display_name,
          case when v_profile.is_system_owner then 'Pemilik Sistem' when v_profile.role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end,
          left(coalesce(p_client_label, ''), 300));
end;
$function$;
revoke all on function public.simlsp_record_login_event(text) from public, anon;
grant execute on function public.simlsp_record_login_event(text) to authenticated;

create or replace function public.simlsp_list_system_logs(p_limit integer default 100)
returns table (
  id text,
  created_at timestamptz,
  actor_name text,
  actor_username text,
  actor_role text,
  action text,
  entity_type text,
  entity_id text,
  entity_label text,
  reason text,
  before_data jsonb,
  after_data jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not simlsp_private.is_system_owner() then
    raise exception 'Riwayat aktivitas hanya dapat dibuka Pemilik Sistem.' using errcode = '42501';
  end if;
  return query
    select logs.id, logs.created_at, logs.actor_name, logs.actor_username, logs.actor_role,
           logs.action, logs.entity_type, logs.entity_id, logs.entity_label, logs.reason,
           logs.before_data, logs.after_data
      from (
        select ('aksi-' || a.id::text) as id, a.created_at, a.actor_name,
               a.actor_username, a.actor_role, a.action, a.entity_type,
               a.entity_id, a.entity_label, a.reason, a.before_data, a.after_data
          from public.simlsp_audit_events a
        union all
        select ('akses-' || l.id::text), l.created_at, l.display_name,
               l.username, l.role, 'Masuk ke aplikasi', 'Akses', '',
               'Sesi SIM-LSP', '', '{}'::jsonb,
               jsonb_build_object('perangkat', l.client_label)
          from public.simlsp_login_events l
      ) logs
     order by logs.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$function$;
revoke all on function public.simlsp_list_system_logs(integer) from public, anon;
grant execute on function public.simlsp_list_system_logs(integer) to authenticated;

create or replace function public.simlsp_write_system_audit(
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text default '',
  p_entity_label text default '',
  p_reason text default '',
  p_before jsonb default '{}'::jsonb,
  p_after jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile public.simlsp_profiles%rowtype;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'Aksi pencatatan server tidak diizinkan.' using errcode = '42501';
  end if;
  select * into v_profile from public.simlsp_profiles p where p.id = p_actor_id;
  if not found then raise exception 'Akun pelaku tidak ditemukan.' using errcode = 'P0002'; end if;
  insert into public.simlsp_audit_events
    (actor_id, actor_username, actor_name, actor_role, action, entity_type,
     entity_id, entity_label, reason, before_data, after_data)
  values
    (p_actor_id, v_profile.username, v_profile.display_name,
     case when v_profile.is_system_owner then 'Pemilik Sistem' when v_profile.role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end,
     left(coalesce(p_action, ''), 100), left(coalesce(p_entity_type, ''), 80),
     left(coalesce(p_entity_id, ''), 160), left(coalesce(p_entity_label, ''), 240),
     left(coalesce(p_reason, ''), 800),
     coalesce(p_before, '{}'::jsonb) - array['password','token','secret','authorization','refresh_token','ciphertext','iv'],
     coalesce(p_after, '{}'::jsonb) - array['password','token','secret','authorization','refresh_token','ciphertext','iv']);
end;
$function$;
revoke all on function public.simlsp_write_system_audit(uuid, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.simlsp_write_system_audit(uuid, text, text, text, text, text, jsonb, jsonb) to service_role;

create or replace function public.simlsp_admin_list_profiles()
returns table(profile_id uuid, username text, display_name text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not simlsp_private.is_system_owner() then
    raise exception 'Daftar akun hanya dapat dibuka Pemilik Sistem.' using errcode = '42501';
  end if;
  return query
    select p.id, p.username, p.display_name, p.role, p.created_at
      from public.simlsp_profiles p
     order by p.username;
end;
$function$;
revoke all on function public.simlsp_admin_list_profiles() from public, anon;
grant execute on function public.simlsp_admin_list_profiles() to authenticated;

create or replace function public.simlsp_admin_set_role(p_username text, p_role text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_actor_profile public.simlsp_profiles%rowtype;
  v_target public.simlsp_profiles%rowtype;
  v_role text := lower(btrim(coalesce(p_role, '')));
begin
  if v_actor is null or not simlsp_private.is_system_owner() then
    raise exception 'Hanya Pemilik Sistem yang dapat mengubah peran akun.' using errcode = '42501';
  end if;
  if v_role not in ('warga', 'sarpras_admin') then
    raise exception 'Peran hanya boleh warga atau sarpras_admin.' using errcode = '22023';
  end if;
  select * into v_actor_profile from public.simlsp_profiles p where p.id = v_actor;
  select * into v_target from public.simlsp_profiles p
   where lower(p.username) = lower(btrim(coalesce(p_username, '')))
   for update;
  if not found then raise exception 'Akun tidak ditemukan.' using errcode = 'P0002'; end if;
  if v_target.is_system_owner and v_role <> 'sarpras_admin' then
    raise exception 'Peran Pemilik Sistem tidak dapat diturunkan.' using errcode = '42501';
  end if;
  if v_target.id = v_actor then
    raise exception 'Peran akun yang sedang digunakan tidak dapat diubah dari halaman ini.' using errcode = '42501';
  end if;
  if v_target.role is distinct from v_role then
    update public.simlsp_profiles set role = v_role where id = v_target.id;
    insert into public.simlsp_audit_events
      (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
    values
      (v_actor, v_actor_profile.username, v_actor_profile.display_name, 'Pemilik Sistem', 'Peran akun diubah', 'Akun',
       v_target.id::text, v_target.username, 'Perubahan peran melalui Data & cadangan.',
       jsonb_build_object('peran', v_target.role), jsonb_build_object('peran', v_role));
  end if;
  return true;
end;
$function$;
revoke all on function public.simlsp_admin_set_role(text, text) from public, anon;
grant execute on function public.simlsp_admin_set_role(text, text) to authenticated;

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
  v_old_reports jsonb := case when jsonb_typeof(old.data->'reports') = 'array' then old.data->'reports' else '[]'::jsonb end;
  v_new_reports jsonb := case when jsonb_typeof(new.data->'reports') = 'array' then new.data->'reports' else '[]'::jsonb end;
  v_old_assets jsonb := case when jsonb_typeof(old.data->'assets') = 'array' then old.data->'assets' else '[]'::jsonb end;
  v_new_assets jsonb := case when jsonb_typeof(new.data->'assets') = 'array' then new.data->'assets' else '[]'::jsonb end;
  v_new jsonb;
  v_old jsonb;
  v_id text;
  v_code text;
  v_label text;
  v_reason text;
  v_before jsonb;
  v_after jsonb;
begin
  if old.data is not distinct from new.data then return new; end if;
  if v_actor_id is not null then
    select p.username, p.display_name,
           case when p.is_system_owner then 'Pemilik Sistem' when p.role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end
      into v_actor_username, v_actor_name, v_actor_role
      from public.simlsp_profiles p where p.id = v_actor_id;
    v_actor_username := coalesce(v_actor_username, '');
    v_actor_name := coalesce(v_actor_name, 'Akun SIM-LSP');
    v_actor_role := coalesce(v_actor_role, '');
  end if;

  for v_new in select value from jsonb_array_elements(v_new_reports) as item(value) loop
    v_id := coalesce(v_new->>'id', '');
    select value into v_old from jsonb_array_elements(v_old_reports) as item(value)
     where value->>'id' = v_id limit 1;
    v_code := coalesce(v_new->>'code', v_id);
    if v_old is null then
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Laporan dibuat', 'Laporan', v_id, v_code,
              jsonb_build_object('status', v_new->'status'));
    elsif v_old->'status' is distinct from v_new->'status' then
      v_reason := left(coalesce(v_new->>'deferReason', v_new->>'rejectionReason', v_new->>'reason', ''), 800);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Status laporan diubah', 'Laporan', v_id, v_code, v_reason,
              jsonb_build_object('status', v_old->'status'), jsonb_build_object('status', v_new->'status'));
    end if;
    v_old := null;
  end loop;
  for v_old in select value from jsonb_array_elements(v_old_reports) as item(value) loop
    if not exists (select 1 from jsonb_array_elements(v_new_reports) as item(value) where value->>'id' = v_old->>'id') then
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Laporan dihapus', 'Laporan',
              coalesce(v_old->>'id', ''), coalesce(v_old->>'code', v_old->>'id', ''), jsonb_build_object('status', v_old->'status'));
    end if;
  end loop;

  for v_new in select value from jsonb_array_elements(v_new_assets) as item(value) loop
    v_id := coalesce(v_new->>'id', '');
    select value into v_old from jsonb_array_elements(v_old_assets) as item(value)
     where value->>'id' = v_id limit 1;
    v_label := coalesce(v_new->>'name', v_id);
    v_before := jsonb_build_object('nama', v_old->'name', 'jumlah', v_old->'quantity', 'satuan', v_old->'unit', 'area', v_old->'area', 'status', v_old->'status', 'kondisi', v_old->'condition');
    v_after := jsonb_build_object('nama', v_new->'name', 'jumlah', v_new->'quantity', 'satuan', v_new->'unit', 'area', v_new->'area', 'status', v_new->'status', 'kondisi', v_new->'condition');
    if v_old is null then
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Aset ditambahkan', 'Aset', v_id, v_label, v_after);
    elsif v_old->'name' is distinct from v_new->'name'
       or v_old->'quantity' is distinct from v_new->'quantity'
       or v_old->'unit' is distinct from v_new->'unit'
       or v_old->'area' is distinct from v_new->'area'
       or v_old->'status' is distinct from v_new->'status'
       or v_old->'condition' is distinct from v_new->'condition' then
      v_reason := left(coalesce(v_new->>'lastChangeReason', v_new->>'description', 'Perubahan inventaris melalui aplikasi.'), 800);
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, before_data, after_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Aset diubah', 'Aset', v_id, v_label, v_reason, v_before, v_after);
    end if;
    v_old := null;
  end loop;
  for v_old in select value from jsonb_array_elements(v_old_assets) as item(value) loop
    if not exists (select 1 from jsonb_array_elements(v_new_assets) as item(value) where value->>'id' = v_old->>'id') then
      insert into public.simlsp_audit_events
        (actor_id, actor_username, actor_name, actor_role, action, entity_type, entity_id, entity_label, before_data)
      values (v_actor_id, v_actor_username, v_actor_name, v_actor_role, 'Aset dihapus', 'Aset',
              coalesce(v_old->>'id', ''), coalesce(v_old->>'name', v_old->>'id', ''),
              jsonb_build_object('nama', v_old->'name', 'jumlah', v_old->'quantity', 'satuan', v_old->'unit', 'area', v_old->'area', 'status', v_old->'status', 'kondisi', v_old->'condition'));
    end if;
  end loop;
  return new;
end;
$function$;

drop trigger if exists simlsp_shared_data_audit_changes on public.simlsp_shared_data;
create trigger simlsp_shared_data_audit_changes
  after update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.audit_shared_state_change();

-- Keep routine report/asset editing for managers, but destructive deletion and
-- large replacement batches are owner-only at the shared-state RPC boundary.
create or replace function public.simlsp_save_shared_state(p_data jsonb, p_expected_revision integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_revision integer;
  current_data jsonb;
  user_role text;
  is_owner boolean;
  old_reports jsonb;
  new_reports jsonb;
  old_assets jsonb;
  new_assets jsonb;
  changed_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Sesi masuk diperlukan.' using errcode = '28000'; end if;
  select profile.role, profile.is_system_owner into user_role, is_owner
    from public.simlsp_profiles profile where profile.id = auth.uid();
  if user_role is null or user_role not in ('sarpras_admin', 'admin', 'sarpras', 'administrator') then
    raise exception 'Akses ditolak. Hanya Admin/Sarpras yang dapat mengubah data secara massal.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Data bersama tidak valid.' using errcode = '22023'; end if;
  if p_expected_revision is null then raise exception 'Nomor revisi diperlukan.' using errcode = '22023'; end if;

  select state.revision, state.data into current_revision, current_data
    from public.simlsp_shared_data state where state.id = 1 for update;
  if not found then raise exception 'Data bersama belum tersedia.' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_revision then raise exception 'Conflict' using errcode = '40001'; end if;

  if not coalesce(is_owner, false) then
    old_reports := case when jsonb_typeof(current_data->'reports') = 'array' then current_data->'reports' else '[]'::jsonb end;
    new_reports := case when jsonb_typeof(p_data->'reports') = 'array' then p_data->'reports' else '[]'::jsonb end;
    old_assets := case when jsonb_typeof(current_data->'assets') = 'array' then current_data->'assets' else '[]'::jsonb end;
    new_assets := case when jsonb_typeof(p_data->'assets') = 'array' then p_data->'assets' else '[]'::jsonb end;
    if exists (select 1 from jsonb_array_elements(old_reports) a(value)
               where not exists (select 1 from jsonb_array_elements(new_reports) b(value) where b.value->>'id' = a.value->>'id'))
       or exists (select 1 from jsonb_array_elements(old_assets) a(value)
                  where not exists (select 1 from jsonb_array_elements(new_assets) b(value) where b.value->>'id' = a.value->>'id')) then
      raise exception 'Penghapusan laporan atau aset hanya dapat dilakukan Pemilik Sistem.' using errcode = '42501';
    end if;
    if coalesce(current_data->'assetDeletionTombstones', '[]'::jsonb)
       is distinct from coalesce(p_data->'assetDeletionTombstones', '[]'::jsonb) then
      raise exception 'Penghapusan atau pemulihan permanen aset hanya dapat dilakukan Pemilik Sistem.' using errcode = '42501';
    end if;
    if exists (
      select 1
        from jsonb_array_elements(case when jsonb_typeof(current_data->'assetAreas') = 'array' then current_data->'assetAreas' else '[]'::jsonb end) old_area(value)
       where coalesce(old_area.value->>'deletedAt', '') = ''
         and not exists (
           select 1
             from jsonb_array_elements(case when jsonb_typeof(p_data->'assetAreas') = 'array' then p_data->'assetAreas' else '[]'::jsonb end) new_area(value)
            where new_area.value->>'key' = old_area.value->>'key'
              and coalesce(new_area.value->>'deletedAt', '') = ''
         )
         and not exists (
           select 1 from jsonb_array_elements(old_assets) old_asset(value)
            where lower(coalesce(old_asset.value->>'area', '')) = lower(coalesce(old_area.value->>'name', ''))
         )
    ) then
      raise exception 'Penghapusan lokasi kosong hanya dapat dilakukan Pemilik Sistem.' using errcode = '42501';
    end if;
    select count(*)::integer into changed_count from (
      select a.value from jsonb_array_elements(old_reports) a(value)
      join jsonb_array_elements(new_reports) b(value) on b.value->>'id' = a.value->>'id'
      where a.value is distinct from b.value
      union all
      select b.value from jsonb_array_elements(new_reports) b(value)
      where not exists (select 1 from jsonb_array_elements(old_reports) a(value) where a.value->>'id' = b.value->>'id')
      union all
      select a.value from jsonb_array_elements(old_assets) a(value)
      join jsonb_array_elements(new_assets) b(value) on b.value->>'id' = a.value->>'id'
      where a.value is distinct from b.value
      union all
      select b.value from jsonb_array_elements(new_assets) b(value)
      where not exists (select 1 from jsonb_array_elements(old_assets) a(value) where a.value->>'id' = b.value->>'id')
    ) changes;
    if changed_count > 50 then
      raise exception 'Perubahan massal lebih dari 50 laporan/aset harus dilakukan Pemilik Sistem.' using errcode = '42501';
    end if;
  end if;

  update public.simlsp_shared_data set data = p_data, revision = revision + 1 where id = 1;
  return current_revision + 1;
end;
$function$;
revoke all on function public.simlsp_save_shared_state(jsonb, integer) from public, anon;
grant execute on function public.simlsp_save_shared_state(jsonb, integer) to authenticated, service_role;
