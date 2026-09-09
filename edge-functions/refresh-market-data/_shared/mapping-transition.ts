export interface StoredMappingIdentity {
  readonly id: string
  readonly mapping_status: string
  readonly provider_instrument_id: string | null
  readonly exchange: string | null
  readonly trading_symbol: string | null
}

export interface CandidateIdentity {
  readonly providerInstrumentId: string | null
  readonly exchange: string | null
  readonly tradingSymbol: string | null
  readonly mappingStatus: string
}

export function verifiedIdentityChanged(
  existing: StoredMappingIdentity | undefined,
  candidate: CandidateIdentity,
): boolean {
  if (!existing || existing.mapping_status !== "VERIFIED") return false
  return candidate.mappingStatus !== "VERIFIED"
    || existing.provider_instrument_id !== candidate.providerInstrumentId
    || existing.exchange !== candidate.exchange
    || existing.trading_symbol !== candidate.tradingSymbol
}
