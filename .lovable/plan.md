# PortfolioAI — First Functional UI (Phase 1)

Planning only. Built entirely on the deployed M01–M08 backend.

Explicit confirmations: no Migration 09, no schema changes, no corporate-action
modelling, no market data, no P&L or cost basis, no AI/engines, no service-role
application credential.

## 0. Backend gaps found (blocking, verified in the deployed SQL)

1. **Security master is empty and browser-read-only.** `securities` /
   `security_aliases` have `SELECT` only for `authenticated`, and no rows were
   ever seeded. `import_source_rows_security_state_ck` requires
   `candidate_security_id` for `security_resolution = 'RESOLVED'`, and
   `commit_import_batch` requires RESOLVED rows. **Therefore no import can be
   committed until reference securities exist.** Agreed resolution: a separate,
   separately reviewed seed migration (call it 09a) is a prerequisite for the
   Import → Commit half of the UI. The UI is designed and built to work the
   moment that data exists; nothing is invented or worked around here.
2. **No public signup.** Users are created manually in the Supabase dashboard.
   The app ships login + password reset only.
3. **No profile auto-creation trigger.** `profiles` has an owner-scoped INSERT
   grant, so the app self-provisions the caller's `profiles` row (and
   `user_settings` row) on first authenticated load. This is inside existing
   grants — no backend change.
4. **No alias-confirmation write path.** Confirming "this source text means this
   security" cannot be persisted (aliases are read-only). Resolution is
   per-import-row only; a future reviewed migration would add reusable mappings.

Everything else in the requested journey is supported by existing grants/RLS.

## 1. Route map

```text
/login                       public — email/password
/forgot-password             public — request reset email
/reset-password              public — token landing, set new password
/                            redirect -> /dashboard
/_app                        protected layout (session gate + shell)
  /dashboard
  /holdings
  /import                    batch list + new upload
  /import/$batchId           workspace: preview / resolve / review / confirm
  /settings                  tabs: profile, preferences, portfolios, accounts
```

Protection uses a `_authenticated`-style pathless layout whose loader/component
waits for the Supabase session and redirects to `/login` otherwise. All data is
fetched client-side (the browser client holds the session; no server function
touches user data), so no protected loader runs during prerender.

## 2. Component hierarchy

```text
AppShell
  SidebarNav (Dashboard, Holdings, Import, Settings; future items omitted)
  TopBar (PortfolioSwitcher, user menu -> Settings, Logout)
  <Outlet/>

Dashboard        StatCard, RoleMixCard, DataQualityCard, LatestImportCard
Holdings         HoldingsToolbar (search/filter/sort), HoldingsTable,
                 HoldingRow -> QuantityCell, StatusBadges, RoleSelect, NotesDialog
Import           BatchList, NewImportDialog(FileDropzone)
ImportWorkspace  StepHeader (Upload>Preview>Validate>Resolve>Review>Confirm)
                 RowTable (virtualised), RowDetailPanel,
                 SecurityResolver, BrokerAccountResolver (+ inline create),
                 IssueList, ExcludeToggle, CommitPanel
Shared           StateBadge, EmptyState, ErrorState, LoadingSkeleton,
                 UnavailableValue ("—" + reason tooltip, never 0)
```

## 3. User journey

Login → shell loads profile/settings/portfolios → pick active portfolio (stored
in localStorage, validated against the user's portfolios) → Import → upload file
→ rows staged raw → preview → validate → resolve securities/accounts → exclude
what shouldn't post → confirm → `commit_import_batch` → Holdings shows derived
positions → assign roles → Dashboard counts update.

## 4. Data per screen (exact objects)

| Screen | Reads | Writes |
| --- | --- | --- |
| Bootstrap | `profiles`, `user_settings`, `portfolios` | insert own `profiles`, `user_settings` if absent |
| Dashboard | `current_holdings`, `portfolio_security_settings`, `transactions` (count), `import_batches` (latest) | none |
| Holdings | `current_holdings` + `securities` (name/symbol/exchange) + `portfolio_security_settings` | insert/update `portfolio_security_settings` (role, notes) |
| Import list | `import_batches` | insert `import_batches` (UPLOADED); delete own batch in deletable states |
| Preview/Validate/Resolve | `import_source_rows`, `securities`, `security_aliases`, `brokers`, `broker_accounts` | insert raw rows; update candidate/resolution/quality columns; update batch `state`, counters; insert `broker_accounts` inline |
| Confirm | aggregate counts from `import_source_rows` | `rpc('commit_import_batch', { p_batch_id })` |
| Settings | `profiles`, `user_settings`, `portfolios`, `brokers`, `broker_accounts` | update profile/settings; insert/update portfolios; insert/update/archive broker accounts |

`public.transactions` is never written from the browser (no grant, by design).

## 5. State management

- TanStack Query for all server state; query keys namespaced by user + active
  portfolio (`['holdings', portfolioId]`, `['batch', batchId, 'rows']`).
- Supabase session in a small `AuthProvider` around the protected layout,
  subscribing to `onAuthStateChange`; sign-out clears the query cache.
- Active portfolio in a `PortfolioProvider` (localStorage-backed, validated).
- Local-only UI state (filters, sort, step) in component state / URL search
  params so the import workspace is refresh-safe.
- Mutations invalidate precisely; no optimistic writes on anything that changes
  resolution or batch state.

## 6. Import parsing

- Parsing happens entirely in the browser; the file itself is never uploaded
  anywhere. CSV via a small parser, XLSX/XLS via SheetJS-style reader (new
  frontend dependency, approved).
- `source_format` set to `CSV` / `XLSX` / `XLS` (values already allowed by the
  check constraint). No enum change.
- SHA-256 of the file bytes computed with WebCrypto → `file_sha256`, plus
  `file_size_bytes`, `mime_type`, `original_filename`, `client_request_id`
  (idempotent re-upload guard), `total_source_rows`.
- Column mapping step: header row auto-suggested, user confirms the mapping.
  Every raw cell is written verbatim to `raw_*` and the whole row to
  `raw_payload`. Nothing is coerced at insert time — raw stays raw.
- Rows inserted in chunks while the batch is `UPLOADED`, then batch → `PREVIEWED`.

## 7. Validation workflow

Client-side interpretation writes only `candidate_*`, `security_resolution`,
`resolution`, `data_quality_state`, `data_quality_issues`:

- Unparseable number/date → candidate stays NULL and an issue is recorded
  (`MISSING_QUANTITY`, `MISSING_DATE`, `MISSING_PRICE`). Never 0.
- Security: exact match on ISIN, then exchange+symbol, then normalized alias.
  One exact hit → suggested candidate, marked *suggested* in the UI until the
  user confirms; several hits → `AMBIGUOUS` + `AMBIGUOUS_SECURITY`; none →
  `UNRESOLVED` + `UNRESOLVED_SECURITY`. Types the ledger can't take yet
  (SPLIT/REVERSAL/ADJUSTMENT) → `UNSUPPORTED` +
  `UNSUPPORTED_CORPORATE_ACTION`. No fuzzy scoring auto-selects anything.
- Broker account: matched only on an explicit user mapping of the raw broker/
  account text to one of their `broker_accounts`; unknown institution →
  `MISSING_BROKER`, known but unidentified account → `MISSING_ACCOUNT`. Each
  demat account stays distinct; rows are never merged by security.
- Duplicates: fingerprint over (account, security, type, date, quantity, price)
  → `duplicate_of_row_id` + `DUPLICATE_SUSPECTED`, flagged, never removed.
- A row becomes `RESOLVED` only with security + type + date + quantity +
  currency + account present and zero issues; the DB check constraints enforce
  this independently.
- Batch state moves `PREVIEWED → VALIDATED → AWAITING_CONFIRMATION` (all inside
  the browser's UPDATE policy); `COMMITTING/COMMITTED/FAILED` are trusted-only.

## 8. Excluded rows

`resolution = 'EXCLUDED'` via an explicit toggle with a reason note. Excluded
rows stay in the table, appear in a dedicated "Excluded" tab and in the confirm
summary, and never produce transactions. Nothing is auto-deleted.

## 9. Confirmation and commit

Confirm screen: total staged, committable (RESOLVED+VALID+no issues), excluded,
unresolved/problem rows, target portfolio, source filename, file hash. Confirm
is enabled only when zero rows remain `UNRESOLVED` and at least one is
committable — mirroring the RPC's own preconditions.

Action calls only `commit_import_batch(batch_id)`. No economics re-sent. Error
codes are surfaced with plain-language meaning: `55006` already in progress,
`22023` not ready / row problem (shows the row number from the message),
`40002` inconsistent data — **no automatic retry**; `42501` not found/not yours.
Success shows inserted/excluded counts and links to Holdings.

## 10. Holdings presentation

From `current_holdings` joined to `securities` and the user's role settings:
security (name, symbol, exchange), net quantity, role, active txn count, first
and last trade date, disclosure badges.

Quantity cell states:
- number → plain value;
- `net_quantity IS NULL` → **UNAVAILABLE** (never 0) with the reason:
  "affected by SPLIT/REVERSAL/ADJUSTMENT — corporate-action handling not
  implemented yet" or "a contributing transaction has no quantity";
- negative → flagged as a probable source/accounting problem, still shown;
- `unhandled_txn_count > 0`, `missing_quantity_count > 0`,
  `non_valid_txn_count > 0` → distinct badges, each with its own wording.

Filters/sorts: text search on name/symbol, role, quantity, unavailable-quantity,
negative, unhandled, unassigned. Nothing requiring prices.

## 11. Role management

Inline `RoleSelect` per holding writing `portfolio_security_settings`
(insert-or-update on owner+portfolio+security), values CORE / SATELLITE /
THEMATIC / WATCHLIST / UNASSIGNED, plus a notes dialog (≤4000 chars). Role is
explicitly independent of asset class and of data quality. Dashboard shows
"Core: n of target m" where m is `portfolios.core_target_count` — labelled a
**stock-count target**, never a percentage. No role-history UI.

## 12. Settings

Tabs: Profile (display name), Preferences (locale, timezone, date format,
number locale), Portfolios (name, description, core target count, archive;
base currency shown read-only after creation because it is insert-only by
grant), Broker accounts (broker, nickname, masked reference, archive). No
credentials, no API keys, anywhere.

## 13. Dashboard (Phase 1 metrics only)

Holdings count; holdings with a role assigned; Core vs core target; Satellite;
Thematic; Watchlist; Unassigned; unavailable-quantity count; negative-quantity
count; unhandled-transaction-affected count; total active transactions; latest
import batch (filename, state, counts, time). No value, weight, P&L, return or
chart of any kind.

## 14. Visual design

Desktop-first, responsive down to tablet/phone (tables collapse to stacked
cards). Restrained investment-terminal look: neutral dark-capable palette with a
single accent, one grotesque/mono pairing for figures, tabular numerals, dense
but airy tables, semantic status badges (neutral grey for *unavailable*, amber
for *needs review*, red only for genuine problems), no animation beyond
transitions, no charts, no placeholder numbers. All colours as design tokens.

## 15. Test plan

Login and session protection; redirect of unauthenticated deep links; logout
clears cache. Portfolio selection persists and rejects a foreign id. CSV and
XLSX parse into raw rows with values preserved verbatim. Validation display for
each issue type. Unresolved security blocks confirm. Missing account blocks
confirm and stays `MISSING_ACCOUNT` (distinct from `MISSING_BROKER`). Excluded
row survives and never posts. Successful commit inserts exactly the committable
rows and freezes the batch. Commit error paths per errcode with no auto-retry.
Holdings derivation, NULL quantity rendered as unavailable, negative shown.
Role assignment round-trips. Cross-user isolation (second account sees nothing).
Direct `transactions` insert from the browser is rejected.

## 16. Implementation order

1. Auth (login, reset, session gate) + profile/settings self-provisioning.
2. App shell, navigation, portfolio context, design tokens.
3. Settings (portfolios, broker accounts) — needed before import is useful.
4. Holdings + role management (works with any transactions that exist).
5. Dashboard metrics.
6. Import: upload/parse/stage → preview.
7. Validation + resolution + exclusion.
8. Confirm + trusted commit + result handling.
9. Tests and polish.

Steps 6–8 can be built and unit-tested before the security seed exists, but
end-to-end commit cannot be exercised until the separately reviewed seed
migration lands.

## 17. Noted for later (not in this UI)

Weighted-average cost was raised as a candidate cost-basis method (e.g. 10 @ 100
plus 10 @ 150 gives an average of 125; selling 12 @ 200 realises 900 and leaves 8
units at 1,000 remaining cost). This is recorded only as a future decision input.
Phase 1 shows no cost basis, no realised or unrealised P&L, and assumes no
accounting method — the interface stays replaceable, exactly as approved.

