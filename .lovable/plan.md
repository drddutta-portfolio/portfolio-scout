# Multi-Sheet Workbook Import (Portfolio-101 format)

Extends the existing import screens so a workbook like Portfolio-101.xlsx can be
brought in end to end. No database changes: M01–M09a stay frozen, transactions are
still created only through the trusted commit path.

## What the workbook contains

- TRANSACTIONS — 966 rows, 479 real trades (421 Buy, 58 Sell), 487 blank filler rows.
  296 real trades have no date. Broker filled on 366 rows (Motilal, Sharekhan,
  Angelone, Zerodha, INDMoney).
- HOLDINGS — 999 rows, 272 tickers; totals derived from the trades.
- STOCKMASTER — company name, sector, symbol, series, ISIN, market cap, cap category.

## Decisions taken

1. Trades are the only thing imported. HOLDINGS is used purely as a check.
2. Undated trades are staged and held as incomplete; they are never finalised until
   a date is supplied. No date is ever invented.
3. Trades with no broker are flagged as missing an account and stay visible.
4. STOCKMASTER helps match tickers in the browser, and where it carries an ISIN that
   confirms a match, that ISIN is shown and can be used to confirm the security.
   Nothing is written to the security list.

## Import flow changes

1. Sheet picker: when a workbook has more than one sheet, the upload step lists the
   sheets and identifies TRANSACTIONS, HOLDINGS and STOCKMASTER by their headings.
   The user confirms which sheet holds the trades.
2. Blank-row filter: rows with no ticker and no units are dropped before staging,
   with the count shown ("487 empty rows skipped").
3. Auto-mapping for the TRANSACTIONS layout: Date, Buy/Sell, Ticker, Units,
   Price/Unit, Invested Value, Broker. Buy/Sell maps to the supported buy and sell
   types; anything else stays unmapped and is flagged, never guessed.
4. Row status after validation:
   - complete trades → ready to confirm
   - no date → incomplete, "date missing", excluded from commit
   - no broker/account → "account missing", excluded from commit until assigned
   Both can be fixed inline in the review table, one row or in bulk by selection.
5. Security matching: ticker matched against the live security list; a STOCKMASTER
   ISIN for the same row is shown as supporting evidence and, when it matches a
   security's ISIN exactly, is offered as the stronger match. Every match still
   requires explicit confirmation.
6. Broker accounts: existing inline creation is reused; a per-broker-name mapping
   panel lets each distinct broker name in the file be pointed at an account once.

## Reconciliation view

After a commit, the batch page gains a comparison table: for each ticker, the units
the app calculated from committed trades next to the units the HOLDINGS sheet claims,
with the difference. Rows that cannot be compared (undated or unassigned trades still
pending) are labelled INSUFFICIENT_DATA rather than showing a false match. No prices,
values or profit figures from the workbook are displayed as app facts.

## Manual trade entry

Currently trades can only come from a file. A new "Add trade" form is added on the
import screen and the dashboard:

- Fields: date (required — but empty stays NULL and the trade is held, never
  guessed), buy/sell, security (picked with the same deterministic search and
  explicit confirmation as imports), units, price, charges, broker account.
- A manual entry goes through the exact same trusted path as files: it is staged in a
  batch of format MANUAL, validated, confirmed and committed by the existing commit
  step. No direct writing of trades, no separate bookkeeping route.
- Each manual entry gets its own small batch so its history stays traceable; the
  batch is labelled "Manual entry" with the entry time.
- Broker account can be created inline, exactly as in file imports.

## Explicitly not included

Cost basis, average buy price, invested/current value, profit and loss, sector and
category columns are read but not stored or presented as portfolio facts. Corporate
actions remain unhandled.

## Technical notes

- `src/lib/parse-file.ts`: return all sheets with headers, add sheet selection; keep
  raw text preservation and the WebCrypto SHA-256 of the original file.
- `src/lib/import-logic.ts`: workbook-shape detection, mapping hints for the
  TRANSACTIONS headers, blank-row filter, bulk fix helpers.
- `src/lib/security-resolution.ts`: optional ISIN hint from STOCKMASTER, exact match
  only, still SUGGESTED until confirmed.
- `src/routes/_app.import.index.tsx`: sheet picker, skipped-row count, broker mapping.
- `src/routes/_app.import.$batchId.tsx`: per-row incomplete reasons, bulk fills,
  reconciliation table.
- Tests: blank-row filtering, mapping detection, undated rows never eligible,
  missing-account flagging, reconciliation differences, ISIN-assisted matching.
