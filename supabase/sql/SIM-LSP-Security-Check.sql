-- Read-only inspection for the live Supabase project.
-- Run in Supabase Dashboard > SQL Editor after applying SIM-LSP-Supabase.sql.

-- These application tables should have Row Level Security enabled.
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls
from pg_catalog.pg_class as c
join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'simlsp_profiles',
    'simlsp_shared_state',
    'simlsp_push_subscriptions',
    'simlsp_push_delivery_log',
    'simlsp_queue_notification_state'
  )
order by c.relname;

-- Direct access should be revoked from anon and authenticated on these private tables.
select
  table_name,
  has_table_privilege('anon', format('public.%I', table_name), 'SELECT') as anon_can_select,
  has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE') as authenticated_can_delete
from (values
  ('simlsp_shared_state'),
  ('simlsp_push_subscriptions'),
  ('simlsp_push_delivery_log'),
  ('simlsp_queue_notification_state')
) as expected(table_name)
where to_regclass(format('public.%I', table_name)) is not null
order by table_name;

-- Authenticated users may SELECT their own profile; RLS must limit rows to auth.uid().
select
  has_table_privilege('anon', 'public.simlsp_profiles', 'SELECT') as anon_can_select_profiles,
  has_table_privilege('authenticated', 'public.simlsp_profiles', 'SELECT') as authenticated_can_select_profiles,
  has_table_privilege('authenticated', 'public.simlsp_profiles', 'INSERT') as authenticated_can_insert_profiles,
  has_table_privilege('authenticated', 'public.simlsp_profiles', 'UPDATE') as authenticated_can_update_profiles,
  has_table_privilege('authenticated', 'public.simlsp_profiles', 'DELETE') as authenticated_can_delete_profiles;

-- Review which roles can execute the SIM-LSP RPCs. Queue count is public by design;
-- state mutation, account administration, and push delivery must be restricted.
select
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name like 'simlsp!_%' escape '!'
order by routine_name, grantee;

-- Review RLS policies and their predicates for these tables.
select
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename in (
    'simlsp_profiles',
    'simlsp_shared_state',
    'simlsp_push_subscriptions',
    'simlsp_push_delivery_log',
    'simlsp_queue_notification_state'
  )
order by tablename, policyname;
