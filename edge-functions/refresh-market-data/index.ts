import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { AngelOneProvider, loadAngelOneConfig } from "./_shared/angel-one.ts"
import {
  DEFAULT_CACHE_TTL_SECONDS,
  isFresh,
  MARKET_DATA_PROVIDER,
  type LatestPriceObservation,
  type ProviderInstrument,
} from "./_shared/market-data.ts"
import { mapAngelInstruments } from "./_shared/instrument-mapping.ts"
import {
  verifiedIdentityChanged,
  type StoredMappingIdentity,
} from "./_shared/mapping-transition.ts"
import { safeError, SafeOperationalError } from "./_shared/security.ts"
import { parseSampleSecurityIds } from "./_shared/sample-request.ts"

interface RefreshRequest {
  readonly action?: unknown
  readonly portfolioId?: unknown
  readonly securityIds?: unknown
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const LEASE_SECONDS = 300
const PRICE_REFRESH_COOLDOWN_SECONDS = 60
const MAPPING_SYNC_COOLDOWN_SECONDS = 3600

interface AdminClient {
  rpc(
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

function json(status: number, body: Readonly<Record<string, unknown>>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function requestedSecuritySample(value: unknown): readonly string[] | null {
  const parsed = parseSampleSecurityIds(value)
  if (!parsed.specified) return null
  if (!parsed.valid) {
    throw new SafeOperationalError(
      "INVALID_SECURITY_SAMPLE",
      "securityIds must contain between one and five UUIDs.",
      400,
    )
  }
  return parsed.ids
}

async function acquireLease(
  admin: AdminClient,
  portfolioId: string,
  operation: "REFRESH_PRICES" | "SYNC_MAPPINGS",
  holder: string,
) {
  const { data, error } = await admin.rpc("acquire_market_data_operation_lease", {
    p_portfolio_id: portfolioId,
    p_provider_code: MARKET_DATA_PROVIDER,
    p_operation: operation,
    p_lease_holder: holder,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) {
    throw new SafeOperationalError(
      "LEASE_ACQUIRE_FAILED",
      "Market-data operation could not be started.",
    )
  }

  const result = Array.isArray(data)
    ? data[0] as { acquired?: unknown; retry_after?: unknown } | undefined
    : undefined
  if (result?.acquired !== true) {
    throw new SafeOperationalError(
      "MARKET_DATA_RATE_LIMITED",
      "A market-data operation is already running or is in its safety cooldown.",
      429,
    )
  }
}

async function releaseLease(
  admin: AdminClient,
  portfolioId: string,
  operation: "REFRESH_PRICES" | "SYNC_MAPPINGS",
  holder: string,
  cooldown: number,
) {
  const { error } = await admin.rpc("release_market_data_operation_lease", {
    p_portfolio_id: portfolioId,
    p_provider_code: MARKET_DATA_PROVIDER,
    p_operation: operation,
    p_lease_holder: holder,
    p_cooldown_seconds: cooldown,
  })
  if (error) {
    throw new SafeOperationalError(
      "LEASE_RELEASE_FAILED",
      "Market-data operation completed but its cooldown could not be recorded.",
    )
  }
}

function extendedQuoteProvenance(item: LatestPriceObservation) {
  return {
    ...item.provenance,
    full_quote: {
      net_change: item.netChange,
      percent_change: item.percentChange,
      average_price: item.averagePrice,
      trade_volume: item.tradeVolume,
      total_buy_quantity: item.totalBuyQuantity,
      total_sell_quantity: item.totalSellQuantity,
      lower_circuit: item.lowerCircuit,
      upper_circuit: item.upperCircuit,
      week_52_low: item.week52Low,
      week_52_high: item.week52High,
    },
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (request.method !== "POST") return json(405, { error: "Method not allowed." })

  const authorization = request.headers.get("Authorization")
  if (!authorization) return json(401, { error: "Authentication required." })

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json(500, { error: "Supabase server configuration is incomplete." })
  }

  try {
    const body = await request.json() as RefreshRequest
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) {
      return json(401, { error: "Invalid authenticated session." })
    }

    if (body.action === "READ_CACHE") {
      if (!Array.isArray(body.securityIds) || body.securityIds.some((value) => typeof value !== "string")) {
        return json(400, { error: "securityIds must be an array of UUID strings." })
      }
      const securityIds = [...new Set(body.securityIds as string[])].slice(0, 1000)
      if (!securityIds.length) return json(200, { prices: [], unresolvedSecurityIds: [] })

      const [priceResult, mappingResult] = await Promise.all([
        userClient
          .from("market_price_latest")
          .select("security_id,price,currency,price_timestamp,retrieved_at,provider_code,market_session_status,previous_close,day_open,day_high,day_low,provenance")
          .eq("provider_code", MARKET_DATA_PROVIDER)
          .in("security_id", securityIds),
        userClient
          .from("market_data_instrument_mappings")
          .select("security_id,mapping_status")
          .eq("provider_code", MARKET_DATA_PROVIDER)
          .in("security_id", securityIds),
      ])
      if (priceResult.error) throw priceResult.error
      if (mappingResult.error) throw mappingResult.error

      const verifiedIds = new Set(
        (mappingResult.data ?? [])
          .filter((mapping) => mapping.mapping_status === "VERIFIED")
          .map((mapping) => mapping.security_id),
      )

      return json(200, {
        prices: (priceResult.data ?? []).map((price) => ({
          securityId: price.security_id,
          price: String(price.price),
          currency: price.currency,
          priceTimestamp: price.price_timestamp,
          retrievedAt: price.retrieved_at,
          provider: price.provider_code,
          marketSessionStatus: price.market_session_status,
          previousClose: price.previous_close === null ? null : String(price.previous_close),
          dayOpen: price.day_open === null ? null : String(price.day_open),
          dayHigh: price.day_high === null ? null : String(price.day_high),
          dayLow: price.day_low === null ? null : String(price.day_low),
          provenance: price.provenance,
        })),
        unresolvedSecurityIds: securityIds.filter((id) => !verifiedIds.has(id)),
      })
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

    if (body.action === "SYNC_MAPPINGS") {
      if (typeof body.portfolioId !== "string") {
        return json(400, { error: "portfolioId must be a UUID string." })
      }
      const sampleSecurityIds = requestedSecuritySample(body.securityIds)
      const { data: portfolio, error: portfolioError } = await admin
        .from("portfolios")
        .select("id,owner_id")
        .eq("id", body.portfolioId)
        .eq("owner_id", userData.user.id)
        .single()
      if (portfolioError || !portfolio) return json(404, { error: "Portfolio not found." })

      const leaseHolder = crypto.randomUUID()
      await acquireLease(admin, portfolio.id, "SYNC_MAPPINGS", leaseHolder)
      try {
        const { data: holdings, error: holdingsError } = await admin
          .from("current_holdings")
          .select("security_id,net_quantity")
          .eq("portfolio_id", portfolio.id)
        if (holdingsError) throw holdingsError

        const openSecurityIds = [...new Set(
          (holdings ?? [])
            .filter((holding) => Number(holding.net_quantity) > 0)
            .map((holding) => holding.security_id),
        )]
        const openSecurityIdSet = new Set(openSecurityIds)
        if (sampleSecurityIds?.some((securityId) => !openSecurityIdSet.has(securityId))) {
          throw new SafeOperationalError(
            "INVALID_MAPPING_SAMPLE",
            "Every sampled security must be a current holding in this portfolio.",
            400,
          )
        }
        const securityIds = sampleSecurityIds ?? openSecurityIds

        const { data: securities, error: securitiesError } = securityIds.length
          ? await admin
            .from("securities")
            .select("id,primary_symbol,exchange,asset_class")
            .in("id", securityIds)
          : { data: [], error: null }
        if (securitiesError) throw securitiesError

        const masterRetrievedAt = new Date().toISOString()
        const masterResponse = await fetch(
          "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
        )
        if (!masterResponse.ok) {
          throw new SafeOperationalError(
            "ANGEL_INSTRUMENT_MASTER_FAILED",
            "Angel One instrument master could not be loaded.",
            502,
          )
        }
        const master = await masterResponse.json() as readonly Readonly<Record<string, unknown>>[]
        const canonical = (securities ?? []).flatMap((security) => {
          if (!security.primary_symbol || !security.exchange) return []
          return [{
            id: security.id,
            primarySymbol: security.primary_symbol,
            exchange: security.exchange,
            assetClass: security.asset_class,
          }]
        })
        const resolved = mapAngelInstruments(canonical, master, masterRetrievedAt)

        const { data: existingRows, error: existingError } = securityIds.length
          ? await admin
            .from("market_data_instrument_mappings")
            .select("id,security_id,mapping_status,provider_instrument_id,exchange,trading_symbol")
            .eq("provider_code", MARKET_DATA_PROVIDER)
            .in("security_id", securityIds)
          : { data: [], error: null }
        if (existingError) throw existingError

        const existingBySecurity = new Map(
          (existingRows ?? []).map((row) => [
            row.security_id,
            row as StoredMappingIdentity & { security_id: string },
          ]),
        )
        const quarantined = resolved.filter((candidate) =>
          verifiedIdentityChanged(existingBySecurity.get(candidate.securityId), candidate)
        )
        const quarantinedIds = new Set(quarantined.map((candidate) => candidate.securityId))
        const accepted = resolved.filter((candidate) => !quarantinedIds.has(candidate.securityId))

        if (quarantined.length) {
          const mappingIds = quarantined
            .map((candidate) => existingBySecurity.get(candidate.securityId)?.id)
            .filter((id): id is string => Boolean(id))
          const { data: pendingReviews, error: pendingError } = await admin
            .from("market_data_mapping_reviews")
            .select("mapping_id")
            .eq("review_status", "PENDING")
            .in("mapping_id", mappingIds)
          if (pendingError) throw pendingError
          const pendingIds = new Set((pendingReviews ?? []).map((review) => review.mapping_id))
          const reviewRows = quarantined.flatMap((candidate) => {
            const existing = existingBySecurity.get(candidate.securityId)
            if (!existing || pendingIds.has(existing.id)) return []
            return [{
              mapping_id: existing.id,
              security_id: candidate.securityId,
              provider_code: MARKET_DATA_PROVIDER,
              proposed_provider_instrument_id: candidate.providerInstrumentId,
              proposed_exchange: candidate.exchange,
              proposed_trading_symbol: candidate.tradingSymbol,
              proposed_provider_instrument_type: candidate.providerInstrumentType,
              proposed_mapping_status: candidate.mappingStatus,
              proposed_match_basis: candidate.matchBasis,
              evidence: candidate.evidence,
              detected_at: masterRetrievedAt,
              review_status: "PENDING",
            }]
          })
          if (reviewRows.length) {
            const { error: reviewError } = await admin
              .from("market_data_mapping_reviews")
              .insert(reviewRows)
            if (reviewError) throw reviewError
          }
        }

        if (accepted.length) {
          const { error: upsertError } = await admin
            .from("market_data_instrument_mappings")
            .upsert(
              accepted.map((mapping) => ({
                security_id: mapping.securityId,
                provider_code: MARKET_DATA_PROVIDER,
                provider_instrument_id: mapping.providerInstrumentId,
                exchange: mapping.exchange,
                trading_symbol: mapping.tradingSymbol,
                provider_instrument_type: mapping.providerInstrumentType,
                mapping_status: mapping.mappingStatus,
                match_basis: mapping.matchBasis,
                evidence: mapping.evidence,
                instrument_master_as_of: masterRetrievedAt.slice(0, 10),
                verified_at: mapping.mappingStatus === "VERIFIED" ? masterRetrievedAt : null,
              })),
              { onConflict: "security_id,provider_code" },
            )
          if (upsertError) throw upsertError
        }

        const unresolvedCount =
          accepted.filter((mapping) => mapping.mappingStatus !== "VERIFIED").length + quarantined.length
        const mappedCount = accepted.filter((mapping) => mapping.mappingStatus === "VERIFIED").length
        const { error: auditError } = await admin.from("market_data_refresh_runs").insert({
          portfolio_id: portfolio.id,
          provider_code: MARKET_DATA_PROVIDER,
          requested_by: userData.user.id,
          status: "SUCCEEDED",
          requested_security_count: securityIds.length,
          unresolved_security_count: unresolvedCount,
          fetched_security_count: mappedCount,
          completed_at: new Date().toISOString(),
          metadata: { operation: "SYNC_MAPPINGS" },
        })
        if (auditError) throw auditError

        return json(200, {
          mapped: mappedCount,
          ambiguous: accepted.filter((mapping) => mapping.mappingStatus === "AMBIGUOUS").length,
          unresolved: accepted.filter((mapping) => mapping.mappingStatus === "UNRESOLVED").length,
          quarantined: quarantined.length,
          unsupported: securityIds.length - resolved.length,
        })
      } finally {
        await releaseLease(
          admin,
          portfolio.id,
          "SYNC_MAPPINGS",
          leaseHolder,
          MAPPING_SYNC_COOLDOWN_SECONDS,
        )
      }
    }

    if (body.action !== "REFRESH") {
      return json(400, { error: "action must be READ_CACHE, SYNC_MAPPINGS, or REFRESH." })
    }
    if (typeof body.portfolioId !== "string") {
      return json(400, { error: "portfolioId must be a UUID string." })
    }

    const sampleSecurityIds = requestedSecuritySample(body.securityIds)
    const { data: portfolio, error: portfolioError } = await admin
      .from("portfolios")
      .select("id,owner_id")
      .eq("id", body.portfolioId)
      .eq("owner_id", userData.user.id)
      .single()
    if (portfolioError || !portfolio) return json(404, { error: "Portfolio not found." })

    const leaseHolder = crypto.randomUUID()
    await acquireLease(admin, portfolio.id, "REFRESH_PRICES", leaseHolder)
    try {
      const { data: holdings, error: holdingsError } = await admin
        .from("current_holdings")
        .select("security_id,net_quantity")
        .eq("portfolio_id", portfolio.id)
      if (holdingsError) throw holdingsError

      const openSecurityIds = [...new Set(
        (holdings ?? [])
          .filter((holding) => Number(holding.net_quantity) > 0)
          .map((holding) => holding.security_id),
      )]
      const openSecurityIdSet = new Set(openSecurityIds)
      if (sampleSecurityIds?.some((securityId) => !openSecurityIdSet.has(securityId))) {
        throw new SafeOperationalError(
          "INVALID_SECURITY_SAMPLE",
          "Every sampled security must be a current holding in this portfolio.",
          400,
        )
      }
      const targetSecurityIds = sampleSecurityIds ?? openSecurityIds

      const { data: mappings, error: mappingError } = targetSecurityIds.length
        ? await admin
          .from("market_data_instrument_mappings")
          .select("id,security_id,provider_instrument_id,exchange,trading_symbol,mapping_status")
          .eq("provider_code", MARKET_DATA_PROVIDER)
          .in("security_id", targetSecurityIds)
        : { data: [], error: null }
      if (mappingError) throw mappingError

      const verified: ProviderInstrument[] = (mappings ?? []).flatMap((mapping) =>
        mapping.mapping_status === "VERIFIED"
          && mapping.provider_instrument_id
          && mapping.exchange
          && mapping.trading_symbol
          ? [{
            mappingId: mapping.id,
            securityId: mapping.security_id,
            providerInstrumentId: mapping.provider_instrument_id,
            exchange: mapping.exchange,
            tradingSymbol: mapping.trading_symbol,
          }]
          : [])
      const unresolved = targetSecurityIds.length - verified.length

      const { data: cached, error: cachedError } = verified.length
        ? await admin
          .from("market_price_latest")
          .select("security_id,retrieved_at")
          .eq("provider_code", MARKET_DATA_PROVIDER)
          .in("security_id", verified.map((item) => item.securityId))
        : { data: [], error: null }
      if (cachedError) throw cachedError

      const freshIds = new Set(
        (cached ?? [])
          .filter((item) => isFresh(item.retrieved_at, new Date(), DEFAULT_CACHE_TTL_SECONDS))
          .map((item) => item.security_id),
      )
      const toFetch = verified.filter((instrument) => !freshIds.has(instrument.securityId))

      const { data: run, error: runError } = await admin
        .from("market_data_refresh_runs")
        .insert({
          portfolio_id: portfolio.id,
          provider_code: MARKET_DATA_PROVIDER,
          requested_by: userData.user.id,
          status: toFetch.length ? "RUNNING" : "SUCCEEDED",
          requested_security_count: targetSecurityIds.length,
          cached_security_count: verified.length - toFetch.length,
          unresolved_security_count: unresolved,
          completed_at: toFetch.length ? null : new Date().toISOString(),
          metadata: {
            operation: "REFRESH_PRICES",
            skipped_fresh: !toFetch.length,
          },
        })
        .select("id")
        .single()
      if (runError) throw runError

      if (!toFetch.length) {
        return json(200, {
          runId: run.id,
          fetched: 0,
          cached: verified.length,
          unresolved,
          failed: 0,
        })
      }

      try {
        const observations = await new AngelOneProvider(loadAngelOneConfig()).getLatestPrices(toFetch)
        if (observations.length) {
          const { error: priceError } = await admin
            .from("market_price_latest")
            .upsert(
              observations.map((item) => ({
                security_id: item.securityId,
                provider_code: item.providerCode,
                mapping_id: item.mappingId,
                price: item.price,
                currency: "INR",
                price_timestamp: item.priceTimestamp,
                retrieved_at: item.retrievedAt,
                market_session_status: item.marketSessionStatus,
                previous_close: item.previousClose,
                day_open: item.dayOpen,
                day_high: item.dayHigh,
                day_low: item.dayLow,
                provenance: extendedQuoteProvenance(item),
              })),
              { onConflict: "security_id,provider_code" },
            )
          if (priceError) throw priceError
        }

        const failed = toFetch.length - observations.length
        const { error: finishError } = await admin
          .from("market_data_refresh_runs")
          .update({
            status: failed ? "PARTIAL" : "SUCCEEDED",
            completed_at: new Date().toISOString(),
            fetched_security_count: observations.length,
            failed_security_count: failed,
          })
          .eq("id", run.id)
        if (finishError) throw finishError

        return json(200, {
          runId: run.id,
          fetched: observations.length,
          cached: verified.length - toFetch.length,
          unresolved,
          failed,
        })
      } catch (error) {
        const safe = safeError(error)
        await admin
          .from("market_data_refresh_runs")
          .update({
            status: "FAILED",
            completed_at: new Date().toISOString(),
            error_summary: safe.code,
          })
          .eq("id", run.id)
        throw safe
      }
    } finally {
      await releaseLease(
        admin,
        portfolio.id,
        "REFRESH_PRICES",
        leaseHolder,
        PRICE_REFRESH_COOLDOWN_SECONDS,
      )
    }
  } catch (error) {
    const safe = safeError(error)
    return json(safe.status, { error: safe.publicMessage, code: safe.code })
  }
})
