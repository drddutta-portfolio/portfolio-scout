-- 0007_commit_import_batch.sql
-- PortfolioAI Migration 07 — trusted, atomic import commit.
--
-- Invariants:
--   * The browser never receives INSERT/UPDATE/DELETE on public.transactions.
--     This RPC is the single narrow write authority for imported ledger rows.
--   * auth.uid() is the authoritative caller identity; the browser supplies
--     only the batch id. All canonical facts are loaded server-side.
--   * SECURITY DEFINER, owner postgres, search_path='', fully schema-qualified,
--     no dynamic SQL, no user-controlled object names, no service-role secret.
--   * AWAITING_CONFIRMATION -> COMMITTING -> COMMITTED, all in one atomic call.
--   * Eligible rows: resolution = RESOLVED and data_quality_state = VALID and
--     cardinality(data_quality_issues) = 0. EXCLUDED rows are preserved and
--     skipped. Anything else aborts the whole commit.
--   * No fabricated financial facts; gross_amount is never derived.
--   * Currency must be explicitly known; the table default is never reached.
--   * One canonical transaction per source row (M06 unique lineage index).
--
-- Rollback:
-- begin;
-- drop function if exists public.commit_import_batch(uuid);
-- commit;

begin;

create function public.commit_import_batch(p_batch_id uuid)
returns table (
  batch_id uuid,
  status public.import_batch_state,
  committed_transaction_count integer,
  excluded_row_count integer,
  already_committed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_batch      public.import_batches%rowtype;
  v_bad        integer;
  v_row        public.import_source_rows%rowtype;
  v_inserted   integer := 0;
  v_excluded   integer := 0;
begin
  if v_uid is null then
    raise exception 'commit_import_batch: authentication required'
      using errcode = '28000';
  end if;

  select * into v_batch
    from public.import_batches b
   where b.id = p_batch_id and b.owner_id = v_uid
   for update;

  if not found then
    raise exception 'commit_import_batch: batch not found'
      using errcode = '42501';
  end if;

  select count(*) into v_excluded
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id and r.resolution = 'EXCLUDED';

  if v_batch.state = 'COMMITTED' then
    select count(*) into v_inserted
      from public.transactions t
      join public.import_source_rows r on r.id = t.import_source_row_id
     where r.import_batch_id = v_batch.id;
    return query select v_batch.id, v_batch.state, v_inserted, v_excluded, true;
    return;
  end if;

  if v_batch.state = 'COMMITTING' then
    raise exception 'commit_import_batch: batch commit already in progress'
      using errcode = '55006';
  end if;

  if v_batch.state <> 'AWAITING_CONFIRMATION' then
    raise exception 'commit_import_batch: batch is not awaiting confirmation'
      using errcode = '22023';
  end if;

  -- portfolio ownership (defence in depth; the composite FK already binds it)
  perform 1 from public.portfolios p
   where p.id = v_batch.portfolio_id and p.owner_id = v_uid;
  if not found then
    raise exception 'commit_import_batch: batch not found' using errcode = '42501';
  end if;

  -- explicit source-row ownership revalidation: the composite FK already makes
  -- this impossible, but the trusted commit boundary verifies it explicitly and
  -- never merely filters such rows out of the commit loop.
  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.owner_id <> v_uid;
  if v_bad > 0 then
    raise exception 'commit_import_batch: inconsistent ownership in batch'
      using errcode = '40002';
  end if;

  -- no row may be left in an indeterminate state
  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'UNRESOLVED';
  if v_bad > 0 then
    raise exception 'commit_import_batch: % row(s) are unresolved', v_bad
      using errcode = '22023';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'RESOLVED'
     and (r.data_quality_state <> 'VALID'
          or pg_catalog.cardinality(r.data_quality_issues) > 0);
  if v_bad > 0 then
    raise exception 'commit_import_batch: % row(s) are not valid for commit', v_bad
      using errcode = '22023';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'COMMITTED';
  if v_bad > 0 then
    raise exception 'commit_import_batch: inconsistent lineage in batch'
      using errcode = '40002';
  end if;

  update public.import_batches
     set state = 'COMMITTING'
   where id = v_batch.id;

  for v_row in
    select * from public.import_source_rows r
     where r.import_batch_id = v_batch.id
       and r.owner_id = v_uid
       and r.resolution = 'RESOLVED'
       and r.data_quality_state = 'VALID'
       and pg_catalog.cardinality(r.data_quality_issues) = 0
     order by r.source_row_number
     for update
  loop
    if v_row.security_resolution <> 'RESOLVED' or v_row.candidate_security_id is null then
      raise exception 'commit_import_batch: row %: security is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.securities s where s.id = v_row.candidate_security_id;
    if not found then
      raise exception 'commit_import_batch: row %: security is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_broker_account_id is null then
      raise exception 'commit_import_batch: row %: broker account is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.broker_accounts a
      where a.id = v_row.candidate_broker_account_id and a.owner_id = v_uid;
    if not found then
      raise exception 'commit_import_batch: row %: broker account is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_txn_type is null then
      raise exception 'commit_import_batch: row %: transaction type is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_txn_type in ('SPLIT','REVERSAL','ADJUSTMENT') then
      raise exception 'commit_import_batch: row %: % is not yet committable',
        v_row.source_row_number, v_row.candidate_txn_type using errcode = '22023';
    end if;
    if v_row.candidate_trade_date is null then
      raise exception 'commit_import_batch: row %: trade date is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_quantity is null or v_row.candidate_quantity <= 0 then
      raise exception 'commit_import_batch: row %: quantity is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_currency is null then
      raise exception 'commit_import_batch: row %: currency is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if coalesce(v_row.candidate_unit_price, 0) < 0
       or coalesce(v_row.candidate_gross_amount, 0) < 0
       or coalesce(v_row.candidate_total_charges, 0) < 0 then
      raise exception 'commit_import_batch: row %: negative amount', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.transactions t where t.import_source_row_id = v_row.id;
    if found then
      raise exception 'commit_import_batch: row % already has a canonical transaction',
        v_row.source_row_number using errcode = '40002';
    end if;

    insert into public.transactions (
      owner_id, portfolio_id, broker_account_id, security_id, txn_type,
      trade_date, quantity, unit_price, gross_amount, total_charges, currency,
      txn_state, data_quality_state, data_quality_issues,
      source_system, source_reference, import_source_row_id)
    values (
      v_uid, v_batch.portfolio_id, v_row.candidate_broker_account_id,
      v_row.candidate_security_id, v_row.candidate_txn_type,
      v_row.candidate_trade_date, v_row.candidate_quantity,
      v_row.candidate_unit_price, v_row.candidate_gross_amount,
      v_row.candidate_total_charges, v_row.candidate_currency,
      'ACTIVE', 'VALID', '{}',
      v_batch.source_system, v_row.raw_source_reference, v_row.id);

    update public.import_source_rows
       set resolution = 'COMMITTED'
     where id = v_row.id;

    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted = 0 then
    raise exception 'commit_import_batch: no committable rows' using errcode = '22023';
  end if;

  update public.import_batches b
     set state = 'COMMITTED',
         committed_at = pg_catalog.now(),
         total_source_rows = s.total,
         rows_valid        = s.valid,
         rows_incomplete   = s.incomplete,
         rows_needs_review = s.review
    from (
      select count(*)::int as total,
             count(*) filter (where data_quality_state = 'VALID')::int as valid,
             count(*) filter (where data_quality_state = 'INCOMPLETE')::int as incomplete,
             count(*) filter (where data_quality_state = 'NEEDS_REVIEW')::int as review
        from public.import_source_rows where import_batch_id = v_batch.id
    ) s
   where b.id = v_batch.id;

  return query select v_batch.id, 'COMMITTED'::public.import_batch_state,
                      v_inserted, v_excluded, false;
end;
$$;

alter function public.commit_import_batch(uuid) owner to postgres;

comment on function public.commit_import_batch(uuid) is
  'Trusted atomic import commit: AWAITING_CONFIRMATION -> COMMITTING -> COMMITTED. '
  'Loads all canonical facts server-side; the browser supplies only the batch id.';

revoke all on function public.commit_import_batch(uuid) from public;
revoke all on function public.commit_import_batch(uuid) from anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;

commit;
