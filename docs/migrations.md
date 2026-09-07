# PortfolioAI — Migration Register

Every database migration for PortfolioAI is recorded here **after** it has been
applied and verified against the live dedicated Supabase project.

Rules (from the Database Architecture and Development Rules documents):

1. Inspect the live schema before proposing a change.
2. Propose the bounded migration and get approval.
3. Apply it as a single sequential file in `db/migrations/`.
4. Verify the remote schema, grants, RLS state and policy list.
5. Record the result in the table below, including a rollback note.
6. A migration is never considered applied because it appears in a document.

## Applied migrations

| File | Date applied | Objects | RLS / grants impact | Verified | Rollback note |
|------|--------------|---------|---------------------|----------|---------------|
| `db/migrations/0001_enums.sql` | 2026-09-05 | 12 enum types: `asset_class`, `portfolio_role`, `txn_type`, `txn_state`, `data_quality_state`, `data_quality_issue`, `import_batch_state`, `corp_action_type`, `credit_action`, `coverage_state`, `credit_outlook`, `rating_watch` | None — types only; no tables, functions, policies or grants | Yes — remote `pg_type`/`pg_enum` match the approved proposal exactly; `pg_tables`, `pg_proc`, `pg_policies` and table grants in `public` all empty | Drop the 12 types in reverse order (SQL in file header). Safe only while no table uses them; never `drop ... cascade`. |
| `db/migrations/0002_identity.sql` | 2026-09-06 07:02 UTC (12:32 IST) | `public.profiles`, `public.user_settings`, `public.set_updated_at()`, triggers `profiles_set_updated_at` / `user_settings_set_updated_at` | RLS enabled on both tables; exactly 6 owner-scoped policies (`SELECT`/`INSERT`/`UPDATE` per table, `TO authenticated`, `= auth.uid()`); no DELETE policy. Column-level grants applied as approved, **but see the open privilege issue below** | Partial — structure, FKs (`ON DELETE RESTRICT` both), RLS, policies and trigger function all verified correct. Privilege verification FAILED: Supabase's pre-existing `ALTER DEFAULT PRIVILEGES` grants `arwdDxtm` on every new `public` table to `anon`, `authenticated` and `service_role`, so the approved narrow column grants were additive and did not restrict anything | `begin; drop table if exists public.user_settings; drop table if exists public.profiles; drop function if exists public.set_updated_at(); commit;` (never `cascade`) |

| `db/migrations/0002a_identity_privileges.sql` | 2026-09-06 07:28 UTC (12:58 IST) | No new objects — privilege correction only | `REVOKE ALL` on `profiles`/`user_settings` from `anon`, `authenticated`, then exact re-grant of the approved table/column privileges; `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL` on tables/sequences and `REVOKE EXECUTE` on functions from `anon`, `authenticated`, `service_role` and `PUBLIC`; direct `EXECUTE` on `set_updated_at()` revoked from `PUBLIC`, `anon`, `authenticated` | Yes — see Migration 02a verification below | Rollback SQL in the file header (restores Supabase's permissive defaults; not recommended) |
| `db/migrations/0003_portfolio_foundation.sql` | 2026-09-06 10:12 UTC (15:42 IST) | `public.brokers` (shared reference data, seeded with exactly one row: `code = 'OTHER'`, `name = 'Other / not listed'`), `public.portfolios`, `public.broker_accounts`; 3 indexes; 3 triggers reusing the existing `public.set_updated_at()` (not redeclared) | Explicit-grant model. `anon`: nothing. `authenticated`: `SELECT` on all three; INSERT on `portfolios(owner_id, name, description, base_currency, core_target_count)` and `broker_accounts(owner_id, broker_id, nickname, account_ref_masked)`; UPDATE on `portfolios(name, description, core_target_count, archived_at)` and `broker_accounts(nickname, account_ref_masked, archived_at)`; no INSERT/UPDATE/DELETE on `brokers`; no DELETE anywhere; `created_at`/`updated_at`/`owner_id`/`base_currency`/`broker_id` not updatable. RLS enabled on all three; 7 policies | Yes — see Migration 03 verification below | `begin; drop table if exists public.broker_accounts; drop table if exists public.portfolios; drop table if exists public.brokers; commit;` (never `cascade`; never drop the shared `set_updated_at()`) |
| `db/migrations/0004_security_identity.sql` | 2026-09-06 13:39 UTC (19:09 IST) | Enum `public.security_alias_type` (7 values); function `public.normalize_alias(text)` (IMMUTABLE, STRICT, SECURITY INVOKER, `search_path=""`); tables `public.securities` and `public.security_aliases` (no rows seeded); 7 indexes; 2 triggers reusing `public.set_updated_at()` (not redeclared) | Shared canonical reference data. `anon`: nothing. `authenticated`: `SELECT` only on both tables, no INSERT/UPDATE/DELETE, no EXECUTE on `normalize_alias`. `PUBLIC` EXECUTE on `normalize_alias` explicitly revoked (verified necessary — new public functions are otherwise PUBLIC-executable). `service_role`: PostgreSQL `ALL` on both tables + EXECUTE on `normalize_alias` (needed for the generated column); no service-role credential exists in the app. RLS enabled on both; exactly 2 SELECT policies | Yes — see Migration 04 verification below | `begin; drop table if exists public.security_aliases; drop table if exists public.securities; drop function if exists public.normalize_alias(text); drop type if exists public.security_alias_type; commit;` (never `cascade`; never drop the shared `set_updated_at()`) |

| `db/migrations/0005_transactions.sql` | 2026-09-07 03:22 UTC (08:52 IST) | `public.transactions` (canonical ledger, 20 columns, no rows); function `public.transactions_guard_immutable_fields()` (SECURITY INVOKER, `search_path=""`); 5 indexes + PK; 2 triggers (`transactions_protect_economic_fields` then `transactions_set_updated_at`, reusing `public.set_updated_at()`); composite unique `broker_accounts_owner_id_id_key` added to support the owner-safe FK | Explicit-grant model. `anon`: nothing. `authenticated`: `SELECT` only — no INSERT/UPDATE/DELETE, no EXECUTE on the guard function. `service_role`: PostgreSQL `ALL` (compatibility only; the application holds no service-role credential). RLS enabled; exactly 1 policy (`transactions_select_own`, SELECT, `TO authenticated`, `owner_id = auth.uid()`) | Yes — see Migration 05 verification below | `begin; drop table if exists public.transactions; drop function if exists public.transactions_guard_immutable_fields(); alter table public.broker_accounts drop constraint if exists broker_accounts_owner_id_id_key; commit;` (never `cascade`) |

## Live schema state

| Date (UTC) | Observation |
|------------|-------------|
| 2026-09-05 | Dedicated Supabase project not yet connected to this Lovable project — no credentials present in the environment, so the live schema could not be inspected. Nothing is assumed to exist. |
| 2026-09-05 | Dedicated Supabase project connected (public URL + publishable key in secret store). User independently verified `public` schema empty. Migration 01 applied and verified remotely: exactly the 12 approved enum types exist, no tables/functions/policies/grants. |
| 2026-09-06 | Migration 02 applied. `public` contains exactly `profiles` and `user_settings`; the 12 enum types are unchanged. Verification results below. |
| 2026-09-06 | Migration 03 applied. `public` contains exactly `brokers`, `broker_accounts`, `portfolios`, `profiles`, `user_settings`; the 12 enum types are unchanged. Verification results below. |
| 2026-09-06 | Migration 04 applied. `public` contains exactly `broker_accounts`, `brokers`, `portfolios`, `profiles`, `securities`, `security_aliases`, `user_settings`; enums = the 12 originals plus `security_alias_type`. Verification results below. |

## Migration 04 verification results (2026-09-06)

Capability evidence gathered before deployment (read-only / rolled back): PostgreSQL 17.6, UTF8 encoding, ICU `en_US.UTF-8`; `normalize(text,text)`, `upper`, `btrim` and all `regexp_replace` variants are `provolatile = 'i'`; a STORED generated column over an IMMUTABLE wrapper function was accepted in a probe; `pg_catalog.normalize(x, NFKC)` is a syntax error, so the unqualified keyword form is used; a newly created `public` function is still PUBLIC-executable despite the 02a default hardening, which is why the migration revokes EXECUTE explicitly.

Structure:
- `public` tables = exactly `broker_accounts`, `brokers`, `portfolios`, `profiles`, `securities`, `security_aliases`, `user_settings`.
- Enums: the 12 Migration 01 types unchanged, plus exactly one new type `security_alias_type = EXCHANGE_SYMBOL, BROKER_SYMBOL, LEGACY_SYMBOL, ISIN, COMPANY_NAME, IMPORT_TEXT, OTHER` in that order.
- `securities` and `security_aliases` are both empty — nothing seeded.
- `profiles`, `user_settings`, `brokers`, `portfolios`, `broker_accounts` ACLs unchanged (`authenticated=r`, no `anon`).
- `security_aliases` columns: `id, security_id, alias_type, alias_value, alias_normalized (generated: normalize_alias(alias_value)), source, exchange, created_at, updated_at` — no `is_confirmed`, no confidence score, no resolution status/method, no `confirmed_by`/`confirmed_at`, no fuzzy-matching fields.
- FK `security_aliases_security_id_fkey` has `confdeltype = 'r'` (RESTRICT); no CASCADE or SET NULL anywhere.
- 7 indexes present; 2 triggers reusing `set_updated_at()`, which is unchanged (`provolatile='v'`, `prosecdef=false`, `search_path=""`).
- `pg_default_acl` for `postgres` in `public` still owner-only (`r={postgres=arwdDxtm}`, `S={postgres=rwU}`, `f={postgres=X}`).

Security identity (owner-level, rolled back): duplicate ISIN rejected; two NULL ISINs accepted; duplicate `(exchange, primary_symbol)` rejected; the same symbol on a second exchange accepted; `primary_symbol` without `exchange` rejected; malformed ISIN rejected; malformed currency rejected; `currency` defaults to `INR`. Lifecycle is `is_active` / `delisted_on` / `archived_at`; no DELETE is available to the browser.

Alias model (rolled back): `EXCHANGE_SYMBOL` without `exchange` rejected, with `exchange` accepted; `BROKER_SYMBOL` without `source` rejected, with `source` accepted; `ISIN` alias `'INE101A0102'` rejected and `'ine101a01026'` accepted (normalized to `INE101A01026`); `COMPANY_NAME`, `IMPORT_TEXT`, `LEGACY_SYMBOL`, `OTHER` accepted with no context. Duplicate `(alias_type, source, exchange, alias_normalized)` rejected; the same alias under a different `source` accepted, and a context-free lookup then returns 2 rows — visible as ambiguous, never merged. Deleting a referenced security is blocked by the RESTRICT FK.

Normalization: `normalize_alias` is `provolatile='i'`, `proisstrict=true`, `prosecdef=false`, `proconfig={search_path=""}`. Results: `'  m&m  '→'M&M'`, `'M_M'→'M_M'`, `'MM'→'MM'` (3 distinct values — punctuation preserved), `'reliance   industries'→'RELIANCE INDUSTRIES'`, zero-width character stripped, `'Alpha   Ltd'→'ALPHA LTD'`, `'alpha ltd.'→'ALPHA LTD.'`.

Privileges / RLS (signed-in and anonymous, rolled back): `authenticated` SELECT succeeds on both tables; INSERT, UPDATE and DELETE denied on both; `authenticated` and `anon` both denied EXECUTE on `normalize_alias`; `anon` denied SELECT on both tables. `proacl` on `normalize_alias` = `{postgres=X, service_role=X}` — no `PUBLIC`, `anon` or `authenticated` entry. RLS enabled on both tables with exactly two SELECT policies for `authenticated`. `relacl` on both tables = `{postgres, authenticated=r, service_role}`. `updated_at` advances on a privileged UPDATE on both tables via the reused trigger.

No service-role credential or key was introduced or used by the application. Repository secret scan, type check and production build all clean.


## Migration 03 verification results (2026-09-06)

Structure and objects:
- `public` tables = exactly `broker_accounts`, `brokers`, `portfolios`, `profiles`, `user_settings`; 12 Migration 01 enum types unchanged; `profiles`/`user_settings` ACLs unchanged (`authenticated=r` only, no `anon`).
- `brokers` contains exactly one row: `OTHER / Other / not listed`.
- `broker_accounts` columns: `account_ref_masked, archived_at, broker_id, created_at, id, nickname, owner_id, updated_at` — no `custom_broker_name`, no client identifier, no credential column.
- `portfolios` columns: `archived_at, base_currency, core_target_count, created_at, description, id, name, owner_id, updated_at` — no accounting method, concentration control, benchmark or target allocation.
- `core_target_count` comment present: "Target NUMBER OF CORE STOCKS (e.g. ~35). Never an allocation percentage."
- All three FKs (`portfolios_owner_id_fkey`, `broker_accounts_owner_id_fkey`, `broker_accounts_broker_id_fkey`) report `confdeltype = 'r'` (ON DELETE RESTRICT).
- RLS enabled on all three; exactly the 7 approved policies, all `{authenticated}`.
- `pg_default_acl` for role `postgres` in `public` still owner-only (`r={postgres=arwdDxtm}`, `S={postgres=rwU}`, `f={postgres=X}`) — Migration 02a hardening intact.
- `set_updated_at()` still `prosecdef = false` with `search_path=""`; reused, not redeclared.

Privileges: `relacl` on each new table = `{postgres, service_role, authenticated=r}` — `anon` absent entirely. `authenticated` table-level privilege is `SELECT` only; column privileges exactly as granted, with no INSERT/UPDATE on `created_at`/`updated_at`, no UPDATE on `portfolios.base_currency`, `owner_id` (either table) or `broker_accounts.broker_id`.

Behavioural (two signed-in test users, all inside rolled-back transactions):
- Own portfolio INSERT (with `base_currency`, `core_target_count`) and own broker-account INSERT succeed.
- Broker SELECT succeeds; broker INSERT / UPDATE / DELETE → permission denied.
- Forged `created_at` INSERT → permission denied; `updated_at` write → permission denied.
- `base_currency` UPDATE → permission denied; `owner_id` reassign → permission denied; `broker_id` change → permission denied.
- DELETE on `portfolios` and `broker_accounts` → permission denied.
- Legitimate `name` UPDATE succeeds; second user sees 0 rows and its UPDATE affects 0 rows.
- Deleting a profile with dependent rows → blocked by `portfolios_owner_id_fkey` RESTRICT.
- `anon` SELECT on `brokers`, `portfolios`, `broker_accounts` → permission denied.
- Triggers verified: after an UPDATE, `updated_at > created_at` on all three tables (same-transaction `now()` semantics noted under Migration 02 still apply).

No service-role credential or key was introduced or used by the application; repository secret scan and type check clean.


## Migration 02 verification results (2026-09-06)

Passed:
- `public` tables = exactly `profiles`, `user_settings`; 12 enum types unchanged.
- `profiles.id -> auth.users(id)` and `user_settings.user_id -> public.profiles(id)` both `confdeltype = 'r'` (ON DELETE RESTRICT).
- RLS enabled on both tables; exactly the 6 approved owner-scoped policies, all `{authenticated}`.
- `set_updated_at()` is NOT `SECURITY DEFINER` (`prosecdef = false`), has `search_path=""`, and is attached to both approved triggers.
- Behavioural (rolled back in a transaction): own profile and settings creation succeed; own editable fields update; another user cannot read or modify the first user's rows (0 rows, 0 updated); deleting the auth user is blocked by `profiles_id_fkey` RESTRICT; DELETE of own row returns 0 rows (no DELETE policy).
- No service-role key introduced or used by the application. Migration applied over a direct authenticated Postgres session; no credential exists in source.

Open issue (requires a follow-up migration, not yet applied):
- Supabase ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, service_role` for the `postgres`/`supabase_admin` roles. Every new `public` table therefore starts with full table privileges for `anon` and `authenticated`; the approved column-level grants only added to that ACL. Observed: `relacl` on both tables contains `anon=arwdDxtm` and `authenticated=arwdDxtm`.
- Consequences today: `anon` is still fully blocked by RLS (no policies apply to it) and DELETE is still blocked by RLS, but an authenticated user CAN write audit timestamps — verified: an own-row INSERT supplying `created_at = 1999-01-01` persisted, and a direct `UPDATE ... SET updated_at` succeeded.
- Remedy to propose: `REVOKE ALL ON public.profiles, public.user_settings FROM anon, authenticated;` immediately before the approved column-level grants (and the same pattern in every future table migration).
- Note: `set_updated_at()` uses `now()` (transaction start time), so an UPDATE inside the same transaction as the INSERT shows an unchanged `updated_at`. Across separate statements/transactions it advances normally.

## Migration 02a verification results (2026-09-06)

Creator role inspected before changing anything: `pg_default_acl` showed permissive
`public` defaults owned by **`postgres`** (the role that applies PortfolioAI
migrations) and by `supabase_admin` (Supabase-managed objects, left untouched).

Verified remotely after applying 02a:
- `relacl` on both tables: `{postgres=arwdDxtm, service_role=arwdDxtm, authenticated=r}` — `anon` absent entirely.
- `authenticated` table privileges: `SELECT` only, on both tables. No INSERT/UPDATE/DELETE at table level.
- Column privileges for `authenticated`: INSERT on `profiles(id, display_name)`; UPDATE on `profiles(display_name)`; INSERT on `user_settings(user_id, locale, timezone, date_format, number_locale)`; UPDATE on the same four settings columns. No INSERT/UPDATE on `created_at` or `updated_at` on either table.
- Behavioural: forging `created_at` on INSERT → permission denied; writing `updated_at` → permission denied; own-row DELETE → permission denied; direct `select public.set_updated_at()` → permission denied for function; cross-user SELECT returns only own row and cross-user UPDATE affects 0 rows; a legitimate `display_name` UPDATE succeeded and advanced `updated_at` via the trigger while `created_at` stayed unchanged; `anon` SELECT → permission denied.
- Unchanged: exactly the 6 approved RLS policies (all `{authenticated}`), RLS enabled on both tables, both FKs `confdeltype = 'r'` (RESTRICT), 12 Migration 01 enum types, `set_updated_at()` still `prosecdef = false` with `search_path=""` and `now()` semantics retained.
- Future objects: `pg_default_acl` for role `postgres` in `public` now reads `r={postgres=arwdDxtm}`, `S={postgres=rwU}`, `f={postgres=X}` — no automatic privileges for `anon`, `authenticated`, `service_role` or `PUBLIC`. A probe table created inside a rolled-back transaction had `relacl = NULL` (owner-only).
- No service-role key introduced or used by the application; secret scan and type check clean.

## Migration 05 verification (2026-09-07, live project)

Structure: exactly one new table `public.transactions` with the 20 approved columns and types (`quantity`, `unit_price`, `gross_amount`, `total_charges` all `numeric(38,18)`; `currency char(3) default 'INR'`; `txn_state default 'ACTIVE'`; `data_quality_state default 'VALID'`; `data_quality_issues data_quality_issue[] default '{}'`; `trade_date` and all monetary columns nullable). No new enum — the enum count remains 13 (12 from Migration 01 + `security_alias_type` from Migration 04). `profiles`, `user_settings`, `brokers`, `portfolios`, `broker_accounts`, `securities`, `security_aliases` unchanged. Table is empty (0 rows). `broker_accounts` has exactly two unique constraints: the pre-existing `broker_accounts_owner_id_nickname_key` and the newly added `broker_accounts_owner_id_id_key`.

Foreign keys: 4, all `confdeltype = 'r'` (RESTRICT) — `transactions_owner_id_fkey`, `transactions_security_id_fkey`, and the owner-safe composites `transactions_portfolio_owner_fk (owner_id, portfolio_id)` and `transactions_broker_account_owner_fk (owner_id, broker_account_id)`.

Indexes: `transactions_pkey`, `transactions_owner_idx`, `transactions_portfolio_idx`, `transactions_security_idx`, `transactions_account_idx`, and the partial `transactions_active_pos_idx (portfolio_id, security_id, trade_date) where txn_state = 'ACTIVE'`. No unique index on `(owner_id, source_system, source_reference)` — the premature idempotency index is confirmed absent, and two rows sharing `source_reference = 'REF1'` inserted successfully.

Constraints: all 13 approved checks present. Behavioural tests (all inside rolled-back transactions) confirmed: `quantity = 0` and `quantity < 0` rejected; negative `unit_price` / `gross_amount` / `total_charges` rejected; lowercase currency rejected; `VALID` with issues rejected; non-`VALID` with no issue rejected; `VALID` missing `trade_date`, `quantity` or `broker_account_id` rejected. MISSING_ACCOUNT semantics: NULL `broker_account_id` with no `MISSING_ACCOUNT` issue rejected by `transactions_missing_account_disclosed`; NULL account with `INCOMPLETE` + `{MISSING_BROKER}` alone still rejected; NULL account with `INCOMPLETE` + `{MISSING_ACCOUNT}` accepted. `SPLIT` with `VALID` rejected; `SPLIT`/`REVERSAL`/`ADJUSTMENT` with `NEEDS_REVIEW` + an issue accepted; `BONUS` unaffected. Cross-owner writes rejected by both composite FKs.

Economic immutability: every one of the 14 guarded columns (`owner_id`, `portfolio_id`, `broker_account_id`, `security_id`, `txn_type`, `trade_date`, `quantity`, `unit_price`, `gross_amount`, `total_charges`, `currency`, `source_system`, `source_reference`, `created_at`) raised `transactions: economic/source fields are immutable; correct via a reversal or superseding ledger row`. A metadata-only UPDATE (`txn_state`, `data_quality_state`, `data_quality_issues`, `notes`) succeeded and advanced `updated_at` via the trigger.

Function security: `transactions_guard_immutable_fields()` has `prosecdef = false`, `search_path=""`, and `proacl = {postgres=X}` — no `PUBLIC`, `anon`, `authenticated` or `service_role` EXECUTE. Direct invocation as `authenticated` → permission denied for function.

Privileges / RLS: `relacl` = `{postgres, authenticated=r, service_role}` — `anon` absent. As `authenticated`, INSERT, UPDATE and DELETE all denied; SELECT returns only own rows (other user sees 0). As `anon`, SELECT and INSERT denied. RLS enabled with exactly one policy.

Delete protection: deleting the owning `profiles`, `portfolios`, `broker_accounts` or `securities` row while a transaction references it is blocked by RESTRICT in every case.

All test data was created inside transactions that were rolled back; post-test row counts for `transactions` and `profiles` are 0. Secret scan clean (no service-role key, DB password or JWT in the repository), `tsgo --noEmit` clean, production build succeeded.

## Migration 06 — import staging & provenance (`db/migrations/0006_import_staging.sql`)

Applied and verified **2026-09-07 03:49 UTC** (09:19 IST) against the dedicated PortfolioAI Supabase project.

Created: `public.import_batches`, `public.import_source_rows` (both empty), enums
`import_row_resolution` (UNRESOLVED, RESOLVED, EXCLUDED, COMMITTED) and
`security_resolution_state` (UNRESOLVED, RESOLVED, AMBIGUOUS, UNSUPPORTED) — public enum count now 15
(12 foundational + `security_alias_type` + these 2). Public tables now 10.

Ledger lineage: `public.transactions` gained exactly one column, `import_source_row_id uuid` (nullable),
with owner-safe composite FK `transactions_source_row_owner_fk (owner_id, import_source_row_id)` ON DELETE
RESTRICT and partial unique index `transactions_source_row_uidx` — one canonical transaction per staging row.
No `import_batch_id` column was added. `transactions_guard_immutable_fields()` was extended (behaviour
otherwise identical) so lineage is immutable too.

Foreign keys: 8 relevant FKs, all `confdeltype='r'` (RESTRICT) — batch→profiles, batch→portfolios
(owner-safe composite), row→profiles, row→import_batches (owner-safe), row→broker_accounts (owner-safe),
row→securities (shared canonical table), row→import_source_rows (owner-safe duplicate self-reference),
transactions→import_source_rows (owner-safe). Behavioural tests rejected cross-owner batch/portfolio,
cross-owner row/batch, cross-owner candidate account, cross-owner duplicate reference, cross-owner
transaction lineage and self duplicate reference; same-owner cross-batch duplicate references were accepted.

Candidate numeric fields are all `numeric(38,18)`.

Initial staging: a browser INSERT using only granted columns succeeds and defaults to
`resolution=UNRESOLVED`, `data_quality_state=INCOMPLETE`, `data_quality_issues='{}'`. UNRESOLVED+INCOMPLETE
with no issues accepted; RESOLVED+INCOMPLETE and RESOLVED+NEEDS_REVIEW with empty issues rejected
(`import_source_rows_flagged_has_issue`); VALID with issues rejected. MISSING_ACCOUNT disclosure is required
once past UNRESOLVED; `MISSING_BROKER` alone does not satisfy it.

Raw evidence immutability: `raw_payload`, all `raw_*` strings, `id`, `import_batch_id`, `owner_id`,
`source_row_number` and `created_at` all rejected with `raw source evidence is immutable`. Candidate
interpretation remains editable pre-commit; `updated_at` is trigger-controlled (an attempt to set it to
2000-01-01 was overwritten by `set_updated_at()`).

Committed interpretation: RESOLVED → COMMITTED succeeds; afterwards every candidate field, security
resolution, resolution, data-quality state/issues and duplicate reference/reason are frozen, and raw
evidence remains immutable.

Batch-state security: as `authenticated`, PREVIEWED/VALIDATED/AWAITING_CONFIRMATION succeed while
COMMITTING and FAILED raise `insufficient_privilege` and COMMITTED is denied outright. A temporary
SECURITY DEFINER probe (created and dropped inside a rolled-back transaction) performed
COMMITTING and COMMITTED successfully — `current_user` based, so the future Migration 07 RPC will work.
COMMITTED is terminal even for the trusted caller. No probe remains in the schema (0 matching functions).

Parent-batch locking: while the batch is COMMITTING, and after it is COMMITTED, browser row UPDATE and
DELETE affect 0 rows, as does batch DELETE — no race allowing interpretation changes after commit starts.

Duplicates / idempotency: duplicate `(batch, source_row_number)` rejected; identical economic rows accepted;
`file_sha256`, `candidate_fingerprint` and `raw_source_reference` are all non-unique; `unique(owner_id,
client_request_id)` enforced when present and repeatable when NULL; a second transaction referencing the
same source row rejected by `transactions_source_row_uidx`.

Ledger regression: transactions remains browser SELECT-only (INSERT/UPDATE/DELETE denied), anon has no
access, owner RLS intact, economic/source fields and now lineage immutable, metadata-only updates still
allowed. No cost-basis, FIFO/LIFO/weighted-average or P&L logic was introduced.

RLS / grants / functions: RLS enabled on both tables with exactly 4 policies each (SELECT/INSERT/UPDATE/
DELETE, owner-scoped). `anon` has no privilege of any kind on either table. `authenticated` has table
SELECT/DELETE plus exactly the approved INSERT and UPDATE column sets (no timestamps, no owner rewrite,
no committed_at). `import_source_rows_guard_raw()`, `import_batches_guard_state()` and
`transactions_guard_immutable_fields()` are all `prosecdef=false` with `search_path=""` and no PUBLIC/
anon/authenticated EXECUTE. `public.set_updated_at()` unchanged.

Deletion / retention: deleting a batch that still has source rows, a source row referenced as duplicate
evidence, and a source row referenced by a canonical transaction are all blocked by RESTRICT. No CASCADE.

All 83 behavioural checks passed inside transactions that were rolled back; post-test row counts for
`import_batches`, `import_source_rows`, `transactions`, `profiles`, `portfolios`, `broker_accounts`,
`securities` and `auth.users` are all 0. Secret scan clean, `tsgo --noEmit` clean, production build
succeeded. No service-role application credential exists; the `service_role` GRANT is a database-role
grant only.

## Migration 07 — trusted import commit (`db/migrations/0007_commit_import_batch.sql`)

Applied and verified **2026-09-07 04:43 UTC** (10:13 IST) against the dedicated PortfolioAI Supabase project.

Created: exactly one database object — `public.commit_import_batch(p_batch_id uuid)` returning
`(batch_id uuid, status public.import_batch_state, committed_transaction_count integer,
excluded_row_count integer, already_committed boolean)`. No new tables, columns, enums, indexes,
triggers or policies. Public function count 5 → 6; public tables still 10; public enums still 15.

Security: `prosecdef=true`, owner `postgres`, `proconfig={search_path=""}`, `provolatile='v'`,
no dynamic SQL, all references schema-qualified. `proacl = {postgres=X/postgres,
authenticated=X/postgres}` — `PUBLIC` and `anon` cannot execute (`has_function_privilege` false for
both, true for `authenticated`). `authenticated` still holds only `SELECT` on `public.transactions`.

Identity / ownership: `auth.uid()` is the sole caller identity; the browser supplies only the batch id.
Batch is loaded `FOR UPDATE` with `owner_id = auth.uid()`; portfolio ownership is revalidated; every
source row of the batch is explicitly revalidated for `owner_id = auth.uid()` (aborting the whole commit
on any mismatch, never filtering).

Eligibility: `resolution='RESOLVED' AND data_quality_state='VALID' AND
cardinality(data_quality_issues)=0`. EXCLUDED rows are skipped and preserved; UNRESOLVED, INCOMPLETE and
NEEDS_REVIEW rows abort the entire commit. Empty and all-EXCLUDED batches are rejected
(`no committable rows`). Only `AWAITING_CONFIRMATION → COMMITTING → COMMITTED` is permitted.

Revalidation per row: security resolved + exists, broker account present + owned, txn type present and
not SPLIT/REVERSAL/ADJUSTMENT, trade date present, quantity present and > 0, currency explicitly present
(the table's INR default is never reached), non-negative amounts, and no pre-existing lineage.

Behavioural verification: 31 checks, all passed, inside a transaction that was rolled back —
unauthenticated (28000), wrong owner (`batch not found`, 42501), single-row commit with field-by-field
mapping (owner/portfolio/account/security/type/date/quantity/unit price/currency/state/source system/
source reference/lineage, `gross_amount` and `total_charges` preserved as NULL, nothing fabricated),
source row RESOLVED→COMMITTED, batch COMMITTED with `committed_at` set and counters recomputed,
idempotent retry (`already_committed=true`, no duplicate), multi-row commit skipping an EXCLUDED row,
UNRESOLVED/INCOMPLETE/NEEDS_REVIEW/missing-account rejections with full rollback to
AWAITING_CONFIRMATION, missing currency rejection, SPLIT/REVERSAL/ADJUSTMENT rejections, duplicate
lineage rejection, empty and all-EXCLUDED batch rejection, wrong-state rejection, the M06 composite FK
rejecting construction of a cross-owner source row (23503, FK not weakened), the M06 check rejecting a
RESOLVED row without security/date/quantity (23514), `authenticated` still denied INSERT/UPDATE/DELETE on
`public.transactions` (42501 each), `authenticated` still denied setting COMMITTING, and committed-row
interpretation still frozen.

Concurrency: the batch row lock (`SELECT ... FOR UPDATE`, the first data statement after the auth check)
serialises callers; a second concurrent call blocks and then observes `COMMITTED` and takes the idempotent
path. Two-session execution was not run because it would require persisting test ledger data; the lock,
the state machine and the unique lineage index were verified in the deployed function source and by the
idempotency and duplicate-lineage tests.

Post-test row counts for `transactions`, `import_batches`, `import_source_rows`, `profiles`, `portfolios`,
`broker_accounts`, `securities` and `auth.users` are all 0 — no residual test data, no portfolio data
imported. Secret scan clean, `tsgo --noEmit` clean, production build succeeded. No service-role
application credential exists.

Rollback: `begin; drop function if exists public.commit_import_batch(uuid); commit;`

## Migration 08 — settings & derived holdings (`db/migrations/0008_derived_holdings.sql`)

Applied and verified **2026-09-07 07:03 UTC** (12:33 IST) against the dedicated PortfolioAI Supabase project.

Objects created (and nothing else): table `public.portfolio_security_settings` (8 columns, 2 indexes,
`portfolio_security_settings_set_updated_at` reusing the shared `public.set_updated_at()`), and view
`public.current_holdings` (`security_invoker = true`, owner `postgres`, never materialized).
No new enum, function or sequence. Structural counts after apply: 11 public tables, 1 view,
0 materialized views, 6 public functions, 15 enums — Migrations 01–07 objects unchanged.

Settings semantics: current role only (`portfolio_role`, default `UNASSIGNED`); notes ≤ 4000 chars;
unique `(owner_id, portfolio_id, security_id)`; three FKs all `ON DELETE RESTRICT`, including the
owner-safe composite `(owner_id, portfolio_id) → portfolios(owner_id, id)`.

Derivation semantics: `current_holdings` reads only `txn_state = 'ACTIVE'` transactions.
`BUY`/`OPENING_POSITION`/`TRANSFER_IN`/`BONUS` add, `SELL`/`TRANSFER_OUT` subtract. Any ACTIVE
`SPLIT`/`REVERSAL`/`ADJUSTMENT` forces `net_quantity = NULL` (disclosed via `unhandled_txn_count`);
any supported row with NULL quantity forces `net_quantity = NULL` (via `missing_quantity_count`).
NULL means INSUFFICIENT_DATA, never zero. Fully-resolved zero holdings are omitted by an outer
`net_quantity is distinct from 0` filter over the derivation CTE; NULL and negative quantities remain
visible. No cost basis, average price, accounting method, P&L, market value or portfolio weight.

Deferred explicitly: role-change history (later audit/decision layer) and corporate-action modelling
(later reviewed migration, subject to the no-double-counting invariant below).

Privileges: `anon` has nothing on either object. `authenticated` on the settings table has SELECT,
DELETE, INSERT on `(owner_id, portfolio_id, security_id, role, notes)` and UPDATE on `(role, notes)`
only — no INSERT/UPDATE on `created_at`/`updated_at` or the identity keys. `authenticated` has SELECT
on the view. `service_role` has `ALL` on the table (compatibility only; no service-role credential
exists in the app). RLS enabled with exactly 4 owner-scoped policies (`pss_select_own`,
`pss_insert_own`, `pss_update_own`, `pss_delete_own`, all `TO authenticated`, `owner_id = auth.uid()`).

Behavioural verification: 42 checks executed inside a single transaction and rolled back; 41 passed
and the one reported failure was a defect in the test's own `LIKE` pattern for `proconfig`, re-checked
directly — `commit_import_batch` remains SECURITY DEFINER, owner `postgres`, `search_path=""`.
Covered: full supported arithmetic (net 16, counts, first/last trade dates); each unsupported type
(`SPLIT`, `REVERSAL`, `ADJUSTMENT`) forcing NULL; NULL-quantity invalidation; clean zero omitted;
zero-with-unhandled still visible as NULL; negative `-5` visible; non-ACTIVE rows excluded from every
aggregate; settings insert/select/update/delete by owner; default role; duplicate, notes-length,
cross-owner-portfolio, forged-`owner_id`, forged-timestamp and identity-key-update rejections;
`set_updated_at` overriding a supplied value; cross-owner reads returning 0 rows and cross-owner
update/delete affecting 0 rows; `anon` denied on both objects; and M01–M07 regression (transactions
still SELECT-only for `authenticated` and not writable/deletable, all public FKs still RESTRICT, 28
policies, `commit_import_batch` unchanged). Post-test residual counts are 0 for `transactions`,
`portfolio_security_settings`, `securities`, `profiles`, `auth.users` and `current_holdings` — no
portfolio data imported. Secret scan clean, `tsgo --noEmit` clean, production build succeeded.

Rollback: `begin; drop view if exists public.current_holdings; drop table if exists public.portfolio_security_settings; commit;` (never `cascade`; never drop the shared `set_updated_at()`)


## Binding migration rule — explicit grants only

From Migration 02a onward, `public` objects created by the migration role
receive **no** automatic Data API privileges. Every future PortfolioAI migration
MUST explicitly `GRANT` the exact table/column/sequence/function privileges each
new object requires (and only those), immediately after creating it, before
enabling RLS and creating policies. Never rely on default privileges, and never
grant `anon` access unless a policy deliberately allows anonymous reads.

## Corporate-action invariant (binding on all future migrations)


- Transactions are the sole accounting/holding source of truth.
- Corporate-action records are event/provenance information only.
- If a corporate action has a quantity/accounting effect, that effect must be represented through an explicit, auditable ledger transaction (or a clearly linked ledger mechanism), never independently by the holdings derivation.
- `current_holdings` must never apply both a corporate-action event and its corresponding ledger transaction for the same economic event — no economic event may affect holdings twice.
- Unsupported or ambiguous corporate actions surface as explicit review states (`UNSUPPORTED_CORPORATE_ACTION` issue / `NEEDS_REVIEW`), never silently adjusted quantities.

## Planned Phase 1 sequence (not yet applied)

01 enums · 02 profiles/user_settings/app_config · 03 portfolios/brokers/broker_accounts ·
04 securities/security_aliases · 05 transactions · 06 import_batches/import_source_rows ·
07 commit_import_batch() · 08 current_holdings/portfolio_security_settings/role_change_history/corporate_actions ·
09 engine_definitions/versions/runs/results · 10 credit_agencies/credit_observations · 11 themes/security_themes
