-- 0005_transactions.sql
-- PortfolioAI Migration 05 — canonical financial ledger.
--
-- Invariants:
--   * transactions are the accounting source of truth; holdings, cost basis
--     and P&L are derived later, never stored here.
--   * No browser INSERT/UPDATE/DELETE. Owner-scoped SELECT only.
--   * Economic fields are immutable after insert (enforced by trigger).
--   * Unknown trade dates stay NULL. Missing is not zero.
--   * quantity is a positive magnitude; txn_type carries direction.
--   * No accounting method (FIFO/LIFO/average) is encoded anywhere.
--   * No source-reference uniqueness: idempotency belongs with import lineage.
--   * All foreign keys are ON DELETE RESTRICT.
--   * Reuses public.set_updated_at(); it is NOT redeclared.
--   * The application never uses a service-role credential; the service_role
--     GRANT is Supabase/admin compatibility only.
--
-- Rollback (safe only while no later migration references this table):
-- begin;
-- drop table if exists public.transactions;
-- drop function if exists public.transactions_guard_immutable_fields();
-- alter table public.broker_accounts
--   drop constraint if exists broker_accounts_owner_id_id_key;
-- commit;

begin;

alter table public.broker_accounts
  add constraint broker_accounts_owner_id_id_key unique (owner_id, id);

create table public.transactions (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.profiles(id) on delete restrict,
  portfolio_id         uuid not null,
  broker_account_id    uuid,
  security_id          uuid not null references public.securities(id) on delete restrict,
  txn_type             public.txn_type not null,
  trade_date           date,
  quantity             numeric(38,18),
  unit_price           numeric(38,18),
  gross_amount         numeric(38,18),
  total_charges        numeric(38,18),
  currency             char(3) not null default 'INR',
  txn_state            public.txn_state not null default 'ACTIVE',
  data_quality_state   public.data_quality_state not null default 'VALID',
  data_quality_issues  public.data_quality_issue[] not null default '{}',
  source_system        text,
  source_reference     text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint transactions_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios (owner_id, id) on delete restrict,
  constraint transactions_broker_account_owner_fk
    foreign key (owner_id, broker_account_id)
    references public.broker_accounts (owner_id, id) on delete restrict,

  constraint transactions_quantity_positive
    check (quantity is null or quantity > 0),
  constraint transactions_unit_price_nonneg
    check (unit_price is null or unit_price >= 0),
  constraint transactions_gross_amount_nonneg
    check (gross_amount is null or gross_amount >= 0),
  constraint transactions_total_charges_nonneg
    check (total_charges is null or total_charges >= 0),
  constraint transactions_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint transactions_source_system_len
    check (source_system is null or char_length(source_system) between 1 and 40),
  constraint transactions_source_reference_len
    check (source_reference is null or char_length(source_reference) between 1 and 128),
  constraint transactions_notes_len
    check (notes is null or char_length(notes) <= 1000),

  -- Data-quality consistency (A-E).
  constraint transactions_valid_has_no_issues
    check (data_quality_state <> 'VALID' or cardinality(data_quality_issues) = 0),
  constraint transactions_flagged_has_issue
    check (data_quality_state = 'VALID' or cardinality(data_quality_issues) >= 1),
  constraint transactions_valid_requires_facts
    check (
      data_quality_state <> 'VALID'
      or (trade_date is not null
          and quantity is not null
          and broker_account_id is not null)
    ),

  -- A missing broker ACCOUNT relationship must be disclosed as MISSING_ACCOUNT.
  -- MISSING_BROKER does not satisfy this: it is reserved for an unknown source
  -- institution during import/staging.
  constraint transactions_missing_account_disclosed
    check (broker_account_id is not null or 'MISSING_ACCOUNT' = any(data_quality_issues)),

  -- Temporary Phase-1 rule: types without deterministic semantics may not be
  -- presented as valid canonical facts. To be relaxed by a later reviewed
  -- migration once split-ratio / reversal-linkage / adjustment semantics exist.
  constraint transactions_uninterpretable_needs_review
    check (
      txn_type not in ('SPLIT','REVERSAL','ADJUSTMENT')
      or data_quality_state = 'NEEDS_REVIEW'
    )
);

comment on table public.transactions is
  'Canonical financial ledger. Accounting source of truth. Browser read-only; economic fields immutable after insert.';
comment on column public.transactions.quantity is
  'Positive magnitude only; direction is determined by txn_type.';
comment on column public.transactions.gross_amount is
  'Source-supplied consideration. Never derived from quantity x unit_price.';
comment on column public.transactions.source_reference is
  'Provenance only. NOT an idempotency key; scoped deduplication arrives with import lineage.';

-- Economic immutability guard. Not SECURITY DEFINER; empty search_path.
create function public.transactions_guard_immutable_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_id          is distinct from old.owner_id
  or new.portfolio_id      is distinct from old.portfolio_id
  or new.broker_account_id is distinct from old.broker_account_id
  or new.security_id       is distinct from old.security_id
  or new.txn_type          is distinct from old.txn_type
  or new.trade_date        is distinct from old.trade_date
  or new.quantity          is distinct from old.quantity
  or new.unit_price        is distinct from old.unit_price
  or new.gross_amount      is distinct from old.gross_amount
  or new.total_charges     is distinct from old.total_charges
  or new.currency          is distinct from old.currency
  or new.source_system     is distinct from old.source_system
  or new.source_reference  is distinct from old.source_reference
  or new.created_at        is distinct from old.created_at
  then
    raise exception
      'transactions: economic/source fields are immutable; correct via a reversal or superseding ledger row'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.transactions_guard_immutable_fields() from public;
revoke execute on function public.transactions_guard_immutable_fields() from anon, authenticated;

create index transactions_owner_idx      on public.transactions (owner_id);
create index transactions_portfolio_idx  on public.transactions (portfolio_id);
create index transactions_security_idx   on public.transactions (security_id);
create index transactions_account_idx    on public.transactions (broker_account_id);
create index transactions_active_pos_idx on public.transactions (portfolio_id, security_id, trade_date)
  where txn_state = 'ACTIVE';

-- Name order matters: the guard ('p') fires before set_updated_at ('s').
create trigger transactions_protect_economic_fields before update on public.transactions
  for each row execute function public.transactions_guard_immutable_fields();
create trigger transactions_set_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- Explicit grants only (Migration 02a model).
grant select on public.transactions to authenticated;
grant all    on public.transactions to service_role;

alter table public.transactions enable row level security;

create policy transactions_select_own on public.transactions
  for select to authenticated using (owner_id = auth.uid());

commit;
