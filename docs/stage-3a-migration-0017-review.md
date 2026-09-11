# Stage 3A — Migration 0017 Safety Review

Status: **REVIEWED — READY FOR MANUAL APPLICATION**

Reviewed file: `db/migrations/0017_canonical_financial_data_foundation.sql`

## Review conclusion

Migration 0017 is suitable for the Stage 3A canonical financial-data foundation and is safe to apply manually before any provider ingestion is introduced.

It is additive only. It does not alter `transactions`, `current_holdings`, portfolio accounting, Angel One mappings, live prices, or EOD history.

## Architecture checks

### Provider independence — PASS

The schema uses a provider registry and canonical metric dictionary rather than provider-specific financial columns. `TRENDLYNE` is seeded as one source, but observations reference generic provider codes and retain original provider values/source keys.

### Point-in-time evidence — PASS

Fundamental, shareholding, analyst consensus, analyst estimate and analyst revision rows preserve observation/publication/retrieval timestamps, original source values, confidence, normalization method/version and observation version. Historical observations are append-oriented at the service-role privilege level.

### Missing-data semantics — PASS

The schema does not default missing financial facts to zero. Nullable observations remain nullable where absence is meaningful. Numeric zero remains distinguishable from missing data.

### Financial-period identity — PASS WITH ADAPTER REQUIREMENT

`financial_periods` provides provider-independent `QUARTER`, `ANNUAL` and `TTM` identities by security and period end. Stage 3B adapters must map provider periods deterministically and must not guess a fiscal quarter when the provider evidence is insufficient.

### Statement scope — PASS

Fundamental observations distinguish `CONSOLIDATED`, `STANDALONE` and `UNKNOWN`, preventing the common error of silently mixing consolidated and standalone financial statements.

### Shareholding model — PASS WITH INGESTION VALIDATION

Normalized ownership categories retain the provider's original category label. Stage 3B ingestion must reject empty ownership observations where all of holding percentage, shares held and pledged percentage are absent.

### Analyst coverage semantics — PASS

`NOT_COVERED` is explicitly represented separately from negative consensus labels. Consensus, estimates and revisions remain evidence rather than investment actions.

### Security / browser privileges — PASS

- `anon`: no access
- `authenticated`: SELECT only
- observation writes: service-role/server-side only
- RLS enabled on all Stage 3A tables
- no browser mutation policies

Reference/provider tables can be maintained by `service_role`; observation tables grant `service_role` only SELECT + INSERT, supporting append-oriented evidence.

### Existing-system compatibility — PASS

All foreign keys point to existing canonical `securities` or new Stage 3A tables. No existing table is altered. The migration reuses the existing `public.set_updated_at()` function for mutable reference dictionaries.

## Stage 3B ingestion invariants

The next provider adapter must enforce these rules even where they are intentionally not encoded as cross-table SQL constraints:

1. A source observation may only supersede an earlier observation for the same security/provider/logical datum.
2. Metric value type and unit must match the canonical metric definition.
3. A shareholding observation must contain at least one actual measure.
4. Provider period labels must map deterministically to a canonical financial period; ambiguous periods are quarantined, not guessed.
5. Unchanged provider observations are skipped; changed provider observations create a new `observation_version` rather than updating prior evidence.
6. Provider raw/source identity must remain stable enough for idempotent retry.
7. Missing source fields remain missing and are never converted to zero.

## Manual post-apply verification

After applying Migration 0017, run the following read-only checks in Supabase SQL Editor.

```sql
-- Expected: 5
select count(*) as provider_count
from public.financial_data_providers;

-- Expected: 20
select count(*) as canonical_metric_count
from public.financial_metric_definitions;

-- Expected: all eight rows have rowsecurity = true
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'financial_data_providers',
    'financial_metric_definitions',
    'financial_periods',
    'fundamental_observations',
    'shareholding_observations',
    'analyst_consensus_observations',
    'analyst_estimate_observations',
    'analyst_revision_observations'
  )
order by relname;

-- Expected: authenticated SELECT=true, INSERT/UPDATE/DELETE=false
select
  has_table_privilege('authenticated','public.fundamental_observations','select') as auth_select,
  has_table_privilege('authenticated','public.fundamental_observations','insert') as auth_insert,
  has_table_privilege('authenticated','public.fundamental_observations','update') as auth_update,
  has_table_privilege('authenticated','public.fundamental_observations','delete') as auth_delete;

-- Expected: service_role SELECT=true, INSERT=true, UPDATE=false, DELETE=false
select
  has_table_privilege('service_role','public.fundamental_observations','select') as service_select,
  has_table_privilege('service_role','public.fundamental_observations','insert') as service_insert,
  has_table_privilege('service_role','public.fundamental_observations','update') as service_update,
  has_table_privilege('service_role','public.fundamental_observations','delete') as service_delete;

-- Expected: no observation rows yet
select
  (select count(*) from public.fundamental_observations) as fundamentals,
  (select count(*) from public.shareholding_observations) as shareholding,
  (select count(*) from public.analyst_consensus_observations) as consensus,
  (select count(*) from public.analyst_estimate_observations) as estimates,
  (select count(*) from public.analyst_revision_observations) as revisions;
```

## Decision

**APPROVED FOR MANUAL DATABASE APPLICATION.**

Do not introduce Trendlyne credentials, API calls, scraping, scoring, or provider-specific schema changes as part of Migration 0017. Those belong to separately reviewed Stage 3B work.