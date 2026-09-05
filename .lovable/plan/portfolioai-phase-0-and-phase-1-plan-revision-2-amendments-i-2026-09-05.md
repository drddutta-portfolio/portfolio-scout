# PortfolioAI — Phase 0 and Phase 1 Plan (Revision 2, amendments incorporated)

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

## 2. Amendments accepted (Revision 2)

1. Canonical accounting numerics are `numeric(38,18)`; display formatting is a UI concern only.
2. **No cost-basis method is hard-coded.** No FIFO, no average cost, no estimation in Phase 1. Quantity derivation proceeds independently; cost basis / realized / unrealized P&L return `INSUFFICIENT_DATA` until you approve a methodology.
3. Strict secrets policy across the whole project (Section 8).
4. No service-role key in Phase 0/1; trusted writes go through a hardened SECURITY DEFINER RPC.
5. No placeholder tables — physical objects only where Phase 1 genuinely needs them. Credit Intelligence is the deliberate exception.
6. Conservative corporate-action handling with explicit NEEDS_REVIEW / UNRELIABLE / INSUFFICIENT_DATA states.
7. Multi-portfolio schema, single default active portfolio in the Phase 1 UI.
8. Credit Intelligence data model retained in full, coverage states neutral.
9. Versioned engine interfaces with honest INSUFFICIENT_DATA; engine families stay separable.
10. Infrastructure verification gate before any migration.

## 3. Current state (verified)

- Repository is the fresh Lovable starter: React 19 + TypeScript + Vite 7 + TanStack Router/Start + Tailwind v4 + shadcn/ui. Only the placeholder home page exists.
- No `src/integrations/`, no Supabase client, no schema, no migrations, no auth, no `.env.example`, no secrets configured.
- Lovable Cloud is **not** enabled, matching the "no Lovable Cloud backend" rule.

## 4. Architecture summary

```text
Browser (React/TS, TanStack Router)
  |  supabase-js, publishable key only  -> RLS-scoped reads; NO direct ledger writes
  |  server functions (server-side)     -> call restricted RPCs
  v
Your dedicated Supabase project
  Auth (email/password, signup disabled)
  Postgres: identity/config, ledger, import staging, roles, engines, credit intelligence
  commit_import_batch() : SECURITY DEFINER, empty search_path, EXECUTE to authenticated
External document storage (Drive/S3): large PDFs; Supabase keeps metadata + checksum + link
```

Code layering: `providers` (vendor adapters, later phases) → `domain` (pure deterministic engines and derivation, no I/O, unit-tested) → `data` (queries + server functions) → `features` (UI).

## 5. Phase 0 implementation sequence

1. **Infrastructure gate** (nothing else starts until all pass):
   - dedicated GitHub repository connected and syncing;
   - dedicated Supabase project connected;
   - Supabase confirmed as database/auth/backend, Lovable Cloud left disabled;
   - live Supabase schema inspected and recorded (expected: empty `public`);
   - secret storage configured and verified;
   - repository scanned to confirm no secret values in tracked files.
2. Secret/environment architecture + `.env.example` (names and empty placeholders only) + `.gitignore` hardening.
3. `src/integrations/supabase/client.ts` (browser, publishable key, RLS) and a server-side client used only inside server functions. No service-role client created.
4. Migration discipline: `supabase/migrations/` with sequential reversible files, `docs/` copies of the four specs, `docs/migrations.md` register recording name, purpose, objects, RLS impact, rollback note and remote-verification result.
5. App shell: professional dark terminal design system in `src/styles.css` (semantic tokens, dense tabular type — no default AI look), left navigation with all 13 target sections, later-phase sections rendered as honest "Phase N" pages.
6. Route skeleton, auth gate, error/not-found boundaries, per-route `head()` metadata.
7. Vitest harness so domain logic is testable from the first commit.

## 6. Phase 1 implementation plan

### Authentication
Supabase Auth email/password. Public signup disabled; owner account provisioned by you in the Supabase dashboard. Password reset, persistent session, logout, protected `_authenticated` subtree, public `/auth` page. Authorization is RLS, independent of the login UI.

### Import workflow
Upload (XLSX/XLS/CSV/Google-Sheet export, parsed in-browser) → Preview raw grid → Column mapping (saveable profile per broker) → Validation per row (types, dates, signs, required fields; unknown date stays NULL and flags NEEDS_REVIEW) → Security & asset-class identification against `securities`/`security_aliases`, unmatched rows resolved by you, never guessed → Duplicate/conflict detection (row checksum against prior batches; near-duplicate warning on same security+date+qty+price) → Confirmation of the exact approved rows → **Trusted commit**.

Trusted commit contract: the browser sends only batch id, approved source-row ids, idempotency token. The RPC re-checks `auth.uid()`, re-checks ownership, locks the batch row, rechecks state, re-validates every approved row server-side, inserts at most one transaction per source row, writes lineage, and atomically marks the batch COMMITTED. Lifecycle: UPLOADED → PREVIEWED → VALIDATED → AWAITING_CONFIRMATION → COMMITTING → COMMITTED (REJECTED / FAILED).

### Derived holdings — quantity only in Phase 1
`current_holdings` view (plus a pure-TS mirror for unit tests) folds ACTIVE transactions per portfolio + security + account with an explicit quantity effect per type: BUY / OPENING_POSITION / TRANSFER_IN / BONUS increase; SELL / TRANSFER_OUT decrease; SPLIT applies only with an explicit ratio; ADJUSTMENT / REVERSAL only with explicit semantics. Anything unresolved marks the holding `UNRELIABLE` or `NEEDS_REVIEW` and the UI says so.

**Cost basis and P&L are not computed in Phase 1.** An `accounting_method` interface (versioned, replaceable, selected by config — not by code) is defined with a single Phase 1 implementation that returns `INSUFFICIENT_DATA` with the reasons (no approved methodology; possibly incomplete history behind an opening position). No FIFO, no average cost, no estimate, no zero, no fabricated acquisition cost. Opening positions are explicitly treated as possibly-incomplete history. A future approved method plugs in behind the same interface without touching the ledger.

### Corporate actions (conservative)
Phase 1 supports only deterministic, explicitly-specified effects (split with ratio, bonus with ratio, transfers, symbol/ISIN change as identity mapping). Rights, merger, demerger, spin-off and buyback are modelled as recognised action types that Phase 1 records but refuses to fold into quantities — they raise NEEDS_REVIEW on affected holdings. Nothing is inferred silently.

### Roles and classification
`portfolio_security_settings` holds role (CORE / SATELLITE / THEMATIC / WATCHLIST / UNASSIGNED), target weight, min/max, freeze flag; `role_change_history` keeps the audit. Asset class lives on `securities` (EQUITY, ETF, MF, DEBT, CASH, OTHER) and is never conflated with role. Core target is a configurable **count** (default 35), shown as "n of ~35 Core names", never enforced automatically.

### Deterministic engines in Phase 1
Live now (only portfolio and transaction data exists):
- **Position Sizing** — Phase 1 stores and displays role, target weight, minimum, maximum and freeze status only. Actual portfolio weight is market value / total portfolio market value, so with no market data it reads UNAVAILABLE. **Quantity share is never used as a weight substitute**, and no ADD / REDUCE / TRIM / HOLD recommendation is issued in Phase 1 — every recommendation that needs actual weight returns INSUFFICIENT_DATA.
- **Portfolio Fit / Concentration** — count-based and role-based concentration only (e.g. names per role, per broker, per sector where known). Value-based concentration reads INSUFFICIENT_DATA until market data exists.

- **Movement Radar** — page live, driven by sizing/concentration/role-mismatch signals, with an explicit anti-churn rule (a signal must persist across N observations before a role change is proposed) and mandatory human confirmation.
- **Exit Radar** — page live, vocabulary distinct from Reduce/Sell; Phase 1 raises only hard evidence-backed flags (role/thesis mismatch, data-integrity breaks) and states plainly that fundamental and credit exit signals arrive in Phases 3–4.

Interface + versioned config + result persistence + UI panel, returning `INSUFFICIENT_DATA` with the missing-input list: Core Selection (with the 25/20/15/10/10/5/5/5/5 weighting stored as config, not code), Quality–Growth, Satellite Opportunity, Core Health, Valuation, Momentum, Risk, Sector, Credit interpretation, Analyst revisions. No invented inputs.

### Credit Intelligence in Phase 1
Full data model and Stock Detail panel built now: agency, instrument/facility, current rating, previous rating, outlook, rating watch, action type, effective date, provenance/source, append-only history, coverage state. With no provider connected the panel reads NOT_COVERED as a neutral grey state that never reduces any score. No rating is ever fabricated.

## 7. Exact Phase 1 database objects and migration sequence

Each migration is bounded and reversible; every `CREATE TABLE` in `public` is followed by explicit GRANTs, then RLS enable, then policies. All money/quantity/price columns are `numeric(38,18)`.

| # | Objects | Purpose |
|---|---|---|
| 01 | enums: `asset_class`, `portfolio_role`, `txn_type`, `txn_state`, `data_quality_state`, `import_batch_state`, `corp_action_type`, `credit_action`, `coverage_state`, `engine_kind`, `sizing_action` | shared vocabulary, no silent strings |
| 02 | `profiles`, `user_settings`, `app_config` | identity, preferences, Core-count target, concentration limits, selected accounting-method version |
| 03 | `portfolios`, `brokers`, `broker_accounts` | ownership, multi-broker/demat (multi-portfolio capable, one default active) |
| 04 | `securities` (symbol, exchange, ISIN, name, asset_class, sector, provenance), `security_aliases` | instrument master + import matching + symbol/ISIN changes |
| 05 | `transactions` (qty/price `numeric(38,18)`, nullable trade_date, type, state ACTIVE/SUPERSEDED/REVERSED, `data_quality_state`, `supersedes_id`, `source_row_id`), indexes | the ledger |
| 06 | `import_batches`, `import_source_rows` (immutable raw JSONB + normalized + validation result + row checksum) | staging with full audit and lineage |
| 07 | `commit_import_batch(...)` — SECURITY DEFINER, `search_path = ''`, schema-qualified, EXECUTE granted to `authenticated` only; `REVOKE ALL` from `public`/`anon` | trusted commit |
| 08 | `current_holdings` view (security_invoker), `portfolio_security_settings`, `role_change_history`, `corporate_actions` | derived quantities, roles, conservative action records |
| 09 | `engine_definitions`, `engine_versions`, `engine_runs`, `engine_results` (component values JSONB, evidence refs, completeness/INSUFFICIENT_DATA reasons) | versioned deterministic results |
| 10 | `credit_observations` (append-only, coverage state), `credit_agencies` reference | first-class Credit Intelligence |
| 11 | `themes`, `security_themes` | Thematic role support |

Relationships: `portfolios → broker_accounts → transactions`; `securities` referenced by transactions, settings, credit observations; `import_source_rows → transactions` gives lineage; `engine_results` keyed by (portfolio, security, engine_version, as_of).

### Deferred physical objects (architecture kept, tables created in their own phase)
`market_observations` (Phase 2), `fundamental_observations`, `research_documents`, `analyst_observations` (Phase 3), `portfolio_snapshots`, `recommendations`, `investment_thesis` + `thesis_revisions`, `user_decisions` (Phase 4 unless a Phase 1 surface genuinely needs them), `ai_runs` (Phase 5). None are created empty in Phase 1. Their interfaces, enums and UI surfaces still exist so nothing conceptual is lost.

## 8. Secret and environment-variable architecture

- **No secret value ever appears in source, docs, tests, fixtures, logs or generated output.** Code references names only.
- Server-only names (read via `process.env['NAME']` inside server-function handlers only, never at module scope): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. Later phases add `ANGEL_ONE_API_KEY`, `TRENDLYNE_API_KEY`, AI provider keys — stored in the secret store when that phase begins, not before.
- Browser-visible, non-secret: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
- `SUPABASE_SERVICE_ROLE_KEY` is **not introduced in Phase 0/1**. If a future feature genuinely needs it I will first justify why authenticated/RLS access is insufficient, where it is stored, why it cannot reach the browser, and the minimum privilege required.
- `.env.example` is committed with names and empty values only. `.gitignore` covers `.env`, `.env.*` (except `.env.example`), and any local credential files.
- Pre-commit check on any configuration change: grep tracked files for key-shaped values and confirm none are present.

## 9. Security and RLS model

- RLS enabled on every table; anon gets no access to portfolio data.
- Policies scope by `auth.uid()` directly where an owner column exists, otherwise via an owning-portfolio EXISTS check through a `SECURITY DEFINER` helper to avoid recursive policies.
- `securities`, `brokers`, `credit_agencies` are shared reference data: SELECT to `authenticated`; writes restricted.
- `transactions`: SELECT to owner; **no client INSERT/UPDATE/DELETE grant at all**. Writes only via `commit_import_batch` and (later) a narrow manual-entry RPC that supersedes rather than overwrites and always writes an audit row.
- `import_source_rows` raw payload is insert/select only — never updatable after validation.
- Risks and mitigations: definer escalation → empty search_path, schema-qualified, ownership re-checked inside, EXECUTE narrowly granted; double commit → batch lock + idempotency token + unique lineage constraint; client-supplied ownership → never trusted, always derived from `auth.uid()`.

## 10. Frontend / page structure

```text
src/routes/
  index.tsx                  public landing + sign-in CTA
  auth.tsx                   sign in / reset password
  _authenticated/route.tsx   session gate
    dashboard.tsx            counts only: holdings count, holdings by role,
                             Core count vs ~35, holdings by broker/account,
                             asset class by count, unresolved securities,
                             import/data-quality status, NEEDS_REVIEW and
                             UNRELIABLE holdings, credit coverage status;
                             market-value tiles read "Market data not yet connected"

    holdings.tsx             dense sortable/filterable table, role + quality chips
    core.tsx satellite.tsx thematic.tsx watchlist.tsx
    stock.$securityId.tsx    Stock Detail (tabbed)
    import.tsx               6-step wizard
    movement.tsx exit.tsx    Movement Radar, Exit Radar
    screeners.tsx calendar.tsx research.tsx committee.tsx  (honest phase pages)
    settings.tsx             brokers, accounts, targets, engine config, provenance
src/domain/engines/*         pure engines + registry + versions
src/domain/holdings/*        quantity derivation + accounting-method interface
src/features/import/*        parse, map, validate, dedupe, confirm
src/data/*.functions.ts      server functions (trusted writes)
src/integrations/supabase/*  browser client, server client, generated types
```

Stock Detail tabs: Identity & classification | Position & sizing | Fundamental | Market | External intelligence (credit first-class) | Portfolio (risk, sector, fit) | Thesis & decisions (Phase 4 surface) | Evidence & provenance. A persistent "Conflicts" strip shows disagreement across engine families rather than averaging it away.

### Provenance and data-quality display
Every value carries a state: OK / MISSING / NOT_COVERED / STALE / NEEDS_REVIEW / UNRELIABLE / INSUFFICIENT_DATA / MANUAL_OVERRIDE, rendered as a neutral chip with a hover card showing source, provider, observation date and ingestion time. Missing never renders as 0, blank or red.

## 11. Storage split

Supabase: auth, ledger, imports, securities, settings, engine results, credit observations. External storage: annual reports, transcripts, presentations, large PDFs — Supabase keeps type, title, period, source URL, external link, checksum and ingestion metadata (from Phase 3).

## 12. GitHub and migration discipline

One bounded feature per commit through the connected repo. Migrations are sequential SQL files in the repo, applied only after you approve that step, then verified against the live schema (tables, grants, RLS, policy list, function privileges) and recorded in `docs/migrations.md` with a rollback note. No migration is claimed applied until remotely verified. Configuration commits pass the secret scan first.

## 13. Testing before Phase 1 is complete

- Unit: quantity derivation across every transaction type incl. split/bonus/reversal/adjustment and missing-date rows; accounting-method interface returns INSUFFICIENT_DATA with reasons and never a number; sizing and concentration math; import validators; duplicate detection; `numeric(38,18)` round-trip precision.
- Integrity: commit RPC is idempotent, rejects foreign batches, rejects re-commit, one transaction per approved row, lineage complete.
- Security: anon blocked; a second user cannot read or write the owner's rows; direct client transaction INSERT rejected; RPC EXECUTE not available to anon.
- End-to-end: sign in → import a real sample file → confirm → derived quantities match a hand-checked expectation → sign out.
- Honesty: a deliberately incomplete import shows NEEDS_REVIEW; P&L shows INSUFFICIENT_DATA; an uncovered stock shows NOT_COVERED in neutral styling.
- Secret scan: no key-shaped value in tracked files.

## 14. Recommended order of implementation

1. Phase 0 infrastructure gate + secrets architecture + `.env.example` + `.gitignore` (no migrations).
2. Supabase clients, migration ledger, docs.
3. Design system, app shell, navigation, route skeleton.
4. Auth + protected routes + owner account.
5. Migrations 01–05 with RLS (enums, identity, portfolios/brokers/accounts, securities, transactions).
6. Migration 06–07 + import wizard + trusted commit RPC.
7. Migration 08 + quantity-derived holdings + Holdings page + Dashboard.
8. Stock Detail shell with honest empty states.
9. Migration 09 + engine registry; Position Sizing and Portfolio Fit live, others INSUFFICIENT_DATA.
10. Migration 10–11 + Credit Intelligence panel, Themes, Movement Radar, Exit Radar.
11. Full test suite, remote verification, documentation update.

## 15. Deferred to later phases

Market/broker adapter (Angel One), research/fundamental adapter (Trendlyne), live credit and analyst feeds, approved cost-basis methodology and P&L, full fundamental/valuation/momentum/risk/sector scoring, complex corporate actions (rights, merger, demerger, spin-off, buyback), thesis and decision persistence, screeners, calendar automation, AI Brain / Investment Committee, alerts, backtesting.

## 16. Remaining risks, ambiguities and questions

1. **Supabase connection is still the hard blocker.** Nothing backend can be built until your dedicated project's URL and publishable key are stored as secrets. Please confirm when done.
2. **Router.** Spec asks React + Vite + TypeScript (satisfied); this template is fixed to TanStack Router/Start rather than react-router. I'll follow the template.
3. **RPC vs Edge Function.** Spec allows either "where justified". I read the trusted commit as a Postgres SECURITY DEFINER RPC — atomic, no service-role key, no extra deployment — which also satisfies amendment 4.
4. **Resolved:** market value, market-value allocation and market-value P&L are absent from Phase 1. The dashboard shows count-based facts only, and every market-value metric shows "Market data not yet connected" / INSUFFICIENT_DATA until Phase 2. Quantity share is never presented as portfolio weight.
5. **Sample import file.** Column mapping and validation will be materially better if you share one real or redacted broker export early.
6. **Split/bonus ratios** must be present explicitly on the transaction or a corporate-action record; otherwise the affected holding is marked unreliable.
7. **"Approximately 35 Core"** stays a soft configurable target with no automatic enforcement.

## 17. Confirmation

No API key, token, password, private key or service-role credential will be written into source files, documentation, tests, fixtures or anything committed to GitHub. Code will reference environment-variable names only; values live solely in the secure secret store. The Supabase service-role key will not be introduced in Phase 0 or Phase 1.

## 18. Recommended first implementation task

Phase 0 step 1–4 only: run the infrastructure gate (GitHub + Supabase connection, live schema inspection, secret configuration, repository secret scan), then create the secrets architecture, `.env.example`, `.gitignore` hardening, Supabase clients and the migration ledger — **no migrations, no schema changes.**
