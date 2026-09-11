# Stage 3B — Migration 0018 Safety Review

Status: **REVIEWED — READY FOR MANUAL APPLICATION**

Reviewed file: `db/migrations/0018_financial_ingestion_control.sql`

## Review conclusion

Migration 0018 is suitable for the Stage 3B ingestion-control foundation after hardening owner/portfolio integrity, audit-row privileges, and RLS visibility.

It is additive only. It does not modify transactions, current holdings, market-data tables, Angel One mappings, EOD history, or Stage 3A canonical financial evidence.

## Important review corrections applied

### Owner / portfolio integrity — FIXED

A portfolio-scoped ingestion run now has a composite foreign key `(owner_id, portfolio_id) -> portfolios(owner_id, id)`. This prevents an audit row from claiming a portfolio under the wrong owner.

### Audit immutability — HARDENED

`service_role` no longer receives blanket `ALL` privileges on the ingestion audit tables.

- `financial_data_ingestion_runs`: SELECT, INSERT, UPDATE only, because run status/counters must be finalized after creation.
- `financial_data_ingestion_rejections`: SELECT, INSERT only; rejection evidence is append-only.
- Neither table grants ordinary DELETE/TRUNCATE privileges to service_role.

### Authenticated visibility — HARDENED

Owner-scoped runs are readable only by their owner. Ownerless operational runs remain shared. Rejection rows inherit visibility through their parent run.

This preserves personal-use V1 behavior while avoiding an unnecessary future cross-user disclosure problem.

### Rejection context shape — HARDENED

`safe_context` must be a JSON object. The adapter still remains responsible for ensuring that it contains no provider credentials or secrets.

## Architecture checks

### Provider independence — PASS

The control layer references the Stage 3A provider registry and contains no Trendlyne-specific financial schema columns.

### Auditability — PASS

Each run records provider, operation, status, requested/resolved/inserted/unchanged/rejected/failed counts, adapter version, provider contract marker, timing, and safe error information.

### Rejection/quarantine semantics — PASS

Ambiguous or invalid source data can be rejected explicitly using structured codes such as `PERIOD_AMBIGUOUS`, `UNIT_UNSUPPORTED`, `METRIC_UNMAPPED`, `VALUE_INVALID`, and `SOURCE_IDENTITY_MISSING` rather than silently coerced.

### Browser mutation boundary — PASS

Authenticated users receive SELECT only. Ingestion writes remain server/service-role only.

### Credential safety — PASS WITH RUNTIME REQUIREMENT

No provider credentials are stored in either table. Stage 3B Edge Functions/adapters must keep provider secrets exclusively in server runtime and must sanitize `error_summary`, `rejection_summary`, and `safe_context` before persistence.

## Stage 3B adapter invariants

The first production provider adapter must:

1. resolve securities deterministically;
2. map financial periods without guessing;
3. preserve standalone/consolidated scope;
4. map only verified source fields to canonical metrics;
5. validate unit/value compatibility before insert;
6. retain stable source identities for idempotent retry;
7. skip unchanged observations;
8. create new observation versions for changed evidence;
9. write structured rejection diagnostics for unsafe/ambiguous records;
10. update the ingestion run to SUCCEEDED/PARTIAL/FAILED with accurate counters;
11. never expose credentials in logs, audit rows, or browser responses.

## Manual post-apply verification

```sql
-- Expected: both tables exist and RLS is enabled.
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'financial_data_ingestion_runs',
    'financial_data_ingestion_rejections'
  )
order by relname;

-- Expected for authenticated: SELECT=true; INSERT/UPDATE/DELETE=false.
select
  has_table_privilege('authenticated','public.financial_data_ingestion_runs','select') as auth_select,
  has_table_privilege('authenticated','public.financial_data_ingestion_runs','insert') as auth_insert,
  has_table_privilege('authenticated','public.financial_data_ingestion_runs','update') as auth_update,
  has_table_privilege('authenticated','public.financial_data_ingestion_runs','delete') as auth_delete;

-- Expected for service_role runs: SELECT/INSERT/UPDATE=true; DELETE=false.
select
  has_table_privilege('service_role','public.financial_data_ingestion_runs','select') as service_select,
  has_table_privilege('service_role','public.financial_data_ingestion_runs','insert') as service_insert,
  has_table_privilege('service_role','public.financial_data_ingestion_runs','update') as service_update,
  has_table_privilege('service_role','public.financial_data_ingestion_runs','delete') as service_delete;

-- Expected for service_role rejections: SELECT/INSERT=true; UPDATE/DELETE=false.
select
  has_table_privilege('service_role','public.financial_data_ingestion_rejections','select') as service_select,
  has_table_privilege('service_role','public.financial_data_ingestion_rejections','insert') as service_insert,
  has_table_privilege('service_role','public.financial_data_ingestion_rejections','update') as service_update,
  has_table_privilege('service_role','public.financial_data_ingestion_rejections','delete') as service_delete;

-- Expected: no rows before any Stage 3B provider test.
select
  (select count(*) from public.financial_data_ingestion_runs) as runs,
  (select count(*) from public.financial_data_ingestion_rejections) as rejections;
```

## Decision

**APPROVED FOR MANUAL DATABASE APPLICATION.**

Do not add provider credentials, production provider calls, scheduled ingestion, or canonical financial writes until the first provider adapter has been separately reviewed against the exact verified provider contract.
