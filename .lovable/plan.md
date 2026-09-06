# Migration 05 — `public.transactions` (revised proposal, NOT applied)

Confirmations: Migration 05 remains **not applied**; no migration file has been created; no remote schema change was made; Migrations 01 / 02 / 02a / 03 / 04 are untouched; no UI work; no secret or service-role credential was added to the application.

Proposed filename: `db/migrations/0005_transactions.sql`

## 1. Revised design summary

| Question | Decision |
|---|---|
| Sign convention | Positive magnitude only; direction comes from `txn_type`. |
| Price / amount | `unit_price` and `gross_amount` are independent supplied source facts, never derived or overwritten. |
| Charges | `total_charges` only; component charges deferred. |
| Currency | Explicit `char(3)` on the row, default `INR`, immutable after insert. |
| Ownership | Composite FKs `(owner_id, portfolio_id)` and `(owner_id, broker_account_id)`. |
| Security | Required; unresolved instruments stay in Migration 06 import staging. |
| Date | `trade_date date`, nullable. No settlement date in Phase 1. |
| Source reference | `source_system` / `source_reference` kept as nullable source facts. **No uniqueness / idempotency index** (changed). |
| Economic immutability | Enforced in the database by a BEFORE UPDATE trigger, not only by grants (new). |
| SPLIT / REVERSAL / ADJUSTMENT | Cannot be `VALID` in Phase 1; must be `NEEDS_REVIEW` (new). |
| Data quality | Minimal contradiction constraints A–E (new). |
| Browser writes | None. Owner-scoped `SELECT` only. |
| Lineage / reversal links | Deferred to Migration 06 / 07 by `alter table`. |

## 2. Field-by-field schema and rationale

| Column | Type | Null | Class | Rationale |
|---|---|---|---|---|
| `id` | uuid pk default gen_random_uuid() | no | required | Stable ledger identity. |
| `owner_id` | uuid → `profiles(id)` RESTRICT | no | required | Ownership anchor for RLS. |
| `portfolio_id` | uuid | no | required | Each ledger row belongs to one portfolio. |
| `broker_account_id` | uuid | yes | useful now | Historical imports may lack it; never fabricated, but such a row cannot be VALID. |
| `security_id` | uuid → `securities(id)` RESTRICT | no | required | Canonical resolved instrument. |
| `txn_type` | `public.txn_type` | no | required | Existing enum, unchanged. |
| `trade_date` | date | yes | required (nullable) | Unknown stays NULL, never substituted. |
| `quantity` | numeric(38,18) | yes | required (nullable) | Positive magnitude; NULL only on disclosed-incomplete rows. |
| `unit_price` | numeric(38,18) | yes | required (nullable) | Absent for BONUS/SPLIT and many historical transfers. |
| `gross_amount` | numeric(38,18) | yes | useful now | Source consideration, kept as supplied. |
| `total_charges` | numeric(38,18) | yes | useful now | Minimum viable auditability. |
| `currency` | char(3) not null default 'INR' | no | required | History stays interpretable if configuration changes. |
| `txn_state` | `public.txn_state` default 'ACTIVE' | no | required | Immutable-history model. |
| `data_quality_state` | `public.data_quality_state` default 'VALID' | no | required | Discloses insufficiency downstream. |
| `data_quality_issues` | `public.data_quality_issue[]` default '{}' | no | required | Explicit issue set. |
| `source_system` | text ≤ 40 | yes | useful now | Provenance label only — not an idempotency key. |
| `source_reference` | text ≤ 128 | yes | useful now | Provider reference; scope-correct uniqueness comes with import lineage. |
| `notes` | text ≤ 1000 | yes | useful now | Bounded; raw payloads belong in Migration 06. |
| `created_at` / `updated_at` | timestamptz not null default now() | no | required | DB-controlled; reuses `public.set_updated_at()`. |

Deferred: `settlement_date`, `import_batch_id`, `import_source_row_id`, `reverses_transaction_id`, `supersedes_transaction_id`, component charges (brokerage/STT/GST/stamp/exchange/SEBI), FX rate, tax-lot, cost-basis and P&L columns, raw source JSON, `is_deleted`.

Precision: `numeric(38,18)` for quantity, price, amount and charges; `date` for the trade date; `char(3)` for currency; enums for vocabularies; bounded `text` for labels. No floating point.

## 3. Source reference / idempotency (revised)

`transactions_source_idem_idx` is **removed**. A provider reference is typically unique only within a broker account, statement or import batch, so `(owner_id, source_system, source_reference)` is too broad and would reject legitimate rows. `source_system` and `source_reference` remain nullable provenance facts with no uniqueness guarantee. Correctly scoped deduplication/idempotency is designed with Migration 06/07 import lineage and the trusted commit path.

## 4. Economic immutability (new)

Grants alone are not enough. A narrow BEFORE UPDATE trigger rejects any change to canonical economic/source-identity columns: `owner_id`, `portfolio_id`, `broker_account_id`, `security_id`, `txn_type`, `trade_date`, `quantity`, `unit_price`, `gross_amount`, `total_charges`, `currency`, `source_system`, `source_reference`, `created_at`.

Mutable metadata (for future trusted workflows only): `txn_state`, `data_quality_state`, `data_quality_issues`, `notes`, and `updated_at` via the existing timestamp trigger.

Trigger ordering: PostgreSQL fires same-timing row triggers in name order, so `transactions_protect_economic_fields` runs before `transactions_set_updated_at`. The guard therefore rejects a disallowed change before the timestamp is touched, and a permitted metadata update proceeds and gets a fresh `updated_at`. The guard deliberately ignores `updated_at` itself so the later trigger can set it.

The function is not SECURITY DEFINER, uses `search_path = ''`, references only `OLD`/`NEW`, and has `EXECUTE` revoked from `PUBLIC`, `anon` and `authenticated` — trigger firing does not require caller `EXECUTE`, matching the Migration 02a/04 model.

A wrong economic fact is corrected only by a new reversal/superseding ledger row, never by editing the original.

## 5. Data-quality constraints (new)

- A. `VALID` ⇒ `data_quality_issues` is empty.
- B. `INCOMPLETE` / `NEEDS_REVIEW` ⇒ at least one issue.
- C. NULL `trade_date` ⇒ not `VALID`.
- D. NULL `quantity` ⇒ not `VALID`.
- E. NULL `broker_account_id` ⇒ not `VALID` (NULL preserved, deficiency disclosed via `MISSING_BROKER` / `MISSING_ACCOUNT`).

No issue-to-column mapping is encoded; the trusted validator does detailed validation. **Array deduplication is deferred**: enforcing set semantics on `data_quality_issue[]` in SQL requires either a normalising trigger or an expensive check, and duplicates are harmless to interpretation. The trusted commit validator will normalise the array; documented as a deliberate deferral.

## 6. SPLIT / REVERSAL / ADJUSTMENT (new)

These have no deterministic Phase-1 semantics, so they must not appear as fully valid canonical facts: `txn_type in ('SPLIT','REVERSAL','ADJUSTMENT')` requires `data_quality_state = 'NEEDS_REVIEW'` (and therefore, via rule B, at least one issue — typically `UNSUPPORTED_CORPORATE_ACTION`). `BONUS` remains interpretable as a positive quantity increase.

This constraint is explicitly temporary and is expected to be relaxed by a later reviewed migration once split-ratio/corporate-action semantics, reversal linkage and adjustment direction/reason semantics exist. None of those semantics are invented here.

Conceptual quantity effect: `BUY`, `OPENING_POSITION`, `TRANSFER_IN`, `BONUS` increase; `SELL`, `TRANSFER_OUT` decrease; `SPLIT` is a ratio transformation, not additive, and must never be double-counted against the later corporate-action master; `REVERSAL` negates an earlier row and needs the Migration 07 link; `ADJUSTMENT` direction is not inferable.

## 7. Trusted-write architecture (corrected wording)

The application never stores or uses a service-role secret. The intended path is: authenticated user JWT → narrow hardened trusted RPC/server operation → auth and ownership validation → server-side revalidation → atomic ledger commit. A PostgreSQL `GRANT` to the `service_role` database role remains for Supabase/admin compatibility only; the exact hardened RPC architecture is decided in Migration 06/07.

## 8. Ownership enforcement

Migration 03 already provides `portfolios (owner_id, id)` unique. Migration 05 additively adds the matching unique constraint on `broker_accounts`, then uses composite FKs so owner/portfolio/account agreement is a schema invariant rather than an application check. No SECURITY DEFINER function is introduced for this. `securities` is shared canonical data and uses a plain FK.

## 9. Exact revised SQL

```sql
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
```

## 10. Privileges, RLS and immutability model

- `anon`: no privileges, no policy.
- `authenticated`: owner-scoped `SELECT` only; no INSERT/UPDATE/DELETE grant and no such policy.
- `service_role`: full table grants for admin/compatibility; the application holds no service-role secret.
- `public.transactions_guard_immutable_fields()`: `EXECUTE` revoked from `PUBLIC`, `anon`, `authenticated`; not SECURITY DEFINER; `search_path = ''`. Trigger firing is unaffected by these revokes.
- `public.set_updated_at()` is reused unchanged and not redeclared.

Corrections never edit an economic fact: a mistaken row is marked `SUPERSEDED` or offset by a `REVERSAL` row written by the trusted path. `updated_at` is retained because state, data-quality and notes legitimately change under trusted metadata updates.

## 11. Deletion behaviour

All four FKs are `ON DELETE RESTRICT`: `owner_id → profiles`, `(owner_id, portfolio_id) → portfolios`, `(owner_id, broker_account_id) → broker_accounts`, `security_id → securities`. No CASCADE, no SET NULL. Deleting an Auth user, profile, portfolio, broker account or security cannot erase ledger history; removal is archival. No browser DELETE path.

## 12. Forward compatibility

- **Migration 06 (imports):** adds `import_batch_id` / `import_source_row_id` via `alter table ... add column ... references ... on delete restrict`, plus correctly scoped idempotency keys. The immutability guard is extended in the same reviewed migration to cover new lineage columns.
- **Migration 07 (corrections):** adds `reverses_transaction_id` / `supersedes_transaction_id` self-FKs with RESTRICT and a self-reference guard.
- **Corporate actions:** the later master must reconcile with SPLIT/BONUS ledger rows so no economic event is counted twice.
- **`current_holdings`:** a deterministic aggregation over `txn_state = 'ACTIVE'` rows grouped by `(portfolio_id, security_id)`, supported by `transactions_active_pos_idx`. Any group containing an unresolved SPLIT, REVERSAL or ADJUSTMENT — all of which are forced to `NEEDS_REVIEW` here — reports `UNRELIABLE` / `INSUFFICIENT_DATA` rather than a number. Cost basis and P&L stay unavailable until an accounting method is separately approved.

## 13. Post-deployment verification

Structural: exactly one new table and one new function; no new enum; Migrations 01–04 objects unchanged; four FKs all `confdeltype = 'r'`; **five** indexes (no `transactions_source_idem_idx`); both BEFORE UPDATE triggers present in the expected name order; RLS enabled with exactly one SELECT policy; ACL shows `authenticated=r`, no `anon`; guard function shows `prosecdef = false`, `proconfig = {search_path=""}` and no anon/authenticated EXECUTE; `set_updated_at()` unchanged; Migration 02a default-privilege hardening intact.

## 14. Behavioural tests (savepointed and rolled back)

1. Cross-owner portfolio and cross-owner broker account both rejected by composite FK.
2. `quantity = 0`, negative quantity/price/charges, lowercase currency all rejected; `INR` default applied.
3. `VALID` with a non-empty issue array rejected; `INCOMPLETE`/`NEEDS_REVIEW` with an empty array rejected.
4. `VALID` with NULL `trade_date`, NULL `quantity`, or NULL `broker_account_id` each rejected; the same rows accepted as `INCOMPLETE` with an issue.
5. SPLIT / REVERSAL / ADJUSTMENT rejected unless `NEEDS_REVIEW`; BONUS accepted normally.
6. Repeated `(owner_id, source_system, source_reference)` values **accepted** (no idempotency index).
7. Privileged (service_role) updates to `quantity`, `unit_price`, `gross_amount`, `total_charges`, `security_id`, `portfolio_id`, `broker_account_id`, `owner_id`, `txn_type`, `trade_date`, `currency`, `source_system`, `source_reference` and `created_at` each rejected by the guard.
8. Privileged metadata-only update (`txn_state`, `data_quality_state`, `data_quality_issues`, `notes`) succeeds and advances `updated_at`.
9. Authenticated user sees only own rows; INSERT/UPDATE/DELETE denied; anonymous access denied.
10. Deleting a referenced profile, portfolio, broker account or security blocked.

Repository afterwards: secret scan, type check, build; then `docs/migrations.md` and `roadmap.md` updated with UTC and IST timestamps.
