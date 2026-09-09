import type { DataQualityIssue, DataQualityState, TxnType } from "@/lib/types";
import { UNSUPPORTED_TXN_TYPES } from "@/lib/types";

/** Deterministic interpretation helpers. Missing source facts are never invented. */
export type MappableField =
  | "security_text" | "isin" | "exchange" | "broker_text" | "account_text"
  | "txn_type" | "date" | "quantity" | "unit_price" | "gross_amount"
  | "total_charges" | "currency" | "source_reference";

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
  security_text: ["ticker", "security", "symbol", "scrip", "instrument", "stock", "tradingsymbol", "company", "name"],
  isin: ["isin"], exchange: ["exchange", "exch"], broker_text: ["broker", "institution", "member"],
  account_text: ["account", "client id", "clientid", "demat", "dp id"],
  txn_type: ["type", "transaction", "side", "buy/sell", "action", "trade type"],
  date: ["date", "trade date", "transaction date", "settlement date"],
  quantity: ["net units", "quantity", "qty", "units", "shares"],
  unit_price: ["avg. buy price", "avg buy price", "average price", "buy price", "unit price", "avg price", "price", "rate"],
  gross_amount: ["invested value", "gross", "consideration", "net amount", "amount", "value"],
  total_charges: ["charge", "brokerage", "fees", "tax", "stt"], currency: ["currency", "ccy"],
  source_reference: ["reference", "order id", "trade id", "contract", "ref"],
};

export function guessMapping(headers: string[]): Partial<Record<MappableField, number>> {
  const mapping: Partial<Record<MappableField, number>> = {}; const used = new Set<number>();
  (Object.keys(HEADER_HINTS) as MappableField[]).forEach((field) => {
    const index = headers.findIndex((header, i) => !used.has(i) && HEADER_HINTS[field].some((hint) => {
      const h = header.toLowerCase().trim(); return h === hint || h.includes(hint);
    }));
    if (index >= 0) { mapping[field] = index; used.add(index); }
  }); return mapping;
}

export function parseSourceDate(raw: string | null | undefined): string | null {
  if (!raw) return null; const value = raw.trim(); if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (dmy) { let year = Number(dmy[3]); if (year < 100) year += 2000; return toIso(year, Number(dmy[2]), Number(dmy[1])); }
  const textual = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/.exec(value);
  if (textual) { const month = MONTHS.indexOf(textual[2]!.slice(0, 3).toLowerCase()) + 1; let year = Number(textual[3]); if (year < 100) year += 2000; return month ? toIso(year, month, Number(textual[1])) : null; }
  return null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function toIso(year: number, month: number, day: number): string | null {
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`); if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getUTCDate() === day && parsed.getUTCMonth() + 1 === month ? iso : null;
}
export function parseSourceNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null; const value = raw.replace(/[,\s₹]/g, "").trim();
  return value && /^-?\d+(\.\d+)?$/.test(value) ? value : null;
}

const TXN_ALIASES: Record<string, TxnType> = { b:"BUY", buy:"BUY", bought:"BUY", purchase:"BUY", s:"SELL", sell:"SELL", sold:"SELL", sale:"SELL", opening:"OPENING_POSITION", "opening position":"OPENING_POSITION", "opening balance":"OPENING_POSITION", holding:"OPENING_POSITION", "transfer in":"TRANSFER_IN", transfer_in:"TRANSFER_IN", in:"TRANSFER_IN", "transfer out":"TRANSFER_OUT", transfer_out:"TRANSFER_OUT", out:"TRANSFER_OUT", bonus:"BONUS", split:"SPLIT", reversal:"REVERSAL", adjustment:"ADJUSTMENT" };
export function parseTxnType(raw: string | null | undefined): TxnType | null { if (!raw) return null; return TXN_ALIASES[raw.trim().toLowerCase()] ?? null; }
export function isUnsupportedTxnType(type: TxnType | null): boolean { return type !== null && UNSUPPORTED_TXN_TYPES.includes(type); }

export interface RowVerdict { issues: DataQualityIssue[]; dataQualityState: DataQualityState; ready: boolean; missingDateOnly: boolean; blockingReasons: string[]; }
export interface RowFacts { securityResolved:boolean; securityAmbiguous:boolean; brokerAccountId:string|null; brokerTextPresent:boolean; txnType:TxnType|null; tradeDate:string|null; quantity:string|null; currency:string|null; }
export interface EvaluateOptions { allowMissingDate?: boolean; allowMissingBrokerAccount?: boolean; }

/** Mirrors M10/M11 commit eligibility. A stated broker without an account always blocks. */
export function evaluateRow(facts: RowFacts, options: EvaluateOptions = {}): RowVerdict {
  const allowMissingDate = options.allowMissingDate === true;
  const allowMissingBrokerAccount = options.allowMissingBrokerAccount === true;
  const issues: DataQualityIssue[] = []; const blocking: string[] = []; let needsReview = false; let otherBlocking = 0;
  if (!facts.securityResolved) { otherBlocking++; if (facts.securityAmbiguous) { issues.push("AMBIGUOUS_SECURITY"); needsReview=true; blocking.push("More than one master security matches; pick one or exclude the row."); } else { issues.push("UNRESOLVED_SECURITY"); blocking.push("No security confirmed."); } }
  const genuinelyUnstatedBroker = !facts.brokerTextPresent && !facts.brokerAccountId;
  if (genuinelyUnstatedBroker) issues.push("MISSING_BROKER");
  if (!facts.brokerAccountId) {
    issues.push("MISSING_ACCOUNT");
    if (!(allowMissingBrokerAccount && genuinelyUnstatedBroker)) { otherBlocking++; blocking.push(facts.brokerTextPresent ? "Source broker is stated but no matching account is chosen." : "No broker account chosen."); }
  }
  if (!facts.tradeDate) { issues.push("MISSING_DATE"); if (!allowMissingDate) { otherBlocking++; blocking.push("Trade date could not be read from the source."); } }
  if (!facts.quantity) { issues.push("MISSING_QUANTITY"); otherBlocking++; blocking.push("Quantity could not be read from the source."); }
  if (!facts.txnType) { issues.push("OTHER"); needsReview=true; otherBlocking++; blocking.push("Transaction type is not recognised."); }
  else if (isUnsupportedTxnType(facts.txnType)) { issues.push("UNSUPPORTED_CORPORATE_ACTION"); needsReview=true; otherBlocking++; blocking.push(`${facts.txnType} has no deterministic meaning yet; exclude the row.`); }
  if (!facts.currency) { issues.push("OTHER"); otherBlocking++; blocking.push("Currency is not stated."); }
  const unique = Array.from(new Set(issues));
  const missingDateOnly = !facts.tradeDate && otherBlocking === 0 && unique.every((i) => i === "MISSING_DATE");
  return { issues: unique, dataQualityState: unique.length===0 ? "VALID" : needsReview ? "NEEDS_REVIEW" : "INCOMPLETE", ready: otherBlocking===0, missingDateOnly, blockingReasons:blocking };
}

export function fingerprint(parts: (string | null)[]): string { return parts.map((p)=>(p??"~").toString().toUpperCase()).join("|").slice(0,200); }
export type SheetKind = "TRANSACTIONS" | "HOLDINGS" | "STOCKMASTER" | "UNKNOWN";
function has(headers:string[], needle:string):boolean { return headers.some((h)=>h.toLowerCase().trim()===needle); }
export function detectSheetKind(name:string, headers:string[]):SheetKind { const label=name.trim().toUpperCase(); if(has(headers,"isin code")&&has(headers,"symbol")) return "STOCKMASTER"; if(has(headers,"net units")&&has(headers,"ticker")) return "HOLDINGS"; if(has(headers,"buy/sell")||(has(headers,"ticker")&&has(headers,"units"))) return "TRANSACTIONS"; if(label==="TRANSACTIONS"||label==="HOLDINGS"||label==="STOCKMASTER") return label as SheetKind; return "UNKNOWN"; }
export function isFillerRow(row:string[], mapping:Partial<Record<MappableField,number>>):boolean { const cell=(field:MappableField)=>{const i=mapping[field]; return i===undefined?"":(row[i]??"").trim();}; return cell("security_text")===""&&cell("quantity")===""; }
export interface HoldingsClaim { ticker:string; netUnits:string|null; }
export function parseHoldingsSheet(headers:string[], rows:string[][]):HoldingsClaim[] { const ti=headers.findIndex((h)=>h.toLowerCase().trim()==="ticker"); const ui=headers.findIndex((h)=>h.toLowerCase().trim()==="net units"); if(ti<0||ui<0)return[]; const out:HoldingsClaim[]=[]; for(const row of rows){const ticker=(row[ti]??"").trim().toUpperCase(); if(ticker)out.push({ticker,netUnits:parseSourceNumber(row[ui]??null)});} return out; }
export interface StockMasterEntry { symbol:string; isin:string|null; name:string|null; }
export function parseStockMaster(headers:string[], rows:string[][]):Map<string,StockMasterEntry>{ const idx=(n:string)=>headers.findIndex((h)=>h.toLowerCase().trim()===n); const si=idx("symbol"), ii=idx("isin code"), ni=idx("company name"); const map=new Map<string,StockMasterEntry>(); if(si<0)return map; for(const row of rows){const symbol=(row[si]??"").trim().toUpperCase(); if(!symbol)continue; const raw=ii>=0?(row[ii]??"").trim().toUpperCase():""; map.set(symbol,{symbol,isin:/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(raw)?raw:null,name:ni>=0?(row[ni]??"").trim()||null:null});} return map; }
const SNAPSHOT_PREFIX="portfolioai.holdings-claim.";
export function storeHoldingsClaim(batchId:string, claims:HoldingsClaim[]){try{localStorage.setItem(SNAPSHOT_PREFIX+batchId,JSON.stringify(claims));}catch{/* optional */}}
export function readHoldingsClaim(batchId:string):HoldingsClaim[]|null{try{const raw=localStorage.getItem(SNAPSHOT_PREFIX+batchId); return raw?JSON.parse(raw) as HoldingsClaim[]:null;}catch{return null;}}
