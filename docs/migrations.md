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


## Live schema state

| Date (UTC) | Observation |
|------------|-------------|
| 2026-09-05 | Dedicated Supabase project not yet connected to this Lovable project — no credentials present in the environment, so the live schema could not be inspected. Nothing is assumed to exist. |
| 2026-09-05 | Dedicated Supabase project connected (public URL + publishable key in secret store). User independently verified `public` schema empty. Migration 01 applied and verified remotely: exactly the 12 approved enum types exist, no tables/functions/policies/grants. |

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
