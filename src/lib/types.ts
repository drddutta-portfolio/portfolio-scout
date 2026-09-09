/**
 * Row shapes for the deployed PortfolioAI backend (Migrations 01-09a).
 * Read-only mirror of the SQL contract; nothing here changes the database.
 */

export type AssetClass =
  | "EQUITY"
  | "ETF"
  | "MUTUAL_FUND"
  | "BOND"
  | "REIT"
  | "INVIT"
  | "COMMODITY"
  | "CASH"
  | "OTHER"
  | "UNKNOWN";

export type PortfolioRole = "CORE" | "SATELLITE" | "THEMATIC" | "WATCHLIST" | "UNASSIGNED";

export const PORTFOLIO_ROLES: PortfolioRole[] = [
  "CORE",
  "SATELLITE",
  "THEMATIC",
  "WATCHLIST",
  "UNASSIGNED",
];

export type TxnType =
  | "BUY"
  | "SELL"
  | "OPENING_POSITION"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "BONUS"
  | "SPLIT"
  | "REVERSAL"
  | "ADJUSTMENT";

export const SUPPORTED_TXN_TYPES: TxnType[] = [
  "BUY",
  "SELL",
  "OPENING_POSITION",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "BONUS",
];

export const UNSUPPORTED_TXN_TYPES: TxnType[] = ["SPLIT", "REVERSAL", "ADJUSTMENT"];

export type DataQualityState = "VALID" | "INCOMPLETE" | "NEEDS_REVIEW";

export type DataQualityIssue =
  | "MISSING_DATE"
  | "MISSING_BROKER"
  | "MISSING_ACCOUNT"
  | "MISSING_QUANTITY"
  | "MISSING_PRICE"
  | "UNRESOLVED_SECURITY"
  | "AMBIGUOUS_SECURITY"
  | "DUPLICATE_SUSPECTED"
  | "UNSUPPORTED_CORPORATE_ACTION"
  | "NEGATIVE_DERIVED_QUANTITY"
  | "OTHER";

export type ImportBatchState =
  | "UPLOADED"
  | "PREVIEWED"
  | "VALIDATED"
  | "AWAITING_CONFIRMATION"
  | "COMMITTING"
  | "COMMITTED"
  | "REJECTED"
  | "FAILED";

export type ImportRowResolution = "UNRESOLVED" | "RESOLVED" | "EXCLUDED" | "COMMITTED";
export type SecurityResolutionState = "UNRESOLVED" | "RESOLVED" | "AMBIGUOUS" | "UNSUPPORTED";

export interface Profile {
  id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  user_id: string;
  locale: string;
  timezone: string;
  date_format: "DD-MM-YYYY" | "MM-DD-YYYY" | "YYYY-MM-DD";
  number_locale: string;
}

export interface Portfolio {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  base_currency: string;
  core_target_count: number | null;
  archived_at: string | null;
  created_at: string;
}

export interface Broker {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

export interface BrokerAccount {
  id: string;
  owner_id: string;
  broker_id: string;
  nickname: string;
  account_ref_masked: string | null;
  archived_at: string | null;
}

export interface Security {
  id: string;
  asset_class: AssetClass;
  name: string;
  isin: string | null;
  exchange: string | null;
  primary_symbol: string | null;
  currency: string;
  is_active: boolean;
}

export interface CurrentHolding {
  owner_id: string;
  portfolio_id: string;
  security_id: string;
  net_quantity: string | null;
  active_txn_count: number;
  unhandled_txn_count: number;
  missing_quantity_count: number;
  non_valid_txn_count: number;
  first_trade_date: string | null;
  last_trade_date: string | null;
}

export interface PortfolioSecuritySetting {
  id: string;
  owner_id: string;
  portfolio_id: string;
  security_id: string;
  role: PortfolioRole;
  notes: string | null;
}

export interface ImportBatch {
  id: string;
  owner_id: string;
  portfolio_id: string;
  state: ImportBatchState;
  original_filename: string;
  source_format: string;
  source_system: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  file_sha256: string | null;
  total_source_rows: number | null;
  rows_valid: number;
  rows_incomplete: number;
  rows_needs_review: number;
  error_summary: string | null;
  committed_at: string | null;
  created_at: string;
}

export interface ImportSourceRow {
  id: string;
  import_batch_id: string;
  owner_id: string;
  source_row_number: number;
  raw_payload: Record<string, string | null>;
  raw_line: string | null;
  raw_security_text: string | null;
  raw_exchange: string | null;
  raw_isin: string | null;
  raw_broker_text: string | null;
  raw_account_text: string | null;
  raw_txn_type: string | null;
  raw_date: string | null;
  raw_quantity: string | null;
  raw_unit_price: string | null;
  raw_gross_amount: string | null;
  raw_total_charges: string | null;
  raw_currency: string | null;
  raw_source_reference: string | null;
  candidate_security_id: string | null;
  candidate_broker_account_id: string | null;
  candidate_txn_type: TxnType | null;
  candidate_trade_date: string | null;
  candidate_quantity: string | null;
  candidate_unit_price: string | null;
  candidate_gross_amount: string | null;
  candidate_total_charges: string | null;
  candidate_currency: string | null;
  candidate_fingerprint: string | null;
  security_resolution: SecurityResolutionState;
  resolution: ImportRowResolution;
  data_quality_state: DataQualityState;
  data_quality_issues: DataQualityIssue[];
  duplicate_of_row_id: string | null;
  duplicate_reason: string | null;
}

/** Mirrors public.transactions (Migration 05). Read-only in the browser. */
export interface Transaction {
  id: string;
  owner_id: string;
  portfolio_id: string;
  broker_account_id: string | null;
  security_id: string;
  txn_type: TxnType;
  trade_date: string | null;
  quantity: string | null;
  unit_price: string | null;
  gross_amount: string | null;
  total_charges: string | null;
  currency: string;
  txn_state: "ACTIVE" | "SUPERSEDED" | "REVERSED";
  data_quality_state: string;
  data_quality_issues: string[];
  source_system: string | null;
  source_reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
