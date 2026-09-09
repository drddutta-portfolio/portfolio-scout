import type { SupabaseClient } from "@supabase/supabase-js";

import type { Security } from "@/lib/types";

/**
 * Deterministic security resolution against the read-only M09a master.
 *
 * Priority: exact ISIN, then exact exchange + symbol, then exact normalized
 * supported alias. No fuzzy matching, no name similarity, no auto-resolve:
 * a single candidate is only ever SUGGESTED until the user confirms it.
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
  const texts = unique(
    inputs.map((i) => (i.securityText ? normalizeAlias(i.securityText) : null)).filter(isString),
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

  const text = input.securityText ? normalizeAlias(input.securityText) : null;
  const exchange = input.exchange ? input.exchange.trim().toUpperCase() : null;

  if (text && exchange) {
    const hits = dedupe(index.byExchangeSymbol.get(`${exchange}::${text}`) ?? []);
    if (hits.length > 0) return { securities: hits, basis: "EXCHANGE_SYMBOL" };
  }

  if (text) {
    const hits = dedupe(index.byAlias.get(text) ?? []);
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
