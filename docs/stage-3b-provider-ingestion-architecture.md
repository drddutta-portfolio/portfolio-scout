# Stage 3B — Provider Adapter & Ingestion Architecture

Status: **DESIGN BASELINE — REVIEW BEFORE DATABASE APPLICATION**

## Goal

Stage 3B adds the ingestion-control layer that sits between external financial-data providers and the canonical Stage 3A tables.

The adapter boundary must keep provider-specific payloads out of the canonical schema while preserving enough source identity and audit data to support idempotent retries, point-in-time reconstruction, and later provider replacement.

## Core rules

- Canonical tables remain provider-agnostic.
- Provider adapters map raw provider fields into Stage 3A metric/period/observation identities.
- Missing values remain missing; no silent zero-filling.
- Ambiguous periods, units, security mappings, or statement scopes are rejected/quarantined rather than guessed.
- Unchanged provider observations are skipped.
- Changed provider observations create a new observation version and supersession link; prior evidence is not updated in place.
- Every ingestion run is auditable and records counts, status, provider, operation, timing, and safe error summaries.
- Browser users may read their ingestion history but cannot mutate canonical observations directly.
- Service-role/server-side code performs provider ingestion.
- No provider credentials are stored in database tables or GitHub.

## New control entities

### `financial_data_ingestion_runs`

One row per provider ingestion attempt.

Tracks:

- owner / requesting user where applicable
- provider code
- operation type
- optional portfolio scope
- optional security scope
- status
- requested / resolved / inserted / unchanged / rejected / failed counts
- started/completed timestamps
- safe error code/summary
- adapter version
- provider contract/version marker

This table is audit/control data only. It is not financial evidence.

### `financial_data_ingestion_rejections`

Stores structured, non-secret rejection diagnostics for source rows/records that could not be normalized safely.

Typical reasons:

- SECURITY_UNRESOLVED
- PERIOD_AMBIGUOUS
- STATEMENT_SCOPE_AMBIGUOUS
- UNIT_UNSUPPORTED
- METRIC_UNMAPPED
- VALUE_INVALID
- SOURCE_IDENTITY_MISSING
- VERSION_CONFLICT

Rejected rows are not silently coerced into canonical observations.

## Provider adapter contract

A provider adapter should conceptually implement these stages:

1. **Fetch** — obtain provider payload using secrets held only in server runtime.
2. **Identify security** — resolve provider security identity to canonical `securities.id` using explicit deterministic mapping.
3. **Normalize period** — derive `QUARTER`, `ANNUAL`, or `TTM` period identity; never guess.
4. **Normalize metric** — map provider field to `financial_metric_definitions.code`.
5. **Normalize value/unit** — preserve original provider value and produce normalized value only when conversion is deterministic.
6. **Determine statement scope** — consolidated / standalone / unknown.
7. **Build source identity** — stable provider record key + observation/version metadata.
8. **Compare with prior evidence** — skip unchanged observations; insert new versions for changed evidence.
9. **Insert canonical evidence** — server-side only.
10. **Audit outcome** — update ingestion run counters and rejections.

## Initial provider strategy

Trendlyne is the first planned structured provider, but the Stage 3B control layer must not depend on Trendlyne-specific columns or assumptions.

Before implementing a production Trendlyne adapter, we must inspect the exact provider contract/API fields available to the user and map only verified fields.

## Deliberately deferred

Stage 3B does not yet add:

- Quality/Growth scoring
- Valuation calculations
- AI analysis
- analyst recommendation scoring
- automatic scheduled ingestion
- scraping as a foundational source

Those depend on a validated ingestion path and trustworthy source contracts first.
