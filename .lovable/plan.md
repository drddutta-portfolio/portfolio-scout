# PortfolioAI — First Functional UI + Migration 09a Prerequisite

Coordinated plan. **Planning only.** Explicitly confirmed: UI not built;
Migration 09a not applied; no migration file created; Supabase not modified; no
securities inserted; no transactions modified; no corporate-action work; no
market data; no engines/AI; no service-role application credential.

(Note: roadmap.md is not edited while in planning mode; it will be updated in
the same change that begins implementation.)

---

# PART A — FINAL FIRST FUNCTIONAL UI BUILD PLAN

## A1. Authentication

Supabase Auth, email/password only. No public signup. Login, forgot-password
request, reset-password landing, persistent session, logout, protected routes.

**Initial-owner provisioning (manual, documented procedure — no auth trigger,
by M02 design):**
1. Create the user in the Supabase dashboard (Authentication → Add user, email +
   password, email confirmed).
2. Copy the new `auth.users.id`.
3. In the SQL editor insert the matching rows (an operator action, run once,
   recorded in `docs/`):
   `insert into public.profiles (id, display_name) values ('<uuid>', '<name>');`
   `insert into public.user_settings (user_id) values ('<uuid>');`
4. Create the first portfolio either in SQL or through the app's Settings screen.

The app additionally self-heals on first authenticated load: if `profiles` /
`user_settings` rows are absent it inserts them under the owner-scoped INSERT
grants (`profiles_insert_own`, `user_settings_insert_own`). This is inside
existing permissions and does not replace the documented procedure.

## A2. Application shell

Desktop-first investment terminal, responsive to tablet/phone. Active nav:
Dashboard, Holdings, Import, Settings. Future modules (Credit Intelligence,
Screener, Analytics) are omitted entirely from the first build — no disabled
teasers with invented data. Dense, calm, no decorative animation, no charts.

## A3. Portfolio context

`public.portfolios`. Active portfolio chosen in the top bar, persisted in
localStorage and validated against the user's own portfolios each load.
Create/edit permitted by existing grants (insert: owner_id, name, description,
base_currency, core_target_count; update: name, description, core_target_count,
archived_at). `base_currency` is shown read-only after creation because it is
insert-only by grant. `core_target_count` is always labelled "target number of
core stocks". No cross-portfolio aggregation.

## A4. Dashboard (Phase 1 facts only)

Holdings count; Core count vs `core_target_count`; Satellite; Thematic;
Watchlist; Unassigned; holdings with unavailable net quantity; negative
quantity; unhandled transaction types; active transaction count; latest import
batch state. Nothing showing value, weight, P&L, return, valuation or price.

## A5–A6. Import: stages and transitions

| # | Stage | Where | What happens |
| --- | --- | --- | --- |
| 1 | Upload | `/import` → NewImportDialog | file chosen; SHA-256 via WebCrypto; nothing written yet |
| 2 | Parse | browser only | CSV parser; XLSX/XLS via a maintained SheetJS-style reader; file never leaves the device |
| 3 | Preview | dialog | first rows shown from the parsed grid |
| 4 | Column mapping | dialog | headers auto-suggested, user confirms; unmapped columns still preserved in `raw_payload` |
| 5 | Stage | on confirm | insert `import_batches` (state UPLOADED) then chunked insert of `import_source_rows`; batch → `PREVIEWED`; navigate to `/import/$batchId` |
| 6 | Validate | workspace, Validate tab | deterministic interpretation writes `candidate_*`, states, issues; batch → `VALIDATED` |
| 7 | Resolve security | Resolve tab | suggestion → explicit confirmation (A7) |
| 8 | Resolve account | Resolve tab | pick existing or create inline (A8) |
| 9 | Review issues | Issues tab | grouped by issue type |
| 10 | Exclude | any row | explicit toggle + reason |
| 11 | Confirm | Confirm tab | summary; batch → `AWAITING_CONFIRMATION` |
| 12 | Commit | Confirm | `rpc('commit_import_batch', { p_batch_id })` |
| 13 | Result | Confirm | inserted/excluded counts, or a plain-language error |
| 14 | Holdings | `/holdings` | queries invalidated, derived positions appear |

Raw values are written verbatim to `raw_*` and `raw_payload`. Nothing missing is
ever coerced to 0 or to today's date.

## A7. Security resolution UX (mandatory rule)

Deterministic lookup order: exact ISIN → exact exchange+symbol → exact
normalized alias (client applies the same normalization rule as
`normalize_alias`: NFKC, strip zero-width, collapse whitespace, trim, uppercase;
punctuation preserved).

- Exactly one hit → **SUGGESTED**: the candidate is displayed with its source
  ("matched by ISIN"), visually distinct (dashed outline, "suggested" chip), and
  the row stays `UNRESOLVED`. Only the user's explicit *Confirm* writes
  `candidate_security_id` + `security_resolution = 'RESOLVED'`.
- More than one hit → `AMBIGUOUS` + `AMBIGUOUS_SECURITY`, all candidates listed,
  user picks one or leaves it.
- No hit → `UNRESOLVED` + `UNRESOLVED_SECURITY`, with an explicit message: "this
  instrument is not in the security master" and guidance that it must be added
  by a reviewed reference-data update.
- Types the ledger cannot accept yet (SPLIT/REVERSAL/ADJUSTMENT) →
  `UNSUPPORTED` + `UNSUPPORTED_CORPORATE_ACTION`; these can only be excluded.
- No fuzzy matching, no scoring, no auto-confirm. No browser writes to
  `securities` or `security_aliases`.

## A8. Broker account resolution

Existing account picker grouped by broker, or inline creation (broker from
`brokers`, nickname, optional masked reference) using the M03 owner-scoped
insert grant. Accounts are never merged or invented; the same broker may hold
several distinct accounts. Unknown institution → `MISSING_BROKER`; institution
known but account unidentified → `MISSING_ACCOUNT`. Both block commit.

## A9. Validation

`VALID` / `INCOMPLETE` / `NEEDS_REVIEW` shown as distinct badges with the full
`data_quality_issues` list spelled out in words. A row is presented as ready
only when it is `RESOLVED` + `VALID` with zero issues — the same condition the
RPC enforces. No issue is ever fabricated to satisfy UI logic; the initial
staged row legitimately carries `UNRESOLVED` with an empty issue array.

## A10. Excluded rows

Explicit `resolution = 'EXCLUDED'` with a reason recorded in
`duplicate_reason`-style free text where appropriate. Preserved, listed in their
own tab and in the confirm summary, never auto-deleted, never committed.

## A11. Final confirmation

Shows target portfolio, source filename, file hash, total source rows, ready
rows, excluded rows, unresolved rows, incomplete rows, needs-review rows.
Confirm is enabled only when zero rows are `UNRESOLVED` and at least one row is
committable. The action calls `commit_import_batch(batch_id)` and nothing else;
no economics are re-sent. Errors are mapped: `55006` already in progress,
`22023` batch/row not ready (row number surfaced), `40002` inconsistent data,
`42501` not found or not yours, `28000` signed out. **No automatic retry.**

## A12. Holdings

`current_holdings` joined to `securities` (name, primary_symbol, exchange,
asset_class) and `portfolio_security_settings` (role, notes). Columns: security,
symbol/exchange, asset class, net quantity, role, active txn count, first trade
date, last trade date, disclosure state.

Quantity states: number → shown; NULL → **UNAVAILABLE** with the specific reason
("affected by SPLIT/REVERSAL/ADJUSTMENT — corporate-action handling not
implemented" when `unhandled_txn_count > 0`, or "a contributing transaction has
no quantity" when `missing_quantity_count > 0"`), never 0; negative → shown and
flagged as a probable source/accounting problem; `non_valid_txn_count > 0` → its
own badge. Filters/sorts: name/symbol search, role, quantity, unavailable,
negative, unhandled, unassigned. No value or weight.

## A13. Role management

Inline select per holding writing `portfolio_security_settings`
(insert-or-update on owner+portfolio+security), values CORE / SATELLITE /
THEMATIC / WATCHLIST / UNASSIGNED, plus a notes dialog (≤4000 chars). Role is
independent of asset class and of data quality. No role history.

## A14. Settings

Profile (display name); Preferences (locale, timezone, date format, number
locale); Portfolios (create, rename, description, core target count, archive);
Broker accounts (broker, nickname, masked reference, archive). No credentials,
keys or secrets anywhere in the product.

## A15. Data-access map (object → operation → permitting rule)

| Surface | Object | Ops | Permitted by |
| --- | --- | --- | --- |
| Bootstrap | `profiles` | SELECT, INSERT(id, display_name), UPDATE(display_name) | M02 grants + `profiles_*_own` |
| Bootstrap | `user_settings` | SELECT, INSERT, UPDATE(locale, timezone, date_format, number_locale) | M02 grants + `user_settings_*_own` |
| Shell / Settings | `portfolios` | SELECT, INSERT(owner_id,name,description,base_currency,core_target_count), UPDATE(name,description,core_target_count,archived_at) | M03 grants + `portfolios_*_own` |
| Settings / Import | `brokers` | SELECT | `brokers_select_all` |
| Settings / Import | `broker_accounts` | SELECT, INSERT(owner_id,broker_id,nickname,account_ref_masked), UPDATE(nickname,account_ref_masked,archived_at) | M03 grants + `broker_accounts_*_own` |
| Import | `import_batches` | SELECT, INSERT(state UPLOADED), UPDATE(state→PREVIEWED/VALIDATED/AWAITING_CONFIRMATION/REJECTED, counters, error_summary), DELETE(deletable states) | M06 grants + four `import_batches_*` policies |
| Import | `import_source_rows` | SELECT, INSERT(raw_* only), UPDATE(candidate_*, resolutions, quality, duplicate_*), DELETE(pre-commit) | M06 grants + four `import_source_rows_*` policies |
| Resolve | `securities`, `security_aliases` | SELECT only | M04 `*_select_all` |
| Commit | `commit_import_batch(uuid)` | EXECUTE | M07 grant to `authenticated` |
| Holdings/Dashboard | `current_holdings` | SELECT | M08 grant (security_invoker view) |
| Holdings/Dashboard | `transactions` | SELECT only | M05 grant — **no browser write path, by design** |
| Holdings | `portfolio_security_settings` | SELECT, INSERT, UPDATE(role, notes), DELETE | M08 grants + four `pss_*_own` policies |

Backend gaps (no workaround invented): (i) security master is empty →
**Part B**; (ii) alias confirmation cannot be persisted for reuse across imports
(aliases are read-only) — resolution stays per-row in v1; (iii) no auth→profile
trigger — handled by the documented manual procedure in A1.

## A16. Routes and components

```text
/login  /forgot-password  /reset-password        public
/                                                 redirect -> /dashboard
_authenticated (pathless gate + AppShell)
  /dashboard  /holdings  /import  /import/$batchId  /settings
```

```text
AppShell: SidebarNav, TopBar(PortfolioSwitcher, UserMenu)
Dashboard: StatCard, RoleMixCard, DataQualityCard, LatestImportCard
Holdings: HoldingsToolbar, HoldingsTable, QuantityCell, StatusBadges,
          RoleSelect, NotesDialog
Import: BatchList, NewImportDialog(FileDropzone, PreviewGrid, ColumnMapper)
ImportWorkspace: StepHeader, RowTable(virtualised), RowDetailPanel,
          SecurityResolver, BrokerAccountResolver, InlineAccountDialog,
          IssueList, ExcludeToggle, ConfirmSummary, CommitResult
Shared: StateBadge, UnavailableValue, EmptyState, ErrorState, LoadingSkeleton,
          ConfirmDialog
```

Loading: skeleton rows, never spinners over stale numbers. Empty: purposeful
first-run copy ("no imports yet"). Error: message + retry, plus a distinct
non-retryable variant for data-consistency errors. Responsive: tables become
stacked cards below `md`; the import workspace requires ≥`md` and says so.

## A17. State architecture

Session in a small `AuthProvider` (one `onAuthStateChange` subscriber at root).
Active portfolio in `PortfolioProvider` (localStorage, validated). Server state
entirely in TanStack Query, keys scoped by portfolio/batch. Parser output is
transient component state, discarded once rows are staged. Wizard step lives in
the URL search params so refresh is safe. Nothing else global.

## A18. Test plan

Login/session protection and deep-link redirect; manually provisioned owner can
sign in and reach the dashboard; portfolio selection persists and rejects a
foreign id; CSV, XLSX and XLS parse with values preserved; staging writes raw
rows only; suggestion appears without resolving; explicit confirmation resolves;
ambiguous and unresolved stay explicit; inline broker-account creation; missing
account blocks commit and stays distinct from missing broker; each validation
state renders correctly; excluded row preserved and not committed; successful
commit; failed commit per errcode with no auto-retry; idempotent retry after
COMMITTED returns already-committed; holdings derivation; NULL holding shown as
unavailable; negative holding flagged; role assignment round-trips; cross-user
isolation; direct `transactions` insert rejected.

## A19. UI implementation order

1. Auth + provisioning + session gate. 2. Shell, nav, portfolio context, design
tokens. 3. Settings (portfolios, broker accounts). 4. Holdings + roles.
5. Dashboard. 6. Import upload/parse/stage/preview. 7. Validation + resolution +
exclusion. 8. Confirm + commit + results. 9. Tests and polish.

---

# PART B — MIGRATION 09a SECURITY MASTER PREREQUISITE

## B1. Deployed M04 assessment

Verified from the applied migration: `securities(id, asset_class, name, isin,
exchange, primary_symbol, currency, is_active, delisted_on, archived_at,
timestamps)` with partial unique ISIN, partial unique (exchange, primary_symbol),
and a check that a symbol requires an exchange; `security_aliases(security_id,
alias_type, alias_value, alias_normalized generated, source, exchange)` with a
unique context key `(alias_type, coalesce(source,''), coalesce(exchange,''),
alias_normalized)` and per-type constraints; `normalize_alias` immutable, EXECUTE
revoked from PUBLIC/anon/authenticated; both tables SELECT-only for the browser
under RLS. **No incompatibility with Part A.** The one structural consequence to
respect: `securities` allows only one `(exchange, primary_symbol)` pair per row,
so exchange-specific symbols beyond the primary must live in aliases.

## B2. Canonical identity model

One `securities` row = one economic instrument, keyed by authoritative ISIN when
one exists.
- NSE equity, BSE equity, and the same company listed on both → **one row**
  (same ISIN), with `exchange`/`primary_symbol` set to the primary listing
  (NSE where listed, otherwise BSE) and the other exchange's symbol/code held as
  an `EXCHANGE_SYMBOL` alias carrying its exchange.
- ETF, REIT, InvIT, bond → same rule; distinguished by `asset_class`.
- Symbol change → update `primary_symbol`, keep the old one as `LEGACY_SYMBOL`.
  Never a new row.
- ISIN change → not resolved by 09a; flagged for review (a corporate-action
  concern). No row is deleted or merged automatically.
- Delisted/inactive → `is_active = false`, `delisted_on` set; the row stays
  forever so ledger lineage survives.
- Never merge two instruments on name similarity alone.

## B3. Authoritative sources (to be verified at artifact-build time, not from
model memory)

| Source | Authority | Coverage | Fields | Format | Notes |
| --- | --- | --- | --- | --- | --- |
| NSE official equity/ETF security lists | Exchange (primary) | NSE listed | symbol, name, ISIN, series, listing date, face value | CSV download | Series letter distinguishes EQ/BE/ETF/debt |
| BSE official "List of Scrips" | Exchange (primary) | BSE listed | scrip code, scrip id, name, ISIN, group, instrument type, status | CSV/XLS download | Gives the BSE numeric code |
| NSDL / CDSL ISIN directories | Depository (authoritative for ISIN) | All Indian ISINs | ISIN, issuer, instrument description, status | published files | Use to arbitrate ISIN conflicts |
| SEBI / AMFI listings | Regulator / industry body | funds, InvIT/REIT registers | scheme or entity identity | published files | Only for classification support |

Rule: exchange files supply symbols and listing status; the depository file is
the tie-breaker for ISIN identity. Each file's licensing/terms of use must be
read and recorded before it is used; nothing is scraped from an unofficial
mirror, and no security is invented.

## B4. Initial universe — recommendation

**Option C: a controlled, broad-but-bounded subset with a defined update path.**
Option A (only what the user holds) breaks watchlists, screening and future
purchases the moment the user looks beyond current holdings. Option B (everything
listed) drags in thousands of illiquid, suspended and debt instruments that add
ambiguity with no Phase-1 benefit.

Proposed 09a scope: all currently-active NSE and BSE **equity** listings in the
normal trading series, plus listed **ETFs, REITs and InvITs**. Excluded from 09a:
debt/SME/suspended/delisted series, mutual-fund schemes, and derivatives — each
added later by a reviewed additive update when a real need appears.

## B5. Securities vs aliases

| Fact | Location |
| --- | --- |
| ISIN | `securities.isin` (also an `ISIN` alias for lookup symmetry) |
| canonical symbol + its exchange | `securities.primary_symbol` + `securities.exchange` |
| other exchange's symbol / BSE scrip code | `security_aliases` type `EXCHANGE_SYMBOL` with that `exchange` |
| company/security name | `securities.name`, plus a `COMPANY_NAME` alias |
| legacy symbol | `LEGACY_SYMBOL` alias |
| broker-specific symbol | `BROKER_SYMBOL` alias with `source` — **not seeded by 09a** |
| free import text | `IMPORT_TEXT` alias — **not seeded by 09a** |

Only alias types the constraints support are used, and only where evidence
exists.

## B6. Same instrument on NSE and BSE (worked example)

Authoritative ISIN `INE000A01001`, NSE symbol `EXAMPLE`, BSE code `500001`.

- `securities` rows: **1**. `isin = INE000A01001`, `exchange = 'NSE'`,
  `primary_symbol = 'EXAMPLE'`, `asset_class = 'EQUITY'`, `currency = 'INR'`.
- aliases: `ISIN/INE000A01001`; `EXCHANGE_SYMBOL/EXAMPLE` (exchange NSE);
  `EXCHANGE_SYMBOL/500001` (exchange BSE); `EXCHANGE_SYMBOL/EXAMPLE`
  (exchange BSE) if BSE also publishes that scrip id; `COMPANY_NAME/...`.
- NSE import: raw symbol `EXAMPLE` → exact `(NSE, EXAMPLE)` on `securities` →
  suggested → confirmed.
- BSE import: raw `500001` → exact alias hit on `(EXCHANGE_SYMBOL, '', BSE,
  500001)` → same security → suggested → confirmed.
- ISIN in the file → direct hit either way.

The unique context key keeps the two exchanges' entries distinct, so nothing is
silently merged. M04 represents this correctly; no schema change is needed.

## B7. Provenance

Documentation and artifact-level provenance only — **no new database columns**.
The seed artifact records, per source file: publisher, file name, download URL,
retrieval timestamp, SHA-256, row count, and the generator script version; the
migration header names the artifact and its hashes. A future provenance table
can be added if evidence-per-row is ever required; it is not required now.

## B8. Deterministic deduplication rules

- Same ISIN across NSE and BSE files → one security; second file contributes
  aliases only.
- Duplicate ISIN with materially different issuer names → **excluded from the
  seed** and listed in a review file. Never auto-resolved.
- Missing ISIN → row is seeded only if `(exchange, symbol)` is unique in the
  source; otherwise excluded for review.
- Duplicate symbol on the same exchange → excluded for review.
- Symbol reused historically by a different ISIN → the active listing takes
  `primary_symbol`; the historical one becomes a `LEGACY_SYMBOL` alias **only**
  when the depository file confirms the linkage; otherwise excluded.
- Conflicting names/classes between sources → depository wins for identity,
  exchange wins for symbol and status; unresolved conflicts are excluded.
- Names are never a deduplication key. Every exclusion stays visible in the
  review artifact rather than being quietly dropped.

## B9. Asset-class mapping

Driven by the source's own instrument/series/type field, not by guesswork:
equity series → `EQUITY`; exchange-traded funds → `ETF`; REIT register → `REIT`;
InvIT register → `INVIT`; debt instruments (if ever seeded) → `BOND`;
fund schemes → `MUTUAL_FUND`; anything the source labels but we cannot map →
`OTHER`; anything the source leaves unlabelled → `UNKNOWN`. Nothing defaults to
`EQUITY`.

## B10. Loading mechanism — recommendation

**A reviewed, generated deterministic seed artifact applied as a migration
file.** A build script (run locally, not in the app) reads the downloaded source
files, applies B8, and emits: (i) `db/migrations/0009a_security_master_seed.sql`
containing literal, ordered `INSERT ... ON CONFLICT DO NOTHING` statements, and
(ii) a review report of counts and exclusions. The SQL is reviewed as an artifact
before it is applied, exactly like every prior migration. No browser writes, no
service-role application credential, no private credential in GitHub, no runtime
network fetch by the app.

## B11. Idempotency and historical safety

`ON CONFLICT DO NOTHING` against the ISIN and (exchange, symbol) unique indexes
and against the alias context key. Never `UPDATE` an existing row, never delete
or recreate a security, never reassign an alias to a different security, never
resolve a conflict silently. Existing `transactions.security_id` lineage is
therefore permanent by construction, and a re-run changes nothing.

## B12. Future updates (planned, not built)

Later additive migrations, each reviewed: new listings and IPOs → insert-only;
symbol change → update `primary_symbol` + add `LEGACY_SYMBOL`; ISIN change and
mergers/demergers → deferred to corporate-action work, never an ad-hoc merge;
delisting → set `is_active = false` and `delisted_on`; new ETF/REIT/InvIT →
same insert path; broker aliases discovered during imports → a future reviewed
write path (does not exist today; see the A15 gap). 09a stays bounded to the
initial seed.

## B13. UI-compatibility demonstration

Broker file row "EXAMPLE / INE000A01001 / 10 / 2026-04-01 / BUY" → client
normalizes → exact ISIN hit in the seeded master → **suggested** candidate shown
→ user confirms → `candidate_security_id` set, `security_resolution = RESOLVED`
→ account chosen → `resolution = RESOLVED`, `data_quality_state = VALID`, empty
issues → batch `AWAITING_CONFIRMATION` → `commit_import_batch` inserts the
canonical transaction with lineage → `current_holdings` shows net quantity 10.
Every step is exercised by permissions that already exist plus the 09a data.

## B14. 09a tests (for its own deployment turn)

Row counts by asset class; zero duplicate ISINs; zero duplicate
(exchange, symbol); every alias resolves to an existing security; NSE/BSE shared
ISIN produces exactly one security with both exchange aliases; re-running the
migration inserts nothing; RLS and grants unchanged; browser still cannot write;
M01–M08 regression; the B13 lookup chain succeeds against real seeded rows.

---

# PART C — EXECUTION SEQUENCE

1. Review and approve this combined plan.
2. Build the 09a seed artifact from authoritative sources and present the exact
   migration SQL plus the exclusion report for review.
3. Review Migration 09a.
4. Deploy and verify Migration 09a.
5. **Stop database expansion.**
6. Build the First Functional UI in the A19 order.
7. Test end-to-end with representative broker files (CSV, XLSX, XLS).
8. Fix only genuine integration defects — no scope growth.
9. Only once the UI is stable, consider corporate actions or deterministic
   engines.

No corporate actions, market data, engines, credit or AI are recommended before
the First Functional UI; no blocking dependency on them was found.
