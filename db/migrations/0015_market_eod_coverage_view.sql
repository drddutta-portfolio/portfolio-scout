-- 0015_market_eod_coverage_view.sql
-- PortfolioAI Stage 2C — read-only portfolio market-history verification support.
--
-- Additive only:
--   * no transaction/holding mutation
--   * no market-history mutation
--   * no provider credential changes
--   * exposes aggregated coverage/quality metadata only

begin;

create or replace view public.market_eod_security_coverage
with (security_invoker = true)
as
select
  security_id,
  provider_code,
  count(*)::bigint as candle_count,
  min(trade_date) as first_trade_date,
  max(trade_date) as last_trade_date,
  count(*) filter (where volume is null)::bigint as missing_volume_count,
  count(*) filter (
    where high_price < open_price
       or high_price < close_price
       or low_price > open_price
       or low_price > close_price
       or high_price < low_price
  )::bigint as invalid_ohlc_count,
  max(retrieved_at) as latest_retrieved_at
from public.market_price_history_eod
group by security_id, provider_code;

comment on view public.market_eod_security_coverage is
  'Read-only aggregate coverage and OHLCV quality summary for provider EOD history. Security-invoker preserves underlying RLS.';

revoke all on public.market_eod_security_coverage from public, anon;
grant select on public.market_eod_security_coverage to authenticated;
grant select on public.market_eod_security_coverage to service_role;

commit;
