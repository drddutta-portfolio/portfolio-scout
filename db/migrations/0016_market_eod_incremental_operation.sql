-- 0016_market_eod_incremental_operation.sql
-- Stage 2C — register incremental EOD refresh as a first-class audited market-data operation.
--
-- Safe additive migration only. No market data, transactions, holdings or mappings are modified.

begin;

alter table public.market_data_refresh_runs
  drop constraint if exists mdrr_operation_ck;

alter table public.market_data_refresh_runs
  add constraint mdrr_operation_ck
  check (operation in ('SYNC_MAPPINGS','REFRESH_PRICES','BACKFILL_EOD','REFRESH_EOD'));

alter table public.market_data_operation_leases
  drop constraint if exists mdol_operation_ck;

alter table public.market_data_operation_leases
  add constraint mdol_operation_ck
  check (operation in ('REFRESH_PRICES','SYNC_MAPPINGS','BACKFILL_EOD','REFRESH_EOD'));

create or replace function public.acquire_market_data_operation_lease(
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
  v_block_until timestamptz;
begin
  if p_provider_code <> 'ANGEL_ONE'
     or p_operation not in ('REFRESH_PRICES','SYNC_MAPPINGS','BACKFILL_EOD','REFRESH_EOD')
     or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'invalid market-data lease request' using errcode = '22023';
  end if;

  perform 1 from public.portfolios where id = p_portfolio_id;
  if not found then raise exception 'portfolio not found' using errcode = '22023'; end if;

  insert into public.market_data_operation_leases(
    portfolio_id, provider_code, operation, lease_holder, lease_expires_at, cooldown_until, updated_at
  ) values (p_portfolio_id, p_provider_code, p_operation, null, null, null, v_now)
  on conflict (portfolio_id, provider_code, operation) do nothing;

  select * into v_row from public.market_data_operation_leases
   where portfolio_id = p_portfolio_id and provider_code = p_provider_code and operation = p_operation
   for update;

  v_block_until := greatest(
    coalesce(v_row.lease_expires_at, '-infinity'::timestamptz),
    coalesce(v_row.cooldown_until, '-infinity'::timestamptz)
  );
  if v_block_until > v_now then
    return query select false, greatest(1, ceil(extract(epoch from v_block_until - v_now))::integer);
    return;
  end if;

  update public.market_data_operation_leases
     set lease_holder = p_lease_holder,
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         cooldown_until = null,
         updated_at = v_now
   where portfolio_id = p_portfolio_id and provider_code = p_provider_code and operation = p_operation;

  return query select true, 0;
end;
$$;

alter function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) owner to postgres;
revoke all on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) from public;
grant execute on function public.acquire_market_data_operation_lease(uuid,text,text,uuid,integer) to service_role;

commit;
