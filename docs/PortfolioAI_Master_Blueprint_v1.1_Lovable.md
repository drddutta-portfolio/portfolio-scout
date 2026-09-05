# PortfolioAI — Master Blueprint v1.1 (Lovable Implementation)

## 1. Purpose
PortfolioAI is a personal investment decision-support platform for Indian equities and related portfolio assets. It is not an advisory service or automated trading bot. The human investor remains the final decision-maker.

Core principle:

> Good company ≠ good investment ≠ good portfolio position ≠ good current price.

This document defines WHAT PortfolioAI must become. It is the canonical product and investment-logic specification for the Lovable implementation.

## 2. Mandatory Technology Direction
- Application builder/development environment: Lovable.
- Source-code repository: a dedicated GitHub repository for this implementation.
- Backend/database/authentication: a dedicated Supabase project.
- Do not use Lovable Cloud as the application database/backend.
- Large research documents should normally remain outside Supabase, with metadata/links stored in Supabase.
- The application must remain portable and maintainable through its GitHub source repository.

## 3. Portfolio Model
PortfolioAI must support multiple brokers/demat accounts and multiple asset classes. Investment role and asset class are separate concepts.

Primary equity roles:
- Core
- Satellite
- Thematic
- Watchlist / unassigned as needed

Other assets such as ETFs must remain explicitly classified rather than being forced into an equity role.

Core is a portfolio role, not a pass/fail screen. The initial target is approximately 35 Core stocks by count, not 35% portfolio allocation. Allocation targets must be configurable.

## 4. Source of Truth
Transactions are the accounting source of truth. Holdings, quantities and portfolio state must be derived from transaction history wherever possible.

Rules:
- Never silently rewrite transaction history.
- Missing data is not zero.
- Unknown facts must remain unknown/null.
- Manual corrections must be auditable.
- Financial calculations must be deterministic.
- Every important imported/external fact should retain provenance.

## 5. Initial Portfolio Import
V1 must support XLSX, XLS, CSV and exported Google Sheet data.

Required workflow:
Upload → Preview → Map columns → Validate → Identify securities/asset classes → Detect duplicates/conflicts → User confirmation → Trusted commit.

Original imported source rows must be preserved for auditability.

## 6. Authentication
Use Supabase Auth.

V1 requirements:
- Email/password sign-in
- Password reset
- Session persistence
- Logout
- Protected application routes
- No public signup unless deliberately enabled later
- Authorization/RLS separate from authentication
- Never expose service-role credentials in the browser

## 7. Investment Intelligence Architecture
PortfolioAI must not reduce all evidence to one opaque AI score. It should maintain four broad engine families:

1. Fundamental Engines
2. Market Engines
3. External Intelligence Engines
4. Portfolio Engines

Conflicts between engines are useful information and must remain visible.

## 8. Core Selection Engine
Initial deterministic weighting:
- Business Quality — 25%
- Sustainable Growth — 20%
- Capital Efficiency — 15%
- Cash Generation — 10%
- Balance Sheet — 10%
- Competitive Advantage — 5%
- Management / Capital Allocation — 5%
- Valuation — 5%
- Momentum — 5%

Weights should be configurable/versioned rather than buried in UI code.

## 9. Quality–Growth Diagnostic
Quality and Growth must remain visible as distinct dimensions. QG analysis is diagnostic evidence, not an automatic hard gate.

The system should help identify combinations such as:
- High Quality / High Growth
- High Quality / Moderate Growth
- Improving Quality / Strong Growth
- Weak Quality / High Growth
- Deteriorating Quality/Growth

## 10. Satellite Opportunity Engine
Satellite positions may have different characteristics from Core holdings. The engine should identify asymmetric opportunities, improving businesses, cyclical/re-rating opportunities and other non-Core candidates without weakening Core standards.

## 11. Core Health Engine
Once a stock is Core, continuously evaluate whether the investment thesis remains healthy. A single weak quarter or price decline must not automatically trigger demotion.

## 12. Valuation Engine
Valuation must be interpreted relative to quality, growth, history, sector/business context and available evidence. “Cheap” and “expensive” must not be determined by a single multiple alone.

## 13. Momentum / Technical Engine
Momentum is primarily a timing and market-behaviour input, not a substitute for fundamental quality.

It should support trend/momentum states, score, spread/relative measures and evidence useful for entry, addition, trimming and deterioration detection.

## 14. Risk Intelligence
Risk analysis should include relevant financial, business, concentration, volatility, governance and portfolio risks where data is available.

## 15. Credit Intelligence
Credit intelligence is a required part of stock evaluation and monitoring.

Store point-in-time observations including, where available:
- Rating agency
- Instrument/debt category
- Current rating
- Previous rating
- Outlook
- Rating watch
- Upgrade/downgrade/affirmation/withdrawal event
- Effective/announcement date
- Source/provenance
- Interpretation/evidence

Rules:
- NOT_RATED and NOT_COVERED are neutral/missing evidence, not automatically negative.
- Rating withdrawal must be interpreted in context; repayment-related withdrawal is not automatically adverse.
- Credit deterioration may influence Balance Sheet, Financial Risk, Core Health and Exit Risk.
- Repeated downgrades, negative outlook/watch and deteriorating financial evidence should be capable of generating stronger warnings.
- Preserve history; do not overwrite prior rating observations.

## 16. Analyst & Earnings Revision Intelligence
Where supported by external sources, capture analyst/revision evidence without treating analyst consensus as truth. Preserve source, date and historical point-in-time context.

## 17. Sector Intelligence
Evaluate a company within sector/business context. Sector evidence should complement company-level analysis and portfolio concentration assessment.

## 18. Portfolio Fit Engine
A good company may still be a poor portfolio addition. Portfolio Fit should consider existing exposure, overlap, diversification, role, risk and target allocation.

## 19. Position Sizing
Maintain:
- Current weight
- Target weight
- Minimum/maximum constraints where applicable
- Role
- Evidence supporting sizing

Possible actions:
ADD, HOLD, ADD ON WEAKNESS, REDUCE, TRIM INTO STRENGTH, FREEZE, EXIT REVIEW, EXIT.

Sizing and selection are separate decisions.

## 20. Movement Engine
The Movement Engine evaluates potential role changes such as promotion/demotion and portfolio action while preventing unnecessary churn.

Human confirmation remains mandatory for actual investment decisions.

## 21. Exit Radar
Exit is different from Reduce/Sell.

The Exit Radar should detect thesis-breaking or materially deteriorating evidence. It should support deterministic Exit Risk and HARD EXIT FLAG logic where justified, while avoiding reactions to isolated weak quarters or ordinary price volatility.

## 22. Thematic Portfolio
Users must be able to create/control themes and associate securities with thematic theses while keeping thematic exposure distinct from Core and Satellite.

## 23. Investment Thesis
Maintain a structured thesis per relevant holding/security, including rationale, expectations, risks, catalysts, evidence, changes and review history.

## 24. Corporate & Research Intelligence
PortfolioAI should progressively ingest structured evidence from:
- Financial results
- Annual reports
- Investor presentations
- Exchange/company announcements
- Corporate actions
- Concall/transcript information
- Credit-rating actions
- Analyst/revision information where available
- Other trusted research sources

Ingestion must be incremental and deduplicated.

## 25. Why Stocks Moved
Provide evidence-based explanations of meaningful portfolio-stock moves using available market, filing, results, news and event evidence. Clearly distinguish known evidence from inference.

## 26. Portfolio Calendar
Maintain upcoming/recent portfolio-relevant events such as results, corporate actions, meetings, known announcements and other monitored events where data is available.

## 27. AI Brain / Investment Committee
Architecture:

Raw Data → Validation → Deterministic Engines → Structured Evidence → AI Context Builder → AI Brain → Investment Committee Summary → Human Decision

AI may:
- synthesize
- explain
- compare
- highlight conflicts
- summarize evidence
- formulate questions/risks

AI must not:
- invent financial facts
- silently alter deterministic values
- replace transaction accounting
- hide contradictory evidence
- make autonomous portfolio transactions

AI must remain optional/provider-agnostic.

## 28. UI / Navigation
The product should feel like a professional personal investment-committee terminal, not a spreadsheet.

Primary navigation:
- Dashboard
- Holdings
- Core
- Satellite
- Thematic
- Movement Radar
- Exit Radar
- Watchlist
- Screeners
- Calendar
- Research
- Investment Committee
- Settings

Tables should be sortable, filterable, configurable and information-dense while remaining understandable.

Stock Detail should consolidate portfolio position, deterministic scores, valuation, momentum, risks, credit intelligence, research evidence, thesis, events and recommendations.

## 29. Storage Strategy
Supabase:
- Authentication
- Transactions
- Holdings-derived structures/views
- Portfolio/security configuration
- Structured market/fundamental observations
- Deterministic assessments
- Credit/analyst observations
- Thesis/evidence/recommendations
- Audit/provenance
- AI run metadata/usage

External document storage:
- Large annual reports
- Presentations
- Transcripts
- Other large research documents

Store links/metadata/checksums in Supabase where appropriate.

## 30. Data Sources / Integration Roadmap
Initial:
- Excel/XLSX/CSV/exported Google Sheet

Later:
- Angel One SmartAPI or approved broker/market-data adapter
- Trendlyne MCP or approved research/fundamental adapter
- Additional source adapters where needed

Provider integrations must be abstracted enough that the core investment logic is not locked to one vendor.

## 31. Development Phases
Phase 0 — Architecture and clean setup
Phase 1 — Foundation, authentication, schema/migrations, import, transactions, derived holdings, portfolio dashboard, roles, initial deterministic engines and UI
Phase 2 — Broker/market-data integration
Phase 3 — Research/fundamental intelligence integration
Phase 4 — Advanced deterministic engines
Phase 5 — AI Brain / Investment Committee
Phase 6 — Monitoring and alerts
Phase 7 — Discovery/screening expansion
Phase 8 — Backtesting/validation

## 32. V1 Success
V1 foundation should allow the owner to securely sign in, import portfolio history, classify assets, derive holdings from transactions, view portfolio value/P&L when supported by validated data, assign roles, view initial deterministic assessments, preserve provenance, and operate through a professional responsive UI backed by Supabase and maintained in GitHub.
