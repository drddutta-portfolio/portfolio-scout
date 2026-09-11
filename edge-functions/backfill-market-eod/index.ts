import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const PROVIDER = "ANGEL_ONE" as const
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const MAX_SECURITIES = 5
const MAX_RANGE_DAYS = 730
const LEASE_SECONDS = 300
const COOLDOWN_SECONDS = 60
const REQUEST_DELAY_MS = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DATE = /^\d{4}-\d{2}-\d{2}$/u

interface RequestBody {
  readonly action?: unknown
  readonly portfolioId?: unknown
  readonly securityIds?: unknown
  readonly fromDate?: unknown
  readonly toDate?: unknown
}

interface MappingRow {
  readonly id: string
  readonly security_id: string
  readonly provider_instrument_id: string | null
  readonly exchange: string | null
  readonly trading_symbol: string | null
  readonly mapping_status: string
}

interface AngelConfig {
  readonly apiKey: string
  readonly clientCode: string
  readonly pin: string
  readonly totpSecret: string
  readonly clientLocalIp: string
  readonly clientPublicIp: string
  readonly macAddress: string
}

interface AngelResponse<T> {
  readonly status?: boolean
  readonly message?: string
  readonly errorcode?: string
  readonly data?: T
}

class PublicError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly status = 500) {
    super(publicMessage)
  }
}

function json(status: number, body: Readonly<Record<string, unknown>>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function required(name: string) {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new PublicError("SERVER_CONFIG_MISSING", "Historical market-data service is not configured.")
  return value
}

function config(): AngelConfig {
  return {
    apiKey: required("ANGEL_ONE_API_KEY"),
    clientCode: required("ANGEL_ONE_CLIENT_CODE"),
    pin: required("ANGEL_ONE_PIN"),
    totpSecret: required("ANGEL_ONE_TOTP_SECRET"),
    clientLocalIp: required("ANGEL_ONE_CLIENT_LOCAL_IP"),
    clientPublicIp: required("ANGEL_ONE_CLIENT_PUBLIC_IP"),
    macAddress: required("ANGEL_ONE_MAC_ADDRESS"),
  }
}

function requestHeaders(value: AngelConfig, jwt?: string) {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": value.clientLocalIp,
    "X-ClientPublicIP": value.clientPublicIp,
    "X-MACAddress": value.macAddress,
    "X-PrivateKey": value.apiKey,
  }
  if (jwt) result.Authorization = `Bearer ${jwt}`
  return result
}

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const normalized = value.toUpperCase().replace(/=+$/u, "").replace(/\s+/gu, "")
  let bits = ""
  for (const character of normalized) {
    const index = alphabet.indexOf(character)
    if (index < 0) throw new PublicError("TOTP_CONFIG_INVALID", "Historical market-data service is not configured.")
    bits += index.toString(2).padStart(5, "0")
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
  }
  return bytes
}

async function totp(secret: string, at = Date.now()) {
  const counter = Math.floor(at / 30_000)
  const message = new Uint8Array(8)
  new DataView(message.buffer).setBigUint64(0, BigInt(counter))
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message))
  const offset = signature[signature.length - 1]! & 0x0f
  const code = ((signature[offset]! & 0x7f) << 24)
    | (signature[offset + 1]! << 16)
    | (signature[offset + 2]! << 8)
    | signature[offset + 3]!
  return String(code % 1_000_000).padStart(6, "0")
}

async function angelJson<T>(response: Response): Promise<AngelResponse<T>> {
  let body: AngelResponse<T> | null = null
  try {
    body = await response.json() as AngelResponse<T>
  } catch {
    // Angel One has occasionally returned an empty 403 body for historical-data throttling.
  }
  if (!response.ok || body?.status !== true) {
    const code = typeof body?.errorcode === "string" && body.errorcode
      ? body.errorcode
      : `HTTP_${response.status}`
    const status = response.status === 429 || response.status === 403 ? 429 : 502
    throw new PublicError(code, "Angel One historical-data request failed.", status)
  }
  return body
}

async function login(value: AngelConfig) {
  const response = await fetch(
    "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword",
    {
      method: "POST",
      headers: requestHeaders(value),
      body: JSON.stringify({
        clientcode: value.clientCode,
        password: value.pin,
        totp: await totp(value.totpSecret),
      }),
    },
  )
  const body = await angelJson<{ readonly jwtToken?: string }>(response)
  const jwt = body.data?.jwtToken
  if (!jwt) throw new PublicError("ANGEL_LOGIN_FAILED", "Angel One historical-data request failed.", 502)
  return jwt
}

function parseSecurityIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SECURITIES) {
    throw new PublicError("INVALID_SECURITY_SAMPLE", `securityIds must contain 1-${MAX_SECURITIES} UUIDs.`, 400)
  }
  const ids = [...new Set(value)]
  if (ids.some((item) => typeof item !== "string" || !UUID.test(item))) {
    throw new PublicError("INVALID_SECURITY_SAMPLE", "securityIds must contain valid UUIDs.", 400)
  }
  return ids as string[]
}

function parseDateRange(fromValue: unknown, toValue: unknown) {
  if (typeof fromValue !== "string" || typeof toValue !== "string" || !DATE.test(fromValue) || !DATE.test(toValue)) {
    throw new PublicError("INVALID_DATE_RANGE", "fromDate and toDate must use YYYY-MM-DD.", 400)
  }
  const from = new Date(`${fromValue}T00:00:00Z`)
  const to = new Date(`${toValue}T00:00:00Z`)
  const today = new Date()
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to || to.getTime() > todayUtc) {
    throw new PublicError("INVALID_DATE_RANGE", "Historical date range is invalid.", 400)
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) {
    throw new PublicError("DATE_RANGE_TOO_LARGE", `Historical pilot is limited to ${MAX_RANGE_DAYS} days.`, 400)
  }
  return { fromDate: fromValue, toDate: toValue }
}

function decimal(value: unknown, field: string) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new PublicError("INVALID_CANDLE", `Angel One returned invalid ${field}.`, 502)
  }
  const text = String(value).trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) {
    throw new PublicError("INVALID_CANDLE", `Angel One returned invalid ${field}.`, 502)
  }
  return text
}

function volume(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const parsed = decimal(value, "volume")
  const numeric = Number(parsed)
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : null
}

function tradeDate(value: unknown) {
  if (typeof value !== "string") throw new PublicError("INVALID_CANDLE", "Angel One returned an invalid candle timestamp.", 502)
  const match = /^(\d{4}-\d{2}-\d{2})T/u.exec(value)
  if (!match) throw new PublicError("INVALID_CANDLE", "Angel One returned an invalid candle timestamp.", 502)
  return match[1]!
}

async function acquireLease(admin: ReturnType<typeof createClient>, portfolioId: string, holder: string) {
  const { data, error } = await admin.rpc("acquire_market_data_operation_lease", {
    p_portfolio_id: portfolioId,
    p_provider_code: PROVIDER,
    p_operation: "BACKFILL_EOD",
    p_lease_holder: holder,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) throw new PublicError("LEASE_ACQUIRE_FAILED", "Historical market-data operation could not be started.")
  const row = Array.isArray(data) ? data[0] as { acquired?: unknown } | undefined : undefined
  if (row?.acquired !== true) {
    throw new PublicError("MARKET_DATA_RATE_LIMITED", "Historical market-data backfill is already running or in cooldown.", 429)
  }
}

async function releaseLease(admin: ReturnType<typeof createClient>, portfolioId: string, holder: string) {
  const { error } = await admin.rpc("release_market_data_operation_lease", {
    p_portfolio_id: portfolioId,
    p_provider_code: PROVIDER,
    p_operation: "BACKFILL_EOD",
    p_lease_holder: holder,
    p_cooldown_seconds: COOLDOWN_SECONDS,
  })
  if (error) console.error("[backfill-market-eod] lease release failed")
}

async function fetchCandles(value: AngelConfig, jwt: string, mapping: MappingRow, fromDate: string, toDate: string) {
  const response = await fetch(
    "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData",
    {
      method: "POST",
      headers: requestHeaders(value, jwt),
      body: JSON.stringify({
        exchange: mapping.exchange,
        symboltoken: mapping.provider_instrument_id,
        interval: "ONE_DAY",
        fromdate: `${fromDate} 09:15`,
        todate: `${toDate} 15:30`,
      }),
    },
  )
  const body = await angelJson<readonly unknown[][]>(response)
  const retrievedAt = new Date().toISOString()
  return (body.data ?? []).map((row) => {
    if (!Array.isArray(row) || row.length < 5) {
      throw new PublicError("INVALID_CANDLE", "Angel One returned an invalid candle row.", 502)
    }
    return {
      security_id: mapping.security_id,
      provider_code: PROVIDER,
      mapping_id: mapping.id,
      trade_date: tradeDate(row[0]),
      open_price: decimal(row[1], "open"),
      high_price: decimal(row[2], "high"),
      low_price: decimal(row[3], "low"),
      close_price: decimal(row[4], "close"),
      volume: volume(row[5]),
      currency: "INR",
      retrieved_at: retrievedAt,
      provenance: {
        endpoint: "/rest/secure/angelbroking/historical/v1/getCandleData",
        interval: "ONE_DAY",
        exchange: mapping.exchange,
        trading_symbol: mapping.trading_symbol,
        symbol_token: mapping.provider_instrument_id,
        requested_from: fromDate,
        requested_to: toDate,
        retrieved_at: retrievedAt,
      },
    }
  })
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

  let runId: string | null = null
  let admin: ReturnType<typeof createClient> | null = null
  let portfolioId: string | null = null
  let leaseHolder: string | null = null

  try {
    const body = await request.json() as RequestBody
    if (body.action !== "BACKFILL_EOD") {
      throw new PublicError("INVALID_ACTION", "action must be BACKFILL_EOD.", 400)
    }
    if (typeof body.portfolioId !== "string" || !UUID.test(body.portfolioId)) {
      throw new PublicError("INVALID_PORTFOLIO", "portfolioId must be a UUID string.", 400)
    }
    portfolioId = body.portfolioId
    const securityIds = parseSecurityIds(body.securityIds)
    const { fromDate, toDate } = parseDateRange(body.fromDate, body.toDate)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) throw new PublicError("UNAUTHENTICATED", "Invalid authenticated session.", 401)

    admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    const { data: portfolio, error: portfolioError } = await admin
      .from("portfolios")
      .select("id,owner_id")
      .eq("id", portfolioId)
      .eq("owner_id", userData.user.id)
      .single()
    if (portfolioError || !portfolio) throw new PublicError("PORTFOLIO_NOT_FOUND", "Portfolio not found.", 404)

    const { data: holdings, error: holdingsError } = await admin
      .from("current_holdings")
      .select("security_id,net_quantity")
      .eq("portfolio_id", portfolioId)
    if (holdingsError) throw holdingsError
    const openIds = new Set(
      (holdings ?? []).filter((row) => Number(row.net_quantity) > 0).map((row) => row.security_id),
    )
    if (securityIds.some((id) => !openIds.has(id))) {
      throw new PublicError("INVALID_SECURITY_SAMPLE", "Every requested security must be a current open holding.", 400)
    }

    const { data: mappings, error: mappingError } = await admin
      .from("market_data_instrument_mappings")
      .select("id,security_id,provider_instrument_id,exchange,trading_symbol,mapping_status")
      .eq("provider_code", PROVIDER)
      .in("security_id", securityIds)
    if (mappingError) throw mappingError

    const verified = (mappings ?? []).filter((row): row is MappingRow =>
      row.mapping_status === "VERIFIED"
      && Boolean(row.provider_instrument_id)
      && (row.exchange === "NSE" || row.exchange === "BSE")
      && Boolean(row.trading_symbol)
    )
    const unresolved = securityIds.length - verified.length

    leaseHolder = crypto.randomUUID()
    await acquireLease(admin, portfolioId, leaseHolder)

    const { data: run, error: runError } = await admin
      .from("market_data_refresh_runs")
      .insert({
        owner_id: userData.user.id,
        portfolio_id: portfolioId,
        provider_code: PROVIDER,
        operation: "BACKFILL_EOD",
        requested_by: userData.user.id,
        status: verified.length ? "RUNNING" : "PARTIAL",
        requested_security_count: securityIds.length,
        unresolved_security_count: unresolved,
        completed_at: verified.length ? null : new Date().toISOString(),
      })
      .select("id")
      .single()
    if (runError) throw runError
    runId = run.id

    if (!verified.length) {
      return json(200, { runId, requested: securityIds.length, fetchedSecurities: 0, unresolved, failed: 0, candlesUpserted: 0 })
    }

    const angelConfig = config()
    const jwt = await login(angelConfig)
    let fetchedSecurities = 0
    let failed = 0
    let candlesUpserted = 0

    for (let index = 0; index < verified.length; index += 1) {
      const mapping = verified[index]!
      try {
        const rows = await fetchCandles(angelConfig, jwt, mapping, fromDate, toDate)
        if (rows.length) {
          for (let offset = 0; offset < rows.length; offset += 500) {
            const { error: historyError } = await admin
              .from("market_price_history_eod")
              .upsert(rows.slice(offset, offset + 500), { onConflict: "security_id,provider_code,trade_date" })
            if (historyError) throw historyError
          }
          candlesUpserted += rows.length
        }
        fetchedSecurities += 1
      } catch (error) {
        failed += 1
        const code = error instanceof PublicError ? error.code : "EOD_SECURITY_FAILED"
        console.error(`[backfill-market-eod] security fetch failed code=${code}`)
        if (error instanceof PublicError && (error.status === 429 || error.status === 401)) throw error
      }

      if (index < verified.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS))
      }
    }

    const status = failed > 0 || unresolved > 0 ? "PARTIAL" : "SUCCEEDED"
    const { error: finishError } = await admin
      .from("market_data_refresh_runs")
      .update({
        status,
        completed_at: new Date().toISOString(),
        fetched_security_count: fetchedSecurities,
        failed_security_count: failed,
      })
      .eq("id", runId)
    if (finishError) throw finishError

    return json(200, {
      runId,
      requested: securityIds.length,
      fetchedSecurities,
      unresolved,
      failed,
      candlesUpserted,
      fromDate,
      toDate,
    })
  } catch (error) {
    const safe = error instanceof PublicError
      ? error
      : new PublicError("EOD_BACKFILL_INTERNAL_ERROR", "Historical market-data operation failed.")
    console.error(`[backfill-market-eod] code=${safe.code}`)

    if (admin && runId) {
      await admin
        .from("market_data_refresh_runs")
        .update({
          status: "FAILED",
          completed_at: new Date().toISOString(),
          error_summary: safe.code,
        })
        .eq("id", runId)
    }

    return json(safe.status, { error: safe.publicMessage, code: safe.code })
  } finally {
    if (admin && portfolioId && leaseHolder) {
      await releaseLease(admin, portfolioId, leaseHolder)
    }
  }
})
