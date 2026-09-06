-- 0002a_identity_privileges.sql
-- PortfolioAI Migration 02a — corrective privilege migration for Migration 02.
--
-- Context:
--   Supabase ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
--   authenticated, service_role` for the object-creating roles. Every new
--   public table therefore starts with full table privileges for anon and
--   authenticated, so the narrow column-level grants in 0002_identity.sql were
--   additive and did not restrict anything.
--
-- This migration:
--   1. Revokes all inherited privileges on public.profiles / public.user_settings
--      from anon and authenticated, then re-grants exactly the approved set.
--   2. Switches the project to an explicit-grant model: future tables,
--      sequences and functions created by the migration role (verified:
--      postgres) receive no automatic Data API privileges.
--   3. Revokes direct EXECUTE on the trigger-only helper
--      public.set_updated_at() from PUBLIC, anon and authenticated.
--
-- Not changed: table structure, foreign keys (ON DELETE RESTRICT), RLS state,
-- the six approved RLS policies, trigger definitions, now() semantics, and the
-- non-SECURITY-DEFINER / search_path='' properties of set_updated_at().
--
-- Binding rule from this migration onward: every future PortfolioAI migration
-- must GRANT explicitly the privileges each new object requires. Nothing is
-- granted automatically.
--
-- Rollback (restores Supabase's permissive defaults; not recommended):
--
-- begin;
-- alter default privileges for role postgres in schema public
--   grant all on tables to anon, authenticated, service_role;
-- alter default privileges for role postgres in schema public
--   grant usage, select on sequences to anon, authenticated, service_role;
-- alter default privileges for role postgres in schema public
--   grant execute on functions to anon, authenticated, service_role;
-- alter default privileges for role postgres in schema public
--   grant execute on functions to public;
-- grant all on public.profiles, public.user_settings to anon, authenticated;
-- grant execute on function public.set_updated_at() to public, anon, authenticated;
-- commit;

begin;

-- 1. Existing tables: reset to the approved privilege set -------------------

revoke all on public.profiles from anon, authenticated;
revoke all on public.user_settings from anon, authenticated;

grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select on public.user_settings to authenticated;
grant insert (user_id, locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;
grant update (locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;

-- service_role privileges are unchanged (granted in 0002_identity.sql).

-- 2. Explicit-grant model for future objects in public ---------------------
--    Creator role verified from pg_default_acl before writing this migration:
--    postgres (the role used to apply PortfolioAI migrations).

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- 3. Trigger-only helper: not directly callable from the Data API ----------
--    Trigger execution does not require EXECUTE on the trigger function.

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon, authenticated;

commit;

-- 4. Residual future-object defaults ---------------------------------------
--    The DML revokes above leave non-DML defaults (TRUNCATE/REFERENCES/TRIGGER/
--    MAINTAIN on tables, UPDATE on sequences). Under the explicit-grant model
--    nothing should be automatic, so remove those too.

begin;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

commit;
