# PortfolioAI — Database Architecture for Lovable v1.0

## 1. Status
This is a FRESH database architecture for the Lovable implementation.

**Implementation status at project start: NOT YET IMPLEMENTED.**

Nothing in this document should be interpreted as an already-applied migration. Lovable must inspect the connected dedicated Supabase project before every database change.

Backend/database/authentication: **Supabase**.
Do **not** use Lovable Cloud as the database/backend.
Source repository: dedicated **GitHub** repository.

## 2. Database Principles
1. Transactions are the accounting source of truth.
2. Never silently overwrite financial history.
3. Missing data is not zero.
4. Asset class is explicit.
5. Investment role is separate from asset class and investment quality.
6. Core is a role, not merely a screen result.
7. Deterministic engines calculate financial/investment metrics.
8. Every external/imported observation should preserve provenance.
9. Scoring methodologies require versioning.
10. Ingestion should be incremental and deduplicated.
11. Large binaries do not belong in Supabase unless deliberately justified.
12. Point-in-time history must be preserved to support audit/backtesting.
13. Security/RLS must be designed with the schema, not added casually later.

## 3. Logical Layers
### A. Identity & Configuration
User identity, portfolio ownership, brokers/accounts, preferences and system/engine configuration.

### B. Portfolio Source
Transactions, import batches/source rows, derived holdings and portfolio/security settings.

### C. Market Data
Prices and market observations with source/date/provenance.

### D. Fundamental & Research Data
Structured company observations, research-document metadata, credit intelligence, analyst/revision observations and corporate events.

### E. Deterministic Intelligence
Versioned engine definitions/results, scores, risk/health/valuation/momentum/portfolio-fit assessments.

### F. Decision & Audit
Thesis, recommendations, evidence, user decisions, snapshots, AI runs and audit history.

## 4. Foundation Entities
Target foundation includes:
- portfolios
- brokers
- broker_accounts
- securities
- transactions
- current_holdings (derived view or equivalent)
- portfolio_security_settings

All user-owned tables must support clear ownership and RLS.

## 5. Transactions
Transactions must use high-precision numeric types suitable for financial quantities/prices.

Target transaction types include:
- BUY
- SELL
- OPENING_POSITION
- TRANSFER_IN
- TRANSFER_OUT
- BONUS
- SPLIT
- REVERSAL
- ADJUSTMENT

Accounting states should distinguish ACTIVE, SUPERSEDED and REVERSED where applicable.

Data-quality states should disclose incomplete imports, including missing date/broker and NEEDS_REVIEW. Unknown dates remain NULL.

The browser should not have unrestricted direct transaction INSERT/UPDATE/DELETE access. Trusted writes should pass through a narrow validated server-side path.

## 6. Derived Holdings
Current holdings must be derived from ACTIVE transaction history rather than becoming a competing accounting ledger.

Quantity effects must be explicit. Unsupported/unresolved SPLIT, ADJUSTMENT or REVERSAL semantics must be disclosed rather than guessed.

Do not claim cost basis or P&L until the chosen deterministic accounting logic has enough validated information.

## 7. Import Architecture
Target entities:
- import_batches
- import_source_rows
- lineage from committed transactions back to source rows

Batch lifecycle:
UPLOADED → PREVIEWED → VALIDATED → AWAITING_CONFIRMATION → COMMITTING → COMMITTED
with REJECTED/FAILED where applicable.

Every source row should retain immutable raw source data plus normalized/validation results.

### Trusted Commit
Browser staging is untrusted. Final commit must be performed through a narrow trusted Supabase RPC/Edge Function/server operation.

Browser input should be minimal, such as:
- batch ID
- approved source-row IDs
- optional idempotency token

Server must:
- revalidate authentication/ownership
- lock/recheck batch state
- validate approved rows
- prevent duplicate commit
- insert at most one intended transaction per source row
- create canonical lineage
- atomically mark the batch committed

If SECURITY DEFINER is required:
- use fixed empty search_path
- schema-qualify referenced objects
- restrict EXECUTE to intended authenticated role(s)
- never expose service-role credentials to browser code

## 8. Authentication
Use Supabase Auth:
- email/password
- password reset
- persistent session
- logout
- protected routes

No public signup by default.

Authentication and authorization are separate. RLS determines access to user-owned data.

## 9. Market Data
Market observations should include:
- security
- observation timestamp/date
- price/market fields
- provider/source
- ingestion timestamp
- quality/status as needed

Avoid unnecessary duplicate storage. Refresh according to investment-use needs rather than intraday-trading frequency.

## 10. Fundamental / Research Observations
Store structured observations separately from raw documents.

Each observation should be capable of retaining:
- security/company
- metric/type
- value/text
- reporting/observation period
- source/provider
- source document/reference
- ingestion timestamp
- confidence/data-quality status where relevant

## 11. Research Documents
Large documents should live outside Supabase. Supabase stores metadata:
- company/security
- document type
- title
- period/date
- source URL/provider
- external storage link
- checksum/deduplication identity
- ingestion metadata

Suggested external hierarchy:
PortfolioAI Research / Company / Document Type /

## 12. Credit Intelligence
Target structured credit observations should support:
- security/company
- agency
- instrument/facility
- current rating
- previous rating
- outlook
- rating watch
- action type
- event/effective date
- source/provider
- source document/link
- ingestion date
- structured interpretation/evidence
- point-in-time validity/history

NOT_RATED and NOT_COVERED must be represented as neutral/missing coverage states rather than adverse ratings.

Never overwrite historical rating actions.

## 13. Analyst / Earnings Revision Intelligence
Support point-in-time analyst/revision observations with provider/source, observation date, applicable period, values and coverage state. NOT_COVERED is neutral.

Historical observations must be append-oriented enough to avoid look-ahead bias.

## 14. Engine Families
Maintain distinct evidence/results for:
- Fundamental
- Market
- External Intelligence
- Portfolio

Do not force conflicting evidence into one opaque master score.

## 15. Deterministic Assessment Entities
Architecture must support versioned results for:
- Core Selection
- Quality–Growth
- Satellite Opportunity
- Core Health
- Valuation
- Momentum
- Risk
- Sector
- Portfolio Fit
- Credit Intelligence interpretation
- Analyst/revision intelligence
- Position Sizing
- Movement
- Exit Risk

Store:
- engine/version
- as-of date/time
- component values
- total/result
- evidence/data references
- data-quality/completeness
- generated timestamp

## 16. Investment Thesis
Maintain structured, historical thesis data per portfolio/security where relevant. Changes should be auditable rather than silently replacing history.

## 17. Themes
Support user-defined themes and security-theme membership with portfolio context.

## 18. Portfolio Snapshots
Point-in-time snapshots may store portfolio-level state needed for history, monitoring and backtesting without replacing the transaction ledger.

## 19. Recommendations & Evidence
System-generated recommendations must be traceable to deterministic results/evidence.

Possible action vocabulary includes:
ADD, HOLD, ADD_ON_WEAKNESS, REDUCE, TRIM_INTO_STRENGTH, FREEZE, EXIT_REVIEW, EXIT.

Recommendations are decision support, not automatic execution.

## 20. User Decisions
Record important human decisions separately from machine recommendations, including decision, date and optional rationale.

## 21. AI Runs
If AI is enabled, store appropriate metadata:
- run/type
- model/provider abstraction
- as-of time
- structured input/evidence references
- output
- usage/cost metadata where available
- status/error

AI output never becomes an accounting source of truth.

## 22. Provenance
Every material external fact should be traceable to source/provider and observation/ingestion time. Manual overrides must be distinguishable from provider data.

## 23. Corporate Actions
Corporate actions require explicit modelling sufficient to keep transaction-derived holdings/accounting correct. Do not infer complex adjustments silently.

## 24. Security / RLS
- RLS on user-owned tables.
- Anonymous users receive no portfolio access.
- Authenticated users access only their owned/authorized data.
- Browser transaction mutation remains restricted.
- Service-role keys never enter frontend code.
- SECURITY DEFINER functions only when necessary and tightly hardened.
- Sensitive configuration/secrets stay in secure server-side environment/secrets.
- Database migrations are reviewed, bounded and reversible where practical.

## 25. Storage / Refresh Policy
Supabase Free-tier usage should be economical:
- structured data in Supabase
- large documents externally
- incremental ingestion
- deduplication
- avoid unnecessary high-frequency market history
- archive/retain evidence according to investment/audit value

## 26. Migration Discipline
For this fresh implementation:
1. Inspect current Supabase schema first.
2. Propose the bounded migration.
3. Explain tables/functions/RLS affected.
4. Apply only after the requested build step is approved/appropriate.
5. Verify remote schema and RLS.
6. Run lint/tests where available.
7. Record migration name/version in project documentation.
8. Never assume a migration exists because it appears in an architecture document.

No pre-existing migration is considered applied merely by being described here.
