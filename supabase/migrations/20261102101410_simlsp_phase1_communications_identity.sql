-- SIM-LSP Phase 1: identity, ticket comments, in-app notifications, and Info Board.
-- Report data remains in simlsp_shared_data; authorization reads participant IDs
-- from that row so comments are never exposed through the shared JSON payload.

create schema if not exists simlsp_private;
revoke all on schema simlsp_private from public, anon, authenticated;
grant usage on schema simlsp_private to authenticated;

create or replace function simlsp_private.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.simlsp_profiles p
    where p.id = auth.uid()
      and p.role = 'sarpras_admin'
  );
$function$;

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
    from public.simlsp_shared_data state
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(state.data -> 'reports') = 'array'
        then state.data -> 'reports' else '[]'::jsonb end
    ) as item(value)
   where state.id = 1
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
  if jsonb_typeof(v_executor_ids) = 'array' then
    for v_executor in select jsonb_array_elements_text(v_executor_ids)
    loop
      if v_executor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and v_executor::uuid = v_user_id then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$function$;

revoke all on function simlsp_private.is_manager() from public, anon, authenticated;
revoke all on function simlsp_private.can_access_report(text) from public, anon, authenticated;
grant execute on function simlsp_private.is_manager() to authenticated;
grant execute on function simlsp_private.can_access_report(text) to authenticated;

alter table public.simlsp_profiles
  add column if not exists avatar_path text,
  add column if not exists avatar_updated_at timestamptz;

revoke update on public.simlsp_profiles from authenticated;
grant update (avatar_path, avatar_updated_at) on public.simlsp_profiles to authenticated;
drop policy if exists "SIM-LSP user updates own avatar" on public.simlsp_profiles;
create policy "SIM-LSP user updates own avatar"
  on public.simlsp_profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create table if not exists public.simlsp_report_comments (
  id uuid primary key default gen_random_uuid(),
  report_id text not null check (report_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  by_user_id uuid references auth.users(id) on delete set null,
  by text not null check (char_length(by) between 1 and 90),
  role text not null check (role in ('Warga Madrasah', 'Sarpras/Admin')),
  text text not null check (char_length(btrim(text)) between 1 and 800),
  avatar_path text,
  created_at timestamptz not null default now()
);

create index if not exists simlsp_report_comments_report_created_idx
  on public.simlsp_report_comments (report_id, created_at, id);
create index if not exists simlsp_report_comments_author_created_idx
  on public.simlsp_report_comments (by_user_id, created_at desc);

alter table public.simlsp_report_comments enable row level security;
revoke all on public.simlsp_report_comments from anon, authenticated;
grant select on public.simlsp_report_comments to authenticated;
drop policy if exists "SIM-LSP participants read report comments" on public.simlsp_report_comments;
create policy "SIM-LSP participants read report comments"
  on public.simlsp_report_comments for select to authenticated
  using (simlsp_private.can_access_report(report_id));

create table if not exists public.simlsp_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.simlsp_profiles(id) on delete cascade,
  type text not null check (type in ('status', 'comment', 'info')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 500),
  report_id text,
  report_code text,
  info_post_id uuid,
  event_key text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, event_key)
);

create index if not exists simlsp_notifications_user_created_idx
  on public.simlsp_notifications (user_id, created_at desc);
create index if not exists simlsp_notifications_unread_idx
  on public.simlsp_notifications (user_id, created_at desc)
  where is_read = false;

alter table public.simlsp_notifications enable row level security;
revoke all on public.simlsp_notifications from anon, authenticated;
grant select on public.simlsp_notifications to authenticated;
grant update (is_read) on public.simlsp_notifications to authenticated;
drop policy if exists "SIM-LSP user reads own notifications" on public.simlsp_notifications;
create policy "SIM-LSP user reads own notifications"
  on public.simlsp_notifications for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "SIM-LSP user marks own notifications read" on public.simlsp_notifications;
create policy "SIM-LSP user marks own notifications read"
  on public.simlsp_notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and is_read = true);

create or replace function simlsp_private.enqueue_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_event_key text,
  p_report_id text default null,
  p_report_code text default null,
  p_info_post_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_user_id = auth.uid() or p_type not in ('status', 'comment', 'info') then
    return;
  end if;
  insert into public.simlsp_notifications (
    user_id, type, title, body, event_key, report_id, report_code, info_post_id
  )
  select p_user_id, p_type, left(p_title, 160), left(p_body, 500), p_event_key,
         p_report_id, p_report_code, p_info_post_id
   where exists (select 1 from public.simlsp_profiles p where p.id = p_user_id)
  on conflict (user_id, event_key) do nothing;
end;
$function$;
revoke all on function simlsp_private.enqueue_notification(uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;

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
  v_comment_id uuid;
  v_comment_at timestamptz;
  v_author text;
  v_author_role text;
  v_avatar_path text;
  v_executor_ids jsonb;
  v_candidate text;
  v_recipient uuid;
  v_recipients uuid[] := array[]::uuid[];
  v_code text;
  v_event_key text;
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

  return jsonb_build_object(
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

create or replace function public.simlsp_add_report_comment(p_report_id text, p_text text)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select simlsp_private.add_report_comment(p_report_id, p_text);
$function$;
revoke all on function public.simlsp_add_report_comment(text, text) from public, anon;
grant execute on function public.simlsp_add_report_comment(text, text) to authenticated;

create or replace function simlsp_private.list_assignable_users()
returns table(profile_id uuid, username text, display_name text, role text, unit text, avatar_path text)
language sql
stable
security definer
set search_path = ''
as $function$
  select p.id, p.username, p.display_name, p.role, m.unit, p.avatar_path
    from public.simlsp_profiles p
    left join public.simlsp_member_registry m on m.id = p.member_registry_id
   where simlsp_private.is_manager()
     and (m.id is null or m.is_active = true)
   order by p.display_name, p.username;
$function$;
revoke all on function simlsp_private.list_assignable_users() from public, anon, authenticated;
grant execute on function simlsp_private.list_assignable_users() to authenticated;

create or replace function public.simlsp_admin_list_assignable_users()
returns table(profile_id uuid, username text, display_name text, role text, unit text, avatar_path text)
language sql
security invoker
set search_path = ''
as $function$
  select * from simlsp_private.list_assignable_users();
$function$;
revoke all on function public.simlsp_admin_list_assignable_users() from public, anon;
grant execute on function public.simlsp_admin_list_assignable_users() to authenticated;

create table if not exists public.simlsp_info_posts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.simlsp_profiles(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  category text not null check (category in ('Pengumuman', 'SOP', 'Jadwal', 'Lainnya')),
  pinned boolean not null default false,
  attachment_path text,
  attachment_name text,
  attachment_content_type text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (attachment_path is null and attachment_name is null and attachment_content_type is null and attachment_size is null)
    or (attachment_path like ('info/' || id::text || '/%')
        and attachment_name is not null
        and attachment_content_type is not null
        and attachment_size is not null
        and attachment_size between 1 and 10485760)
  )
);

create index if not exists simlsp_info_posts_published_idx
  on public.simlsp_info_posts (pinned desc, created_at desc);
alter table public.simlsp_info_posts enable row level security;
revoke all on public.simlsp_info_posts from anon, authenticated;
grant select, insert, update, delete on public.simlsp_info_posts to authenticated;
drop policy if exists "SIM-LSP authenticated users read info posts" on public.simlsp_info_posts;
create policy "SIM-LSP authenticated users read info posts"
  on public.simlsp_info_posts for select to authenticated using (true);
drop policy if exists "SIM-LSP managers create info posts" on public.simlsp_info_posts;
create policy "SIM-LSP managers create info posts"
  on public.simlsp_info_posts for insert to authenticated
  with check (simlsp_private.is_manager() and created_by = (select auth.uid()));
drop policy if exists "SIM-LSP managers update info posts" on public.simlsp_info_posts;
create policy "SIM-LSP managers update info posts"
  on public.simlsp_info_posts for update to authenticated
  using (simlsp_private.is_manager())
  with check (simlsp_private.is_manager());
drop policy if exists "SIM-LSP managers delete info posts" on public.simlsp_info_posts;
create policy "SIM-LSP managers delete info posts"
  on public.simlsp_info_posts for delete to authenticated
  using (simlsp_private.is_manager());

create or replace function simlsp_private.touch_info_post_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function simlsp_private.touch_info_post_updated_at() from public, anon, authenticated;
drop trigger if exists simlsp_info_posts_touch_updated_at on public.simlsp_info_posts;
create trigger simlsp_info_posts_touch_updated_at
  before update on public.simlsp_info_posts
  for each row execute function simlsp_private.touch_info_post_updated_at();

create or replace function simlsp_private.notify_new_info_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select p.id from public.simlsp_profiles p where p.id is distinct from new.created_by
  loop
    perform simlsp_private.enqueue_notification(
      v_user_id, 'info', new.category || ': ' || new.title,
      left(btrim(new.body), 320), 'info:' || new.id::text,
      null, null, new.id
    );
  end loop;
  return new;
end;
$function$;
revoke all on function simlsp_private.notify_new_info_post() from public, anon, authenticated;
drop trigger if exists simlsp_info_posts_notify_insert on public.simlsp_info_posts;
create trigger simlsp_info_posts_notify_insert
  after insert on public.simlsp_info_posts
  for each row execute function simlsp_private.notify_new_info_post();

create or replace function simlsp_private.notify_shared_report_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_old_report jsonb;
  v_user_id uuid;
  v_reporter text;
  v_executor_ids jsonb;
  v_executor text;
  v_event_key text;
  v_code text;
  v_status text;
  v_title text;
  v_body text;
begin
  -- Initial seeding may copy years of historical tickets. Do not notify for an
  -- administrator seed; a first report submitted by a resident still notifies admins.
  if coalesce(jsonb_array_length(case when jsonb_typeof(old.data -> 'reports') = 'array' then old.data -> 'reports' else '[]'::jsonb end), 0) = 0
     and (simlsp_private.is_manager()
       or coalesce(jsonb_array_length(case when jsonb_typeof(new.data -> 'reports') = 'array' then new.data -> 'reports' else '[]'::jsonb end), 0) > 1) then
    return new;
  end if;

  for v_report in
    select item.value from jsonb_array_elements(
      case when jsonb_typeof(new.data -> 'reports') = 'array' then new.data -> 'reports' else '[]'::jsonb end
    ) as item(value)
  loop
    select item.value into v_old_report
      from jsonb_array_elements(
        case when jsonb_typeof(old.data -> 'reports') = 'array' then old.data -> 'reports' else '[]'::jsonb end
      ) as item(value)
     where item.value ->> 'id' = v_report ->> 'id'
     limit 1;

    if v_old_report is null then
      v_code := coalesce(nullif(v_report ->> 'code', ''), v_report ->> 'id', 'tiket');
      v_event_key := 'new-report:' || coalesce(v_report ->> 'id', 'unknown');
      v_body := left(coalesce(v_report ->> 'object', 'Laporan sarpras') || ' · ' || coalesce(v_report ->> 'location', 'Lokasi belum diisi'), 320);
      for v_user_id in select p.id from public.simlsp_profiles p where p.role = 'sarpras_admin'
      loop
        perform simlsp_private.enqueue_notification(v_user_id, 'status', 'Laporan baru masuk · ' || v_code, v_body, v_event_key, v_report ->> 'id', v_code);
      end loop;
      continue;
    end if;

    if v_old_report ->> 'status' is not distinct from v_report ->> 'status'
       or coalesce(v_report ->> 'statusEventId', '') = ''
       or v_report ->> 'statusEventId' is not distinct from v_old_report ->> 'statusEventId' then
      v_old_report := null;
      continue;
    end if;

    v_code := coalesce(nullif(v_report ->> 'code', ''), v_report ->> 'id', 'tiket');
    v_status := case coalesce(v_report ->> 'status', '')
      when 'BARU' then 'Baru'
      when 'PERLU_DILENGKAPI' then 'Perlu dilengkapi'
      when 'ANTREAN' then 'Terverifikasi'
      when 'MENUNGGU_PERSETUJUAN' then 'Menunggu persetujuan'
      when 'DITUGASKAN' then 'Ditugaskan'
      when 'DALAM_PENGERJAAN' then 'Dalam pengerjaan'
      when 'MENUNGGU_VERIFIKASI' then 'Menunggu verifikasi'
      when 'DITUNDA' then 'Ditunda'
      when 'SELESAI' then 'Selesai'
      when 'DITOLAK' then 'Ditolak'
      when 'DIBATALKAN' then 'Dibatalkan'
      else coalesce(v_report ->> 'status', 'diperbarui') end;
    v_title := 'Pembaruan status · ' || v_code;
    v_body := 'Status tiket berubah menjadi ' || v_status || '.';
    if coalesce(v_report ->> 'status', '') = 'DITOLAK' and coalesce(v_report ->> 'deferReason', '') <> '' then
      v_body := left(v_body || ' Alasan: ' || (v_report ->> 'deferReason'), 500);
    elsif coalesce(v_report ->> 'status', '') = 'DITUNDA' and coalesce(v_report ->> 'deferReason', '') <> '' then
      v_body := left(v_body || ' Alasan: ' || (v_report ->> 'deferReason'), 500);
    end if;
    v_event_key := 'status:' || coalesce(v_report ->> 'id', 'unknown') || ':' ||
      coalesce(nullif(v_report ->> 'statusEventId', ''), nullif(v_report ->> 'updatedAt', ''), txid_current()::text);

    v_reporter := coalesce(v_report ->> 'creatorProfileId', v_report ->> 'creator_profile_id', '');
    if v_reporter ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform simlsp_private.enqueue_notification(v_reporter::uuid, 'status', v_title, v_body, v_event_key, v_report ->> 'id', v_code);
    end if;

    v_executor_ids := coalesce(v_report -> 'executorIds', v_report -> 'executor_ids');
    if jsonb_typeof(v_executor_ids) = 'array' then
      for v_executor in select jsonb_array_elements_text(v_executor_ids)
      loop
        if v_executor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          perform simlsp_private.enqueue_notification(v_executor::uuid, 'status', v_title, v_body, v_event_key, v_report ->> 'id', v_code);
        end if;
      end loop;
    end if;

    for v_user_id in select p.id from public.simlsp_profiles p where p.role = 'sarpras_admin'
    loop
      perform simlsp_private.enqueue_notification(v_user_id, 'status', v_title, v_body, v_event_key, v_report ->> 'id', v_code);
    end loop;

    v_old_report := null;
  end loop;
  return new;
end;
$function$;
revoke all on function simlsp_private.notify_shared_report_changes() from public, anon, authenticated;
drop trigger if exists simlsp_shared_data_notify_report_changes on public.simlsp_shared_data;
create trigger simlsp_shared_data_notify_report_changes
  after update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.notify_shared_report_changes();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-avatars', 'user-avatars', false, 204800, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 204800,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'info-board-files', 'info-board-files', false, 10485760,
  array[
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'image/jpeg', 'image/png', 'image/webp'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "SIM-LSP authenticated read user avatars" on storage.objects;
create policy "SIM-LSP authenticated read user avatars"
  on storage.objects for select to authenticated
  using (bucket_id = 'user-avatars');
drop policy if exists "SIM-LSP user uploads own avatar" on storage.objects;
create policy "SIM-LSP user uploads own avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (storage.filename(name) = 'avatar.jpg')
  );
drop policy if exists "SIM-LSP user updates own avatar" on storage.objects;
create policy "SIM-LSP user updates own avatar"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and storage.filename(name) = 'avatar.jpg'
  )
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and storage.filename(name) = 'avatar.jpg'
  );
drop policy if exists "SIM-LSP user deletes own avatar" on storage.objects;
create policy "SIM-LSP user deletes own avatar"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and storage.filename(name) = 'avatar.jpg'
  );

drop policy if exists "SIM-LSP authenticated read info files" on storage.objects;
create policy "SIM-LSP authenticated read info files"
  on storage.objects for select to authenticated
  using (bucket_id = 'info-board-files');
drop policy if exists "SIM-LSP managers upload info files" on storage.objects;
create policy "SIM-LSP managers upload info files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'info-board-files'
    and (storage.foldername(name))[1] = 'info'
    and simlsp_private.is_manager()
  );
drop policy if exists "SIM-LSP managers update info files" on storage.objects;
create policy "SIM-LSP managers update info files"
  on storage.objects for update to authenticated
  using (bucket_id = 'info-board-files' and simlsp_private.is_manager())
  with check (
    bucket_id = 'info-board-files'
    and (storage.foldername(name))[1] = 'info'
    and simlsp_private.is_manager()
  );
drop policy if exists "SIM-LSP managers delete info files" on storage.objects;
create policy "SIM-LSP managers delete info files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'info-board-files' and simlsp_private.is_manager());

grant execute on function simlsp_private.is_manager() to authenticated;
