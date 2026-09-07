-- 0008_derived_holdings.sql
-- PortfolioAI Migration 08 — per-portfolio/security configuration + derived holdings.
--
-- Invariants:
--   * public.transactions remains the accounting source of truth.
--     public.current_holdings is a VIEW derived from ACTIVE transactions only.
--     It is never materialized and never becomes a competing ledger.
--   * A non-NULL net_quantity means EVERY active quantity-affecting transaction
--     for the holding is currently understood and has a usable quantity.
--   * SPLIT / REVERSAL / ADJUSTMENT semantics are NOT implemented in M08.
--     Their presence forces net_quantity = NULL (disclosed via unhandled_txn_count).
--     Corporate-action modelling is DEFERRED to a later reviewed migration.
--   * Role-change history is DEFERRED (not removed): portfolio_security_settings
--     stores only the current role; historical role transitions belong to the
--     later audit/decision layer.
--   * No cost basis, average price, FIFO/LIFO/weighted-average assumption, P&L,
--     market value, portfolio weight, market price, engine or AI logic here.
--   * All foreign keys are ON DELETE RESTRICT. Reuses public.set_updated_at().
--   * No SECURITY DEFINER object. The application holds no service-role credential;
--     the service_role GRANT is Supabase/admin compatibility only.
--
-- Rollback:
-- begin;
-- drop view if exists public.current_holdings;
-- drop table if exists public.portfolio_security_settings;
-- commit;
-- (never `drop ... cascade`; never drop the shared set_updated_at())

begin;

-- ---------------------------------------------------------------------------
-- 1. public.portfolio_security_settings
-- ---------------------------------------------------------------------------

create table public.portfolio_security_settings (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete restrict,
  portfolio_id uuid not null,
  security_id  uuid not null references public.securities(id) on delete restrict,
  role         public.portfolio_role not null default 'UNASSIGNED',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint pss_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios (owner_id, id) on delete restrict,

  constraint pss_unique_per_portfolio_security
    unique (owner_id, portfolio_id, security_id),

  constraint pss_notes_len check (notes is null or char_length(notes) <= 4000)
);

comment on table public.portfolio_security_settings is
  'Per-portfolio, per-security user configuration (current role only). Non-financial config; not accounting history. Role-change history is deferred to the later audit/decision layer.';
comment on column public.portfolio_security_settings.role is
  'Current classification only (CORE/SATELLITE/THEMATIC/WATCHLIST/UNASSIGNED). Core target remains a stock COUNT on portfolios.core_target_count, never an allocation percentage.';

create index pss_owner_portfolio_idx on public.portfolio_security_settings (owner_id, portfolio_id);
create index pss_owner_security_idx  on public.portfolio_security_settings (owner_id, security_id);

create trigger portfolio_security_settings_set_updated_at before update
  on public.portfolio_security_settings
  for each row execute function public.set_updated_at();

-- Explicit privileges only (Migration 02a model).
revoke all on public.portfolio_security_settings from public;
revoke all on public.portfolio_security_settings from anon, authenticated;

grant select on public.portfolio_security_settings to authenticated;
grant insert (owner_id, portfolio_id, security_id, role, notes)
  on public.portfolio_security_settings to authenticated;
grant update (role, notes)
  on public.portfolio_security_settings to authenticated;
grant delete on public.portfolio_security_settings to authenticated;
grant all on public.portfolio_security_settings to service_role;

alter table public.portfolio_security_settings enable row level security;

create policy pss_select_own on public.portfolio_security_settings
  for select to authenticated using (owner_id = auth.uid());

create policy pss_insert_own on public.portfolio_security_settings
  for insert to authenticated with check (owner_id = auth.uid());

create policy pss_update_own on public.portfolio_security_settings
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy pss_delete_own on public.portfolio_security_settings
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. public.current_holdings (derived view)
-- ---------------------------------------------------------------------------

create view public.current_holdings
with (security_invoker = true) as
with derived as (
  select
    t.owner_id,
    t.portfolio_id,
    t.security_id,
    case
      -- (a) unhandled semantics present: never guess SPLIT/REVERSAL/ADJUSTMENT effects
      when count(*) filter (
        where t.txn_type in ('SPLIT','REVERSAL','ADJUSTMENT')
      ) > 0 then null
      -- (b) supported row with missing quantity: missing is not zero
      when count(*) filter (
        where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
          and t.quantity is null
      ) > 0 then null
      -- (c) fully understood: explicit signed sum over supported types only
      else sum(
        case
          when t.txn_type in ('BUY','OPENING_POSITION','TRANSFER_IN','BONUS') then  t.quantity
          when t.txn_type in ('SELL','TRANSFER_OUT')                          then -t.quantity
        end
      ) filter (
        where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
      )
    end as net_quantity,
    count(*) as active_txn_count,
    count(*) filter (where t.txn_type in ('SPLIT','REVERSAL','ADJUSTMENT')) as unhandled_txn_count,
    count(*) filter (
      where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
        and t.quantity is null
    ) as missing_quantity_count,
    count(*) filter (where t.data_quality_state <> 'VALID') as non_valid_txn_count,
    min(t.trade_date) as first_trade_date,
    max(t.trade_date) as last_trade_date
  from public.transactions t
  where t.txn_state = 'ACTIVE'
  group by t.owner_id, t.portfolio_id, t.security_id
)
select
  owner_id,
  portfolio_id,
  security_id,
  net_quantity,
  active_txn_count,
  unhandled_txn_count,
  missing_quantity_count,
  non_valid_txn_count,
  first_trade_date,
  last_trade_date
from derived
-- Omit fully-resolved zero holdings. Rows whose net_quantity is NULL
-- (unhandled/missing data) and negative quantities stay visible for disclosure.
where net_quantity is distinct from 0;

comment on view public.current_holdings is
  'Derived holdings over ACTIVE transactions only. Not a ledger. Supported directions: BUY/OPENING_POSITION/TRANSFER_IN/BONUS positive; SELL/TRANSFER_OUT negative. net_quantity is NULL when any ACTIVE SPLIT/REVERSAL/ADJUSTMENT exists (unhandled semantics, disclosed via unhandled_txn_count) or when a supported row has NULL quantity (missing_quantity_count). Fully-resolved zero holdings are omitted; negative quantities remain visible. No cost basis, price, P&L, market value or weight.';
comment on column public.current_holdings.net_quantity is
  'Non-NULL means every ACTIVE quantity-affecting transaction for this holding is currently understood and has a usable quantity. NULL means INSUFFICIENT_DATA, never zero.';

revoke all on public.current_holdings from public;
revoke all on public.current_holdings from anon, authenticated;
grant select on public.current_holdings to authenticated;

commit;
