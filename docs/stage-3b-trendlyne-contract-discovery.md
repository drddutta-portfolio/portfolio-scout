# Stage 3B — Trendlyne MCP Contract Discovery

Status: **CODE PREPARED — MANUAL CONFIGURATION / DEPLOYMENT REQUIRED**

## Purpose

Before PortfolioAI writes any Trendlyne-derived financial observations, it must discover the exact MCP tool contract exposed by the user's subscription and compare it with the official public Trendlyne MCP documentation.

This step is diagnostic only. It does not fetch or persist fundamental values, shareholding values, analyst estimates, research documents, or scores.

## Official contract expectations

Trendlyne's published MCP documentation currently exposes tools including:

- `search_identity`
- `search_parameters`
- `get_parameter_values`
- `get_shareholding`
- `get_insider_trading`
- `search_unstructured_reports`

PortfolioAI treats these names as discovery expectations only. The actual subscription contract returned by `tools/list` is authoritative for the later adapter.

## Secret handling

Trendlyne provides a subscription-specific Remote MCP Server URL. Published setup guidance says clients use that URL with no separate authentication selection.

PortfolioAI still treats the complete remote URL as a credential-like secret because it may be subscription-specific. It must be stored only as a Supabase Edge Function secret:

- `TRENDLYNE_MCP_URL`

Optional non-secret override:

- `TRENDLYNE_MCP_PROTOCOL_VERSION` — defaults to `2025-06-18`

The URL must never be committed to GitHub, inserted into database audit rows, returned to the browser, or printed to logs.

## Edge Function

`edge-functions/discover-trendlyne-contract/index.ts`

Authenticated action:

```json
{ "action": "DISCOVER" }
```

The function:

1. validates the PortfolioAI caller using Supabase Auth;
2. requires an HTTPS `TRENDLYNE_MCP_URL` from Edge Function secrets;
3. creates an owner-scoped `DISCOVER` ingestion audit row;
4. performs MCP `initialize`;
5. completes the initialization notification;
6. calls `tools/list`;
7. returns only safe contract metadata: tool names, descriptions, input property names and required property names;
8. records discovery counts/status in `financial_data_ingestion_runs`;
9. never calls a Trendlyne financial-data tool;
10. never writes Stage 3A financial observations.

## Safety boundary

Do not build the production Trendlyne normalization adapter until this discovery output has been inspected.

The next adapter must map only verified provider fields into canonical Stage 3A metrics/periods. Unsupported or ambiguous fields must be rejected/quarantined rather than guessed.

## Deployment

Deployment is manual only through:

`.github/workflows/deploy-discover-trendlyne-contract.yml`

No GitHub push deploys this function automatically.
