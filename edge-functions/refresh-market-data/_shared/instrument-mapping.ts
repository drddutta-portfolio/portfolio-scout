export interface CanonicalSecurity {
  readonly id: string
  readonly primarySymbol: string
  readonly exchange: string
  readonly assetClass: string
}

interface AngelInstrument {
  readonly token?: unknown
  readonly symbol?: unknown
  readonly name?: unknown
  readonly expiry?: unknown
  readonly instrumenttype?: unknown
  readonly exch_seg?: unknown
}

export interface InstrumentMappingCandidate {
  readonly securityId: string
  readonly providerInstrumentId: string | null
  readonly exchange: string | null
  readonly tradingSymbol: string | null
  readonly providerInstrumentType: string | null
  readonly mappingStatus: "VERIFIED" | "UNRESOLVED" | "AMBIGUOUS"
  readonly matchBasis: "EXCHANGE_SYMBOL_EXACT" | null
  readonly evidence: Readonly<Record<string, unknown>>
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function supportedCashInstrument(instrument: AngelInstrument) {
  const exchange = text(instrument.exch_seg)
  const expiry = text(instrument.expiry)
  return (exchange === "NSE" || exchange === "BSE") && expiry === null
}

/**
 * Conservative mapping only: canonical exchange + canonical primary_symbol must
 * exactly equal Angel One exch_seg + name. No fuzzy/name similarity or exchange
 * inference is allowed. Unresolved or ambiguous results remain visibly unresolved.
 */
export function mapAngelInstruments(
  securities: readonly CanonicalSecurity[],
  master: readonly AngelInstrument[],
  instrumentMasterRetrievedAt: string,
): InstrumentMappingCandidate[] {
  const eligible = securities.filter((security) =>
    (security.assetClass === "EQUITY" || security.assetClass === "ETF")
    && (security.exchange === "NSE" || security.exchange === "BSE")
    && security.primarySymbol.trim() !== "")

  const candidates = new Map<string, AngelInstrument[]>()
  master.forEach((instrument) => {
    if (!supportedCashInstrument(instrument)) return
    const exchange = text(instrument.exch_seg)
    const canonicalSymbol = text(instrument.name)
    if (!exchange || !canonicalSymbol) return
    const key = `${exchange}:${canonicalSymbol.toUpperCase()}`
    candidates.set(key, [...(candidates.get(key) ?? []), instrument])
  })

  return eligible.map((security) => {
    const key = `${security.exchange}:${security.primarySymbol.toUpperCase()}`
    const matches = candidates.get(key) ?? []
    const evidence = {
      method: "Exact equality of PortfolioAI exchange + primary_symbol to Angel One exch_seg + name",
      canonical_exchange: security.exchange,
      canonical_symbol: security.primarySymbol,
      instrument_master_retrieved_at: instrumentMasterRetrievedAt,
      candidate_count: matches.length,
      candidates: matches.slice(0, 10).map((instrument) => ({
        token: text(instrument.token),
        trading_symbol: text(instrument.symbol),
        name: text(instrument.name),
        exchange: text(instrument.exch_seg),
        instrument_type: text(instrument.instrumenttype),
      })),
    }

    if (matches.length !== 1) {
      return {
        securityId: security.id,
        providerInstrumentId: null,
        exchange: security.exchange,
        tradingSymbol: null,
        providerInstrumentType: null,
        mappingStatus: matches.length ? "AMBIGUOUS" as const : "UNRESOLVED" as const,
        matchBasis: null,
        evidence,
      }
    }

    const match = matches[0]!
    const token = text(match.token)
    const tradingSymbol = text(match.symbol)
    const exchange = text(match.exch_seg)
    if (!token || !tradingSymbol || !exchange) {
      return {
        securityId: security.id,
        providerInstrumentId: null,
        exchange: security.exchange,
        tradingSymbol: null,
        providerInstrumentType: null,
        mappingStatus: "UNRESOLVED" as const,
        matchBasis: null,
        evidence: { ...evidence, invalid_candidate_shape: true },
      }
    }

    return {
      securityId: security.id,
      providerInstrumentId: token,
      exchange,
      tradingSymbol,
      providerInstrumentType: text(match.instrumenttype),
      mappingStatus: "VERIFIED" as const,
      matchBasis: "EXCHANGE_SYMBOL_EXACT" as const,
      evidence,
    }
  })
}
