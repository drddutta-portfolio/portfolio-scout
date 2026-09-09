import type { DataQualityIssue, DataQualityState, TxnType } from "@/lib/types";
import { UNSUPPORTED_TXN_TYPES } from "@/lib/types";

/**
 * Deterministic interpretation helpers for the import workspace.
 *
 * Absolute rule: a value that cannot be read from the source stays NULL.
 * Nothing is defaulted to zero, to today's date, or to a guessed instrument,
 * account or transaction type.
 */

export type MappableField =
  | "security_text"
  | "isin"
  | "exchange"
  | "broker_text"
  | "account_text"
  | "txn_type"
  | "date"
  | "quantity"
  | "unit_price"
  | "gross_amount"
  | "total_charges"
  | "currency"
  | "source_reference";

export const MAPPABLE_FIELDS: { field: MappableField; label: string; hint?: string }[] = [
  { field: "security_text", label: "Security name / symbol" },
  { field: "isin", label: "ISIN" },
  { field: "exchange", label: "Exchange" },
  { field: "txn_type", label: "Transaction type" },
  { field: "date", label: "Trade date" },
  { field: "quantity", label: "Quantity" },
  { field: "unit_price", label: "Unit price", hint: "optional" },
  { field: "gross_amount", label: "Gross amount", hint: "optional, never derived" },
  { field: "total_charges", label: "Total charges", hint: "optional" },
  { field: "currency", label: "Currency", hint: "optional column" },
  { field: "broker_text", label: "Broker / institution", hint: "optional" },
  { field: "account_text", label: "Account reference", hint: "optional" },
  { field: "source_reference", label: "Source reference", hint: "optional" },
];

const HEADER_HINTS: Record<MappableField, string[]> = {
  security_text: [
    "ticker",
    "security",
    "symbol",
    "scrip",
    "instrument",
    "stock",
    "tradingsymbol",
    "company",
    "name",
  ],
  isin: ["isin"],
  exchange: ["exchange", "exch"],
  broker_text: ["broker", "institution", "member"],
  account_text: ["account", "client id", "clientid", "demat", "dp id"],
  txn_type: ["type", "transaction", "side", "buy/sell", "action", "trade type"],
  date: ["date", "trade date", "transaction date", "settlement date"],
  quantity: ["net units", "quantity", "qty", "units", "shares"],
  unit_price: [
    "avg. buy price",
    "avg buy price",
    "average price",
    "buy price",
    "unit price",
    "avg price",
    "price",
    "rate",
  ],
  gross_amount: ["invested value", "gross", "consideration", "net amount", "amount", "value"],
  total_charges: ["charge", "brokerage", "fees", "tax", "stt"],

  currency: ["currency", "ccy"],
  source_reference: ["reference", "order id", "trade id", "contract", "ref"],
};

export function guessMapping(headers: string[]): Partial<Record<MappableField, number>> {
  const mapping: Partial<Record<MappableField, number>> = {};
  const used = new Set<number>();
  (Object.keys(HEADER_HINTS) as MappableField[]).forEach((field) => {
    const hints = HEADER_HINTS[field];
    const index = headers.findIndex((header, i) => {
      if (used.has(i)) return false;
      const h = header.toLowerCase().trim();
      return hints.some((hint) => h === hint || h.includes(hint));
    });
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  });
  return mapping;
}

/** Parses a date only when the shape is unambiguous; otherwise returns null. */
export function parseSourceDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (day > 31 || month > 12) return null;
    return toIso(year, month, day);
  }

  const textual = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/.exec(value);
  if (textual) {
    const month = MONTHS.indexOf(textual[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    let year = Number(textual[3]);
    if (year < 100) year += 2000;
    return toIso(year, month, Number(textual[1]));
  }

  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function toIso(year: number, month: number, day: number): string | null {
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCDate() !== day || parsed.getUTCMonth() + 1 !== month) return null;
  return iso;
}

/** Parses a positive decimal. Returns null on anything unreadable. */
export function parseSourceNumber(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/[,\s₹]/g, "").trim();
  if (!value) return null;
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  return value;
}

const TXN_ALIASES: Record<string, TxnType> = {
  b: "BUY",
  buy: "BUY",
  bought: "BUY",
  purchase: "BUY",
  s: "SELL",
  sell: "SELL",
  sold: "SELL",
  sale: "SELL",
  opening: "OPENING_POSITION",
  "opening position": "OPENING_POSITION",
  "opening balance": "OPENING_POSITION",
  holding: "OPENING_POSITION",
  "transfer in": "TRANSFER_IN",
  transfer_in: "TRANSFER_IN",
  in: "TRANSFER_IN",
  "transfer out": "TRANSFER_OUT",
  transfer_out: "TRANSFER_OUT",
  out: "TRANSFER_OUT",
  bonus: "BONUS",
  split: "SPLIT",
  reversal: "REVERSAL",
  adjustment: "ADJUSTMENT",
};

export function parseTxnType(raw: string | null | undefined): TxnType | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return TXN_ALIASES[key] ?? null;
}

export function isUnsupportedTxnType(type: TxnType | null): boolean {
  return type !== null && UNSUPPORTED_TXN_TYPES.includes(type);
}

export interface RowVerdict {
  issues: DataQualityIssue[];
  dataQualityState: DataQualityState;
  /** Commit-eligible under the currently available backend rules. */
  ready: boolean;
  /** The only thing missing is the trade date; every other fact is complete. */
  missingDateOnly: boolean;
  blockingReasons: string[];
}

export interface RowFacts {
  securityResolved: boolean;
  securityAmbiguous: boolean;
  brokerAccountId: string | null;
  brokerTextPresent: boolean;
  txnType: TxnType | null;
  tradeDate: string | null;
  quantity: string | null;
  currency: string | null;
}

export interface EvaluateOptions {
  /**
   * Migration 10 lets a row whose only defect is an unknown trade date reach
   * the ledger as INCOMPLETE + MISSING_DATE. Until M10 is deployed this stays
   * false and a missing date keeps blocking the commit, exactly as today.
   */
  allowMissingDate?: boolean;
}

/** Applies the deployed backend's own rules; never softens them. */
export function evaluateRow(facts: RowFacts, options: EvaluateOptions = {}): RowVerdict {
  const allowMissingDate = options.allowMissingDate === true;
  const issues: DataQualityIssue[] = [];
  const blocking: string[] = [];
  let needsReview = false;
  let otherBlocking = 0;

  if (!facts.securityResolved) {
    otherBlocking += 1;
    if (facts.securityAmbiguous) {
      issues.push("AMBIGUOUS_SECURITY");
      needsReview = true;
      blocking.push("More than one master security matches; pick one or exclude the row.");
    } else {
      issues.push("UNRESOLVED_SECURITY");
      blocking.push("No security confirmed.");
    }
  }
  if (!facts.brokerTextPresent && !facts.brokerAccountId) {
    issues.push("MISSING_BROKER");
  }
  if (!facts.brokerAccountId) {
    issues.push("MISSING_ACCOUNT");
    otherBlocking += 1;
    blocking.push("No broker account chosen.");
  }
  if (!facts.tradeDate) {
    issues.push("MISSING_DATE");
    if (!allowMissingDate) {
      blocking.push("Trade date could not be read from the source.");
    }
  }
  if (!facts.quantity) {
    issues.push("MISSING_QUANTITY");
    otherBlocking += 1;
    blocking.push("Quantity could not be read from the source.");
  }
  if (!facts.txnType) {
    issues.push("OTHER");
    needsReview = true;
    otherBlocking += 1;
    blocking.push("Transaction type is not recognised.");
  } else if (isUnsupportedTxnType(facts.txnType)) {
    issues.push("UNSUPPORTED_CORPORATE_ACTION");
    needsReview = true;
    otherBlocking += 1;
    blocking.push(`${facts.txnType} has no deterministic meaning yet; exclude the row.`);
  }
  if (!facts.currency) {
    issues.push("OTHER");
    otherBlocking += 1;
    blocking.push("Currency is not stated.");
  }

  const unique = Array.from(new Set(issues));
  const missingBrokerOnlyNote = unique.filter(
    (i) => i !== "MISSING_BROKER" && i !== "MISSING_DATE",
  );
  const missingDateOnly =
    !facts.tradeDate && otherBlocking === 0 && missingBrokerOnlyNote.length === 0;
  const ready = otherBlocking === 0 && (facts.tradeDate !== null || allowMissingDate);
  return {
    issues: unique,
    dataQualityState: unique.length === 0 ? "VALID" : needsReview ? "NEEDS_REVIEW" : "INCOMPLETE",
    ready,
    missingDateOnly,
    blockingReasons: blocking,
  };
}

export function fingerprint(parts: (string | null)[]): string {
  return parts
    .map((p) => (p ?? "~").toString().toUpperCase())
    .join("|")
    .slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Multi-sheet workbook support                                        */
/* ------------------------------------------------------------------ */

export type SheetKind = "TRANSACTIONS" | "HOLDINGS" | "STOCKMASTER" | "UNKNOWN";

function has(headers: string[], needle: string): boolean {
  return headers.some((h) => h.toLowerCase().trim() === needle);
}

/** Identifies a sheet purely from its headings; never from its position. */
export function detectSheetKind(name: string, headers: string[]): SheetKind {
  const label = name.trim().toUpperCase();
  if (has(headers, "isin code") && has(headers, "symbol")) return "STOCKMASTER";
  if (has(headers, "net units") && has(headers, "ticker")) return "HOLDINGS";
  if (has(headers, "buy/sell") || (has(headers, "ticker") && has(headers, "units")))
    return "TRANSACTIONS";
  if (label === "TRANSACTIONS" || label === "HOLDINGS" || label === "STOCKMASTER")
    return label as SheetKind;
  return "UNKNOWN";
}

/**
 * A row carrying no security text and no quantity is filler, not a trade.
 * Filler rows are dropped before staging and the count is disclosed.
 */
export function isFillerRow(
  row: string[],
  mapping: Partial<Record<MappableField, number>>,
): boolean {
  const cell = (field: MappableField) => {
    const index = mapping[field];
    if (index === undefined) return "";
    return (row[index] ?? "").trim();
  };
  const security = cell("security_text");
  const quantity = cell("quantity");
  // No security and no quantity means the row carries no trade, whatever else
  // the spreadsheet computed in its other columns.
  return security === "" && quantity === "";
}

export interface HoldingsClaim {
  ticker: string;
  netUnits: string | null;
}

/** Reads the HOLDINGS sheet purely as a claimed unit count for reconciliation. */
export function parseHoldingsSheet(headers: string[], rows: string[][]): HoldingsClaim[] {
  const tickerIndex = headers.findIndex((h) => h.toLowerCase().trim() === "ticker");
  const unitsIndex = headers.findIndex((h) => h.toLowerCase().trim() === "net units");
  if (tickerIndex < 0 || unitsIndex < 0) return [];
  const out: HoldingsClaim[] = [];
  for (const row of rows) {
    const ticker = (row[tickerIndex] ?? "").trim().toUpperCase();
    if (!ticker) continue;
    out.push({ ticker, netUnits: parseSourceNumber(row[unitsIndex] ?? null) });
  }
  return out;
}

export interface StockMasterEntry {
  symbol: string;
  isin: string | null;
  name: string | null;
}

/** Reads STOCKMASTER as matching evidence only. Nothing is written to the master. */
export function parseStockMaster(
  headers: string[],
  rows: string[][],
): Map<string, StockMasterEntry> {
  const idx = (needle: string) => headers.findIndex((h) => h.toLowerCase().trim() === needle);
  const symbolIndex = idx("symbol");
  const isinIndex = idx("isin code");
  const nameIndex = idx("company name");
  const map = new Map<string, StockMasterEntry>();
  if (symbolIndex < 0) return map;
  for (const row of rows) {
    const symbol = (row[symbolIndex] ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const isinRaw = isinIndex >= 0 ? (row[isinIndex] ?? "").trim().toUpperCase() : "";
    map.set(symbol, {
      symbol,
      isin: /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isinRaw) ? isinRaw : null,
      name: nameIndex >= 0 ? (row[nameIndex] ?? "").trim() || null : null,
    });
  }
  return map;
}

/* Browser-only reconciliation snapshot (never a ledger fact). */
const SNAPSHOT_PREFIX = "portfolioai.holdings-claim.";

export function storeHoldingsClaim(batchId: string, claims: HoldingsClaim[]) {
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + batchId, JSON.stringify(claims));
  } catch {
    /* storage unavailable: reconciliation is simply not offered */
  }
}

export function readHoldingsClaim(batchId: string): HoldingsClaim[] | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_PREFIX + batchId);
    return raw ? (JSON.parse(raw) as HoldingsClaim[]) : null;
  } catch {
    return null;
  }
}
