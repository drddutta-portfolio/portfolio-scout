# Deploy refresh-market-data Edge Function

Deploy the existing `edge-functions/refresh-market-data/` source to the dedicated external Supabase project as the function `refresh-market-data`. No redesign, no rewrites, no new migrations, no database or UI changes.

## Prerequisite (user action required)

Deploying to an external Supabase project requires a **Supabase Management API personal access token** (`sbp_...`). The sandbox currently has only `PORTFOLIOAI_SUPABASE_URL`, the publishable key, and the DB password — none of these can deploy Edge Functions.

- Create a token at https://supabase.com/dashboard/account/tokens (read + write access to the PortfolioAI project).
- Provide it in chat or store it as a secret; it will be used only as the `SUPABASE_ACCESS_TOKEN` env var for the deploy command, never committed or printed.

If the token cannot be provided, the alternative is manual deployment by the user with `supabase functions deploy refresh-market-data` from their machine — in that case this plan stops.

## Steps

1. **Pre-flight verification (read-only)**
   - Confirm M13 objects exist via `psql` using the existing DB password (read-only queries only: check `market_price_latest`-related tables from `db/migrations/0013_market_data_foundation.sql`).
   - Confirm the seven `ANGEL_ONE_*` secrets exist on the project via Management API `GET /v1/projects/{ref}/secrets` (names only; values are never returned or printed).
   - Bundle-check the function locally with Deno (`deno check`/`deno bundle` on `index.ts` in a temp copy) to catch compile errors before deploy.

2. **Stage a deploy directory (no repo changes)**
   - Copy `edge-functions/refresh-market-data/` to a temp `supabase/functions/refresh-market-data/` staging layout under `/tmp` (the Supabase CLI requires this layout; the repository itself is not modified).
   - Create a minimal temp `config.toml` for the project ref with `verify_jwt = true` explicitly set for this function (default is already true; this makes the security posture explicit). No other config.
   - Project ref is derived at deploy time from `PORTFOLIOAI_SUPABASE_URL`.

3. **Deploy**
   - Install the Supabase CLI via nix in the sandbox.
   - Run `supabase functions deploy refresh-market-data --project-ref <ref>` with `SUPABASE_ACCESS_TOKEN` set, from the temp staging directory.
   - Do NOT use `--no-verify-jwt`. Do NOT pass any Angel One or database secrets on the command line.

4. **Post-deploy verification (read-only)**
   - `GET /v1/projects/{ref}/functions` via Management API: confirm `refresh-market-data` is listed with status ACTIVE and `verify_jwt: true`.
   - Confirm no invocation is performed: **no** SYNC_MAPPINGS, REFRESH, or full-portfolio refresh is run. Controlled 3–5 security pilot is a separate, later step.

5. **Report and stop**
   - Report only: deployment success/failure and any build/deploy errors.
   - Confirm: no migrations executed, M01–M13 untouched, no transaction/holdings/import changes, no UI changes, no secrets exposed.
   - Note any repo-hygiene follow-ups only if something unexpected was required (expected: none — temp staging lives outside the repo).

## Technical details

- Tooling: Supabase CLI (nix), Deno for local bundle check, `psql` for read-only M13 verification, Management API over HTTPS for function/secret listing.
- Secrets handling: the access token is an env var for the single deploy command; it is never echoed, logged, written to files, or committed. Token output from CLI is not printed beyond status lines.
- Rollback: if deploy fails, nothing changes on the project (functions deploy is all-or-nothing per version); the previously deployed version, if any, remains active.
- Out of scope: Angel One pilot invocation, market-data refresh, any database writes, any repo source edits.
