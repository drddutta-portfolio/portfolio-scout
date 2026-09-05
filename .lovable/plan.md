# Migration 01 — Shared Enum Vocabulary (revised proposal)

Status: NOT applied. No remote schema change made. No secrets or service-role key added.

Proposed file: `db/migrations/0001_enums.sql`

## Amendment decisions

1. **MULTIPLE_ISSUES removed** — `data_quality_issue` will be stored as an array/set per row; individual issues are recorded explicitly. No combined pseudo-value.
2. **`data_quality_state` narrowed to source/import data only** — values reduced to VALID / INCOMPLETE / NEEDS_REVIEW. Analytical-result availability (AVAILABLE, INSUFFICIENT_DATA, UNRELIABLE, NOT_APPLICABLE) is a separate concept and will get its own status vocabulary in the engine/derived-results migration (09), not here. Rule: source-data quality and analytical-result availability are never mixed in one enum.
3. **Corporate-action no-double-counting invariant documented** — see dedicated section below. No corporate-action engine is built in Migration 01.

Retained (review found no concrete problems): `asset_class`, `portfolio_role`, `txn_type`, `txn_state`, `data_quality_issue`, `import_batch_state`, `corp_action_type`, `credit_action`, `coverage_state`, `credit_outlook`, `rating_watch`.

Still deferred until their implementation migrations: `engine_kind`, `sizing_action`, and the new result-status enum.

## Enum list and values

```
asset_class        : EQUITY, ETF, MUTUAL_FUND, BOND, REIT, INVIT, COMMODITY, CASH, OTHER, UNKNOWN
portfolio_role     : CORE, SATELLITE, THEMATIC, WATCHLIST, UNASSIGNED
txn_type           : BUY, SELL, OPENING_POSITION, TRANSFER_IN, TRANSFER_OUT,
                     BONUS, SPLIT, REVERSAL, ADJUSTMENT
txn_state          : ACTIVE, SUPERSEDED, REVERSED
data_quality_state : VALID, INCOMPLETE, NEEDS_REVIEW
data_quality_issue : MISSING_DATE, MISSING_BROKER, MISSING_ACCOUNT, MISSING_QUANTITY,
                     MISSING_PRICE, UNRESOLVED_SECURITY, AMBIGUOUS_SECURITY,
                     DUPLICATE_SUSPECTED, UNSUPPORTED_CORPORATE_ACTION,
                     NEGATIVE_DERIVED_QUANTITY, OTHER
import_batch_state : UPLOADED, PREVIEWED, VALIDATED, AWAITING_CONFIRMATION,
                     COMMITTING, COMMITTED, REJECTED, FAILED
corp_action_type   : SPLIT, BONUS, RIGHTS, MERGER, DEMERGER, SPIN_OFF, BUYBACK,
                     SYMBOL_CHANGE, ISIN_CHANGE, OTHER
credit_action      : ASSIGNED, UPGRADE, DOWNGRADE, AFFIRMED, OUTLOOK_CHANGE,
                     WATCH_PLACED, WATCH_REMOVED, WITHDRAWN, SUSPENDED, REINSTATED
coverage_state     : COVERED, NOT_RATED, NOT_COVERED, WITHDRAWN, UNKNOWN
credit_outlook     : POSITIVE, STABLE, NEGATIVE, DEVELOPING, NOT_APPLICABLE, UNKNOWN
rating_watch       : NONE, POSITIVE, NEGATIVE, DEVELOPING, UNKNOWN
```

Neutrality note: `NOT_RATED`, `NOT_COVERED`, `UNKNOWN`, `NOT_APPLICABLE` are coverage/absence markers only. No engine may map them to a penalty; enforced in engine code and tests.

## Corporate-action no-double-counting invariant

Architecture rule, binding on all future migrations:

- Transactions are the sole accounting/holding source of truth.
- Corporate-action records are event/provenance information only.
- If a corporate action has a quantity/accounting effect, that effect must be represented through an explicit, auditable ledger transaction (or a clearly linked ledger mechanism), never independently by the holdings derivation.
- `current_holdings` must never apply both a corporate-action event and its corresponding ledger transaction for the same economic event.
- Unsupported or ambiguous corporate actions must surface as explicit review states (`UNSUPPORTED_CORPORATE_ACTION` issue / NEEDS_REVIEW) rather than silently adjusted quantities.

## Proposed SQL — 0001_enums.sql

```sql
-- 0001_enums.sql
-- PortfolioAI Migration 01 — shared enum vocabulary.
-- Creates types only. No tables, no data, no RLS surface.
-- Rollback: see footer.

begin;

create type public.asset_class as enum (
  'EQUITY','ETF','MUTUAL_FUND','BOND','REIT','INVIT','COMMODITY','CASH','OTHER','UNKNOWN');

create type public.portfolio_role as enum (
  'CORE','SATELLITE','THEMATIC','WATCHLIST','UNASSIGNED');

create type public.txn_type as enum (
  'BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT',
  'BONUS','SPLIT','REVERSAL','ADJUSTMENT');

create type public.txn_state as enum ('ACTIVE','SUPERSEDED','REVERSED');

-- Source/import data quality only. Analytical-result availability
-- (AVAILABLE/INSUFFICIENT_DATA/UNRELIABLE/NOT_APPLICABLE) is a separate
-- vocabulary owned by the engine migration.
create type public.data_quality_state as enum ('VALID','INCOMPLETE','NEEDS_REVIEW');

-- Stored as a set/array per row; individual issues are recorded explicitly.
create type public.data_quality_issue as enum (
  'MISSING_DATE','MISSING_BROKER','MISSING_ACCOUNT','MISSING_QUANTITY','MISSING_PRICE',
  'UNRESOLVED_SECURITY','AMBIGUOUS_SECURITY','DUPLICATE_SUSPECTED',
  'UNSUPPORTED_CORPORATE_ACTION','NEGATIVE_DERIVED_QUANTITY','OTHER');

create type public.import_batch_state as enum (
  'UPLOADED','PREVIEWED','VALIDATED','AWAITING_CONFIRMATION',
  'COMMITTING','COMMITTED','REJECTED','FAILED');

create type public.corp_action_type as enum (
  'SPLIT','BONUS','RIGHTS','MERGER','DEMERGER','SPIN_OFF','BUYBACK',
  'SYMBOL_CHANGE','ISIN_CHANGE','OTHER');

create type public.credit_action as enum (
  'ASSIGNED','UPGRADE','DOWNGRADE','AFFIRMED','OUTLOOK_CHANGE',
  'WATCH_PLACED','WATCH_REMOVED','WITHDRAWN','SUSPENDED','REINSTATED');

create type public.coverage_state as enum (
  'COVERED','NOT_RATED','NOT_COVERED','WITHDRAWN','UNKNOWN');

create type public.credit_outlook as enum (
  'POSITIVE','STABLE','NEGATIVE','DEVELOPING','NOT_APPLICABLE','UNKNOWN');

create type public.rating_watch as enum (
  'NONE','POSITIVE','NEGATIVE','DEVELOPING','UNKNOWN');

commit;
```

## Rollback

```sql
begin;
drop type if exists public.rating_watch;
drop type if exists public.credit_outlook;
drop type if exists public.coverage_state;
drop type if exists public.credit_action;
drop type if exists public.corp_action_type;
drop type if exists public.import_batch_state;
drop type if exists public.data_quality_issue;
drop type if exists public.data_quality_state;
drop type if exists public.txn_state;
drop type if exists public.txn_type;
drop type if exists public.portfolio_role;
drop type if exists public.asset_class;
commit;
```

Safe while no table uses these types. After migration 02+, a plain `drop type` fails on dependency — revert dependent migrations first. Never `drop ... cascade`.

## Security / RLS implications

- Types carry no rows, no RLS surface, no grants. `usage` on public-schema types is available to all roles by default; it exposes only value names.
- No functions, no `security definer`, no service-role usage, no secrets.

## Forward compatibility

- `alter type ... add value` allows cheap extension (append or `before`/`after`); renaming/removing values is effectively impossible — hence trimming to minimal vocabularies now.
- `alter type ... add value` must run outside a transaction block in future migrations.
- Neutral/unknown members exist wherever absence is meaningful, so ingestion never guesses.

## Post-deployment checks

1. `pg_type` query returns exactly the 12 enum types in `public`.
2. `pg_enum` values match the lists above per type, in declared order.
3. `pg_tables` in `public` still returns no rows — Migration 01 creates no tables.
4. No functions or policies created.
5. Record file, date, objects, rollback note in `docs/migrations.md`.
6. Type check + build pass.

## Confirmations

- Migration 01 has NOT been applied.
- No remote Supabase schema change has been made.
- No API key or secret added to source code.
- No service-role key introduced.
- Corporate-action no-double-counting invariant documented above; no engine built.

Awaiting approval before applying anything to Supabase.
