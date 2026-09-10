const SECRET_LABELS = [
  "ANGEL_ONE_API_KEY",
  "ANGEL_ONE_CLIENT_CODE",
  "ANGEL_ONE_PIN",
  "ANGEL_ONE_TOTP_SECRET",
  "ANGEL_ONE_CLIENT_LOCAL_IP",
  "ANGEL_ONE_CLIENT_PUBLIC_IP",
  "ANGEL_ONE_MAC_ADDRESS",
] as const

const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/gu,
  /("?(?:jwtToken|refreshToken|feedToken|accessToken|authorization|password|pin|totp|clientcode)"?\s*[:=]\s*)"?[^\s,"}]+"?/giu,
] as const

export const SAFE_PROVIDER_FAILURE = "Market-data provider request failed."

function diagnosticText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return String(value)

  const record = value as Readonly<Record<string, unknown>>
  const fields = ["code", "message", "details", "hint", "status", "statusText"] as const
  const parts = fields.flatMap((field) => {
    const fieldValue = record[field]
    return typeof fieldValue === "string" || typeof fieldValue === "number"
      ? [`${field}=${String(fieldValue)}`]
      : []
  })

  if (parts.length) return parts.join(" | ")

  try {
    return JSON.stringify(value)
  } catch {
    return "Unserializable structured error"
  }
}

export function redactSensitiveText(value: unknown, secrets: readonly string[] = []): string {
  let text = diagnosticText(value)
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "$1[REDACTED]")
  for (const secret of secrets) {
    if (secret.length >= 3) text = text.split(secret).join("[REDACTED]")
  }
  for (const label of SECRET_LABELS) {
    text = text.replace(new RegExp(`${label}\\s*[:=]\\s*\\S+`, "giu"), `${label}=[REDACTED]`)
  }
  return text.slice(0, 500)
}

export class SafeOperationalError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly status = 500) {
    super(publicMessage)
    this.name = "SafeOperationalError"
  }
}

export function safeError(error: unknown): SafeOperationalError {
  if (error instanceof SafeOperationalError) return error

  // Keep browser responses generic, but emit a tightly redacted server-side
  // diagnostic so production contract failures can be identified from the
  // Supabase Edge Function Logs without exposing credentials or bearer tokens.
  console.error(`[refresh-market-data] ${redactSensitiveText(error)}`)

  return new SafeOperationalError("MARKET_DATA_INTERNAL_ERROR", "Market-data operation failed.")
}
