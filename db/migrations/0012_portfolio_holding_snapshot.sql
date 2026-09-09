-- 0012_portfolio_holding_snapshot.sql
-- PortfolioAI Migration 12 — supplemental spreadsheet HOLDINGS snapshot.
--
-- Purpose
--   Preserve presentation/reference fields from a user-supplied HOLDINGS sheet
--   (average buy price, invested value, spreadsheet price/value/P&L, sector,
--   etc.) without changing the accounting source of truth.
--
-- Invariants
--   * public.transactions remains the canonical accounting ledger.
--   * public.current_holdings remains the canonical derived quantity view.
--   * This table is a user-owned SOURCE SNAPSHOT only; its figures may be stale
--     and must never silently overwrite transactions or deterministic engines.
--   * One current snapshot row per portfolio/security. A later spreadsheet
--     upload may replace that source snapshot while preserving provenance.
--   * No service-role credential is exposed to the browser.

begin;

create table public.portfolio_holding_snapshots (
  id                         uuid primary key default gen_random_uuid(),
  owner_id                   uuid not null references public.profiles(id) on delete restrict,
  portfolio_id               uuid not null,
  security_id                uuid not null references public.securities(id) on delete restrict,

  source_ticker              text not null,
  source_company_name        text,
  net_units_claim            numeric(38,18),
  avg_buy_price              numeric(38,18),
  invested_value             numeric(38,18),
  spreadsheet_current_price  numeric(38,18),
  spreadsheet_current_value  numeric(38,18),
  spreadsheet_unrealized_pl  numeric(38,18),
  spreadsheet_unrealized_pct numeric(20,8),
  spreadsheet_realized_pl    numeric(38,18),
  spreadsheet_realized_pct   numeric(20,8),
  sector                     text,
  market_cap                 numeric(38,8),
  cap_category               text,

  source_filename            text not null,
  source_file_sha256         text not null,
  snapshot_as_of_date        date,
  imported_at                timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint phs_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios(owner_id, id) on delete restrict,
  constraint phs_unique_portfolio_security
    unique (owner_id, portfolio_id, security_id),
  constraint phs_ticker_len check (char_length(source_ticker) between 1 and 80),
  constraint phs_sha256_shape check (source_file_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.portfolio_holding_snapshots is
  'User-owned latest spreadsheet HOLDINGS snapshot. Supplemental/reference data only; transactions/current_holdings remain accounting truth.';
comment on column public.portfolio_holding_snapshots.spreadsheet_current_price is
  'Price cached in the uploaded spreadsheet at import time. Not live market data.';
comment on column public.portfolio_holding_snapshots.net_units_claim is
  'Consolidated units claimed by the source HOLDINGS sheet, used for reconciliation against current_holdings.';

create index phs_owner_portfolio_idx
  on public.portfolio_holding_snapshots(owner_id, portfolio_id);
create index phs_portfolio_ticker_idx
  on public.portfolio_holding_snapshots(portfolio_id, source_ticker);

create trigger portfolio_holding_snapshots_set_updated_at
before update on public.portfolio_holding_snapshots
for each row execute function public.set_updated_at();

revoke all on public.portfolio_holding_snapshots from public;
revoke all on public.portfolio_holding_snapshots from anon, authenticated;

grant select on public.portfolio_holding_snapshots to authenticated;
grant insert (
  owner_id, portfolio_id, security_id, source_ticker, source_company_name,
  net_units_claim, avg_buy_price, invested_value, spreadsheet_current_price,
  spreadsheet_current_value, spreadsheet_unrealized_pl,
  spreadsheet_unrealized_pct, spreadsheet_realized_pl,
  spreadsheet_realized_pct, sector, market_cap, cap_category,
  source_filename, source_file_sha256, snapshot_as_of_date, imported_at
) on public.portfolio_holding_snapshots to authenticated;

-- The client uses UPSERT on the unique owner/portfolio/security key. RLS still
-- requires owner_id=auth.uid(), and the portfolio FK still restricts rows to a
-- portfolio owned by that same user. Allowing these key columns in UPDATE is
-- therefore owner-scoped and is limited to this supplemental snapshot table.
grant update (
  owner_id, portfolio_id, security_id,
  source_ticker, source_company_name, net_units_claim, avg_buy_price,
  invested_value, spreadsheet_current_price, spreadsheet_current_value,
  spreadsheet_unrealized_pl, spreadsheet_unrealized_pct,
  spreadsheet_realized_pl, spreadsheet_realized_pct, sector, market_cap,
  cap_category, source_filename, source_file_sha256, snapshot_as_of_date,
  imported_at
) on public.portfolio_holding_snapshots to authenticated;
grant delete on public.portfolio_holding_snapshots to authenticated;
grant all on public.portfolio_holding_snapshots to service_role;

alter table public.portfolio_holding_snapshots enable row level security;

create policy phs_select_own on public.portfolio_holding_snapshots
  for select to authenticated using (owner_id = auth.uid());
create policy phs_insert_own on public.portfolio_holding_snapshots
  for insert to authenticated with check (owner_id = auth.uid());
create policy phs_update_own on public.portfolio_holding_snapshots
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy phs_delete_own on public.portfolio_holding_snapshots
  for delete to authenticated using (owner_id = auth.uid());

commit;

-- Verification after deployment:
-- select relrowsecurity from pg_class where oid = 'public.portfolio_holding_snapshots'::regclass;
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='portfolio_holding_snapshots';
-- Browser authenticated user should see/write only owner_id=auth.uid() rows.
