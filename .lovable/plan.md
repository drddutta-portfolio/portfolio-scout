# PortfolioAI — Phase 0 and Phase 1 Plan

## 1. Understanding of PortfolioAI

A private, single-owner decision-support terminal for Indian equities. It answers: what do I own, is each holding healthy, what should be added/held/reduced/promoted/demoted/exited, what changed the thesis, and is a good company also a good position at a good price today.

Non-negotiables carried into every design decision below:
- Transactions are the accounting truth; holdings are derived, never a second ledger.
- Missing is missing — never zero, never a negative judgement. NOT_RATED / NOT_COVERED are neutral.
- Scores are deterministic and versioned; AI (later phase) only explains and never overrides.
- Core / Satellite / Thematic / Watchlist are roles, separate from asset class. Core target ≈ 35 stocks by count.
- Quality–Growth is diagnostic, not a gate. Momentum is timing input. Reduce ≠ Exit. One weak quarter never auto-demotes.
- Engine conflicts stay visible; no single opaque master score.
- Position sizing is separate from stock selection. The investor decides.

## 2. Current state (verified this turn)

- Repository is the fresh Lovable starter: React 19 + TypeScript + Vite 7 + TanStack Router/Start + Tailwind v4 + shadcn/ui. Only the placeholder home page exists.
- No `src/integrations/`, no Supabase client, no schema, no migrations, no auth — nothing from the spec is implemented.
- Lovable Cloud is **not** enabled, which matches the spec's "no Lovable Cloud backend" rule.

Two things must be resolved by you before any backend code is written (see Section 12): connecting your own Supabase project's credentials, and confirming the GitHub repo connection.

## 3. Architecture summary

```text
Browser (React/TS, TanStack Router)
  |  supabase-js with publishable key  -> RLS-scoped reads/writes (own data only)
  |  server functions (server-side)    -> trusted writes: import commit, engine runs
  v
Your dedicated Supabase project
  Auth (email/password, signup disabled)
  Postgres: identity/config, ledger, import staging, market, research,
            engine results, decisions/audit
  RLS on every user-owned table + hardened SECURITY DEFINER commit RPC
External document storage (Drive/S3): large PDFs; Supabase keeps metadata + checksum + link
```

Layering in code: `providers` (vendor adapters, later phases) → `domain` (pure deterministic engines, no I/O) → `data` (Supabase queries/server functions) → `features` (UI). Engines are pure TypeScript functions with versioned config so results are reproducible and testable.

## 4. Phase 0 — Architecture and Setup

1. Connect the dedicated GitHub repository and confirm sync.
2. Connect your dedicated Supabase project: store `SUPABASE_URL`, publishable/anon key, and (server-only) service key as project secrets; never in client code or git.
3. Create `src/integrations/supabase/client.ts` (browser, RLS) and a server-only client used exclusively inside server functions.
4. Inspect the live schema and record that it is empty; establish the migration ledger under `supabase/migrations/` with sequential, reversible, documented migrations, plus `docs/` copies of the four specs and a `docs/migrations.md` register.
5. App shell: professional dark "terminal" design system in `src/styles.css` (semantic tokens only, dense tabular type, no default AI-purple), left nav with all 13 target sections — later-phase sections rendered as honest "Phase N" placeholders, not hidden.
6. Route skeleton, auth gate, error/not-found boundaries, `head()` metadata per route.
7. Test harness (Vitest) wired so engines are unit-testable from day one.

## 5. Phase 1 — Foundation (scope)

Authentication → core schema + RLS → brokers/accounts/securities → transaction ledger → import pipeline → derived holdings → Dashboard/Holdings/Stock Detail → first deterministic engines → Position Sizing / Movement Radar / Exit Radar in their honest initial form.

### Authentication
Supabase Auth email/password. Public signup disabled (owner account provisioned by you in the Supabase dashboard). Password reset, persistent session, logout, protected `_authenticated` route subtree, public `/auth` page. Authorization is RLS, independent of the login UI.

### Import workflow
Upload (XLSX/XLS/CSV/Google-Sheet export, parsed in-browser) → Preview raw grid → Column mapping (with a saveable mapping profile per broker) → Validation row-by-row (types, dates, signs, required fields; unknown date stays NULL and flags NEEDS_REVIEW) → Security & asset-class identification (match to `securities`, else user resolves; never guessed silently) → Duplicate/conflict detection (row checksum vs previous batches; near-duplicate same security+date+qty+price warning) → User confirmation of the exact approved rows → **Trusted commit** via one server-side RPC.

Trusted commit contract: the browser sends only batch id, approved source-row ids and an idempotency token. The server re-checks auth and ownership, locks the batch row, rechecks state, re-validates every approved row server-side, inserts at most one transaction per source row, writes lineage `transaction.source_row_id`, and atomically marks the batch COMMITTED. Batch lifecycle: UPLOADED → PREVIEWED → VALIDATED → AWAITING_CONFIRMATION → COMMITTING → COMMITTED (REJECTED / FAILED).

### Derived holdings
A `current_holdings` view (plus a documented pure-TS mirror for testing) folds ACTIVE transactions per portfolio+security+account: explicit quantity effect per type (BUY/OPENING_POSITION/TRANSFER_IN/BONUS +, SELL/TRANSFER_OUT −, SPLIT ratio-applied only when a ratio is present, ADJUSTMENT/REVERSAL explicit). Any unresolved SPLIT/ADJUSTMENT/REVERSAL marks the holding `UNRELIABLE` and the UI shows it — no guessing. Cost basis and P&L are computed (FIFO, documented) **only** when every contributing transaction has price and date; otherwise the cell reads "insufficient data", not 0.

### Roles and classification
`portfolio_security_settings` holds role (CORE / SATELLITE / THEMATIC / WATCHLIST / UNASSIGNED), target weight, min/max, freeze flag and role-change history. Asset class lives on `securities` (EQUITY, ETF, MF, DEBT, CASH, OTHER) and is never conflated with role. Core target is a configurable **count** (default 35) shown as "n of ~35 Core names".

### Deterministic engines in Phase 1
Implemented with real data available now (portfolio + transactions only):
- **Position Sizing** — current weight vs target weight, min/max breach, drift; suggests ADD / HOLD / REDUCE / TRIM_INTO_STRENGTH / FREEZE from sizing evidence only, clearly labelled "sizing, not selection".
- **Portfolio Fit / Concentration** — position, sector (when known) and role concentration vs configured limits.
- **Core Selection, Quality–Growth, Core Health, Valuation, Momentum, Satellite Opportunity, Risk, Sector, Credit interpretation, Analyst revisions, Movement, Exit Risk** — implemented as versioned engine *interfaces plus registry, config rows, result tables and UI panels*, returning `INSUFFICIENT_DATA` with the list of missing inputs. Nothing is faked.
- **Movement Radar** — page live in Phase 1, driven by sizing/concentration/role-mismatch signals, with an explicit anti-churn rule (a signal must persist across N observations before proposing a role change) and mandatory human confirmation.
- **Exit Radar** — page live, separate vocabulary from Reduce/Sell; Phase 1 surfaces only hard, evidence-backed flags (e.g. role/thesis mismatch, data-integrity breaks) and states plainly that thesis-breaking fundamental and credit signals arrive in Phases 3–4.

### Credit Intelligence in Phase 1
Full schema, coverage states and Stock Detail panel are built now. With no provider connected the panel reads NOT_COVERED (neutral, grey — never red), and the architecture already supports agency, instrument, current/previous rating, outlook, watch, action type, effective date, provenance and append-only history.

## 6. Proposed Supabase schema (Phase 1)

Migration sequence, each bounded and reversible; every `CREATE TABLE` in `public` is followed by explicit GRANTs, then RLS enable, then policies.

| # | Objects | Purpose |
|---|---|---|
| 01 | enums (`asset_class`, `portfolio_role`, `txn_type`, `txn_state`, `data_quality`, `import_batch_state`, `credit_action`, `coverage_state`, `engine_kind`) | shared vocabulary |
| 02 | `profiles`, `user_settings`, `app_config` | identity, preferences, Core-count target and limits |
| 03 | `portfolios`, `brokers`, `broker_accounts` | ownership + multi-broker/demat |
| 04 | `securities` (symbol, exchange, ISIN, name, asset_class, sector, provenance), `security_aliases` | instrument master + import matching |
| 05 | `transactions` (numeric(24,8) qty/price, nullable date, type, state ACTIVE/SUPERSEDED/REVERSED, data_quality, source_row_id, supersedes_id) | the ledger |
| 06 | `import_batches`, `import_source_rows` (immutable raw JSONB + normalized + validation result + row checksum) | staging with audit |
| 07 | `commit_import_batch()` RPC (SECURITY DEFINER, `search_path = ''`, schema-qualified, EXECUTE to `authenticated` only) | trusted commit |
| 08 | `current_holdings` view (security_invoker), `portfolio_security_settings`, `role_change_history`, `themes`, `security_themes` | derived state + roles |
| 09 | `engine_definitions`, `engine_versions`, `engine_runs`, `engine_results` (component values JSONB, evidence refs, completeness) | versioned deterministic results |
| 10 | `credit_observations`, `analyst_observations`, `research_documents` (metadata + external link + checksum), `corporate_actions`, `market_observations` | append-only external evidence |
| 11 | `recommendations`, `user_decisions`, `investment_thesis` + `thesis_revisions`, `portfolio_snapshots`, `ai_runs` (empty until Phase 5) | decision + audit layer |

Relationships: `portfolios → broker_accounts → transactions`; `securities` referenced by transactions, settings, all evidence tables; `import_source_rows → transactions` gives lineage; `engine_results` keyed by (security, portfolio, engine_version, as_of).

### RLS approach
- RLS enabled on every table; anon gets nothing on user data.
- Policies scope by `auth.uid()` — directly where an owner column exists, otherwise via an owning-portfolio EXISTS check.
- `securities` / `brokers` are shared reference data: SELECT to `authenticated`, writes restricted.
- `transactions`: SELECT to owner; **no direct client INSERT/UPDATE/DELETE**. Writes only through the commit RPC and (later) a narrow manual-entry server function that always writes an audit trail — corrections supersede rather than overwrite.
- `import_source_rows` raw data is insert/select by owner, never updatable after validation.
- Service key stays server-side only; never in the browser bundle or git.

### Security risks and mitigations
SECURITY DEFINER privilege escalation → empty search_path, schema-qualified, ownership re-checked inside, EXECUTE narrowly granted. Double-commit → batch state lock + idempotency token + unique lineage constraint. Client-supplied ownership → never trusted; derived from `auth.uid()`. Recursive policies → role/permission checks via a `SECURITY DEFINER` helper function.

## 7. Frontend / page structure

```text
src/routes/
  index.tsx                  public landing + sign-in CTA
  auth.tsx                   sign in / reset password
  _authenticated/route.tsx   session gate
    dashboard.tsx            portfolio value, role mix, Core count vs ~35,
                             data-quality banner, top movers, alerts
    holdings.tsx             dense sortable/filterable table, role & quality chips
    core.tsx satellite.tsx thematic.tsx watchlist.tsx
    stock.$securityId.tsx    Stock Detail (tabbed)
    import.tsx               6-step wizard
    movement.tsx exit.tsx    Movement Radar, Exit Radar
    screeners.tsx calendar.tsx research.tsx committee.tsx  (Phase placeholders)
    settings.tsx             brokers, accounts, targets, engine config, provenance
src/domain/engines/*         pure deterministic engines + registry + versions
src/domain/holdings/*        pure derivation mirror (unit-tested)
src/features/import/*        parse, map, validate, dedupe, confirm
src/data/*.functions.ts      server functions (trusted writes)
src/integrations/supabase/*  browser client, server client, generated types
```

Stock Detail tabs: Identity & classification | Position & sizing | Fundamental (Core/QG/Health/Valuation) | Market (momentum) | External intelligence (credit, analyst, research, events) | Portfolio (risk, sector, fit) | Thesis & decisions | Evidence & provenance. A persistent "Conflicts" strip shows disagreement across engine families instead of averaging it away.

### Provenance and data quality in the UI
Every value carries a state: OK / MISSING / NOT_COVERED / STALE / NEEDS_REVIEW / UNRELIABLE / MANUAL_OVERRIDE. Rendered as a neutral chip with a hover card showing source, provider, observation date and ingestion time. Missing never renders as 0, blank or red.

## 8. Storage split

Supabase: auth, ledger, imports, securities, settings, engine results, evidence metadata, decisions. External storage: annual reports, transcripts, presentations, large PDFs — Supabase keeps type, title, period, source URL, external link, checksum (for dedupe) and ingestion metadata.

## 9. GitHub and migration discipline

One bounded feature per commit, synced through the connected repo. Migrations are sequential SQL files in the repo, applied only after you approve the step, then verified against the live schema (tables, grants, RLS, policy list) and recorded in `docs/migrations.md`. No migration is claimed applied until verified remotely. Rollback notes accompany each file.

## 10. Testing before Phase 1 is "done"

- Unit tests: holdings derivation across every transaction type incl. split/reversal/adjustment and missing-date rows; FIFO cost basis with and without complete data; Position Sizing and concentration math; import validators and duplicate detection.
- Integrity tests: commit RPC is idempotent, rejects foreign batches, rejects re-commit, produces exactly one transaction per approved row, lineage complete.
- Security tests: anon reads blocked; second user cannot read/write first user's rows; direct client transaction INSERT rejected.
- End-to-end: sign in → import a real sample file → confirm → holdings match a hand-checked expected total → sign out.
- Honesty check: a deliberately incomplete import shows NEEDS_REVIEW and never a zero.

## 11. Recommended implementation order

1. Connect Supabase + GitHub, secrets, clients, migration ledger (Phase 0).
2. Design system + app shell + navigation + route skeleton.
3. Auth + protected routes + owner account.
4. Migrations 01–05 (enums, identity, portfolios/brokers/accounts, securities, transactions) with RLS.
5. Migrations 06–07 + import wizard + trusted commit.
6. Migration 08 + derived holdings + Holdings page + Dashboard.
7. Stock Detail shell with all panels and honest empty states.
8. Migration 09 + engine registry + Position Sizing / Portfolio Fit live; other engines as INSUFFICIENT_DATA.
9. Migrations 10–11 + Movement Radar, Exit Radar, credit/analyst/research placeholders with real schema.
10. Test suite, verification pass, documentation.

## 12. Deferred to later phases

Market/broker data adapter (Angel One), research/fundamental adapter (Trendlyne), live credit and analyst feeds, full Core Selection / QG / Health / Valuation / Momentum / Risk / Sector scoring, screeners, calendar automation, AI Brain and Investment Committee, alerts and scheduled refresh, backtesting. All keep their schema, interfaces and UI surfaces in Phase 1.

## 13. Risks, ambiguities and questions

1. **Supabase connection is a hard blocker.** Lovable Cloud is disabled here, matching your spec, but nothing backend can be built until your dedicated Supabase project's URL and keys are added as project secrets. Please confirm you'll supply them.
2. **Router.** The spec says React + Vite + TypeScript — satisfied. This template is fixed to TanStack Router/Start (not react-router); I'll follow it.
3. **Edge Functions vs server functions.** Spec says "Supabase RPC/Edge Functions where justified". The trusted commit is best done as a Postgres SECURITY DEFINER RPC (atomic, no extra deployment) with the app's server functions as the caller. Flagging this as a deliberate reading, not a silent change.
4. **Cost-basis method** is unspecified. I propose FIFO, documented and versioned; average-cost can be added as a configurable alternative. Please confirm.
5. **Split handling.** Spec forbids silent inference. Phase 1 requires an explicit ratio on SPLIT transactions or a corporate-action record; otherwise the holding is marked unreliable.
6. **Multi-portfolio vs single portfolio.** Schema supports many; the UI will default to one active portfolio unless you want a portfolio switcher in Phase 1.
7. **Sample import file.** Column mapping and validation will be far more accurate if you share one real (or redacted) broker export early.
8. **"Approximately 35 Core"** is treated as a soft, configurable target with no automatic enforcement.
