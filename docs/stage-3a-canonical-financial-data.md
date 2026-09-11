# Stage 3A — Canonical Financial Data Architecture

Status: **DESIGN BASELINE — REVIEW BEFORE DATABASE APPLICATION**

## Goal

Stage 3A creates a provider-agnostic, point-in-time financial data model for PortfolioAI before any Trendlyne or other provider ingestion is introduced.

The architecture follows the project rules:

- security → metric/observation → financial period → normalized value → provider/source → publication/observation/retrieval time
- missing data remains missing; it must never silently become zero
- provider-specific field names remain provenance, not schema columns
- later corrections or provider revisions create new observations/versions rather than silently replacing what was known earlier
- browser access is read-only; ingestion is server-side only
- financial facts are security-level evidence and do not modify transactions, holdings or market-data truth
- Trendlyne is a planned provider, not a hard dependency

## Canonical tables

### `financial_data_providers`
Shared provider/source registry. Initial codes include `TRENDLYNE`, `OFFICIAL_COMPANY`, `NSE_BSE`, `MANUAL`, and `OTHER_VERIFIED`.

### `financial_metric_definitions`
Canonical metric dictionary. Provider adapters map source fields into these stable codes instead of adding provider-specific columns.

Initial metric families include:

- income statement: revenue, EBITDA, PBT, PAT, EPS
- margins: EBITDA margin, PBT margin, PAT margin
- capital efficiency: ROCE, ROE
- cash generation: CFO, capex, free cash flow
- balance sheet: total debt, cash/equivalents, net debt, net worth
- shareholder returns/capital: dividend payout, shares outstanding

The dictionary is deliberately extensible. Sector-specific metrics can be added later without altering observation-table shape.

### `financial_periods`
Canonical periods per security: `QUARTER`, `ANNUAL`, or `TTM`. Period identity is independent of provider so several providers can publish observations for the same company/period.

### `fundamental_observations`
Append-oriented normalized metric observations. Each row retains:

- security and canonical period
- canonical metric code
- statement scope (`CONSOLIDATED`, `STANDALONE`, `UNKNOWN`)
- normalized numeric or text value
- canonical unit/currency
- provider and provider/source field
- stable source record key
- original provider value/payload fragment
- observation, publication and retrieval timestamps
- confidence
- normalization method/version
- explicit observation version and optional superseded observation reference

The intended idempotency identity is provider + source record key + metric + period + statement scope + observation version.

### `shareholding_observations`
Point-in-time shareholding evidence by financial period and normalized holder category. Source category labels remain preserved because provider category taxonomies can differ.

### `analyst_consensus_observations`
Point-in-time analyst coverage evidence: analyst/Buy/Hold/Sell counts, normalized consensus label, targets, observed current price and provider provenance. `NOT_COVERED` remains an availability state, not a negative score.

### `analyst_estimate_observations`
Period-specific estimates such as revenue, EBITDA, PBT, PAT and EPS. Consensus/high/low estimates are separate observations and retain observation time, analyst count and provenance.

### `analyst_revision_observations`
Point-in-time revision evidence for EPS, revenue, EBITDA, PBT, PAT, target price or other normalized subjects. Supports windowed revision percentages, previous/current values and counts of upward/downward revisions or upgrades/downgrades.

## Data ownership and security

These are shared security-level observations rather than portfolio-owned accounting records.

- `authenticated`: SELECT only
- `service_role`: canonical/reference maintenance and server-side ingestion
- `anon`: no access
- RLS enabled on all Stage 3A tables
- no browser mutation policies

Observation tables are intended to be append-oriented. Later ingestion code must insert a new version for corrections/revisions instead of updating historical evidence in place.

## What Stage 3A deliberately does not do

- no Trendlyne API call
- no scraping
- no provider credentials
- no scores or investment recommendations
- no Quality/Growth/Valuation calculations
- no AI processing
- no transaction or holdings mutation
- no automatic Supabase deployment

## Stage 3B handoff

After Migration 0017 is reviewed and applied, Stage 3B should add provider adapters and ingestion-run auditing. A provider adapter must map source payloads into canonical metric/period/observation rows, preserve source identities, and skip unchanged observations rather than repeatedly downloading or rewriting data.
