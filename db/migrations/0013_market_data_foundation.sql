-- 0013_market_data_foundation.sql
-- PortfolioAI Migration 13 — market-data foundation for Angel One SmartAPI.
--
-- PREPARED FOR REVIEW. Apply only after review/approval.
--
-- Purpose
--   Add provider/security mappings, latest quote cache, EOD history, refresh
--   audit records, mapping-change quarantine, and operation leases.
--
-- Invariants
--   * public.transactions remains accounting truth.
--   * public.current_holdings remains quantity truth.
--   * Market data is observation/provenance data only; it never mutates ledger facts.
--   * Browser has SELECT-only access to shared market observations/mappings.
--   * Provider writes occur only server-side through the Edge Function/service role.
--   * No API credential/token is stored in any table.
--   * No trading/order execution objects are introduced.
--
-- Rollback (only before application code depends on M13):
--   begin;
--   drop function if exists public.release_market_data_operation_lease(uuid,text,text,uuid,integer);
--   drop function if exists public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer);
--   drop table if exists public.market_data_operation_leases;
--   drop table if exists public.market_data_refresh_runs;
--   drop table if exists public.market_data_mapping_reviews;
--   drop table if exists public.market_price_history_eod;
--   drop table if exists public.market_price_latest;
--   drop table if exists public.market_data_instrument_mappings;
--   commit;
--   Never use CASCADE.

begin;

-- ---------------------------------------------------------------------------
-- 1. Provider instrument identity
-- ---------------------------------------------------------------------------

create table public.market_data_instrument_mappings (
  id                       uuid primary key default gen_random_uuid(),
  security_id              uuid not null references public.securities(id) on delete restrict,
  provider_code            text not null,
  provider_instrument_id   text,
  exchange                 text,
  trading_symbol           text,
  provider_instrument_type text,
  mapping_status           text not null default 'UNRESOLVED',
  match_basis              text,
  evidence                 jsonb not null default '{}'::jsonb,
  instrument_master_as_of  date,
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint mdim_provider_code_ck check (provider_code in ('ANGEL_ONE')),
  constraint mdim_mapping_status_ck check (mapping_status in ('VERIFIED','UNRESOLVED','AMBIGUOUS')),
  constraint mdim_match_basis_ck check (match_basis is null or match_basis in ('EXCHANGE_SYMBOL_EXACT')),
  constraint mdim_exchange_ck check (exchange is null or exchange in ('NSE','BSE')),
  constraint mdim_verified_shape_ck check (
    mapping_status <> 'VERIFIED'
    or (
      provider_instrument_id is not null
      and exchange is not null
      and trading_symbol is not null
      and match_basis is not null
      and verified_at is not null
    )
  ),
  constraint mdim_unique_security_provider unique (security_id, provider_code)
);

create index mdim_provider_status_idx
  on public.market_data_instrument_mappings(provider_code, mapping_status);
create unique index mdim_unique_provider_identity
  on public.market_data_instrument_mappings(provider_code, exchange, provider_instrument_id)
  where provider_instrument_id is not null;

create trigger market_data_instrument_mappings_set_updated_at
before update on public.market_data_instrument_mappings
for each row execute function public.set_updated_at();

comment on table public.market_data_instrument_mappings is
  'Canonical security to market-data provider instrument mapping. Shared reference data; server-written, authenticated read-only.';

revoke all on public.market_data_instrument_mappings from public;
revoke all on public.market_data_instrument_mappings from anon, authenticated;
grant select on public.market_data_instrument_mappings to authenticated;
grant all on public.market_data_instrument_mappings to service_role;

alter table public.market_data_instrument_mappings enable row level security;
create policy mdim_authenticated_read on public.market_data_instrument_mappings
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. Latest quote cache (FULL quote subset useful to investment workflows)
-- ---------------------------------------------------------------------------

create table public.market_price_latest (
  id                    uuid primary key default gen_random_uuid(),
  security_id           uuid not null references public.securities(id) on delete restrict,
  provider_code         text not null,
  mapping_id            uuid not null references public.market_data_instrument_mappings(id) on delete restrict,
  price                 numeric(38,18) not null,
  currency              text not null default 'INR',
  price_timestamp       timestamptz,
  retrieved_at          timestamptz not null,
  market_session_status text not null default 'UNKNOWN',
  previous_close        numeric(38,18),
  day_open              numeric(38,18),
  day_high              numeric(38,18),
  day_low               numeric(38,18),
  net_change            numeric(38,18),
  percent_change        numeric(20,8),
  average_price         numeric(38,18),
  trade_volume          numeric(38,0),
  total_buy_quantity    numeric(38,0),
  total_sell_quantity   numeric(38,0),
  lower_circuit         numeric(38,18),
  upper_circuit         numeric(38,18),
  week_52_low           numeric(38,18),
  week_52_high          numeric(38,18),
  provenance            jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint mpl_provider_code_ck check (provider_code in ('ANGEL_ONE')),
  constraint mpl_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint mpl_session_ck check (market_session_status in ('OPEN','CLOSED','PRE_OPEN','POST_CLOSE','UNKNOWN')),
  constraint mpl_price_positive_ck check (price >= 0),
  constraint mpl_unique_security_provider unique (security_id, provider_code),
  constraint mpl_mapping_provider_security_fk
    foreign key (mapping_id, security_id, provider_code)
    references public.market_data_instrument_mappings(id, security_id, provider_code)
    on delete restrict
);

-- Required by the composite FK above; id remains the primary identity.
alter table public.market_data_instrument_mappings
  add constraint mdim_id_security_provider_key unique (id, security_id, provider_code);

create index mpl_retrieved_idx on public.market_price_latest(provider_code, retrieved_at desc);

create trigger market_price_latest_set_updated_at
before update on public.market_price_latest
for each row execute function public.set_updated_at();

comment on table public.market_price_latest is
  'Latest cached provider quote. Observation only; not accounting truth. Includes selected Angel One FULL quote fields.';

revoke all on public.market_price_latest from public;
revoke all on public.market_price_latest from anon, authenticated;
grant select on public.market_price_latest to authenticated;
grant all on public.market_price_latest to service_role;

alter table public.market_price_latest enable row level security;
create policy mpl_authenticated_read on public.market_price_latest
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Daily OHLCV history for deterministic momentum/market engines
-- ---------------------------------------------------------------------------

create table public.market_price_history_eod (
  id             uuid primary key default gen_random_uuid(),
  security_id    uuid not null references public.securities(id) on delete restrict,
  provider_code  text not null,
  mapping_id     uuid not null references public.market_data_instrument_mappings(id) on delete restrict,
  trade_date     date not null,
  open_price     numeric(38,18) not null,
  high_price     numeric(38,18) not null,
  low_price      numeric(38,18) not null,
  close_price    numeric(38,18) not null,
  volume         numeric(38,0),
  currency       text not null default 'INR',
  retrieved_at   timestamptz not null default now(),
  provenance     jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),

  constraint mphe_provider_code_ck check (provider_code in ('ANGEL_ONE')),
  constraint mphe_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint mphe_ohlc_nonnegative_ck check (
    open_price >= 0 and high_price >= 0 and low_price >= 0 and close_price >= 0
  ),
  constraint mphe_range_ck check (high_price >= low_price),
  constraint mphe_volume_ck check (volume is null or volume >= 0),
  constraint mphe_unique_day unique (security_id, provider_code, trade_date),
  constraint mphe_mapping_provider_security_fk
    foreign key (mapping_id, security_id, provider_code)
    references public.market_data_instrument_mappings(id, security_id, provider_code)
    on delete restrict
);

create index mphe_security_date_idx
  on public.market_price_history_eod(security_id, trade_date desc);
create index mphe_provider_date_idx
  on public.market_price_history_eod(provider_code, trade_date desc);

comment on table public.market_price_history_eod is
  'Provider-sourced daily OHLCV observations for deterministic investment analysis. Append/upsert by provider+security+date; never a transaction ledger.';

revoke all on public.market_price_history_eod from public;
revoke all on public.market_price_history_eod from anon, authenticated;
grant select on public.market_price_history_eod to authenticated;
grant all on public.market_price_history_eod to service_role;

alter table public.market_price_history_eod enable row level security;
create policy mphe_authenticated_read on public.market_price_history_eod
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 4. Mapping-change quarantine/audit (server only)
-- ---------------------------------------------------------------------------

create table public.market_data_mapping_reviews (
  id                                uuid primary key default gen_random_uuid(),
  mapping_id                        uuid not null references public.market_data_instrument_mappings(id) on delete restrict,
  security_id                       uuid not null references public.securities(id) on delete restrict,
  provider_code                     text not null,
  proposed_provider_instrument_id   text,
  proposed_exchange                 text,
  proposed_trading_symbol           text,
  proposed_provider_instrument_type text,
  proposed_mapping_status           text not null,
  proposed_match_basis              text,
  evidence                          jsonb not null default '{}'::jsonb,
  detected_at                       timestamptz not null,
  review_status                     text not null default 'PENDING',
  reviewed_at                       timestamptz,
  created_at                        timestamptz not null default now(),

  constraint mdmr_provider_ck check (provider_code in ('ANGEL_ONE')),
  constraint mdmr_mapping_status_ck check (proposed_mapping_status in ('VERIFIED','UNRESOLVED','AMBIGUOUS')),
  constraint mdmr_review_status_ck check (review_status in ('PENDING','ACCEPTED','REJECTED'))
);

create unique index mdmr_one_pending_per_mapping
  on public.market_data_mapping_reviews(mapping_id)
  where review_status = 'PENDING';

revoke all on public.market_data_mapping_reviews from public;
revoke all on public.market_data_mapping_reviews from anon, authenticated;
grant all on public.market_data_mapping_reviews to service_role;

alter table public.market_data_mapping_reviews enable row level security;
-- No browser policy: operational server-only table.

-- ---------------------------------------------------------------------------
-- 5. User-visible refresh audit; server writes, owner reads
-- ---------------------------------------------------------------------------

create table public.market_data_refresh_runs (
  id                         uuid primary key default gen_random_uuid(),
  owner_id                   uuid not null references public.profiles(id) on delete restrict,
  portfolio_id               uuid not null,
  provider_code              text not null,
  operation                  text not null,
  requested_by               uuid not null references public.profiles(id) on delete restrict,
  status                     text not null,
  requested_security_count   integer not null default 0,
  cached_security_count      integer not null default 0,
  unresolved_security_count  integer not null default 0,
  fetched_security_count     integer not null default 0,
  failed_security_count      integer not null default 0,
  started_at                 timestamptz not null default now(),
  completed_at               timestamptz,
  error_summary              text,
  created_at                 timestamptz not null default now(),

  constraint mdrr_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios(owner_id, id) on delete restrict,
  constraint mdrr_provider_ck check (provider_code in ('ANGEL_ONE')),
  constraint mdrr_operation_ck check (operation in ('SYNC_MAPPINGS','REFRESH_PRICES','BACKFILL_EOD')),
  constraint mdrr_status_ck check (status in ('RUNNING','SUCCEEDED','PARTIAL','FAILED','SKIPPED_FRESH')),
  constraint mdrr_counts_ck check (
    requested_security_count >= 0 and cached_security_count >= 0
    and unresolved_security_count >= 0 and fetched_security_count >= 0
    and failed_security_count >= 0
  )
);

create index mdrr_owner_portfolio_started_idx
  on public.market_data_refresh_runs(owner_id, portfolio_id, started_at desc);

revoke all on public.market_data_refresh_runs from public;
revoke all on public.market_data_refresh_runs from anon, authenticated;
grant select on public.market_data_refresh_runs to authenticated;
grant all on public.market_data_refresh_runs to service_role;

alter table public.market_data_refresh_runs enable row level security;
create policy mdrr_select_own on public.market_data_refresh_runs
  for select to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Server-only lease/cooldown state
-- ---------------------------------------------------------------------------

create table public.market_data_operation_leases (
  portfolio_id     uuid not null references public.portfolios(id) on delete restrict,
  provider_code    text not null,
  operation        text not null,
  lease_holder     uuid,
  lease_expires_at timestamptz,
  cooldown_until   timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (portfolio_id, provider_code, operation),
  constraint mdol_provider_ck check (provider_code in ('ANGEL_ONE')),
  constraint mdol_operation_ck check (operation in ('REFRESH_PRICES','SYNC_MAPPINGS','BACKFILL_EOD'))
);

revoke all on public.market_data_operation_leases from public;
revoke all on public.market_data_operation_leases from anon, authenticated;
grant all on public.market_data_operation_leases to service_role;

alter table public.market_data_operation_leases enable row level security;
-- No browser policy.

-- Atomic lease acquisition used only by service-role Edge Functions.
create function public.acquire_market_data_operation_lease(
  p_portfolio_id uuid,
  p_provider_code text,
  p_operation text,
  p_lease_holder uuid,
  p_lease_seconds integer
)
returns table(acquired boolean, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.market_data_operation_leases%rowtype;
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  insert into public.market_data_operation_leases(
    portfolio_id, provider_code, operation, lease_holder, lease_expires_at, cooldown_until, updated_at
  ) values (
    p_portfolio_id, p_provider_code, p_operation, null, null, null, v_now
  ) on conflict (portfolio_id, provider_code, operation) do nothing;

  select * into v_row
  from public.market_data_operation_leases
  where portfolio_id = p_portfolio_id
    and provider_code = p_provider_code
    and operation = p_operation
  for update;

  if (v_row.lease_expires_at is not null and v_row.lease_expires_at > v_now)
     or (v_row.cooldown_until is not null and v_row.cooldown_until > v_now) then
    return query select false,
      greatest(1, ceil(extract(epoch from greatest(
        coalesce(v_row.lease_expires_at, v_now),
        coalesce(v_row.cooldown_until, v_now)
      ) - v_now))::integer);
    return;
  end if;

  update public.market_data_operation_leases
  set lease_holder = p_lease_holder,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      cooldown_until = null,
      updated_at = v_now
  where portfolio_id = p_portfolio_id
    and provider_code = p_provider_code
    and operation = p_operation;

  return query select true, 0;
end;
$$;

create function public.release_market_data_operation_lease(
  p_portfolio_id uuid,
  p_provider_code text,
  p_operation text,
  p_lease_holder uuid,
  p_cooldown_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_cooldown_seconds < 0 or p_cooldown_seconds > 86400 then
    raise exception 'invalid cooldown duration' using errcode = '22023';
  end if;

  update public.market_data_operation_leases
  set lease_holder = null,
      lease_expires_at = null,
      cooldown_until = v_now + make_interval(secs => p_cooldown_seconds),
      updated_at = v_now
  where portfolio_id = p_portfolio_id
    and provider_code = p_provider_code
    and operation = p_operation
    and lease_holder = p_lease_holder;
end;
$$;

alter function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) owner to postgres;
alter function public.release_market_data_operation_lease(uuid,text,text,uuid,integer) owner to postgres;

revoke all on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) from public;
revoke all on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) from anon, authenticated;
grant execute on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) to service_role;

revoke all on function public.release_market_data_operation_lease(uuid,text,text,uuid,integer) from public;
revoke all on function public.release_market_data_operation_lease(uuid,text,text,uuid,integer) from anon, authenticated;
grant execute on function public.release_market_data_operation_lease(uuid,text,text,uuid,integer) to service_role;

comment on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) is
  'Service-role-only atomic market-data operation lease/cooldown acquisition.';
comment on function public.release_market_data_operation_lease(uuid,text,text,uuid,integer) is
  'Service-role-only market-data operation lease release with cooldown.';

commit;

-- Post-deployment verification checklist:
-- 1. RLS enabled on all six M13 tables.
-- 2. anon has no privileges on any M13 object.
-- 3. authenticated has SELECT only on mappings/latest/history + own refresh runs.
-- 4. authenticated cannot execute either lease RPC.
-- 5. service_role has write access and lease RPC execution.
-- 6. no secrets/tokens/API credentials exist in any M13 column.
-- 7. current_holdings and transactions definitions are unchanged.
