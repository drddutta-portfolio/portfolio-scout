# PortfolioAI — backfill-market-eod Edge Function

Controlled historical EOD OHLCV backfill for PortfolioAI using Angel One SmartAPI.

## Purpose

This function is intentionally separate from `refresh-market-data` so the stable live-quote path is not disturbed while historical data is introduced.

It writes only to the existing `public.market_price_history_eod` provider-observation table created by migration `0013_market_data_foundation.sql`. It never changes transactions, holdings quantities, cost basis, or portfolio accounting.

## Pilot contract

Authenticated request body:

```json
{
  "action": "BACKFILL_EOD",
  "portfolioId": "<portfolio uuid>",
  "securityIds": ["<1 to 5 current open security uuids>"],
  "fromDate": "2025-09-11",
  "toDate": "2026-09-10"
}
```

Safety constraints:

- 1–5 securities per request during the pilot.
- Every security must be a current open holding in the selected portfolio.
- Only stored `VERIFIED` Angel One mappings are eligible.
- Date range must use `YYYY-MM-DD`, cannot extend into the future, and is capped at 730 days for the pilot.
- Uses Angel One `ONE_DAY` candles only.
- Requests are spaced by 500 ms, which is more conservative than the documented 3 requests/second historical API limit.
- Uses the existing `BACKFILL_EOD` lease/cooldown and `market_data_refresh_runs` audit trail from migration 0013.
- Upsert identity is `(security_id, provider_code, trade_date)`, so reruns are idempotent.
- Browser never receives or stores Angel One credentials.

## Provider endpoint

`POST /rest/secure/angelbroking/historical/v1/getCandleData`

Returned rows are interpreted as:

`[timestamp, open, high, low, close, volume]`

and stored with provenance in `market_price_history_eod`.

## Deployment

The GitHub workflow `.github/workflows/deploy-backfill-market-eod.yml` stages this directory in Supabase CLI format and deploys the function with JWT verification enabled.

It uses the same existing GitHub deployment secrets and the same seven Angel One Supabase Edge Function secrets already used by live market data. No additional credential is required.

## Expansion rule

Do not expand beyond the five-security pilot until:

1. deployment succeeds;
2. one controlled 1-year pilot succeeds;
3. row count/date coverage/OHLCV sanity are verified in Supabase;
4. provider throttling behavior is confirmed in production.
