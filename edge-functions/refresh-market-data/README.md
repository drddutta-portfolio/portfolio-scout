# PortfolioAI — refresh-market-data Edge Function

Server-side Angel One SmartAPI market-data adapter for the dedicated PortfolioAI Supabase project.

## Scope

Current actions:

- `SYNC_MAPPINGS` — map current PortfolioAI holdings to Angel One symbol tokens using exact exchange + primary symbol matching against the official Angel One instrument master.
- `REFRESH` — refresh stale FULL quotes for verified mappings (50 symbols/request, conservative ~1 request/second batching).
- `READ_CACHE` — return cached quote fields to an authenticated client.

Not in scope: orders, trade execution, Angel One demat reconciliation, order-book/trade-book import.

## Required database migration

Deploy and verify `db/migrations/0013_market_data_foundation.sql` first.

## Required Edge Function secrets

Set these only in Supabase Edge Function Secrets. Never commit values to GitHub:

- `ANGEL_ONE_API_KEY`
- `ANGEL_ONE_CLIENT_CODE`
- `ANGEL_ONE_PIN`
- `ANGEL_ONE_TOTP_SECRET`
- `ANGEL_ONE_CLIENT_LOCAL_IP`
- `ANGEL_ONE_CLIENT_PUBLIC_IP`
- `ANGEL_ONE_MAC_ADDRESS`

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions. The service-role key must never be placed in browser/runtime frontend configuration.

## Source layout

This repository deliberately does not use the root `supabase/` migration directory because Lovable reserves it for its own managed database. The canonical Edge Function source is retained here under `edge-functions/refresh-market-data/` and can be copied/deployed to the dedicated Supabase project's `refresh-market-data` function.

## Pilot sequence

1. Deploy M13.
2. Add the seven Angel One secrets.
3. Deploy this Edge Function.
4. Invoke `SYNC_MAPPINGS` with a sample of 3–5 current `securityIds`.
5. Review mapped/unresolved/quarantined counts.
6. Invoke `REFRESH` for the same sample.
7. Verify `market_price_latest` contains no credentials/tokens and the expected quote fields.
8. Only then expand mapping/refresh to the full current portfolio.

The browser cannot bypass the cache TTL or lease/cooldown protection.
