-- Restrict legacy shared-state RPCs to authenticated sessions and make their
-- SECURITY DEFINER behavior explicit. The app requires sign-in before use.

create or replace function public.simlsp_get_shared_state()
returns json
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result json;
begin
  select pg_catalog.json_build_object('revision', revision, 'data', data)
    into result
    from public.simlsp_shared_data
   where id = 1;
  return result;
end;
$function$;
revoke all on function public.simlsp_get_shared_state() from public, anon;
grant execute on function public.simlsp_get_shared_state() to authenticated, service_role;

create or replace function public.simlsp_save_shared_state(p_data jsonb, p_expected_revision integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_revision integer;
  user_role text;
begin
  if auth.uid() is null then
    raise exception 'Sesi masuk diperlukan.' using errcode = '28000';
  end if;

  select profile.role
    into user_role
    from public.simlsp_profiles profile
   where profile.id = auth.uid();
  if user_role is null or user_role not in ('sarpras_admin', 'admin', 'sarpras', 'administrator') then
    raise exception 'Akses ditolak. Hanya Admin/Sarpras yang dapat mengubah data secara massal.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'Data bersama tidak valid.' using errcode = '22023';
  end if;
  if p_expected_revision is null then
    raise exception 'Nomor revisi diperlukan.' using errcode = '22023';
  end if;

  select state.revision
    into current_revision
    from public.simlsp_shared_data state
   where state.id = 1
   for update;
  if not found then
    raise exception 'Data bersama belum tersedia.' using errcode = 'P0002';
  end if;
  if current_revision <> p_expected_revision then
    raise exception 'Conflict' using errcode = '40001';
  end if;

  update public.simlsp_shared_data
     set data = p_data,
         revision = revision + 1
   where id = 1;
  return current_revision + 1;
end;
$function$;
revoke all on function public.simlsp_save_shared_state(jsonb, integer) from public, anon;
grant execute on function public.simlsp_save_shared_state(jsonb, integer) to authenticated, service_role;

create or replace function public.simlsp_update_own_report(p_report_id text, p_action text, p_detail text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_data jsonb;
  current_revision integer;
  reports jsonb;
  report jsonb;
  report_status text;
  user_id uuid := auth.uid();
  display_name text;
  event_at text := pg_catalog.to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  found_report boolean := false;
begin
  if user_id is null then
    raise exception 'Sesi masuk diperlukan.' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.simlsp_profiles profile
     where profile.id = user_id and profile.role = 'warga'
  ) then
    raise exception 'Aksi ini hanya tersedia untuk akun Warga Madrasah.' using errcode = '42501';
  end if;
  if coalesce(p_report_id, '') !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'ID laporan tidak valid.' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('cancel', 'clarify') then
    raise exception 'Aksi laporan tidak valid.' using errcode = '22023';
  end if;
  if p_action = 'clarify' and (char_length(btrim(coalesce(p_detail, ''))) < 1 or char_length(p_detail) > 2000) then
    raise exception 'Informasi tambahan harus berisi 1 sampai 2000 karakter.' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(profile.display_name), ''), profile.username)
    into display_name
    from public.simlsp_profiles profile
   where profile.id = user_id;
  select state.data, state.revision
    into current_data, current_revision
    from public.simlsp_shared_data state
   where state.id = 1
   for update;
  if not found then
    raise exception 'Data bersama tidak tersedia.' using errcode = 'P0002';
  end if;
  reports := current_data -> 'reports';
  if jsonb_typeof(reports) is distinct from 'array' then
    raise exception 'Daftar laporan tidak valid.' using errcode = '22023';
  end if;

  for i in 0 .. jsonb_array_length(reports) - 1 loop
    report := reports -> i;
    if report ->> 'id' = p_report_id then
      if coalesce(report ->> 'creatorProfileId', '') <> user_id::text then
        raise exception 'Akses ditolak: akun ini bukan pelapor tiket.' using errcode = '42501';
      end if;
      report_status := coalesce(report ->> 'status', '');

      if p_action = 'cancel' then
        if report_status not in ('BARU', 'PERLU_DILENGKAPI', 'ANTREAN', 'MENUNGGU_PERSETUJUAN') then
          raise exception 'Status tiket ini tidak dapat dibatalkan oleh pelapor.' using errcode = '42501';
        end if;
        report := pg_catalog.jsonb_set(report, '{status}', '"DIBATALKAN"'::jsonb, true);
        report := pg_catalog.jsonb_set(report, '{events}',
          (case when jsonb_typeof(report -> 'events') = 'array' then report -> 'events' else '[]'::jsonb end)
          || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'at', event_at, 'by', display_name, 'role', 'Warga Madrasah',
            'message', 'Laporan dibatalkan oleh pelapor.', 'public', true
          )), true);
      else
        if report_status <> 'PERLU_DILENGKAPI' then
          raise exception 'Tiket ini tidak sedang menunggu informasi tambahan.' using errcode = '42501';
        end if;
        report := pg_catalog.jsonb_set(report, '{description}',
          pg_catalog.to_jsonb(coalesce(report ->> 'description', '') || E'\n\nInformasi tambahan: ' || btrim(p_detail)), true);
        report := pg_catalog.jsonb_set(report, '{status}', '"BARU"'::jsonb, true);
        report := pg_catalog.jsonb_set(report, '{events}',
          (case when jsonb_typeof(report -> 'events') = 'array' then report -> 'events' else '[]'::jsonb end)
          || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'at', event_at, 'by', display_name, 'role', 'Warga Madrasah',
            'message', 'Pelapor melengkapi informasi; laporan kembali menunggu verifikasi.', 'public', true
          )), true);
      end if;

      reports := pg_catalog.jsonb_set(reports, array[i::text], report, true);
      found_report := true;
      exit;
    end if;
  end loop;
  if not found_report then
    raise exception 'Laporan tidak ditemukan.' using errcode = 'P0002';
  end if;

  current_data := pg_catalog.jsonb_set(current_data, '{reports}', reports, true);
  update public.simlsp_shared_data
     set data = current_data,
         revision = revision + 1
   where id = 1;
  return current_revision + 1;
end;
$function$;
revoke all on function public.simlsp_update_own_report(text, text, text) from public, anon;
grant execute on function public.simlsp_update_own_report(text, text, text) to authenticated, service_role;

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
  now_text text := pg_catalog.to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if actor_id is null then
    raise exception 'Sesi masuk diperlukan.' using errcode = '28000';
  end if;
  select profile.role, coalesce(nullif(btrim(profile.display_name), ''), profile.username)
    into actor_role, actor_name
    from public.simlsp_profiles profile
   where profile.id = actor_id;
  if actor_role is distinct from 'warga' then
    raise exception 'Hanya akun Warga Madrasah yang dapat mengirim laporan.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object' then
    raise exception 'Data laporan tidak valid.' using errcode = '22023';
  end if;

  report_data := p_report || pg_catalog.jsonb_build_object(
    'creatorProfileId', actor_id::text,
    'creator', actor_name,
    'reporterName', coalesce(nullif(btrim(p_report ->> 'reporterName'), ''), actor_name),
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
      'at', now_text,
      'by', actor_name,
      'role', 'Warga Madrasah',
      'message', 'Laporan dibuat dan menunggu verifikasi.',
      'public', true
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
      from jsonb_array_elements(report_data -> 'photos') as photo(value)
     where jsonb_typeof(photo.value) is distinct from 'object'
        or coalesce(photo.value ->> 'path', '') !~ ('^reports/' || report_id || '/[A-Za-z0-9_-]+[.]jpg$')
        or coalesce(photo.value ->> 'contentType', '') <> 'image/jpeg'
        or (case when jsonb_typeof(photo.value -> 'size') = 'number'
               then (photo.value ->> 'size')::numeric between 1 and 524288
               else false end) is not true
  ) then
    raise exception 'Metadata foto tidak valid.' using errcode = '22023';
  end if;

  select state.data, state.revision
    into current_data, current_revision
    from public.simlsp_shared_data state
   where state.id = 1
   for update;
  if not found then
    raise exception 'Penyimpanan bersama SIM-LSP belum tersedia.' using errcode = 'P0002';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(current_data -> 'reports') = 'array' then current_data -> 'reports' else '[]'::jsonb end) existing(value)
     where existing.value ->> 'id' = report_id
  ) then
    raise exception 'ID laporan sudah digunakan.' using errcode = '23505';
  end if;

  current_data := pg_catalog.jsonb_set(
    current_data,
    '{reports}',
    (case when jsonb_typeof(current_data -> 'reports') = 'array' then current_data -> 'reports' else '[]'::jsonb end) || pg_catalog.jsonb_build_array(report_data),
    true
  );
  update public.simlsp_shared_data
     set data = current_data,
         revision = revision + 1
   where id = 1;
  return current_revision + 1;
end;
$function$;
revoke all on function public.simlsp_submit_report(jsonb) from public, anon;
grant execute on function public.simlsp_submit_report(jsonb) to authenticated, service_role;

-- Trigger functions are invoked by PostgreSQL, not through PostgREST RPC.
revoke all on function public.simlsp_notify_new_report_rows() from public, anon, authenticated, service_role;

-- Keep comment notifications compatible with the existing table while avoiding
-- PL/pgSQL composite-field ambiguity for the column named "by".
create or replace function simlsp_private.add_report_comment(p_report_id text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_text text := btrim(coalesce(p_text, ''));
  v_report jsonb;
  v_profile public.simlsp_profiles%rowtype;
  v_executor_ids jsonb;
  v_candidate text;
  v_recipient uuid;
  v_recipients uuid[] := array[]::uuid[];
  v_code text;
  v_event_key text;
  v_comment_id uuid;
  v_comment_at timestamptz;
  v_author text;
  v_author_role text;
  v_avatar_path text;
begin
  if v_user_id is null then
    raise exception 'Masuk ke akun sebelum mengirim komentar.' using errcode = '28000';
  end if;
  if coalesce(p_report_id, '') !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'Kode tiket tidak valid.' using errcode = '22023';
  end if;
  if char_length(v_text) < 1 or char_length(v_text) > 800 then
    raise exception 'Komentar harus berisi 1–800 karakter.' using errcode = '22023';
  end if;
  if not simlsp_private.can_access_report(p_report_id) then
    raise exception 'Akun ini tidak berhak membuka diskusi tiket tersebut.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));
  if (select count(*) from public.simlsp_report_comments c
       where c.by_user_id = v_user_id and c.created_at > now() - interval '5 minutes') >= 10 then
    raise exception 'Batas komentar tercapai. Coba lagi beberapa menit kemudian.' using errcode = '54000';
  end if;

  select item.value into v_report
    from public.simlsp_shared_data state
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(state.data -> 'reports') = 'array'
        then state.data -> 'reports' else '[]'::jsonb end
    ) as item(value)
   where state.id = 1 and item.value ->> 'id' = p_report_id
   limit 1;
  if v_report is null then
    raise exception 'Tiket tidak ditemukan.' using errcode = 'P0002';
  end if;

  select * into v_profile from public.simlsp_profiles p where p.id = v_user_id;
  if not found then
    raise exception 'Profil akun tidak ditemukan.' using errcode = 'P0002';
  end if;

  v_author := coalesce(nullif(btrim(v_profile.display_name), ''), v_profile.username);
  v_author_role := case when v_profile.role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end;
  v_avatar_path := v_profile.avatar_path;
  insert into public.simlsp_report_comments (report_id, by_user_id, by, role, text, avatar_path)
  values (p_report_id, v_user_id, v_author, v_author_role, v_text, v_avatar_path)
  returning id, created_at into v_comment_id, v_comment_at;

  v_code := coalesce(nullif(v_report ->> 'code', ''), p_report_id);
  v_event_key := 'comment:' || v_comment_id::text;
  v_candidate := coalesce(v_report ->> 'creatorProfileId', v_report ->> 'creator_profile_id', '');
  if v_candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_recipients := array_append(v_recipients, v_candidate::uuid);
  end if;

  v_executor_ids := coalesce(v_report -> 'executorIds', v_report -> 'executor_ids');
  if jsonb_typeof(v_executor_ids) = 'array' then
    for v_candidate in select jsonb_array_elements_text(v_executor_ids)
    loop
      if v_candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_recipients := array_append(v_recipients, v_candidate::uuid);
      end if;
    end loop;
  end if;

  select coalesce(array_agg(p.id), array[]::uuid[]) || v_recipients
    into v_recipients
    from public.simlsp_profiles p
   where p.role = 'sarpras_admin';

  for v_recipient in
    select distinct recipient_id from unnest(v_recipients) as recipients(recipient_id)
  loop
    perform simlsp_private.enqueue_notification(
      v_recipient, 'comment', 'Komentar baru · ' || v_code,
      v_author || ': ' || left(v_text, 320), v_event_key, p_report_id, v_code
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'id', v_comment_id,
    'reportId', p_report_id,
    'at', v_comment_at,
    'by', v_author,
    'byUserId', v_user_id,
    'role', v_author_role,
    'text', v_text,
    'avatarPath', v_avatar_path
  );
end;
$function$;
revoke all on function simlsp_private.add_report_comment(text, text) from public, anon, authenticated;
grant execute on function simlsp_private.add_report_comment(text, text) to authenticated;
