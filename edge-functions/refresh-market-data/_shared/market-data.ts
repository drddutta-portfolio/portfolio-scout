export const MARKET_DATA_PROVIDER = "ANGEL_ONE" as const
export const QUOTE_BATCH_SIZE = 50
export const DEFAULT_CACHE_TTL_SECONDS = 300

export interface ProviderInstrument {
  readonly mappingId: string
  readonly securityId: string
  readonly providerInstrumentId: string
  readonly exchange: string
  readonly tradingSymbol: string
}

export interface LatestPriceObservation {
  readonly mappingId: string
  readonly securityId: string
  readonly providerCode: typeof MARKET_DATA_PROVIDER
  readonly price: string
  readonly priceTimestamp: string | null
  readonly retrievedAt: string
  readonly marketSessionStatus: "OPEN" | "CLOSED" | "PRE_OPEN" | "POST_CLOSE" | "UNKNOWN"
  readonly previousClose: string | null
  readonly dayOpen: string | null
  readonly dayHigh: string | null
  readonly dayLow: string | null
  readonly netChange: string | null
  readonly percentChange: string | null
  readonly averagePrice: string | null
  readonly tradeVolume: string | null
  readonly totalBuyQuantity: string | null
  readonly totalSellQuantity: string | null
  readonly lowerCircuit: string | null
  readonly upperCircuit: string | null
  readonly week52Low: string | null
  readonly week52High: string | null
  readonly provenance: Readonly<Record<string, unknown>>
}

export interface MarketDataProvider {
  readonly code: string
  getLatestPrices(instruments: readonly ProviderInstrument[]): Promise<readonly LatestPriceObservation[]>
}

export function chunk<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Chunk size must be a positive integer.")
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export function unsignedDecimal(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" && typeof value !== "string") return null
  const text = String(value).trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error(`Angel One returned invalid ${field}.`)
  return text
}

export function signedDecimal(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" && typeof value !== "string") return null
  const text = String(value).trim()
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error(`Angel One returned invalid ${field}.`)
  return text
}

/** Angel One exchange timestamps are India-local when returned as text. */
export function parseAngelTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== "string" || !value.trim()) return null

  const text = value.trim()
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (match) {
    const months: Record<string, number> = {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
    }
    const month = months[match[2]!.toUpperCase()]
    if (!month) return null
    const iso = `${match[3]}-${String(month).padStart(2, "0")}-${match[1]}T${match[4]}:${match[5]}:${match[6]}+05:30`
    const parsed = new Date(iso)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function isFresh(retrievedAt: string, now: Date, ttlSeconds: number) {
  const retrieved = new Date(retrievedAt).getTime()
  return Number.isFinite(retrieved) && now.getTime() - retrieved < ttlSeconds * 1000
}
