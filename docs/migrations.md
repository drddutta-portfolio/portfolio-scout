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

## Live schema state

| Date (UTC) | Observation |
|------------|-------------|
| 2026-09-05 | Dedicated Supabase project not yet connected to this Lovable project — no credentials present in the environment, so the live schema could not be inspected. Nothing is assumed to exist. |
| 2026-09-05 | Dedicated Supabase project connected (public URL + publishable key in secret store). User independently verified `public` schema empty. Migration 01 applied and verified remotely: exactly the 12 approved enum types exist, no tables/functions/policies/grants. |
| 2026-09-06 | Migration 02 applied. `public` contains exactly `profiles` and `user_settings`; the 12 enum types are unchanged. Verification results below. |

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
