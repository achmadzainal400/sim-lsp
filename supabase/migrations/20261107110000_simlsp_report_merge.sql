-- SIM-LSP: explicit citizen/Admin duplicate decisions and linked ticket progress.

create table if not exists public.simlsp_report_merge_links (
  child_report_id text primary key check (child_report_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  parent_report_id text not null check (parent_report_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  merged_by uuid not null references public.simlsp_profiles(id) on delete restrict,
  merged_by_role text not null check (merged_by_role in ('warga', 'sarpras_admin')),
  merged_at timestamptz not null default now(),
  reason text not null default '',
  constraint simlsp_report_merge_links_not_self check (child_report_id <> parent_report_id)
);
create index if not exists simlsp_report_merge_links_parent_idx
  on public.simlsp_report_merge_links(parent_report_id, merged_at);
alter table public.simlsp_report_merge_links enable row level security;
revoke all on public.simlsp_report_merge_links from public, anon, authenticated;
grant all on public.simlsp_report_merge_links to service_role;

create table if not exists public.simlsp_report_duplicate_decisions (
  source_report_id text not null check (source_report_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  candidate_report_id text not null check (candidate_report_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  by_user_id uuid not null references public.simlsp_profiles(id) on delete restrict,
  by_role text not null check (by_role in ('warga', 'sarpras_admin')),
  choice text not null check (choice in ('separate', 'merge')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  primary key (source_report_id, candidate_report_id, by_user_id),
  constraint simlsp_report_duplicate_decisions_not_self check (source_report_id <> candidate_report_id),
  constraint simlsp_report_duplicate_decisions_reason_size check (char_length(reason) <= 800)
);
create index if not exists simlsp_report_duplicate_decisions_candidate_idx
  on public.simlsp_report_duplicate_decisions(candidate_report_id, created_at desc);
alter table public.simlsp_report_duplicate_decisions enable row level security;
revoke all on public.simlsp_report_duplicate_decisions from public, anon, authenticated;
grant all on public.simlsp_report_duplicate_decisions to service_role;

create or replace function simlsp_private.duplicate_similarity(p_left text, p_right text, p_kind text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_left text := lower(coalesce(p_left, ''));
  v_right text := lower(coalesce(p_right, ''));
  v_stop_words text[];
  v_left_tokens text[];
  v_right_tokens text[];
  v_shared integer;
  v_union integer;
  v_coverage numeric;
  v_jaccard numeric;
begin
  v_left := pg_catalog.regexp_replace(v_left, '(^|[^a-z0-9])kran([^a-z0-9]|$)', '\1keran\2', 'g');
  v_right := pg_catalog.regexp_replace(v_right, '(^|[^a-z0-9])kran([^a-z0-9]|$)', '\1keran\2', 'g');
  v_left := pg_catalog.regexp_replace(v_left, '([a-z])([0-9])', '\1 \2', 'g');
  v_right := pg_catalog.regexp_replace(v_right, '([a-z])([0-9])', '\1 \2', 'g');
  v_left := pg_catalog.btrim(pg_catalog.regexp_replace(v_left, '[^a-z0-9]+', ' ', 'g'));
  v_right := pg_catalog.btrim(pg_catalog.regexp_replace(v_right, '[^a-z0-9]+', ' ', 'g'));
  if p_kind = 'location' then
    v_stop_words := array['area', 'di', 'dari', 'ke', 'lokasi', 'ruang', 'ruangan'];
  else
    v_stop_words := array['ada', 'atau', 'barang', 'berfungsi', 'bermasalah', 'bocor', 'dan', 'dari', 'dengan', 'dibuka', 'digunakan', 'ini', 'itu', 'karena', 'ke', 'kondisi', 'kurang', 'macet', 'mati', 'masalah', 'menyala', 'nyala', 'pada', 'patah', 'pecah', 'perbaikan', 'rusak', 'sarana', 'sulit', 'tidak', 'untuk', 'yang'];
  end if;
  select coalesce(array_agg(tokens.token order by tokens.token), array[]::text[])
    into v_left_tokens
    from (select distinct token from pg_catalog.regexp_split_to_table(v_left, ' ') as words(token)
           where token <> '' and token <> all(v_stop_words)) as tokens;
  select coalesce(array_agg(tokens.token order by tokens.token), array[]::text[])
    into v_right_tokens
    from (select distinct token from pg_catalog.regexp_split_to_table(v_right, ' ') as words(token)
           where token <> '' and token <> all(v_stop_words)) as tokens;
  if cardinality(v_left_tokens) = 0 or cardinality(v_right_tokens) = 0 then return 0; end if;
  select count(*)::integer into v_shared
    from pg_catalog.unnest(v_left_tokens) as left_token(token)
    join pg_catalog.unnest(v_right_tokens) as right_token(token) using (token);
  v_union := cardinality(v_left_tokens) + cardinality(v_right_tokens) - v_shared;
  v_jaccard := v_shared::numeric / greatest(v_union, 1);
  v_coverage := v_shared::numeric / least(cardinality(v_left_tokens), cardinality(v_right_tokens));
  if v_coverage = 1 then
    return greatest(v_jaccard, 0.78 + 0.22 * least(cardinality(v_left_tokens), cardinality(v_right_tokens))::numeric /
      greatest(cardinality(v_left_tokens), cardinality(v_right_tokens)));
  end if;
  return v_jaccard;
end;
$function$;
revoke all on function simlsp_private.duplicate_similarity(text, text, text) from public, anon, authenticated, service_role;

-- Keep link metadata server-owned and mirror the parent workflow to every child.
create or replace function simlsp_private.reconcile_report_merge_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reports jsonb;
  v_clean_reports jsonb := '[]'::jsonb;
  v_report jsonb;
  v_report_id text;
  v_parent_id text;
  v_child_ids jsonb;
  v_link record;
  v_merge_timestamp timestamptz;
  v_child_index integer;
  v_parent_index integer;
  v_child jsonb;
  v_parent jsonb;
  v_old_child jsonb;
  v_old_parent jsonb;
  v_old_reports jsonb;
  v_child_events jsonb;
  v_parent_events jsonb;
  v_child_photos jsonb;
  v_parent_work_photos jsonb;
  v_event jsonb;
  v_event_index bigint;
  v_event_key text;
  v_event_at text;
  v_merge_at text;
  v_field text;
  v_new_event_id text;
  v_workflow_fields text[] := array[
    'status', 'priority', 'urgency', 'needsApproval', 'approvalStatus', 'approverName',
    'previousStatus', 'legacyStatus', 'approvalNote', 'deferReason', 'internalNote',
    'pj', 'executor', 'executorIds', 'executor_ids', 'startedAt', 'completedAt',
    'materialCost', 'serviceCost', 'result', 'targetDate', 'updatedAt'
  ];
begin
  if jsonb_typeof(new.data -> 'reports') is distinct from 'array' then return new; end if;
  v_reports := new.data -> 'reports';
  v_old_reports := case when jsonb_typeof(old.data -> 'reports') = 'array' then old.data -> 'reports' else '[]'::jsonb end;

  for v_report in select item.value from pg_catalog.jsonb_array_elements(v_reports) as item(value)
  loop
    v_report_id := coalesce(v_report ->> 'id', '');
    select link.parent_report_id into v_parent_id from public.simlsp_report_merge_links link
     where link.child_report_id = v_report_id;
    select coalesce(jsonb_agg(to_jsonb(link.child_report_id) order by link.child_report_id), '[]'::jsonb)
      into v_child_ids from public.simlsp_report_merge_links link where link.parent_report_id = v_report_id;
    v_report := v_report - 'mergedIntoReportId' - 'mergedReportIds' - 'mergedAt' - 'duplicateDecisions';
    if v_parent_id is not null then
      v_report := jsonb_set(v_report, '{mergedIntoReportId}', to_jsonb(v_parent_id), true);
      select link.merged_at into v_merge_timestamp from public.simlsp_report_merge_links link where link.child_report_id = v_report_id;
      v_report := jsonb_set(v_report, '{mergedAt}', to_jsonb(v_merge_timestamp), true);
    end if;
    if jsonb_array_length(v_child_ids) > 0 then v_report := jsonb_set(v_report, '{mergedReportIds}', v_child_ids, true); end if;
    select item.value into v_old_child from pg_catalog.jsonb_array_elements(v_old_reports) as item(value)
     where item.value ->> 'id' = v_report_id limit 1;
    if v_old_child is null and auth.uid() is not null and coalesce(v_report ->> 'creatorProfileId', '') = auth.uid()::text then
      v_report := jsonb_set(v_report, '{duplicateMergeEnabled}', 'true'::jsonb, true);
    end if;
    v_clean_reports := v_clean_reports || jsonb_build_array(v_report);
  end loop;
  v_reports := v_clean_reports;

  -- Keep relational links valid if an older backup or stale client omits a linked ticket.
  if exists (
    select 1 from public.simlsp_report_merge_links link
     where not exists (select 1 from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = link.child_report_id)
        or not exists (select 1 from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = link.parent_report_id)
  ) then
    raise exception 'Tiket yang sudah tergabung tidak dapat dihapus dari data. Pulihkan tiket terkait terlebih dahulu.' using errcode = '23503';
  end if;

  -- A resident cannot change the status of a parent ticket that already represents a group.
  if auth.uid() is not null and not simlsp_private.is_manager() then
    for v_link in select distinct parent_report_id from public.simlsp_report_merge_links
    loop
      select item.value into v_old_parent from pg_catalog.jsonb_array_elements(v_old_reports) as item(value)
       where item.value ->> 'id' = v_link.parent_report_id limit 1;
      select item.value into v_parent from pg_catalog.jsonb_array_elements(v_reports) as item(value)
       where item.value ->> 'id' = v_link.parent_report_id limit 1;
      if v_old_parent ->> 'status' is distinct from v_parent ->> 'status' then
        raise exception 'Tiket ini mewakili beberapa laporan. Hubungi Sarpras/Admin untuk memperbarui status.' using errcode = '42501';
      end if;
    end loop;
    for v_link in select distinct child_report_id from public.simlsp_report_merge_links
    loop
      select item.value into v_old_child from pg_catalog.jsonb_array_elements(v_old_reports) as item(value)
       where item.value ->> 'id' = v_link.child_report_id limit 1;
      select item.value into v_child from pg_catalog.jsonb_array_elements(v_reports) as item(value)
       where item.value ->> 'id' = v_link.child_report_id limit 1;
      if v_old_child is not null and v_child is not null and (
        v_old_child -> 'status' is distinct from v_child -> 'status'
        or v_old_child -> 'description' is distinct from v_child -> 'description'
        or v_old_child -> 'events' is distinct from v_child -> 'events'
      ) then
        raise exception 'Laporan yang telah digabung hanya dapat diperbarui melalui tiket induk.' using errcode = '42501';
      end if;
    end loop;
  end if;

  for v_link in select link.child_report_id, link.parent_report_id, link.merged_at
    from public.simlsp_report_merge_links link order by link.merged_at, link.child_report_id
  loop
    select item.ordinality::integer - 1, item.value into v_child_index, v_child
      from pg_catalog.jsonb_array_elements(v_reports) with ordinality as item(value, ordinality)
     where item.value ->> 'id' = v_link.child_report_id limit 1;
    if not found then continue; end if;
    select item.ordinality::integer - 1, item.value into v_parent_index, v_parent
      from pg_catalog.jsonb_array_elements(v_reports) with ordinality as item(value, ordinality)
     where item.value ->> 'id' = v_link.parent_report_id limit 1;
    if not found then continue; end if;
    select item.value into v_old_child from pg_catalog.jsonb_array_elements(v_old_reports) as item(value)
     where item.value ->> 'id' = v_link.child_report_id limit 1;
    select item.value into v_old_parent from pg_catalog.jsonb_array_elements(v_old_reports) as item(value)
     where item.value ->> 'id' = v_link.parent_report_id limit 1;

    v_new_event_id := coalesce(v_child ->> 'statusEventId', '');
    foreach v_field in array v_workflow_fields loop
      if v_parent ? v_field then v_child := jsonb_set(v_child, array[v_field], v_parent -> v_field, true);
      else v_child := v_child - v_field; end if;
    end loop;
    if v_old_child ->> 'status' is distinct from v_parent ->> 'status' then
      if v_new_event_id = '' or v_new_event_id = coalesce(v_old_child ->> 'statusEventId', '') then
        v_new_event_id := pg_catalog.gen_random_uuid()::text;
      end if;
      v_child := jsonb_set(v_child, '{statusEventId}', to_jsonb(v_new_event_id), true);
    end if;
    if v_parent ? 'statusUpdatedAt' then v_child := jsonb_set(v_child, '{statusUpdatedAt}', v_parent -> 'statusUpdatedAt', true); end if;
    select coalesce(jsonb_agg(photo.value order by photo.ordinality), '[]'::jsonb)
      into v_child_photos
      from pg_catalog.jsonb_array_elements(case when jsonb_typeof(v_child -> 'photos') = 'array' then v_child -> 'photos' else '[]'::jsonb end)
        with ordinality as photo(value, ordinality)
     where coalesce(photo.value ->> 'kind', 'bukti') <> 'hasil';
    select coalesce(jsonb_agg(photo.value order by photo.ordinality), '[]'::jsonb)
      into v_parent_work_photos
      from pg_catalog.jsonb_array_elements(case when jsonb_typeof(v_parent -> 'photos') = 'array' then v_parent -> 'photos' else '[]'::jsonb end)
        with ordinality as photo(value, ordinality)
     where photo.value ->> 'kind' = 'hasil';
    v_child := jsonb_set(v_child, '{photos}', v_child_photos || v_parent_work_photos, true);
    v_child_events := case when jsonb_typeof(v_child -> 'events') = 'array' then v_child -> 'events' else '[]'::jsonb end;
    v_parent_events := case when jsonb_typeof(v_parent -> 'events') = 'array' then v_parent -> 'events' else '[]'::jsonb end;
    v_merge_at := pg_catalog.to_char(v_link.merged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    for v_event, v_event_index in
      select item.value, item.ordinality from pg_catalog.jsonb_array_elements(v_parent_events) with ordinality as item(value, ordinality)
    loop
      if coalesce((v_event ->> 'public')::boolean, true) is false then continue; end if;
      v_event_at := coalesce(v_event ->> 'at', '');
      if v_event_at < v_merge_at then continue; end if;
      v_event_key := pg_catalog.md5(v_link.parent_report_id || ':' || v_event_index::text || ':' || v_event::text);
      if not exists (select 1 from pg_catalog.jsonb_array_elements(v_child_events) child_event(value)
                      where child_event.value ->> 'mergedFromReportId' = v_link.parent_report_id
                        and (child_event.value - 'mergeMirrorKey' - 'mergedFromReportId') = v_event) then
        v_child_events := v_child_events || jsonb_build_array(v_event || jsonb_build_object('mergeMirrorKey', v_event_key, 'mergedFromReportId', v_link.parent_report_id));
      end if;
    end loop;
    v_child := jsonb_set(v_child, '{events}', v_child_events, true);
    v_reports := jsonb_set(v_reports, array[v_child_index::text], v_child, true);
  end loop;
  new.data := jsonb_set(new.data, '{reports}', v_reports, true);
  return new;
end;
$function$;
revoke all on function simlsp_private.reconcile_report_merge_links() from public, anon, authenticated, service_role;
drop trigger if exists simlsp_shared_data_reconcile_report_merges on public.simlsp_shared_data;
create trigger simlsp_shared_data_reconcile_report_merges
  before update of data on public.simlsp_shared_data
  for each row execute function simlsp_private.reconcile_report_merge_links();

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
  if v_user_id is null or coalesce(p_report_id, '') = '' then return false; end if;
  if simlsp_private.is_manager() then return true; end if;
  select item.value into v_report from public.simlsp_shared_data state
    cross join lateral pg_catalog.jsonb_array_elements(case when jsonb_typeof(state.data -> 'reports') = 'array' then state.data -> 'reports' else '[]'::jsonb end) item(value)
   where state.id = 1 and item.value ->> 'id' = p_report_id limit 1;
  if v_report is null then return false; end if;
  v_reporter := coalesce(v_report ->> 'creatorProfileId', v_report ->> 'creator_profile_id', '');
  if v_reporter ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and v_reporter::uuid = v_user_id then return true; end if;
  v_executor_ids := coalesce(v_report -> 'executorIds', v_report -> 'executor_ids');
  if jsonb_typeof(v_executor_ids) = 'array' then
    for v_executor in select jsonb_array_elements_text(v_executor_ids) loop
      if v_executor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and v_executor::uuid = v_user_id then return true; end if;
    end loop;
  end if;
  return exists (
    select 1 from public.simlsp_report_merge_links link
    join lateral pg_catalog.jsonb_array_elements(case when jsonb_typeof(state.data -> 'reports') = 'array' then state.data -> 'reports' else '[]'::jsonb end) member(value)
      on member.value ->> 'id' = link.child_report_id
    where state.id = 1 and link.parent_report_id = p_report_id and (
      member.value ->> 'creatorProfileId' = v_user_id::text or exists (
        select 1 from pg_catalog.jsonb_array_elements_text(case
          when jsonb_typeof(coalesce(member.value -> 'executorIds', member.value -> 'executor_ids')) = 'array'
          then coalesce(member.value -> 'executorIds', member.value -> 'executor_ids') else '[]'::jsonb end) assignee(value)
        where assignee.value = v_user_id::text
      )
    )
  );
end;
$function$;
revoke all on function simlsp_private.can_access_report(text) from public, anon, authenticated;
grant execute on function simlsp_private.can_access_report(text) to authenticated;

-- A comment on the parent ticket also notifies every reporter in the linked group.
create or replace function simlsp_private.notify_merged_report_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_parent_id text;
  v_report_code text;
  v_user_id uuid;
  v_reports jsonb;
  v_author_name text;
begin
  select link.parent_report_id into v_parent_id
    from public.simlsp_report_merge_links link where link.child_report_id = new.report_id;
  v_parent_id := coalesce(v_parent_id, new.report_id);
  select case when jsonb_typeof(state.data -> 'reports') = 'array' then state.data -> 'reports' else '[]'::jsonb end
    into v_reports from public.simlsp_shared_data state where state.id = 1;
  select coalesce(item.value ->> 'code', v_parent_id) into v_report_code
    from pg_catalog.jsonb_array_elements(coalesce(v_reports, '[]'::jsonb)) item(value)
   where item.value ->> 'id' = v_parent_id limit 1;
  v_report_code := coalesce(v_report_code, v_parent_id);
  v_author_name := coalesce(nullif(new.by, ''), 'Un usuario');

  for v_user_id in
    select distinct recipient_id::uuid from (
      select member.value ->> 'creatorProfileId' as recipient_id
        from pg_catalog.jsonb_array_elements(coalesce(v_reports, '[]'::jsonb)) member(value)
       where (member.value ->> 'id' = v_parent_id or exists (
         select 1 from public.simlsp_report_merge_links link
          where link.parent_report_id = v_parent_id and link.child_report_id = member.value ->> 'id'
       ))
      union all
      select executor.value as recipient_id
        from pg_catalog.jsonb_array_elements(coalesce(v_reports, '[]'::jsonb)) member(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(case
          when jsonb_typeof(coalesce(member.value -> 'executorIds', member.value -> 'executor_ids')) = 'array'
          then coalesce(member.value -> 'executorIds', member.value -> 'executor_ids') else '[]'::jsonb end) executor(value)
       where (member.value ->> 'id' = v_parent_id or exists (
         select 1 from public.simlsp_report_merge_links link
          where link.parent_report_id = v_parent_id and link.child_report_id = member.value ->> 'id'
       ))
      union all
      select profile.id::text as recipient_id from public.simlsp_profiles profile where profile.role = 'sarpras_admin'
    ) recipients
    where recipient_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    perform simlsp_private.enqueue_notification(v_user_id, 'comment', 'Komentar baru · ' || v_report_code,
      v_author_name || ': ' || left(new.text, 320), 'comment:' || new.id::text, v_parent_id, v_report_code);
  end loop;
  return new;
end;
$function$;
revoke all on function simlsp_private.notify_merged_report_comment() from public, anon, authenticated, service_role;
drop trigger if exists simlsp_notify_merged_report_comment on public.simlsp_report_comments;
create trigger simlsp_notify_merged_report_comment
  after insert on public.simlsp_report_comments
  for each row execute function simlsp_private.notify_merged_report_comment();

create or replace function public.simlsp_resolve_duplicate_report(
  p_report_id text,
  p_candidate_id text,
  p_decision text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_data jsonb;
  v_reports jsonb;
  v_revision integer;
  v_source jsonb;
  v_candidate jsonb;
  v_source_root_id text;
  v_candidate_root_id text;
  v_source_root jsonb;
  v_candidate_root jsonb;
  v_parent jsonb;
  v_child jsonb;
  v_parent_id text;
  v_child_id text;
  v_parent_at timestamptz;
  v_child_at timestamptz;
  v_parent_idx integer;
  v_child_idx integer;
  v_source_at timestamptz;
  v_candidate_at timestamptz;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := pg_catalog.now();
  v_now_text text := pg_catalog.to_char(pg_catalog.now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_separated boolean;
  v_code text;
  v_message text;
  v_member record;
  v_decision jsonb;
begin
  if v_actor is null then raise exception 'Masuk ke akun sebelum memilih penggabungan.' using errcode = '28000'; end if;
  if coalesce(p_report_id, '') !~ '^[A-Za-z0-9_-]{1,100}$' or coalesce(p_candidate_id, '') !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'ID tiket tidak valid.' using errcode = '22023'; end if;
  if p_report_id = p_candidate_id then raise exception 'Pilih dua tiket yang berbeda.' using errcode = '22023'; end if;
  if p_decision is null or p_decision not in ('merge', 'separate') then raise exception 'Pilihan penggabungan tidak dikenal.' using errcode = '22023'; end if;
  select profile.role, coalesce(nullif(btrim(profile.display_name), ''), profile.username)
    into v_actor_role, v_actor_name from public.simlsp_profiles profile where profile.id = v_actor;
  if v_actor_role is null then raise exception 'Profil akun tidak ditemukan.' using errcode = 'P0002'; end if;
  if v_actor_role not in ('warga', 'sarpras_admin') then raise exception 'Peran akun tidak dapat mengubah keputusan tiket.' using errcode = '42501'; end if;

  select state.data, state.revision into v_data, v_revision from public.simlsp_shared_data state where state.id = 1 for update;
  if not found then raise exception 'Data bersama belum tersedia.' using errcode = 'P0002'; end if;
  v_reports := case when jsonb_typeof(v_data -> 'reports') = 'array' then v_data -> 'reports' else '[]'::jsonb end;
  select item.value into v_source from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = p_report_id limit 1;
  select item.value into v_candidate from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = p_candidate_id limit 1;
  if v_source is null or v_candidate is null then raise exception 'Salah satu tiket tidak ditemukan. Muat ulang data lalu coba lagi.' using errcode = 'P0002'; end if;
  if coalesce(v_source ->> 'status', '') in ('SELESAI', 'DITOLAK', 'DIBATALKAN') or coalesce(v_candidate ->> 'status', '') in ('SELESAI', 'DITOLAK', 'DIBATALKAN') then
    raise exception 'Hanya laporan yang masih terbuka dapat dibandingkan atau digabungkan.' using errcode = '42501';
  end if;
  begin
    v_source_at := (v_source ->> 'createdAt')::timestamptz;
    v_candidate_at := (v_candidate ->> 'createdAt')::timestamptz;
  exception when others then raise exception 'Tanggal salah satu tiket tidak dapat diverifikasi.' using errcode = '22023';
  end;
  if abs(extract(epoch from (v_source_at - v_candidate_at))) > 1209600
     or simlsp_private.duplicate_similarity(v_source ->> 'location', v_candidate ->> 'location', 'location') < 0.7
     or simlsp_private.duplicate_similarity(v_source ->> 'object', v_candidate ->> 'object', 'object') < 0.5 then
    raise exception 'Tiket pembanding tidak lagi memenuhi kriteria kemiripan 14 hari. Periksa daftar tiket.' using errcode = '42501';
  end if;

  if p_decision = 'separate' then
    if v_actor_role <> 'warga' or coalesce(v_source ->> 'creatorProfileId', '') <> v_actor::text
       or coalesce((v_source ->> 'duplicateMergeEnabled')::boolean, false) is not true then
      raise exception 'Hanya pelapor laporan baru yang dapat mengirim keputusan ini.' using errcode = '42501';
    end if;
    if char_length(v_reason) < 5 or char_length(v_reason) > 800 then raise exception 'Jelaskan perbedaan laporan dengan 5 sampai 800 karakter.' using errcode = '22023'; end if;
    if exists (select 1 from public.simlsp_report_merge_links link where link.child_report_id in (p_report_id, p_candidate_id) or link.parent_report_id in (p_report_id, p_candidate_id)) then
      raise exception 'Tiket yang sudah digabungkan tidak dapat ditandai terpisah.' using errcode = '42501';
    end if;
    insert into public.simlsp_report_duplicate_decisions(source_report_id, candidate_report_id, by_user_id, by_role, choice, reason, created_at)
    values (p_report_id, p_candidate_id, v_actor, v_actor_role, 'separate', v_reason, v_now)
    on conflict (source_report_id, candidate_report_id, by_user_id) do update set choice = excluded.choice, reason = excluded.reason, created_at = excluded.created_at;
    for v_member in select profile.id from public.simlsp_profiles profile where profile.role = 'sarpras_admin' loop
      perform simlsp_private.enqueue_notification(v_member.id, 'status', 'Laporan perlu ditinjau · ' || coalesce(v_source ->> 'code', p_report_id),
        'Pelapor menilai laporan ini berbeda dari ' || coalesce(v_candidate ->> 'code', p_candidate_id) || '. Buka tiket untuk membaca alasannya.',
        'duplicate-separate:' || p_report_id || ':' || p_candidate_id || ':' || v_actor::text, p_report_id, v_source ->> 'code');
    end loop;
    return jsonb_build_object('decision', 'separate', 'reportId', p_report_id, 'candidateId', p_candidate_id, 'revision', v_revision);
  end if;

  if v_actor_role = 'warga' then
    if coalesce(v_source ->> 'creatorProfileId', '') <> v_actor::text
       or coalesce((v_source ->> 'duplicateMergeEnabled')::boolean, false) is not true
       or exists (select 1 from public.simlsp_report_merge_links link where link.child_report_id = p_report_id) then
      raise exception 'Anda hanya dapat memilih penggabungan pada laporan baru milik sendiri.' using errcode = '42501';
    end if;
    if v_source_at < v_candidate_at then
      raise exception 'Pilih tiket lama sebagai pembanding untuk laporan baru Anda.' using errcode = '22023';
    end if;
  elsif char_length(v_reason) < 5 or char_length(v_reason) > 800 then
    raise exception 'Alasan Admin menggabungkan tiket wajib diisi (5 sampai 800 karakter).' using errcode = '22023';
  end if;
  select exists (select 1 from public.simlsp_report_duplicate_decisions decision
    where decision.choice = 'separate'
      and ((decision.source_report_id = p_report_id and decision.candidate_report_id = p_candidate_id)
        or (decision.source_report_id = p_candidate_id and decision.candidate_report_id = p_report_id))) into v_separated;
  if v_actor_role = 'warga' and v_separated then raise exception 'Salah satu pelapor menandai kedua laporan berbeda. Minta Sarpras/Admin meninjau.' using errcode = '42501'; end if;

  select link.parent_report_id into v_source_root_id from public.simlsp_report_merge_links link where link.child_report_id = p_report_id;
  if v_source_root_id is null then v_source_root_id := p_report_id; end if;
  select link.parent_report_id into v_candidate_root_id from public.simlsp_report_merge_links link where link.child_report_id = p_candidate_id;
  if v_candidate_root_id is null then v_candidate_root_id := p_candidate_id; end if;
  if v_source_root_id = v_candidate_root_id then return jsonb_build_object('decision', 'merged', 'alreadyMerged', true, 'parentReportId', v_source_root_id, 'revision', v_revision); end if;
  select item.value into v_source_root from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = v_source_root_id limit 1;
  select item.value into v_candidate_root from pg_catalog.jsonb_array_elements(v_reports) item(value) where item.value ->> 'id' = v_candidate_root_id limit 1;
  if v_source_root is null or v_candidate_root is null then raise exception 'Tiket induk tidak ditemukan. Muat ulang data lalu coba lagi.' using errcode = 'P0002'; end if;
  begin
    v_parent_at := (v_source_root ->> 'createdAt')::timestamptz;
    v_child_at := (v_candidate_root ->> 'createdAt')::timestamptz;
  exception when others then raise exception 'Tanggal tiket induk tidak dapat diverifikasi.' using errcode = '22023';
  end;
  if v_parent_at <= v_child_at then v_parent_id := v_source_root_id; v_child_id := v_candidate_root_id; v_parent := v_source_root; v_child := v_candidate_root;
  else v_parent_id := v_candidate_root_id; v_child_id := v_source_root_id; v_parent := v_candidate_root; v_child := v_source_root; end if;
  v_code := coalesce(v_parent ->> 'code', v_parent_id);
  v_message := case when v_actor_role = 'sarpras_admin' then 'Sarpras/Admin menggabungkan tiket ' || coalesce(v_child ->> 'code', v_child_id) || ' ke tiket induk ini.'
    else 'Pelapor menyetujui penggabungan tiket ' || coalesce(v_child ->> 'code', v_child_id) || ' ke tiket induk ini.' end;
  if v_reason <> '' then v_message := v_message || ' Alasan: ' || v_reason; end if;

  update public.simlsp_report_merge_links set parent_report_id = v_parent_id where parent_report_id = v_child_id;
  insert into public.simlsp_report_merge_links(child_report_id, parent_report_id, merged_by, merged_by_role, merged_at, reason)
  values (v_child_id, v_parent_id, v_actor, v_actor_role, v_now, v_reason)
  on conflict (child_report_id) do update set parent_report_id = excluded.parent_report_id, merged_by = excluded.merged_by, merged_by_role = excluded.merged_by_role, merged_at = excluded.merged_at, reason = excluded.reason;
  insert into public.simlsp_report_duplicate_decisions(source_report_id, candidate_report_id, by_user_id, by_role, choice, reason, created_at)
  values (p_report_id, p_candidate_id, v_actor, v_actor_role, 'merge', v_reason, v_now)
  on conflict (source_report_id, candidate_report_id, by_user_id) do update set choice = excluded.choice, reason = excluded.reason, created_at = excluded.created_at;
  select item.ordinality::integer - 1 into v_parent_idx from pg_catalog.jsonb_array_elements(v_reports) with ordinality item(value, ordinality) where item.value ->> 'id' = v_parent_id limit 1;
  v_parent := jsonb_set(v_parent, '{events}', (case when jsonb_typeof(v_parent -> 'events') = 'array' then v_parent -> 'events' else '[]'::jsonb end)
    || jsonb_build_array(jsonb_build_object('at', v_now_text, 'by', v_actor_name, 'role', case when v_actor_role = 'sarpras_admin' then 'Sarpras/Admin' else 'Warga Madrasah' end, 'message', v_message, 'public', true)), true);
  v_reports := jsonb_set(v_reports, array[v_parent_idx::text], v_parent, true);
  v_data := jsonb_set(v_data, '{reports}', v_reports, true);
  update public.simlsp_shared_data set data = v_data, revision = revision + 1 where id = 1;

  for v_member in
    select distinct member.value ->> 'creatorProfileId' as user_id
      from pg_catalog.jsonb_array_elements(v_reports) member(value)
     where (member.value ->> 'id' = v_parent_id or exists (select 1 from public.simlsp_report_merge_links link where link.parent_report_id = v_parent_id and link.child_report_id = member.value ->> 'id'))
       and coalesce(member.value ->> 'creatorProfileId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    perform simlsp_private.enqueue_notification(v_member.user_id::uuid, 'status', 'Laporan digabungkan · ' || v_code,
      'Tiket ' || coalesce(v_child ->> 'code', v_child_id) || ' mengikuti perkembangan tiket induk ' || v_code || '. Nomor tiket Anda tetap dapat dipantau.',
      'report-merge:' || v_parent_id || ':' || v_child_id || ':' || v_now::text, v_parent_id, v_code);
  end loop;
  return jsonb_build_object('decision', 'merged', 'parentReportId', v_parent_id, 'parentCode', v_code,
    'childReportId', v_child_id, 'childCode', coalesce(v_child ->> 'code', v_child_id), 'revision', v_revision + 1);
end;
$function$;
revoke all on function public.simlsp_resolve_duplicate_report(text, text, text, text) from public, anon;
grant execute on function public.simlsp_resolve_duplicate_report(text, text, text, text) to authenticated, service_role;

create or replace function public.simlsp_list_duplicate_decisions(p_report_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Sesi masuk diperlukan.' using errcode = '28000'; end if;
  select profile.role into v_role from public.simlsp_profiles profile where profile.id = auth.uid();
  if v_role is null or not simlsp_private.can_access_report(p_report_id) then raise exception 'Akses ditolak untuk keputusan tiket ini.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'reportId', case when decision.source_report_id = p_report_id then decision.candidate_report_id else decision.source_report_id end,
    'choice', decision.choice, 'reason', decision.reason, 'byRole', decision.by_role,
    'by', coalesce(nullif(btrim(profile.display_name), ''), profile.username), 'at', decision.created_at
  ) order by decision.created_at desc), '[]'::jsonb)
    into v_result
    from public.simlsp_report_duplicate_decisions decision
    join public.simlsp_profiles profile on profile.id = decision.by_user_id
   where decision.source_report_id = p_report_id or decision.candidate_report_id = p_report_id;
  return coalesce(v_result, '[]'::jsonb);
end;
$function$;
revoke all on function public.simlsp_list_duplicate_decisions(text) from public, anon;
grant execute on function public.simlsp_list_duplicate_decisions(text) to authenticated, service_role;

create or replace function public.simlsp_get_queue_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select count(*)::integer
    from public.simlsp_shared_data state
    cross join lateral pg_catalog.jsonb_array_elements(case when jsonb_typeof(state.data -> 'reports') = 'array' then state.data -> 'reports' else '[]'::jsonb end) report(value)
   where state.id = 1
     and report.value ->> 'status' = any (array['BARU','MENUNGGU_PERSETUJUAN','ANTREAN','DITUGASKAN','DALAM_PENGERJAAN','MENUNGGU_VERIFIKASI']::text[])
     and not exists (select 1 from public.simlsp_report_merge_links link where link.child_report_id = report.value ->> 'id');
$function$;
revoke all on function public.simlsp_get_queue_count() from public;
grant execute on function public.simlsp_get_queue_count() to anon, authenticated;

create or replace function public.simlsp_claim_queue_notification()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reports jsonb;
  v_count integer;
  v_previous integer;
begin
  select case when jsonb_typeof(state.data -> 'reports') = 'array' then state.data -> 'reports' else '[]'::jsonb end
    into v_reports from public.simlsp_shared_data state where state.id = 1 for update;
  select count(*)::integer into v_count from pg_catalog.jsonb_array_elements(coalesce(v_reports, '[]'::jsonb)) report(value)
   where report.value ->> 'status' = any (array['BARU','MENUNGGU_PERSETUJUAN','ANTREAN','DITUGASKAN','DALAM_PENGERJAAN','MENUNGGU_VERIFIKASI']::text[])
     and not exists (select 1 from public.simlsp_report_merge_links link where link.child_report_id = report.value ->> 'id');
  select state.queue_count into v_previous from public.simlsp_queue_notification_state state where state.id = true for update;
  if not found then
    insert into public.simlsp_queue_notification_state(id, queue_count) values (true, v_count);
    return jsonb_build_object('changed', true, 'count', v_count);
  end if;
  if v_previous is distinct from v_count then
    update public.simlsp_queue_notification_state set queue_count = v_count, updated_at = pg_catalog.now() where id = true;
    return jsonb_build_object('changed', true, 'count', v_count);
  end if;
  return jsonb_build_object('changed', false, 'count', v_count);
end;
$function$;
revoke all on function public.simlsp_claim_queue_notification() from public, anon, authenticated;
grant execute on function public.simlsp_claim_queue_notification() to service_role;

notify pgrst, 'reload schema';
