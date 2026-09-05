# PortfolioAI — Lovable Build Guide v1.0

## 1. Purpose
This is the execution guide for building PortfolioAI through Lovable.

PortfolioAI must be built as an independent application with:
- a dedicated GitHub repository;
- a dedicated Supabase project;
- Supabase as database/auth/backend;
- **no Lovable Cloud database/backend**.

## 2. Required Specification Pack
Lovable must treat these four files together as the project specification:

1. `PortfolioAI_Master_Blueprint_v1.1_Lovable.md`
2. `PortfolioAI_Database_Architecture_Lovable_v1.0.md`
3. `PortfolioAI_Development_Rules_v1.0_Lovable.md`
4. `PortfolioAI_Lovable_Build_Guide_v1.0.md`

This Build Guide does not replace the other three documents.

### Authority
- Master Blueprint: WHAT the product/investment system must do.
- Database Architecture: HOW structured data, accounting, provenance and security must work.
- Development Rules: HOW implementation changes must be performed.
- Build Guide: HOW Lovable should sequence and interpret the work.

If there is a genuine conflict, stop and surface it rather than silently choosing a different product rule.

## 3. Clean Implementation Rule
Treat the connected GitHub repository and Supabase project as the only implementation environment for this build.

At initial setup:
- verify GitHub connection/repository;
- verify Supabase project connection;
- inspect the actual repository;
- inspect the actual Supabase schema;
- assume no schema/migration exists until verified.

Never infer implementation state from a specification document.

## 4. Mandatory Stack
Preferred frontend:
- React
- Vite
- TypeScript
- maintainable component architecture
- responsive professional UI

Backend:
- Supabase PostgreSQL
- Supabase Auth
- Supabase RLS
- Supabase RPC/Edge Functions only where justified

Repository:
- GitHub

Do not migrate the backend to Lovable Cloud.

## 5. Product Mission
Build a personal Indian-equity investment decision-support system that answers:
- What do I own and how is it performing?
- Is each holding healthy and why?
- Which holdings should be added to, held, reduced, promoted, demoted or reviewed for exit?
- What new information changed the investment thesis?
- Is a good company currently a good portfolio position at a good price?

The system assists the investor; it does not autonomously trade.

## 6. Non-Negotiable Financial Principles
- Transactions are accounting source of truth.
- Holdings are derived.
- Missing data is not zero.
- Never fabricate financial data.
- Preserve source/provenance.
- Deterministic engines calculate scores.
- AI explains/synthesizes but does not invent or override.
- Historical point-in-time evidence must be retained where needed.
- Human decisions remain separate from machine recommendations.

## 7. Authentication
Implement Supabase Auth with:
- owner login using email/password;
- password reset;
- persistent session;
- logout;
- protected routes;
- no public signup by default.

Implement RLS separately from authentication.

## 8. Portfolio Structure
Support:
- multiple brokers/accounts
- multiple asset classes
- Core
- Satellite
- Thematic
- Watchlist/unassigned where needed

Core target is approximately 35 stocks by count, not 35% allocation.

## 9. Engines That Must Remain in Scope
Do not omit these merely because their live data integration is later:

### Fundamental
- Core Selection
- Quality–Growth
- Satellite Opportunity
- Core Health
- Valuation
- Balance Sheet / Cash Generation / Capital Efficiency components

### Market
- Momentum / Technical
- price/market behaviour

### External Intelligence
- Credit Intelligence
- Analyst & Earnings Revision Intelligence
- corporate/research intelligence

### Portfolio
- Risk
- Sector
- Portfolio Fit
- Position Sizing
- Movement
- Exit Radar
- Thematic context

Conflicts among engines should remain visible.

## 10. Credit Intelligence Requirement
Credit intelligence is mandatory in the target architecture.

Support rating agency, instrument, rating, previous rating, outlook/watch, action, date and provenance.

Important:
- NOT_RATED / NOT_COVERED = neutral absence of coverage.
- Withdrawal is interpreted in context.
- Deterioration can affect Balance Sheet/Risk/Core Health/Exit Risk.
- Preserve rating history.
- Do not fabricate a credit rating when no source exists.

If a live credit provider is unavailable during early phases, retain the schema/UI/evidence model as appropriate and show coverage honestly.

## 11. Initial Data Import
Implement a safe user flow:

Upload XLS/XLSX/CSV/exported Google Sheet
→ Preview
→ Column mapping
→ Validation
→ Security/asset identification
→ Duplicate/conflict detection
→ User confirmation
→ Trusted server-side commit

Preserve original source rows and lineage.

## 12. Trusted Transaction Writes
Do not grant the browser unrestricted direct transaction mutation.

Use a narrow validated trusted commit mechanism for imports and other sensitive accounting writes.

All privileged Supabase functions must follow the Database Architecture security rules.

## 13. UI Direction
The UI should resemble a professional personal investment-committee terminal.

Navigation target:
Dashboard / Holdings / Core / Satellite / Thematic / Movement Radar / Exit Radar / Watchlist / Screeners / Calendar / Research / Investment Committee / Settings

Requirements:
- responsive
- sortable/filterable tables
- clear score/evidence presentation
- visible data-quality states
- visible conflicts/warnings
- drill-down to stock details
- provenance available without overwhelming the main view

## 14. Stock Detail
Target Stock Detail should progressively contain:
- identity/classification
- position/weight/P&L
- role and target sizing
- Core/quality/growth/health assessments
- valuation
- momentum
- risk
- sector/portfolio fit
- credit intelligence
- analyst/revision evidence
- research/corporate events
- thesis
- calendar
- Movement/Exit evidence
- recommendation/evidence
- human decision history

## 15. Storage
Use Supabase for structured data.

Do not fill Supabase with large report/transcript binaries by default. Use external document storage and retain metadata/links/checksums in Supabase.

## 16. Data Integration Sequence
### Initial
Portfolio import from spreadsheet files.

### Later
Market/broker adapter such as Angel One SmartAPI.

### Later
Research/fundamental intelligence adapter such as Trendlyne MCP.

Design provider adapters so core PortfolioAI logic does not depend directly on one vendor.

## 17. AI Sequence
Do not build the AI Brain before deterministic foundations are trustworthy.

Required flow:
Raw data → validation → deterministic engines → structured evidence → AI context → AI synthesis → Investment Committee → human decision.

AI features should fail gracefully without corrupting core portfolio functionality.

## 18. Build Phases
### Phase 0 — Setup / Architecture
- connect dedicated GitHub repo
- connect dedicated Supabase
- verify environment
- establish app shell
- establish migration discipline
- establish auth architecture
- document configuration

### Phase 1 — Foundation
- authentication
- core schema/RLS
- import staging/validation/commit
- transactions
- derived holdings
- brokers/accounts/assets
- portfolio roles/settings
- dashboard/holdings UI
- initial deterministic engines
- initial Stock Detail
- initial Movement/Exit/Position Sizing surfaces

### Phase 2 — Market/Broker Data
Introduce approved market/broker provider integration incrementally.

### Phase 3 — Fundamental/Research Intelligence
Introduce research/fundamental/credit/analyst data adapters as available.

### Phase 4 — Advanced Engines
Improve risk, sector, portfolio fit, credit interpretation, revisions, position sizing, movement and exit logic.

### Phase 5 — AI Brain / Investment Committee
Add evidence-grounded AI synthesis.

### Phase 6 — Monitoring
Alerts, scheduled refreshes, portfolio calendar and movement explanations.

### Phase 7 — Discovery
Screeners and opportunity discovery.

### Phase 8 — Backtesting
Point-in-time validation and methodology testing.

## 19. How Lovable Must Work
For each bounded task:
1. Read the relevant specification sections.
2. Inspect current code/schema.
3. State what will change.
4. Identify any DB migration/RLS/security impact.
5. Implement only the bounded scope.
6. Build/test.
7. Verify Supabase changes.
8. Report exactly what changed and what did not.
9. Commit/sync through GitHub according to project workflow.

Do not make unrelated “helpful” redesigns.

## 20. Database Change Rule
Before significant schema changes, provide a concise plan including:
- new/changed tables
- columns/types
- constraints/indexes
- RLS
- functions/triggers
- migration safety
- rollback/reversibility considerations

Never claim a migration is deployed until the connected Supabase project verifies it.

## 21. Security Rule
Never:
- expose Supabase service-role key
- disable RLS as a convenience
- trust browser-supplied ownership
- allow arbitrary transaction writes
- commit secrets to GitHub

## 22. Data Honesty
Use explicit states such as:
- unavailable
- not covered
- missing
- stale
- needs review
- incomplete

Never convert these silently to zero, false or a negative investment judgment.

## 23. No Premature Simplification
If a target feature belongs to a later phase, it may be deferred, but its conceptual requirement remains.

Do not delete Credit Intelligence, Analyst Intelligence, Exit Radar, Movement, Position Sizing, Thematic, Research, AI Investment Committee or other specified systems just because Phase 1 does not yet have all required data.

## 24. First Lovable Build Instruction
At the start of this project, Lovable should NOT attempt to build the entire application in one pass.

First:
1. Read all four specification files.
2. Confirm the dedicated GitHub repository.
3. Confirm the dedicated Supabase project.
4. Confirm Supabase—not Lovable Cloud—is the backend.
5. Inspect repository and database state.
6. Produce a Phase 0 + Phase 1 implementation plan.
7. Identify ambiguities/conflicts.
8. Do not create broad database changes until the plan is reviewed.

## 25. Completion Standard
The goal is not merely an attractive dashboard. PortfolioAI succeeds only when its accounting integrity, deterministic investment logic, provenance, security, portfolio workflow and evidence-based decision support work together correctly.
