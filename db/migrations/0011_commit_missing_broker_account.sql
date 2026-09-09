-- 0011_commit_missing_broker_account.sql
-- PortfolioAI Migration 11 — preserve otherwise-valid historical transactions
-- whose source workbook does not state a broker/account.
--
-- PREPARED FOR REVIEW ONLY. DO NOT DEPLOY UNTIL REVIEWED.
--
-- Purpose
--   Some historical source rows contain a real BUY/SELL and quantity but no
--   source broker. Guessing a broker would fabricate an accounting fact, while
--   leaving the row outside the ledger makes current holdings incomplete.
--
-- This migration permits exactly this additional incomplete shape:
--   * canonical security resolved
--   * supported transaction type
--   * positive quantity
--   * valid currency
--   * source broker text is blank
--   * candidate_broker_account_id is NULL
--   * data quality explicitly includes MISSING_BROKER + MISSING_ACCOUNT
--   * MISSING_DATE may additionally be present when the trade date is unknown
--
-- Such a row is committed with broker_account_id = NULL and remains
-- INCOMPLETE. It contributes to quantity-based holdings because M08 does not
-- require a broker account for the arithmetic.
--
-- The migration also adds one narrowly-scoped trusted repair RPC so the owner
-- may later fill a previously unknown broker account. Raw import evidence and
-- all other economic fields remain immutable; the repair is audit-logged.
--
-- No existing migration is edited. No CASCADE. No browser INSERT/UPDATE/DELETE
-- grant is added to transactions. SPLIT / REVERSAL / ADJUSTMENT remain blocked.

begin;

-- Owner-safe FK target for the repair audit table. The PK already guarantees id
-- uniqueness; this additional key exists only so owner_id can participate in
-- composite foreign keys, matching the ownership pattern used elsewhere.
alter table public.transactions
  add constraint transactions_owner_id_id_key unique (owner_id, id);

-- ---------------------------------------------------------------------------
-- 1. Minimal immutable audit trail for trusted data-quality repairs.
-- ---------------------------------------------------------------------------

create table public.transaction_repairs (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.profiles(id) on delete restrict,
  transaction_id        uuid not null,
  repair_type           text not null check (repair_type in ('FILL_MISSING_BROKER_ACCOUNT')),
  old_broker_account_id uuid,
  new_broker_account_id uuid not null,
  old_quality_state     public.data_quality_state not null,
  old_quality_issues    public.data_quality_issue[] not null,
  new_quality_state     public.data_quality_state not null,
  new_quality_issues    public.data_quality_issue[] not null,
  created_at            timestamptz not null default now(),
  constraint transaction_repairs_owner_transaction_fk
    foreign key (owner_id, transaction_id)
    references public.transactions(owner_id, id) on delete restrict,
  constraint transaction_repairs_old_account_owner_fk
    foreign key (owner_id, old_broker_account_id)
    references public.broker_accounts(owner_id, id) on delete restrict,
  constraint transaction_repairs_new_account_owner_fk
    foreign key (owner_id, new_broker_account_id)
    references public.broker_accounts(owner_id, id) on delete restrict
);

create index transaction_repairs_transaction_idx
  on public.transaction_repairs (transaction_id, created_at);
create index transaction_repairs_owner_idx
  on public.transaction_repairs (owner_id, created_at);

alter table public.transaction_repairs enable row level security;

create policy transaction_repairs_select_own on public.transaction_repairs
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.transaction_repairs from public;
revoke all on public.transaction_repairs from anon;
revoke all on public.transaction_repairs from authenticated;
grant select on public.transaction_repairs to authenticated;
grant all on public.transaction_repairs to service_role;

comment on table public.transaction_repairs is
  'Append-only audit log of trusted data-quality repairs to canonical transactions. Browser read-only.';

-- ---------------------------------------------------------------------------
-- 2. Extend the immutable-field guard by one tightly-defined repair exception.
--    Authenticated users still have NO direct UPDATE privilege on transactions.
-- ---------------------------------------------------------------------------

create or replace function public.transactions_guard_immutable_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allowed_broker_fill boolean;
begin
  v_allowed_broker_fill :=
    old.broker_account_id is null
    and new.broker_account_id is not null
    and old.data_quality_state = 'INCOMPLETE'
    and 'MISSING_ACCOUNT' = any(old.data_quality_issues)
    and not ('MISSING_ACCOUNT' = any(new.data_quality_issues))
    and not ('MISSING_BROKER' = any(new.data_quality_issues));

  if new.owner_id is distinct from old.owner_id
  or new.portfolio_id is distinct from old.portfolio_id
  or (
       new.broker_account_id is distinct from old.broker_account_id
       and not v_allowed_broker_fill
     )
  or new.security_id is distinct from old.security_id
  or new.txn_type is distinct from old.txn_type
  or new.trade_date is distinct from old.trade_date
  or new.quantity is distinct from old.quantity
  or new.unit_price is distinct from old.unit_price
  or new.gross_amount is distinct from old.gross_amount
  or new.total_charges is distinct from old.total_charges
  or new.currency is distinct from old.currency
  or new.source_system is distinct from old.source_system
  or new.source_reference is distinct from old.source_reference
  or new.import_source_row_id is distinct from old.import_source_row_id
  or new.created_at is distinct from old.created_at
  then
    raise exception
      'transactions: economic/source/lineage fields are immutable; only a trusted fill of a previously missing broker account is permitted'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.transactions_guard_immutable_fields() from public;
revoke execute on function public.transactions_guard_immutable_fields() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trusted batch commit. M10 missing-date support remains unchanged; M11
--    adds only source-broker-blank + account-null as an accepted incomplete fact.
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

  -- Every RESOLVED row must be either fully VALID or incomplete solely for
  -- the explicitly supported unknown-date / genuinely unstated-broker facts.
  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'RESOLVED'
     and not (
       (r.data_quality_state = 'VALID'
        and cardinality(r.data_quality_issues) = 0
        and r.candidate_trade_date is not null
        and r.candidate_broker_account_id is not null)
       or
       (r.data_quality_state = 'INCOMPLETE'
        and cardinality(r.data_quality_issues) >= 1
        and r.data_quality_issues <@ array[
          'MISSING_DATE','MISSING_BROKER','MISSING_ACCOUNT'
        ]::public.data_quality_issue[]
        and (
          (r.candidate_trade_date is null
           and 'MISSING_DATE' = any(r.data_quality_issues))
          or
          (r.candidate_trade_date is not null
           and not ('MISSING_DATE' = any(r.data_quality_issues)))
        )
        and (
          (r.candidate_broker_account_id is null
           and btrim(coalesce(r.raw_broker_text, '')) = ''
           and 'MISSING_BROKER' = any(r.data_quality_issues)
           and 'MISSING_ACCOUNT' = any(r.data_quality_issues))
          or
          (r.candidate_broker_account_id is not null
           and not ('MISSING_BROKER' = any(r.data_quality_issues))
           and not ('MISSING_ACCOUNT' = any(r.data_quality_issues)))
        )
       )
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

    if v_row.candidate_broker_account_id is not null then
      perform 1 from public.broker_accounts a
       where a.id = v_row.candidate_broker_account_id
         and a.owner_id = v_uid
         and a.archived_at is null;
      if not found then
        raise exception 'commit_import_batch: row %: broker account is invalid', v_row.source_row_number
          using errcode = '22023';
      end if;
    elsif btrim(coalesce(v_row.raw_broker_text, '')) <> '' then
      raise exception 'commit_import_batch: row %: source broker is stated but no account is mapped', v_row.source_row_number
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
    if v_row.candidate_quantity is null or v_row.candidate_quantity <= 0 then
      raise exception 'commit_import_batch: row %: quantity is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_currency is null or v_row.candidate_currency !~ '^[A-Z]{3}$' then
      raise exception 'commit_import_batch: row %: valid currency is required', v_row.source_row_number
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

    v_dq_issues := '{}'::public.data_quality_issue[];
    if v_row.candidate_trade_date is null then
      v_dq_issues := array_append(v_dq_issues, 'MISSING_DATE'::public.data_quality_issue);
    end if;
    if v_row.candidate_broker_account_id is null then
      v_dq_issues := array_append(v_dq_issues, 'MISSING_BROKER'::public.data_quality_issue);
      v_dq_issues := array_append(v_dq_issues, 'MISSING_ACCOUNT'::public.data_quality_issue);
    end if;
    v_dq_state := case when cardinality(v_dq_issues) = 0
                       then 'VALID'::public.data_quality_state
                       else 'INCOMPLETE'::public.data_quality_state end;

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
         committed_at = now(),
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
revoke all on function public.commit_import_batch(uuid) from public;
revoke all on function public.commit_import_batch(uuid) from anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;

comment on function public.commit_import_batch(uuid) is
  'Trusted atomic import commit. Unknown dates and genuinely unstated source brokers may remain NULL only when explicitly disclosed as INCOMPLETE quality issues.';

-- ---------------------------------------------------------------------------
-- 4. Trusted one-time fill of a previously unknown broker account.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_transaction_broker_account(
  p_transaction_id uuid,
  p_broker_account_id uuid
)
returns table (
  transaction_id uuid,
  broker_account_id uuid,
  data_quality_state public.data_quality_state,
  data_quality_issues public.data_quality_issue[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := auth.uid();
  v_txn         public.transactions%rowtype;
  v_new_issues  public.data_quality_issue[];
  v_new_state   public.data_quality_state;
begin
  if v_uid is null then
    raise exception 'resolve_transaction_broker_account: authentication required'
      using errcode = '28000';
  end if;

  select * into v_txn
    from public.transactions t
   where t.id = p_transaction_id
     and t.owner_id = v_uid
   for update;

  if not found then
    raise exception 'resolve_transaction_broker_account: transaction not found'
      using errcode = '42501';
  end if;

  if v_txn.txn_state <> 'ACTIVE' then
    raise exception 'resolve_transaction_broker_account: only ACTIVE transactions can be repaired'
      using errcode = '22023';
  end if;
  if v_txn.broker_account_id is not null then
    raise exception 'resolve_transaction_broker_account: broker account is already known'
      using errcode = '22023';
  end if;
  if not ('MISSING_ACCOUNT' = any(v_txn.data_quality_issues))
     or not ('MISSING_BROKER' = any(v_txn.data_quality_issues)) then
    raise exception 'resolve_transaction_broker_account: transaction is not flagged as an unknown source broker/account'
      using errcode = '22023';
  end if;

  perform 1 from public.broker_accounts a
   where a.id = p_broker_account_id
     and a.owner_id = v_uid
     and a.archived_at is null;
  if not found then
    raise exception 'resolve_transaction_broker_account: broker account is invalid'
      using errcode = '22023';
  end if;

  v_new_issues := array_remove(v_txn.data_quality_issues, 'MISSING_ACCOUNT'::public.data_quality_issue);
  v_new_issues := array_remove(v_new_issues, 'MISSING_BROKER'::public.data_quality_issue);
  v_new_state := case
    when cardinality(v_new_issues) = 0
      and v_txn.trade_date is not null
      and v_txn.quantity is not null
      then 'VALID'::public.data_quality_state
    else 'INCOMPLETE'::public.data_quality_state
  end;

  update public.transactions
     set broker_account_id = p_broker_account_id,
         data_quality_state = v_new_state,
         data_quality_issues = v_new_issues
   where id = v_txn.id;

  insert into public.transaction_repairs (
    owner_id, transaction_id, repair_type,
    old_broker_account_id, new_broker_account_id,
    old_quality_state, old_quality_issues,
    new_quality_state, new_quality_issues)
  values (
    v_uid, v_txn.id, 'FILL_MISSING_BROKER_ACCOUNT',
    v_txn.broker_account_id, p_broker_account_id,
    v_txn.data_quality_state, v_txn.data_quality_issues,
    v_new_state, v_new_issues);

  return query
    select v_txn.id, p_broker_account_id, v_new_state, v_new_issues;
end;
$$;

alter function public.resolve_transaction_broker_account(uuid, uuid) owner to postgres;
revoke all on function public.resolve_transaction_broker_account(uuid, uuid) from public;
revoke all on function public.resolve_transaction_broker_account(uuid, uuid) from anon;
grant execute on function public.resolve_transaction_broker_account(uuid, uuid) to authenticated;

comment on function public.resolve_transaction_broker_account(uuid, uuid) is
  'Owner-scoped trusted repair: fills only a previously NULL broker_account_id on an ACTIVE transaction flagged MISSING_BROKER + MISSING_ACCOUNT, removes those two issues, and writes an audit row.';

commit;

-- Verification before enabling the frontend M11 flag:
--   * source-broker blank + account NULL + otherwise complete commits INCOMPLETE
--     with MISSING_BROKER + MISSING_ACCOUNT (plus MISSING_DATE when applicable)
--   * source-broker stated + account NULL remains blocked
--   * missing account plus any unrelated issue remains blocked
--   * dated/known-account and M10 date-null/known-account behavior is unchanged
--   * SPLIT / REVERSAL / ADJUSTMENT remain blocked
--   * current_holdings includes quantity from broker-unknown ACTIVE transactions
--   * browser still cannot INSERT/UPDATE/DELETE public.transactions directly
--   * resolve_transaction_broker_account accepts only owner-owned ACTIVE rows
--     whose broker/account was previously NULL and flagged missing
--   * a second repair or attempt to change a known broker is rejected
--   * transaction_repairs receives one immutable audit row per successful repair
--
-- Rollback guidance
--   Recreate public.commit_import_batch from 0010 and recreate
--   public.transactions_guard_immutable_fields from 0006 before dropping the
--   repair RPC/table. Do not roll back while application code depends on M11.
--   Never use CASCADE.
