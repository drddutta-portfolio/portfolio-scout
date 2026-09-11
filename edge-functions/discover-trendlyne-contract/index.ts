import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

interface DiscoverRequest {
  readonly action?: unknown
}

interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

interface McpTool {
  readonly name?: unknown
  readonly description?: unknown
  readonly inputSchema?: unknown
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const ADAPTER_VERSION = "trendlyne-mcp-contract-discovery-v1"
const DEFAULT_PROTOCOL_VERSION = "2025-06-18"
const PROVIDER_CODE = "TRENDLYNE"
const MAX_RESPONSE_BYTES = 2_000_000

function json(status: number, body: Readonly<Record<string, unknown>>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

class SafeOperationalError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status = 500,
  ) {
    super(publicMessage)
    this.name = "SafeOperationalError"
  }
}

function safeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/https?:\/\/[^\s)\]}>,]+/giu, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s,]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/gu, "[REDACTED_TOKEN]")
    .slice(0, 500)
}

function safeError(error: unknown): SafeOperationalError {
  if (error instanceof SafeOperationalError) return error
  console.error(`[discover-trendlyne-contract] ${safeDiagnostic(error)}`)
  return new SafeOperationalError(
    "TRENDLYNE_DISCOVERY_FAILED",
    "Trendlyne contract discovery failed.",
  )
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim()
  if (!value) {
    throw new SafeOperationalError(
      "TRENDLYNE_MCP_NOT_CONFIGURED",
      "Trendlyne MCP is not configured for PortfolioAI.",
      503,
    )
  }
  return value
}

function parseJsonOrSse(text: string): JsonRpcEnvelope {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Empty MCP response")

  try {
    return JSON.parse(trimmed) as JsonRpcEnvelope
  } catch {
    // Streamable HTTP servers may return SSE. Use the latest JSON `data:` event.
    const events = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)

    for (let index = events.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(events[index]) as JsonRpcEnvelope
      } catch {
        // Continue looking for a JSON event.
      }
    }
  }

  throw new Error("Unsupported MCP response format")
}

async function readBounded(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("MCP response exceeded discovery size limit")
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("MCP response exceeded discovery size limit")
  }
  return text
}

async function mcpPost(
  url: string,
  payload: Readonly<Record<string, unknown>>,
  sessionId?: string | null,
): Promise<{ envelope: JsonRpcEnvelope; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }
  if (sessionId) headers["Mcp-Session-Id"] = sessionId

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  const text = await readBounded(response)
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`)
  }

  return {
    envelope: parseJsonOrSse(text),
    sessionId: response.headers.get("Mcp-Session-Id") ?? sessionId ?? null,
  }
}

function normalizeTool(tool: McpTool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema as Record<string, unknown>
    : null
  const properties = schema?.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties as Record<string, unknown>).sort()
    : []
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string").sort()
    : []

  return {
    name: typeof tool.name === "string" ? tool.name : "UNKNOWN",
    description: typeof tool.description === "string" ? tool.description.slice(0, 500) : null,
    inputProperties: properties,
    required,
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (request.method !== "POST") return json(405, { error: "Method not allowed." })

  const authorization = request.headers.get("Authorization")
  if (!authorization) return json(401, { error: "Authentication required." })

  let runId: string | null = null
  let admin: ReturnType<typeof createClient> | null = null

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL")
    const anonKey = requiredEnv("SUPABASE_ANON_KEY")
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")

    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: userData, error: userError } = await caller.auth.getUser()
    if (userError || !userData.user) return json(401, { error: "Authentication required." })

    let body: DiscoverRequest
    try {
      body = await request.json() as DiscoverRequest
    } catch {
      return json(400, { error: "Request body must be JSON." })
    }
    if (body.action !== "DISCOVER") {
      return json(400, { error: "action must be DISCOVER." })
    }

    // Treat the subscription-specific MCP URL as a secret even though Trendlyne's
    // published setup flow uses no separate Authentication header.
    const mcpUrl = requiredEnv("TRENDLYNE_MCP_URL")
    let parsedUrl: URL
    try {
      parsedUrl = new URL(mcpUrl)
    } catch {
      throw new SafeOperationalError(
        "TRENDLYNE_MCP_URL_INVALID",
        "Trendlyne MCP configuration is invalid.",
        503,
      )
    }
    if (parsedUrl.protocol !== "https:") {
      throw new SafeOperationalError(
        "TRENDLYNE_MCP_URL_INSECURE",
        "Trendlyne MCP configuration must use HTTPS.",
        503,
      )
    }

    const protocolVersion = Deno.env.get("TRENDLYNE_MCP_PROTOCOL_VERSION")?.trim()
      || DEFAULT_PROTOCOL_VERSION

    const { data: run, error: runError } = await admin
      .from("financial_data_ingestion_runs")
      .insert({
        owner_id: userData.user.id,
        portfolio_id: null,
        provider_code: PROVIDER_CODE,
        operation: "DISCOVER",
        requested_by: userData.user.id,
        security_id: null,
        status: "RUNNING",
        requested_record_count: 0,
        adapter_version: ADAPTER_VERSION,
        provider_contract: `MCP ${protocolVersion}`,
      })
      .select("id")
      .single()
    if (runError || !run) throw runError ?? new Error("Could not create discovery run")
    runId = run.id

    const initialize = await mcpPost(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "PortfolioAI", version: ADAPTER_VERSION },
      },
    })
    if (initialize.envelope.error) throw new Error("MCP initialize returned an error")

    const negotiated = initialize.envelope.result && typeof initialize.envelope.result === "object"
      ? initialize.envelope.result as Record<string, unknown>
      : {}
    const negotiatedVersion = typeof negotiated.protocolVersion === "string"
      ? negotiated.protocolVersion
      : protocolVersion

    // Complete MCP initialization before listing tools.
    await mcpPost(mcpUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, initialize.sessionId)

    const toolsResponse = await mcpPost(mcpUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, initialize.sessionId)
    if (toolsResponse.envelope.error) throw new Error("MCP tools/list returned an error")

    const toolsResult = toolsResponse.envelope.result && typeof toolsResponse.envelope.result === "object"
      ? toolsResponse.envelope.result as Record<string, unknown>
      : {}
    const rawTools = Array.isArray(toolsResult.tools) ? toolsResult.tools as McpTool[] : []
    const tools = rawTools.map(normalizeTool).sort((a, b) => a.name.localeCompare(b.name))

    const expected = [
      "search_identity",
      "search_parameters",
      "get_parameter_values",
      "get_shareholding",
      "get_insider_trading",
      "search_unstructured_reports",
    ]
    const names = new Set(tools.map((tool) => tool.name))
    const expectedPresent = expected.filter((name) => names.has(name))
    const expectedMissing = expected.filter((name) => !names.has(name))

    const { error: finishError } = await admin
      .from("financial_data_ingestion_runs")
      .update({
        status: "SUCCEEDED",
        requested_record_count: expected.length,
        resolved_record_count: expectedPresent.length,
        inserted_record_count: 0,
        unchanged_record_count: tools.length,
        rejected_record_count: expectedMissing.length,
        failed_record_count: 0,
        provider_contract: `MCP ${negotiatedVersion}; ${tools.length} tools`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId)
    if (finishError) throw finishError

    return json(200, {
      runId,
      adapterVersion: ADAPTER_VERSION,
      protocolVersion: negotiatedVersion,
      toolCount: tools.length,
      expectedPresent,
      expectedMissing,
      tools,
    })
  } catch (error) {
    const safe = safeError(error)
    if (admin && runId) {
      await admin
        .from("financial_data_ingestion_runs")
        .update({
          status: "FAILED",
          completed_at: new Date().toISOString(),
          error_code: safe.code,
          error_summary: safe.publicMessage,
          failed_record_count: 1,
        })
        .eq("id", runId)
    }
    return json(safe.status, { error: safe.publicMessage, code: safe.code, runId })
  }
})
