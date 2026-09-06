-- 0003_portfolio_foundation.sql
-- PortfolioAI Migration 03 — portfolio foundation: brokers (shared reference
-- data), portfolios and broker_accounts (both user-owned).
--
-- Invariants:
--   * brokers is shared canonical reference data, read-only to the browser.
--     Migration 03 seeds ONLY 'OTHER'; confirmed canonical brokers arrive later
--     through additive migrations keyed on the stable `code`.
--   * No broker credentials, API keys, tokens, PINs, TOTP secrets or private
--     keys — here or anywhere in the database.
--   * No full broker client identifier; only a user-typed, display-only masked
--     fragment.
--   * broker_accounts do NOT belong directly to a portfolio. One portfolio may
--     aggregate several accounts and one account may later feed several logical
--     portfolios; the mapping arrives later, when import semantics are fixed.
--   * user_settings.default_portfolio_id remains deferred.
--   * No accounting-method field: cost basis / P&L stay unavailable until an
--     accounting methodology is explicitly approved.
--   * core_target_count is a COUNT OF STOCKS, never an allocation percentage.
--   * base_currency is settable on INSERT only; it is not an ordinary editable
--     property once financial records exist.
--   * No DELETE for the browser anywhere; removal is archival (archived_at).
--   * All foreign keys are ON DELETE RESTRICT: investment/accounting history
--     must never disappear through incidental parent deletion.
--   * Explicit-grant model (Migration 02a): nothing is granted automatically.
--   * Audit timestamps are database-controlled; reuses public.set_updated_at()
--     from Migration 02 — it is NOT redeclared here.
--
-- Rollback (safe only while no later migration references these tables;
-- revert dependents first; never drop ... cascade; never drop the shared
-- public.set_updated_at() function):
--
-- begin;
-- drop table if exists public.broker_accounts;
-- drop table if exists public.portfolios;
-- drop table if exists public.brokers;
-- commit;

begin;

-- 1. brokers: shared reference data, no credentials, ever. -------------------

create table public.brokers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9_]{2,32}$'),
  name        text not null check (char_length(name) between 1 and 120),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.brokers (code, name) values
  ('OTHER','Other / not listed');

-- 2. portfolios: user-owned. -------------------------------------------------

create table public.portfolios (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references public.profiles(id) on delete restrict,
  name              text not null check (char_length(name) between 1 and 120),
  description       text check (description is null or char_length(description) <= 2000),
  base_currency     char(3) not null default 'INR' check (base_currency ~ '^[A-Z]{3}$'),
  core_target_count integer check (core_target_count is null or core_target_count between 1 and 500),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner_id, name),
  unique (owner_id, id)   -- enables a future ownership-safe composite FK
);

comment on column public.portfolios.core_target_count is
  'Target NUMBER OF CORE STOCKS (e.g. ~35). Never an allocation percentage.';

-- 3. broker_accounts: user-owned. No portfolio_id (many-to-many arrives later).

create table public.broker_accounts (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete restrict,
  broker_id          uuid not null references public.brokers(id) on delete restrict,
  nickname           text not null check (char_length(nickname) between 1 and 80),
  account_ref_masked text check (account_ref_masked is null or char_length(account_ref_masked) between 1 and 24),
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (owner_id, nickname)
);

create index portfolios_owner_idx       on public.portfolios (owner_id);
create index broker_accounts_owner_idx  on public.broker_accounts (owner_id);
create index broker_accounts_broker_idx on public.broker_accounts (broker_id);

create trigger brokers_set_updated_at before update on public.brokers
  for each row execute function public.set_updated_at();
create trigger portfolios_set_updated_at before update on public.portfolios
  for each row execute function public.set_updated_at();
create trigger broker_accounts_set_updated_at before update on public.broker_accounts
  for each row execute function public.set_updated_at();

-- 4. Explicit grants only (Migration 02a model: nothing is automatic). -------

grant select on public.brokers to authenticated;
grant all    on public.brokers to service_role;

grant select on public.portfolios to authenticated;
grant insert (owner_id, name, description, base_currency, core_target_count)
  on public.portfolios to authenticated;
grant update (name, description, core_target_count, archived_at)
  on public.portfolios to authenticated;
grant all on public.portfolios to service_role;

grant select on public.broker_accounts to authenticated;
grant insert (owner_id, broker_id, nickname, account_ref_masked)
  on public.broker_accounts to authenticated;
grant update (nickname, account_ref_masked, archived_at)
  on public.broker_accounts to authenticated;
grant all on public.broker_accounts to service_role;

-- 5. RLS. --------------------------------------------------------------------

alter table public.brokers          enable row level security;
alter table public.portfolios       enable row level security;
alter table public.broker_accounts  enable row level security;

create policy brokers_select_all on public.brokers
  for select to authenticated using (true);

create policy portfolios_select_own on public.portfolios
  for select to authenticated using (owner_id = auth.uid());
create policy portfolios_insert_own on public.portfolios
  for insert to authenticated with check (owner_id = auth.uid());
create policy portfolios_update_own on public.portfolios
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy broker_accounts_select_own on public.broker_accounts
  for select to authenticated using (owner_id = auth.uid());
create policy broker_accounts_insert_own on public.broker_accounts
  for insert to authenticated with check (owner_id = auth.uid());
create policy broker_accounts_update_own on public.broker_accounts
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

commit;
