-- 0001_enums.sql
-- PortfolioAI Migration 01 — shared enum vocabulary.
-- Creates types only. No tables, no data, no RLS surface.
--
-- Rollback (safe only while no table uses these types; after later migrations,
-- revert dependent migrations first; never drop ... cascade):
--
-- begin;
-- drop type if exists public.rating_watch;
-- drop type if exists public.credit_outlook;
-- drop type if exists public.coverage_state;
-- drop type if exists public.credit_action;
-- drop type if exists public.corp_action_type;
-- drop type if exists public.import_batch_state;
-- drop type if exists public.data_quality_issue;
-- drop type if exists public.data_quality_state;
-- drop type if exists public.txn_state;
-- drop type if exists public.txn_type;
-- drop type if exists public.portfolio_role;
-- drop type if exists public.asset_class;
-- commit;

begin;

create type public.asset_class as enum (
  'EQUITY','ETF','MUTUAL_FUND','BOND','REIT','INVIT','COMMODITY','CASH','OTHER','UNKNOWN');

create type public.portfolio_role as enum (
  'CORE','SATELLITE','THEMATIC','WATCHLIST','UNASSIGNED');

create type public.txn_type as enum (
  'BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT',
  'BONUS','SPLIT','REVERSAL','ADJUSTMENT');

create type public.txn_state as enum ('ACTIVE','SUPERSEDED','REVERSED');

-- Source/import data quality only. Analytical-result availability
-- (AVAILABLE/INSUFFICIENT_DATA/UNRELIABLE/NOT_APPLICABLE) is a separate
-- vocabulary owned by the engine migration.
create type public.data_quality_state as enum ('VALID','INCOMPLETE','NEEDS_REVIEW');

-- Stored as a set/array per row; individual issues are recorded explicitly.
create type public.data_quality_issue as enum (
  'MISSING_DATE','MISSING_BROKER','MISSING_ACCOUNT','MISSING_QUANTITY','MISSING_PRICE',
  'UNRESOLVED_SECURITY','AMBIGUOUS_SECURITY','DUPLICATE_SUSPECTED',
  'UNSUPPORTED_CORPORATE_ACTION','NEGATIVE_DERIVED_QUANTITY','OTHER');

create type public.import_batch_state as enum (
  'UPLOADED','PREVIEWED','VALIDATED','AWAITING_CONFIRMATION',
  'COMMITTING','COMMITTED','REJECTED','FAILED');

create type public.corp_action_type as enum (
  'SPLIT','BONUS','RIGHTS','MERGER','DEMERGER','SPIN_OFF','BUYBACK',
  'SYMBOL_CHANGE','ISIN_CHANGE','OTHER');

create type public.credit_action as enum (
  'ASSIGNED','UPGRADE','DOWNGRADE','AFFIRMED','OUTLOOK_CHANGE',
  'WATCH_PLACED','WATCH_REMOVED','WITHDRAWN','SUSPENDED','REINSTATED');

create type public.coverage_state as enum (
  'COVERED','NOT_RATED','NOT_COVERED','WITHDRAWN','UNKNOWN');

create type public.credit_outlook as enum (
  'POSITIVE','STABLE','NEGATIVE','DEVELOPING','NOT_APPLICABLE','UNKNOWN');

create type public.rating_watch as enum (
  'NONE','POSITIVE','NEGATIVE','DEVELOPING','UNKNOWN');

commit;
