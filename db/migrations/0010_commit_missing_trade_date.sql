-- 0010_commit_missing_trade_date.sql
-- PortfolioAI Migration 10 — allow an unknown trade date to be committed,
-- while keeping the missing date fully disclosed.
--
-- PREPARED FOR REVIEW ONLY. NOT DEPLOYED.
--
-- Problem
--   Historical broker workbooks frequently carry trades whose date was never
--   recorded. M06 forbids resolution = 'RESOLVED' without candidate_trade_date,
--   and M07 refuses to commit such a row. The economic facts (security, account,
--   type, quantity, currency) are nevertheless complete, so the trade is real
--   and must be capable of entering the ledger. Inventing a date would be a
--   fabricated accounting fact and is never acceptable.
--
-- What this migration changes (and nothing else)
--   1. public.import_source_rows: the RESOLVED completeness constraint no longer
--      requires candidate_trade_date. A new constraint requires that a RESOLVED
--      row with no date is INCOMPLETE and carries MISSING_DATE.
--   2. public.commit_import_batch(uuid): eligibility widens by exactly one case
--      — a RESOLVED row that is INCOMPLETE solely because its trade date is
--      unknown. The canonical transaction is written with trade_date = NULL,
--      data_quality_state = 'INCOMPLETE' and data_quality_issues = {MISSING_DATE}.
--
-- What this migration deliberately does NOT change
--   * No edit to 0001–0009a; they stay byte-for-byte as deployed.
--   * public.transactions is untouched. It already permits a NULL trade_date on
--     a non-VALID row (transactions_valid_requires_facts) and already forbids a
--     VALID row without a date, so a dateless trade can never look valid.
--   * public.current_holdings (M08) is untouched: it aggregates quantity and
--     only reports min/max trade_date, so a NULL date needs no view change.
--   * SPLIT / REVERSAL / ADJUSTMENT remain uncommittable through the import path.
--   * The trusted SECURITY DEFINER model, owner/portfolio revalidation, row
--     locking, lineage uniqueness, idempotency, EXCLUDED preservation, browser
--     privileges and transaction immutability are all carried over unchanged.
--   * No CASCADE anywhere. No new grant. No service-role application credential.
--
-- Rollback
--   The old M06 staging constraint can be restored only when no currently
--   RESOLVED staging row relies on the relaxed NULL-date rule. Already COMMITTED
--   rows do not violate the old M06 RESOLVED constraint, and M05 already permits
--   canonical non-VALID transactions whose trade_date is NULL.
--
--   Check first:
--     select count(*)
--       from public.import_source_rows
--      where resolution = 'RESOLVED'
--        and candidate_trade_date is null;
--
--   If that count is 0:
--   begin;
--   alter table public.import_source_rows
--     drop constraint if exists import_source_rows_missing_date_disclosed;
--   alter table public.import_source_rows
--     drop constraint import_source_rows_resolution_ck,
--     add constraint import_source_rows_resolution_ck check (
--       resolution <> 'RESOLVED' or (
--         candidate_security_id is not null and security_resolution = 'RESOLVED'
--         and candidate_txn_type is not null and candidate_trade_date is not null
--         and candidate_quantity is not null));
--   -- then recreate public.commit_import_batch(uuid) verbatim from
--   -- db/migrations/0007_commit_import_batch.sql (create or replace).
--   commit;

begin;

-- ---------------------------------------------------------------------------
-- 1. Staging: a RESOLVED row may lack only its date, and must say so.
-- ---------------------------------------------------------------------------

alter table public.import_source_rows
  drop constraint import_source_rows_resolution_ck,
  add constraint import_source_rows_resolution_ck check (
    resolution <> 'RESOLVED' or (
      candidate_security_id is not null and security_resolution = 'RESOLVED'
      and candidate_txn_type is not null
      and candidate_quantity is not null));

alter table public.import_source_rows
  add constraint import_source_rows_missing_date_disclosed check (
    resolution <> 'RESOLVED'
    or candidate_trade_date is not null
    or (data_quality_state = 'INCOMPLETE'
        and 'MISSING_DATE' = any(data_quality_issues)));

comment on constraint import_source_rows_missing_date_disclosed on public.import_source_rows is
  'A resolved row with an unknown trade date is never VALID: it stays INCOMPLETE and names MISSING_DATE. The date is never invented.';

-- ---------------------------------------------------------------------------
-- 2. Trusted commit: one additional eligible shape, nothing else relaxed.
-- ---------------------------------------------------------------------------

create or replace function public.commit_import_batch(p_batch_id uuid)
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
  v_dq_state   public.data_quality_state;
  v_dq_issues  public.data_quality_issue[];
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

  perform 1 from public.portfolios p
   where p.id = v_batch.portfolio_id and p.owner_id = v_uid;
  if not found then
    raise exception 'commit_import_batch: batch not found' using errcode = '42501';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.owner_id <> v_uid;
  if v_bad > 0 then
    raise exception 'commit_import_batch: inconsistent ownership in batch'
      using errcode = '40002';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'UNRESOLVED';
  if v_bad > 0 then
    raise exception 'commit_import_batch: % row(s) are unresolved', v_bad
      using errcode = '22023';
  end if;

  -- Eligibility, unchanged except for the one new shape:
  --   (a) VALID with zero issues, or
  --   (b) INCOMPLETE whose ONLY issue is MISSING_DATE and whose date is NULL.
  -- Any other issue, in any combination, still aborts the whole commit.
  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'RESOLVED'
     and not (
       (r.data_quality_state = 'VALID'
        and pg_catalog.cardinality(r.data_quality_issues) = 0)
       or (r.data_quality_state = 'INCOMPLETE'
           and r.candidate_trade_date is null
           and r.data_quality_issues = array['MISSING_DATE']::public.data_quality_issue[])
     );
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
       and (
         (r.data_quality_state = 'VALID'
          and pg_catalog.cardinality(r.data_quality_issues) = 0)
         or (r.data_quality_state = 'INCOMPLETE'
             and r.candidate_trade_date is null
             and r.data_quality_issues = array['MISSING_DATE']::public.data_quality_issue[])
       )
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
    -- The trade date may be unknown; it is never invented. It is committed as
    -- NULL and disclosed below. Every other economic fact stays mandatory.
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

    if v_row.candidate_trade_date is null then
      v_dq_state  := 'INCOMPLETE';
      v_dq_issues := array['MISSING_DATE']::public.data_quality_issue[];
    else
      v_dq_state  := 'VALID';
      v_dq_issues := '{}'::public.data_quality_issue[];
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
      'ACTIVE', v_dq_state, v_dq_issues,
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
  'Loads all canonical facts server-side; the browser supplies only the batch id. '
  'A row whose only defect is an unknown trade date commits with trade_date NULL, '
  'data_quality_state INCOMPLETE and data_quality_issues {MISSING_DATE}.';

-- Privileges are re-asserted (idempotent) exactly as M07 granted them.
revoke all on function public.commit_import_batch(uuid) from public;
revoke all on function public.commit_import_batch(uuid) from anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;

commit;