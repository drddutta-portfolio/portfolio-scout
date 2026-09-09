import type { SupabaseClient } from "@supabase/supabase-js";

import type { Security } from "@/lib/types";

/**
 * Deterministic security resolution against the read-only M09a master.
 *
 * Priority: exact ISIN, then exact exchange + symbol, then exact normalized
 * supported alias. No fuzzy matching, no name similarity, no auto-resolve:
 * a single candidate is only ever SUGGESTED until the user confirms it.
 *
 * Source workbooks may encode an exchange-qualified symbol in one cell, e.g.
 * "NSE:BBOX" or "BSE:500325". That shape is parsed deterministically into
 * exchange=NSE/BSE and symbol=BBOX/500325; nothing is guessed.
 */

export type MatchBasis = "ISIN" | "EXCHANGE_SYMBOL" | "ALIAS" | null;

export interface Candidates {
  securities: Security[];
  basis: MatchBasis;
}

export interface ResolutionInput {
  isin: string | null;
  exchange: string | null;
  securityText: string | null;
}

/** Same conservative normalization the database applies to alias values. */
export function normalizeAlias(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Parse only explicit exchange-qualified source text. Supported examples:
 * NSE:INFY, NSE - INFY, BSE:500209. No inferred exchange is ever added.
 */
export function parseQualifiedSymbol(
  securityText: string | null | undefined,
): { exchange: string; symbol: string } | null {
  if (!securityText) return null;
  const value = normalizeAlias(securityText);
  const match = /^(NSE|BSE)\s*(?::|\-|\/)\s*(.+)$/.exec(value);
  if (!match) return null;
  const symbol = normalizeAlias(match[2] ?? "");
  if (!symbol) return null;
  return { exchange: match[1]!, symbol };
}

interface MasterIndex {
  byIsin: Map<string, Security[]>;
  byExchangeSymbol: Map<string, Security[]>;
  byAlias: Map<string, Security[]>;
}

/**
 * Loads only the master rows relevant to this batch (never the whole master).
 */
export async function buildMasterIndex(
  client: SupabaseClient,
  inputs: ResolutionInput[],
): Promise<MasterIndex> {
  const isins = unique(
    inputs.map((i) => (i.isin ? i.isin.trim().toUpperCase() : null)).filter(isString),
  );

  // Query both the literal source text and, when the source explicitly embeds
  // NSE/BSE, the exact stripped symbol. This fixes rows such as "NSE:BBOX"
  // without creating aliases or broadening matching semantics.
  const texts = unique(
    inputs
      .flatMap((i) => {
        if (!i.securityText) return [] as string[];
        const literal = normalizeAlias(i.securityText);
        const qualified = parseQualifiedSymbol(i.securityText);
        return qualified ? [literal, qualified.symbol] : [literal];
      })
      .filter(isString),
  );

  const byIsin = new Map<string, Security[]>();
  const byExchangeSymbol = new Map<string, Security[]>();
  const byAlias = new Map<string, Security[]>();

  const securityIds = new Set<string>();
  const aliasHits: { normalized: string; securityId: string; type: string; exchange: string | null }[] =
    [];

  for (const chunk of chunks(isins, 200)) {
    const { data, error } = await client.from("securities").select("*").in("isin", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Security[]) {
      push(byIsin, row.isin!.toUpperCase(), row);
    }
  }

  for (const chunk of chunks(texts, 200)) {
    const { data, error } = await client
      .from("security_aliases")
      .select("security_id, alias_type, alias_normalized, exchange")
      .in("alias_normalized", chunk)
      .in("alias_type", ["EXCHANGE_SYMBOL", "ISIN", "COMPANY_NAME", "LEGACY_SYMBOL"]);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as {
      security_id: string;
      alias_type: string;
      alias_normalized: string;
      exchange: string | null;
    }[]) {
      aliasHits.push({
        normalized: row.alias_normalized,
        securityId: row.security_id,
        type: row.alias_type,
        exchange: row.exchange,
      });
      securityIds.add(row.security_id);
    }
  }

  const securitiesById = new Map<string, Security>();
  for (const chunk of chunks(Array.from(securityIds), 200)) {
    const { data, error } = await client.from("securities").select("*").in("id", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Security[]) securitiesById.set(row.id, row);
  }

  for (const hit of aliasHits) {
    const security = securitiesById.get(hit.securityId);
    if (!security) continue;
    if (hit.type === "EXCHANGE_SYMBOL" && hit.exchange) {
      push(byExchangeSymbol, `${hit.exchange.toUpperCase()}::${hit.normalized}`, security);
    }
    push(byAlias, hit.normalized, security);
  }

  return { byIsin, byExchangeSymbol, byAlias };
}

export function resolveCandidates(index: MasterIndex, input: ResolutionInput): Candidates {
  const isin = input.isin ? input.isin.trim().toUpperCase() : null;
  if (isin) {
    const hits = dedupe(index.byIsin.get(isin) ?? []);
    if (hits.length > 0) return { securities: hits, basis: "ISIN" };
  }

  const explicitExchange = input.exchange ? input.exchange.trim().toUpperCase() : null;
  const literalText = input.securityText ? normalizeAlias(input.securityText) : null;
  const qualified = parseQualifiedSymbol(input.securityText);

  // Prefer an explicit exchange column. Otherwise an explicit NSE:/BSE: prefix
  // is itself sufficient source evidence for exact exchange+symbol resolution.
  const exchange = explicitExchange ?? qualified?.exchange ?? null;
  const symbol = qualified?.symbol ?? literalText;

  if (symbol && exchange) {
    const hits = dedupe(index.byExchangeSymbol.get(`${exchange}::${symbol}`) ?? []);
    if (hits.length > 0) return { securities: hits, basis: "EXCHANGE_SYMBOL" };
  }

  // If a qualified source string did not resolve exchange+symbol, only try its
  // stripped exact symbol as an alias. This remains exact, never fuzzy.
  if (symbol) {
    const hits = dedupe(index.byAlias.get(symbol) ?? []);
    if (hits.length > 0) return { securities: hits, basis: "ALIAS" };
  }

  if (literalText && literalText !== symbol) {
    const hits = dedupe(index.byAlias.get(literalText) ?? []);
    if (hits.length > 0) return { securities: hits, basis: "ALIAS" };
  }

  return { securities: [], basis: null };
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dedupe(list: Security[]): Security[] {
  const seen = new Map<string, Security>();
  for (const item of list) seen.set(item.id, item);
  return Array.from(seen.values());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

function isString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
