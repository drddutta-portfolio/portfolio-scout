# Roadmap

## Done
- [x] Migration 01 (db/migrations/0001_enums.sql) — applied 2026-09-05, verified remotely
- [x] Migration 02 (db/migrations/0002_identity.sql) — applied 2026-09-06; structure/RLS/FK/policies verified,
      privilege gap found (Supabase permissive default ACLs)
- [x] Migration 02a (db/migrations/0002a_identity_privileges.sql) — applied and verified 2026-09-06:
      anon has no privileges, authenticated has exactly the approved table/column set,
      created_at/updated_at not client-writable, set_updated_at() not directly callable,
      future public objects have no automatic Data API privileges

- [x] Migration 03 (db/migrations/0003_portfolio_foundation.sql) — applied and verified 2026-09-06 10:12 UTC:
      brokers (seed: OTHER only, read-only to browser), portfolios, broker_accounts;
      3 RESTRICT FKs, RLS + 7 policies, explicit grants, no anon access, no DELETE,
      base_currency insert-only, no custom_broker_name, default_portfolio_id still deferred

- [x] Migration 04 (db/migrations/0004_security_identity.sql) — applied and verified 2026-09-06 13:39 UTC (19:09 IST):
      enum security_alias_type, normalize_alias() (IMMUTABLE/STRICT/SECURITY INVOKER/search_path=""),
      securities + security_aliases (shared canonical reference data, no rows seeded),
      SELECT-only for authenticated, no anon access, no PUBLIC/anon/authenticated EXECUTE on
      normalize_alias, RESTRICT FK, RLS + 2 SELECT policies, punctuation-preserving normalization,
      no is_confirmed / resolution-workflow fields

- [x] Migration 05 (db/migrations/0005_transactions.sql) — applied and verified 2026-09-07 03:22 UTC (08:52 IST):
      public.transactions (canonical ledger, empty), owner-safe composite FKs to portfolios and
      broker_accounts, 4 RESTRICT FKs, 13 checks incl. MISSING_ACCOUNT disclosure and
      SPLIT/REVERSAL/ADJUSTMENT -> NEEDS_REVIEW, economic-immutability trigger
      (SECURITY INVOKER, search_path=""), no source-reference idempotency index,
      authenticated SELECT only, no anon access, RLS + 1 owner policy,
      no service-role credential in the application

- [x] Migration 06 (db/migrations/0006_import_staging.sql) — applied and verified 2026-09-07 03:49 UTC (09:19 IST):
      import_batches + import_source_rows (untrusted staging, both empty), enums import_row_resolution and
      security_resolution_state, transactions.import_source_row_id lineage (+ unique index, immutable),
      8 RESTRICT FKs incl. owner-safe duplicate self-reference, raw-evidence and committed-interpretation
      immutability, trusted-only COMMITTING/COMMITTED/FAILED (current_user based), parent-batch locking,
      no economic-content uniqueness, RLS + 8 policies, explicit column grants, no anon access,
      no service-role credential in the application

- [x] Migration 07 (db/migrations/0007_commit_import_batch.sql) — applied and verified 2026-09-07 04:43 UTC (10:13 IST):
      public.commit_import_batch(uuid) is the only new object — SECURITY DEFINER, owner postgres,
      search_path="", EXECUTE for authenticated only (PUBLIC/anon revoked), auth.uid() identity,
      FOR UPDATE batch lock, AWAITING_CONFIRMATION -> COMMITTING -> COMMITTED, explicit batch/portfolio/
      source-row ownership revalidation, RESOLVED+VALID+zero-issues eligibility, EXCLUDED preserved,
      SPLIT/REVERSAL/ADJUSTMENT non-committable, explicit currency, no fabricated facts, one canonical
      transaction per source row, idempotent retry, atomic all-or-nothing, recomputed counters;
      31/31 behavioural checks passed in rolled-back transactions, zero residual data,
      no service-role credential in the application

- [x] Migration 08 (db/migrations/0008_derived_holdings.sql) — applied and verified 2026-09-07 07:03 UTC (12:33 IST):
      public.portfolio_security_settings (current role only, notes<=4000, owner-safe composite unique,
      3 RESTRICT FKs, shared set_updated_at trigger, narrow authenticated column grants, RLS with exactly
      4 owner-scoped policies) and public.current_holdings (view, security_invoker=true, ACTIVE transactions
      only, BUY/OPENING_POSITION/TRANSFER_IN/BONUS positive and SELL/TRANSFER_OUT negative, any ACTIVE
      SPLIT/REVERSAL/ADJUSTMENT or NULL supported quantity forces net_quantity NULL, clean zero holdings
      omitted, NULL and negative holdings visible, no cost basis/P&L/market value/weight/accounting method);
      41 behavioural checks passed in a rolled-back transaction (the single reported failure was a defect in
      the test's own LIKE pattern; commit_import_batch re-verified unchanged), zero residual data,
      no service-role credential in the application.
      Deferred: role-change history and corporate-action modelling.

## In progress
- [ ] Migration 09a (security master seed) — ARTIFACT GENERATED AND DRY-RUN VERIFIED (rolled back), awaiting approval. See `docs/migration-09a-review.md`.
      Build from authoritative NSE/BSE/depository sources, deterministic dedup + review report.

## Next (awaiting approval)
- [ ] First Functional UI build (after M09a is reviewed, approved and deployed)
- [ ] Migration 09 (corporate_actions) — NOT started


