import type { SupabaseClient } from "@supabase/supabase-js";

import type { ParsedFile, ParsedSheet } from "@/lib/parse-file";
import { buildMasterIndex, resolveCandidates } from "@/lib/security-resolution";

export interface HoldingSnapshotInput {
  security_id: string;
  source_ticker: string;
  source_company_name: string | null;
  net_units_claim: string | null;
  avg_buy_price: string | null;
  invested_value: string | null;
  spreadsheet_current_price: string | null;
  spreadsheet_current_value: string | null;
  spreadsheet_unrealized_pl: string | null;
  spreadsheet_unrealized_pct: string | null;
  spreadsheet_realized_pl: string | null;
  spreadsheet_realized_pct: string | null;
  sector: string | null;
  market_cap: string | null;
  cap_category: string | null;
}

export interface HoldingSnapshotImportResult {
  resolved: HoldingSnapshotInput[];
  unresolvedTickers: string[];
  totalRows: number;
}

interface StockMasterMeta {
  isin: string | null;
  sector: string | null;
  marketCap: string | null;
  capCategory: string | null;
}

const HEADER_ALIASES = {
  ticker: ["ticker", "symbol"],
  company: ["company", "company name"],
  netUnits: ["net units", "net qty", "quantity"],
  avgBuyPrice: ["avg. buy price", "avg buy price", "average buy price"],
  investedValue: ["invested value", "invested cost", "cost value"],
  currentPrice: ["current price", "ltp", "market price"],
  currentValue: ["current value", "market value"],
  unrealizedPl: ["unrealized p/l", "unrealised p/l", "unrealized pl", "unrealised pl"],
  unrealizedPct: ["unrealized %", "unrealised %", "unrealized pct", "unrealised pct"],
  realizedPl: ["realized p/l", "realised p/l", "realized pl", "realised pl"],
  realizedPct: ["realized %", "realised %", "realized pct", "realised pct"],
  sector: ["sector", "sectors"],
} as const;

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findColumn(headers: string[], aliases: readonly string[]): number {
  const normalized = headers.map(normalizedHeader);
  return normalized.findIndex((header) => aliases.includes(header));
}

function cell(row: string[], index: number): string | null {
  if (index < 0) return null;
  const value = row[index]?.trim() ?? "";
  if (!value || value === "#REF!" || value === "#N/A") return null;
  return value;
}

function numericCell(row: string[], index: number): string | null {
  const value = cell(row, index);
  if (!value) return null;
  const cleaned = value.replace(/[₹,%\s]/g, "").replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
}

function findSheet(parsed: ParsedFile, preferredNames: string[]): ParsedSheet | null {
  const upper = new Set(preferredNames.map((name) => name.toUpperCase()));
  return parsed.sheets.find((sheet) => upper.has(sheet.name.trim().toUpperCase())) ?? null;
}

function parseStockMaster(parsed: ParsedFile): Map<string, StockMasterMeta> {
  const sheet = findSheet(parsed, ["STOCKMASTER", "STOCK MASTER"]);
  const out = new Map<string, StockMasterMeta>();
  if (!sheet) return out;

  const symbolIndex = findColumn(sheet.headers, ["symbol"]);
  const isinIndex = findColumn(sheet.headers, ["isin code", "isin"]);
  const sectorIndex = findColumn(sheet.headers, ["sectors", "sector"]);
  const marketCapIndex = findColumn(sheet.headers, ["market cap", "market capitalization"]);
  const capCategoryIndex = findColumn(sheet.headers, ["cap category", "market cap category"]);

  for (const row of sheet.rows) {
    const symbol = cell(row, symbolIndex)?.toUpperCase();
    if (!symbol) continue;
    out.set(symbol, {
      isin: cell(row, isinIndex)?.toUpperCase() ?? null,
      sector: cell(row, sectorIndex),
      marketCap: numericCell(row, marketCapIndex),
      capCategory: cell(row, capCategoryIndex),
    });
  }
  return out;
}

export async function buildHoldingSnapshotImport(
  client: SupabaseClient,
  parsed: ParsedFile,
): Promise<HoldingSnapshotImportResult> {
  const sheet = findSheet(parsed, ["HOLDINGS"]);
  if (!sheet) throw new Error("This workbook does not contain a HOLDINGS sheet.");

  const tickerIndex = findColumn(sheet.headers, HEADER_ALIASES.ticker);
  const companyIndex = findColumn(sheet.headers, HEADER_ALIASES.company);
  const netUnitsIndex = findColumn(sheet.headers, HEADER_ALIASES.netUnits);
  const avgBuyIndex = findColumn(sheet.headers, HEADER_ALIASES.avgBuyPrice);
  const investedIndex = findColumn(sheet.headers, HEADER_ALIASES.investedValue);
  const currentPriceIndex = findColumn(sheet.headers, HEADER_ALIASES.currentPrice);
  const currentValueIndex = findColumn(sheet.headers, HEADER_ALIASES.currentValue);
  const unrealizedPlIndex = findColumn(sheet.headers, HEADER_ALIASES.unrealizedPl);
  const unrealizedPctIndex = findColumn(sheet.headers, HEADER_ALIASES.unrealizedPct);
  const realizedPlIndex = findColumn(sheet.headers, HEADER_ALIASES.realizedPl);
  const realizedPctIndex = findColumn(sheet.headers, HEADER_ALIASES.realizedPct);
  const sectorIndex = findColumn(sheet.headers, HEADER_ALIASES.sector);

  if (tickerIndex < 0 || netUnitsIndex < 0) {
    throw new Error("HOLDINGS must contain Ticker and Net Units columns.");
  }

  const stockMaster = parseStockMaster(parsed);
  const sourceRows = sheet.rows
    .map((row) => {
      const ticker = cell(row, tickerIndex)?.toUpperCase() ?? null;
      if (!ticker) return null;
      const master = stockMaster.get(ticker);
      return {
        row,
        ticker,
        master,
        company: cell(row, companyIndex),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const inputs = sourceRows.map((entry) => ({
    isin: entry.master?.isin ?? null,
    exchange: null,
    securityText: entry.ticker,
  }));
  const index = await buildMasterIndex(client, inputs);

  const resolved: HoldingSnapshotInput[] = [];
  const unresolvedTickers: string[] = [];

  sourceRows.forEach((entry, i) => {
    const candidates = resolveCandidates(index, inputs[i]!);
    if (candidates.securities.length !== 1) {
      unresolvedTickers.push(entry.ticker);
      return;
    }
    const security = candidates.securities[0]!;
    const { row } = entry;
    resolved.push({
      security_id: security.id,
      source_ticker: entry.ticker,
      source_company_name: entry.company,
      net_units_claim: numericCell(row, netUnitsIndex),
      avg_buy_price: numericCell(row, avgBuyIndex),
      invested_value: numericCell(row, investedIndex),
      spreadsheet_current_price: numericCell(row, currentPriceIndex),
      spreadsheet_current_value: numericCell(row, currentValueIndex),
      spreadsheet_unrealized_pl: numericCell(row, unrealizedPlIndex),
      spreadsheet_unrealized_pct: numericCell(row, unrealizedPctIndex),
      spreadsheet_realized_pl: numericCell(row, realizedPlIndex),
      spreadsheet_realized_pct: numericCell(row, realizedPctIndex),
      sector: cell(row, sectorIndex) ?? entry.master?.sector ?? null,
      market_cap: entry.master?.marketCap ?? null,
      cap_category: entry.master?.capCategory ?? null,
    });
  });

  return { resolved, unresolvedTickers, totalRows: sourceRows.length };
}
