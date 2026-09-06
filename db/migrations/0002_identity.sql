-- 0002_identity.sql
-- PortfolioAI Migration 02 — identity foundation: profiles, user_settings,
-- shared set_updated_at() trigger function.
--
-- Invariants:
--   * Supabase Auth remains the sole credential store; no credentials here.
--   * Auth-user deletion is NON-destructive: on delete restrict. Deleting an
--     authentication identity must never cascade-delete PortfolioAI
--     investment/accounting/audit history.
--   * Audit timestamps are database-controlled: created_at via default,
--     updated_at via trigger. Column-level grants keep both out of reach of
--     the authenticated (browser) role.
--
-- Rollback (safe only while no later migration depends on these objects;
-- revert dependents first; never drop ... cascade):
--
-- begin;
-- drop table if exists public.user_settings;
-- drop table if exists public.profiles;
-- drop function if exists public.set_updated_at();
-- commit;

begin;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 120)
);

create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  locale text not null default 'en-IN'
    check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Asia/Kolkata'
    check (char_length(timezone) between 1 and 64),
  date_format text not null default 'DD-MM-YYYY'
    check (date_format in ('DD-MM-YYYY','MM-DD-YYYY','YYYY-MM-DD')),
  number_locale text not null default 'en-IN'
    check (number_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

-- Column-scoped privileges: created_at / updated_at are never client-writable.
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select on public.user_settings to authenticated;
grant insert (user_id, locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;
grant update (locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;

grant all on public.profiles to service_role;
grant all on public.user_settings to service_role;

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy user_settings_select_own on public.user_settings
  for select to authenticated using (user_id = auth.uid());
create policy user_settings_insert_own on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());
create policy user_settings_update_own on public.user_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
