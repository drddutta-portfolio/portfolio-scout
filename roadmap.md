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

## Next (awaiting approval)
- [ ] Migration 07 (commit_import_batch trusted RPC) — proposal revised with the two final
      corrections (explicit per-row owner revalidation, exact empty-issues eligibility condition);
      awaiting final approval. NOT applied, no migration file created
