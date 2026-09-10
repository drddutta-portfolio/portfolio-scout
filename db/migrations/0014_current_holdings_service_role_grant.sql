-- 0014_current_holdings_service_role_grant.sql
-- PortfolioAI Migration 14 — allow trusted Edge Functions to read the derived holdings view.
--
-- Context:
--   * public.current_holdings is a SECURITY INVOKER view over public.transactions.
--   * Migration 08 granted SELECT to authenticated users only.
--   * refresh-market-data uses the Supabase service_role client for trusted server-side work.
--   * service_role already has access to the underlying transactions table, but PostgreSQL
--     still requires an explicit SELECT privilege on the view itself.
--
-- This migration changes privileges only. It does not alter holdings logic, transactions,
-- RLS policies, accounting semantics, market-data tables, or browser permissions.

begin;

grant select on public.current_holdings to service_role;

commit;
