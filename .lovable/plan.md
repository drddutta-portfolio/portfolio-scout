# Migration 05 — `public.transactions` (proposal only, NOT applied)

Confirmations: Migration 05 has **not** been applied; no migration file was created; no remote schema change was made; Migrations 01 / 02 / 02a / 03 / 04 are untouched; no UI work; no secrets, credentials or service-role key introduced into the application.

Proposed filename: `db/migrations/0005_transactions.sql`

## 1. Design decisions (summary)

| Question | Decision |
|---|---|
| Sign convention | **Always-positive magnitude**; direction is derived from `txn_type`. |
| Price / amount | Both nullable; `unit_price` and `gross_amount` are each *source facts*, never derived or overwritten. |
| Charges | `total_charges` only. Component-level brokerage/STT/GST/stamp **deferred**. |
| Currency | Stored explicitly on the row, `char(3)` default `INR`, insert-only. |
| Ownership | Composite FKs `(owner_id, portfolio_id)` and `(owner_id, broker_account_id)` — schema-level, no SECURITY DEFINER. |
| Security | Required (`not null`). Unresolved rows belong in Migration 06 import staging. |
| Date | `trade_date date` **nullable**. No settlement date in Phase 1. |
| Lineage | Deferred to Migration 06 via `alter table`. Only `source_system` + `source_reference` now, plus a partial idempotency index. |
| Reversal links | Deferred to Migration 07. `txn_state` exists now; links added additively later. |
| Browser writes | **None.** Owner-scoped `SELECT` only. |
| `updated_at` | Kept, but only metadata columns will ever move it; economic columns are immutable by grant. |

## 2. Field-by-field schema and rationale

| Column | Type | Null | Class | Rationale |
|---|---|---|---|---|
| `id` | uuid pk default gen_random_uuid() | no | required | Stable ledger identity. |
| `owner_id` | uuid → `profiles(id)` RESTRICT | no | required | Ownership anchor for RLS. |
| `portfolio_id` | uuid | no | required | A ledger row must belong to one portfolio. |
| `broker_account_id` | uuid | yes | useful now | Historical imports often lack the account; must not be fabricated. |
| `security_id` | uuid → `securities(id)` RESTRICT | no | required | Canonical resolved instrument. Unresolved → staging. |
| `txn_type` | `public.txn_type` | no | required | Existing enum, unchanged. |
| `trade_date` | date | yes | required (nullable) | Unknown date stays NULL. Never substituted. |
| `quantity` | numeric(38,18) | yes | required (nullable) | Positive magnitude; NULL only for INCOMPLETE imports. |
| `unit_price` | numeric(38,18) | yes | required (nullable) | Absent for BONUS/SPLIT and many historical TRANSFER_IN rows. |
| `gross_amount` | numeric(38,18) | yes | useful now | Source-supplied consideration; kept as-is even if ≠ qty×price. |
| `total_charges` | numeric(38,18) | yes | useful now | Minimum viable auditability of net outflow. |
| `currency` | char(3) not null default 'INR' | no | required | Interpretability if portfolio config later changes. |
| `txn_state` | `public.txn_state` not null default 'ACTIVE' | no | required | Immutable-history model. |
| `data_quality_state` | `public.data_quality_state` not null default 'VALID' | no | required | Discloses incompleteness downstream. |
| `data_quality_issues` | `public.data_quality_issue[]` not null default '{}' | no | required | Explicit issue set, not free text. |
| `source_system` | text ≤ 40 | yes | useful now | 'MANUAL', broker name etc.; label only. |
| `source_reference` | text ≤ 128 | yes | useful now | Broker/source txn id, enables idempotency before import tables exist. |
| `notes` | text ≤ 1000 | yes | useful now | Bounded. Raw payloads belong in Migration 06. |
| `created_at` / `updated_at` | timestamptz not null default now() | no | required | DB-controlled; reuses `public.set_updated_at()` (not redeclared). |

**Deferred / premature (explicitly not added now):** `settlement_date`, `import_batch_id`, `import_source_row_id`, `reverses_transaction_id`, `supersedes_transaction_id`, per-component charges (brokerage, STT, GST, stamp, exchange, SEBI), FX rate, tax-lot columns, cost-basis or realised-P&L columns, raw source JSON, `is_deleted`.

Precision: `numeric(38,18)` for quantity, price, amount and charges. Everything else uses the simplest correct type — `date` for the trade date, `char(3)` for currency, enums for vocabularies, bounded `text` for labels. No floating point anywhere.

## 3. Sign convention

Quantity is stored as a **positive magnitude** (`quantity > 0` when present); `txn_type` alone determines direction. This prevents a BUY silently carrying a negative quantity and reversing meaning, and it is enforceable by a single CHECK.

Conceptual quantity effect (derivation logic lands with `current_holdings`, not now):

- `BUY`, `OPENING_POSITION`, `TRANSFER_IN`, `BONUS` → increase
- `SELL`, `TRANSFER_OUT` → decrease
- `SPLIT` → quantity transformation, **not** additive; treated as a ratio event and only interpretable together with the later corporate-action master. A SPLIT ledger row and a corporate-action record must never both be applied to the same economic event.
- `REVERSAL` → negates an earlier row; requires the Migration 07 link before it can be applied deterministically.
- `ADJUSTMENT` → direction is not inferable from the type; requires explicit later semantics.

Until SPLIT / REVERSAL / ADJUSTMENT semantics are formally approved, any holding derivation that encounters them for a security must report `INSUFFICIENT_DATA` / `UNRELIABLE` for that security rather than silently producing a number.

## 4. Price / amount, charges, currency

`unit_price` and `gross_amount` are both *supplied source facts*. Neither is generated from the other and neither is overwritten. If both are present and inconsistent with `quantity`, the row is not rejected: the discrepancy is a data-quality signal to be flagged (`NEEDS_REVIEW`) by the later trusted commit path, since a broker may legitimately report an all-in consideration. No accounting method (FIFO / LIFO / weighted average) is encoded, and no cost-basis or P&L column exists; those remain `INSUFFICIENT_DATA` until a methodology is separately approved.

Charges: `total_charges` only. Component-level Indian charge modelling is explicitly deferred until a concrete tax/audit requirement exists.

Currency is stored on the row (not inherited) so history stays interpretable if a portfolio's or security's configuration changes later. It is insert-only: excluded from every authenticated grant (there are none) and from all future browser update paths.

## 5. Ownership enforcement

Migration 03 already gives `portfolios` a `unique (owner_id, id)`. Migration 05 additively adds the matching `unique (owner_id, id)` on `broker_accounts` (non-destructive, no data change), then uses composite foreign keys:

```
foreign key (owner_id, portfolio_id)      references public.portfolios (owner_id, id)      on delete restrict
foreign key (owner_id, broker_account_id) references public.broker_accounts (owner_id, id) on delete restrict
```

This makes owner/portfolio/broker-account agreement a **schema invariant**, not merely an RLS or application check. No SECURITY DEFINER function is introduced. `securities` is shared canonical data and carries no ownership, so it uses a plain FK.

## 6. Full SQL (for review)

```sql
-- 0005_transactions.sql
-- PortfolioAI Migration 05 — canonical financial ledger.
--
-- Invariants:
--   * transactions are the accounting source of truth; holdings, cost basis
--     and P&L are derived later, never stored here.
--   * No browser INSERT/UPDATE/DELETE. Owner-scoped SELECT only.
--   * Unknown trade dates stay NULL. Missing is not zero.
--   * quantity is a positive magnitude; txn_type carries direction.
--   * No accounting method (FIFO/LIFO/average) is encoded anywhere.
--   * All foreign keys are ON DELETE RESTRICT.
--   * Reuses public.set_updated_at(); it is NOT redeclared.
--
-- Rollback (safe only while no later migration references this table):
-- begin;
-- drop table if exists public.transactions;
-- alter table public.broker_accounts drop constraint if exists broker_accounts_owner_id_id_key;
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
  constraint transactions_incomplete_disclosed
    check (
      (trade_date is not null and quantity is not null)
      or data_quality_state in ('INCOMPLETE','NEEDS_REVIEW')
    )
);

comment on table public.transactions is
  'Canonical financial ledger. Accounting source of truth. Browser read-only.';
comment on column public.transactions.quantity is
  'Positive magnitude only; direction is determined by txn_type.';
comment on column public.transactions.gross_amount is
  'Source-supplied consideration. Never derived from quantity x unit_price.';

create index transactions_owner_idx        on public.transactions (owner_id);
create index transactions_portfolio_idx    on public.transactions (portfolio_id);
create index transactions_security_idx     on public.transactions (security_id);
create index transactions_account_idx      on public.transactions (broker_account_id);
create index transactions_active_pos_idx   on public.transactions (portfolio_id, security_id, trade_date)
  where txn_state = 'ACTIVE';
create unique index transactions_source_idem_idx
  on public.transactions (owner_id, source_system, source_reference)
  where source_system is not null and source_reference is not null;

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

## 7. Privileges, RLS and immutability

- `anon`: no privileges, no policy — no access at all.
- `authenticated`: `SELECT` only, owner-scoped by the single policy. **No** INSERT, UPDATE or DELETE grant and no corresponding policy, so the ledger is browser read-only even if a policy were later added by mistake.
- `service_role`: full PostgreSQL grants, used by the trusted server-side commit path in Migration 06/07. No service-role credential enters the application.

Immutable-history model: corrections never edit an economic fact. A mistaken row is marked `SUPERSEDED` or offset by a `REVERSAL` row written by the trusted path; `txn_state` already exists for this. `updated_at` is retained because state and data-quality metadata legitimately change over time under trusted writes; economic columns cannot change from the browser because no UPDATE grant exists at all.

## 8. Deletion behaviour

Every FK is `ON DELETE RESTRICT`: `owner_id → profiles`, `(owner_id, portfolio_id) → portfolios`, `(owner_id, broker_account_id) → broker_accounts`, `security_id → securities`. No CASCADE, no SET NULL anywhere. Deleting an Auth user, profile, portfolio, broker account or security cannot erase ledger history; removal is archival (`archived_at`, `is_active`). There is no browser DELETE path.

## 9. Forward compatibility

- **Migration 06 (imports):** adds `import_batch_id` and `import_source_row_id` by `alter table ... add column ... references ... on delete restrict`. Nothing dangling is created now.
- **Migration 07 (corrections):** adds `reverses_transaction_id` / `supersedes_transaction_id` self-FKs with RESTRICT and a `check (id <> ...)` self-reference guard.
- **Corporate actions:** the later master table must reconcile against SPLIT/BONUS ledger rows so the same economic event is never counted twice.
- **`current_holdings`:** derivable as a deterministic aggregation over `txn_state = 'ACTIVE'` rows grouped by `(portfolio_id, security_id)`, supported by `transactions_active_pos_idx`. Any group containing an unresolved SPLIT, REVERSAL or ADJUSTMENT reports `UNRELIABLE`/`INSUFFICIENT_DATA` instead of a number. Quantity may become derivable before cost basis; cost basis and P&L stay unavailable until an accounting method is approved.

## 10. Post-deployment verification and behavioural tests

Structural queries: one new table only; no new enum or function; Migrations 01–04 objects unchanged; four FKs all `confdeltype = 'r'`; six indexes present; RLS enabled with exactly one SELECT policy; ACL shows `authenticated=r` and no `anon`; `set_updated_at()` unchanged and trigger attached; Migration 02a default-privilege hardening intact.

Behavioural tests (savepointed and rolled back, as service_role plus two impersonated users):

1. Portfolio owned by user B rejected on a transaction owned by user A (composite FK).
2. Broker account owned by user B likewise rejected.
3. `quantity = 0` and negative quantity/price/charges rejected.
4. NULL `trade_date` with `VALID` rejected; with `INCOMPLETE` accepted.
5. Lowercase currency rejected; default `INR` applied.
6. Duplicate `(owner, source_system, source_reference)` rejected; multiple NULL references accepted.
7. Authenticated user sees only own rows; INSERT / UPDATE / DELETE all denied.
8. Anonymous access denied.
9. Deleting a referenced profile, portfolio, broker account or security blocked.
10. Privileged update advances `updated_at`.

Repository: secret scan, type check, build; then `docs/migrations.md` and `roadmap.md` updated with UTC and IST timestamps.
