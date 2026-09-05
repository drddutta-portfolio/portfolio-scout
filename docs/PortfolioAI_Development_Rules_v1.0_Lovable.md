# PortfolioAI — Development Rules v1.0 (Lovable)

## 1. Source of Truth
- GitHub is the source-code repository and version-control source of truth.
- The Master Blueprint is the canonical product/investment specification.
- Database Architecture governs persistence, accounting, provenance and security.
- This Development Rules document governs implementation behaviour.
- The Lovable Build Guide governs how Lovable should execute the specification.
- Do not silently change product/investment rules.
- Material architecture changes should be documented before implementation.

## 2. Implementation Environment
- Build this implementation through Lovable.
- Use a dedicated GitHub repository.
- Use a dedicated Supabase project for database, authentication and backend capabilities.
- Do not use Lovable Cloud as the database/backend.
- Keep the application portable through GitHub and standard project configuration.

## 3. Incremental Development
- Implement one bounded feature/workstream at a time.
- Before material changes, inspect the existing implementation.
- Compile/run/test after changes.
- Prefer small, reviewable commits.
- Do not redesign unrelated areas during a bounded task.

## 4. Financial Integrity
- Transactions are the accounting source of truth.
- Never silently edit financial history.
- Missing is not zero.
- Do not fabricate dates, prices, fundamentals, ratings, analyst data or events.
- Preserve provenance.
- Financial calculations and investment-engine scores must be deterministic.
- AI-generated text must not become a source fact merely because it sounds plausible.

## 5. AI Rules
- AI is optional.
- Feed AI structured evidence.
- AI may explain, synthesize, compare and surface conflicts.
- AI must not override deterministic calculations.
- AI must not invent unavailable financial facts.
- AI integrations should remain provider-agnostic where practical.
- Human decision remains final.

## 6. Data / Storage
- Supabase stores structured application data.
- Large research documents should normally live in external document storage with metadata/links in Supabase.
- Ingestion must be incremental.
- Deduplicate repeated source documents/observations.
- Preserve point-in-time history needed for audit/backtesting.

## 7. Portfolio Rules
- Asset class and investment role are separate.
- Core, Satellite and Thematic serve different purposes.
- Core target is approximately 35 stocks by count, not a fixed percentage allocation.
- Quality–Growth is diagnostic, not a universal hard gate.
- Momentum is primarily a timing/market-behaviour input.
- Valuation must be interpreted relative to quality/growth/context.
- Reduce/Sell is not synonymous with Exit.
- One weak quarter or ordinary price fall must not automatically demote/exit a stock.
- Credit-rating absence (NOT_RATED/NOT_COVERED) must not automatically penalize a stock.

## 8. Security
- Use Supabase Auth.
- Use RLS for user-owned data.
- No service-role secret in frontend/browser.
- Keep secrets out of GitHub.
- Restrict privileged database functions.
- Treat browser input as untrusted.
- Validate trusted writes server-side.

## 9. Backward Compatibility
Once a feature is live:
- Preserve working behaviour unless change is intentional.
- Avoid destructive schema changes where an additive migration is practical.
- Keep migrations explicit.
- Document breaking changes and migration path.

## 10. Testing
A feature is not complete because its UI renders.

Definition of done should include, as applicable:
- data model
- validation
- deterministic logic
- error handling
- authentication/authorization
- RLS/security
- loading/empty/error states
- responsive UI
- tests/checks
- documentation
- successful build
- migration verification

Financial/import logic needs realistic edge cases including missing fields, duplicates, reversals, partial histories and unsupported corporate actions.

## 11. UX
- Professional investment-committee terminal feel.
- Responsive.
- Information-dense but clear.
- Important warnings/conflicts visible.
- Provenance/evidence accessible.
- Human remains in control.
- Avoid decorative UI that obscures investment information.

## 12. Change Documentation
For material work, record:
- objective
- files/components changed
- schema/migrations changed
- investment logic changed
- security impact
- tests performed
- known limitations
- next step

## 13. No Silent Simplification
Lovable must not remove, merge or simplify a required engine/business rule merely because a first implementation lacks data.

If live data is not yet available:
- create the correct architecture/interface where appropriate
- display unavailable/not-covered honestly
- defer population/integration to the relevant phase
- never substitute invented data

## 14. Definition of Done
A feature is complete only when the intended product behaviour, data model, validation, deterministic logic, error handling, security, testing and documentation appropriate to that feature are in place.
