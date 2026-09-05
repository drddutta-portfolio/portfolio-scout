# Migration 01 — Shared Enum Vocabulary (proposal only)

Status: NOT applied. No remote schema change made. No secrets or service-role key added.

Proposed file: `db/migrations/0001_enums.sql`

## Review of the proposed enum list

Kept, with reasons:

| Enum | Required because |
|------|------------------|
| `asset_class` | Asset class is explicit and separate from role (Blueprint principle 4). |
| `portfolio_role` | Core / Satellite / Thematic / Watchlist are distinct roles. |
| `txn_type` | Transaction vocabulary — accounting source of truth. |
| `txn_state` | ACTIVE / SUPERSEDED / REVERSED accounting states. |
| `data_quality_state` | Disclose incomplete imports honestly; missing is never zero. |
| `import_batch_state` | Approved batch lifecycle. |
| `corp_action_type` | Conservative corporate-action modelling with explicit unsupported states. |
| `credit_action` | Append-only credit rating actions. |
| `coverage_state` | Neutral NOT_RATED / NOT_COVERED. |

Recommended changes to the earlier list:

- **Remove `engine_kind` from Migration 01.** Engine definitions arrive in migration 09. A text/enum choice there is better made alongside the engine tables, and an enum created three migrations early risks locking naming prematurely. No Phase-1 object before 09 references it.
- **Remove `sizing_action` from Migration 01.** Position Sizing issues no ADD/REDUCE/TRIM in Phase 1 (all outputs are `INSUFFICIENT_DATA` until market value exists). Creating the action vocabulary now would be a premature commitment; it belongs with the sizing tables.
- **Add `credit_outlook` and `rating_watch`.** The approved Credit Intelligence model explicitly requires outlook and rating-watch fields; they are constrained vocabularies used by migration 10 and belong in the shared vocabulary migration.
- **Split data quality.** Keep `data_quality_state` as the overall verdict, and add `data_quality_issue` for the specific reason(s) — a single enum cannot express "date missing AND broker missing" without inventing combined values. Rows carry one state plus an array of issues.
- **`txn_type` unchanged.** Exactly the nine approved concepts; no extra accounting semantics added.

## Enum values

```
asset_class        : EQUITY, ETF, MUTUAL_FUND, BOND, REIT, INVIT, COMMODITY, CASH, OTHER, UNKNOWN
portfolio_role     : CORE, SATELLITE, THEMATIC, WATCHLIST, UNASSIGNED
txn_type           : BUY, SELL, OPENING_POSITION, TRANSFER_IN, TRANSFER_OUT,
                     BONUS, SPLIT, REVERSAL, ADJUSTMENT
txn_state          : ACTIVE, SUPERSEDED, REVERSED
data_quality_state : VALID, INCOMPLETE, NEEDS_REVIEW, UNRELIABLE, INSUFFICIENT_DATA
data_quality_issue : MISSING_DATE, MISSING_BROKER, MISSING_ACCOUNT, MISSING_QUANTITY,
                     MISSING_PRICE, UNRESOLVED_SECURITY, AMBIGUOUS_SECURITY,
                     DUPLICATE_SUSPECTED, UNSUPPORTED_CORPORATE_ACTION,
                     NEGATIVE_DERIVED_QUANTITY, MULTIPLE_ISSUES, OTHER
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

Notes on neutrality: `NOT_RATED`, `NOT_COVERED`, `UNKNOWN`, `NOT_APPLICABLE` are coverage/absence markers only. No engine may map them to a penalty; that rule is enforced in engine code and tests, not in the type.

## Proposed SQL

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

create type public.data_quality_state as enum (
  'VALID','INCOMPLETE','NEEDS_REVIEW','UNRELIABLE','INSUFFICIENT_DATA');

create type public.data_quality_issue as enum (
  'MISSING_DATE','MISSING_BROKER','MISSING_ACCOUNT','MISSING_QUANTITY','MISSING_PRICE',
  'UNRESOLVED_SECURITY','AMBIGUOUS_SECURITY','DUPLICATE_SUSPECTED',
  'UNSUPPORTED_CORPORATE_ACTION','NEGATIVE_DERIVED_QUANTITY','MULTIPLE_ISSUES','OTHER');

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

Safe while no table uses these types. Once migration 02+ is applied, a plain `drop type` fails on dependency — rollback then means reverting the dependent migration first. Never `drop ... cascade`.

## Security / RLS implications

- Types carry no rows, no RLS surface, no grants. `usage` on types in `public` is available to all roles by default; that exposes only value names, no data.
- No functions, no `security definer`, no service-role usage.
- No secrets touched.

## Forward compatibility

- Postgres allows `alter type ... add value` (append, and `before`/`after` a value), so extension is cheap. Renaming/removing values is not — hence the deliberate trimming of `engine_kind` and `sizing_action`.
- `alter type ... add value` cannot run inside a transaction block in older PG; future migrations that add values will run those statements outside the `begin/commit` wrapper.
- Every enum includes an explicit unknown/neutral member where absence is meaningful, so ingestion never has to guess or fall back to a semantically loaded value.

## Post-deployment checks

1. `select typname from pg_type where typnamespace='public'::regnamespace and typtype='e' order by 1;` returns exactly the 12 types.
2. `select enumlabel from pg_enum ... order by enumsortorder` matches the lists above per type, in order.
3. `select tablename from pg_tables where schemaname='public';` still returns no rows — Migration 01 creates no tables.
4. Confirm no functions or policies were created.
5. Record file, date, objects, rollback note in `docs/migrations.md`.
6. Type check + build still pass.

## Confirmations

- Migration 01 has NOT been applied.
- No remote Supabase schema change has been made.
- No API key or secret added to source code.
- No service-role key introduced.
