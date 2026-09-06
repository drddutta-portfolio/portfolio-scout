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
