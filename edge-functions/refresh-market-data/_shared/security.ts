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

export function redactSensitiveText(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown error"
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
  return error instanceof SafeOperationalError
    ? error
    : new SafeOperationalError("MARKET_DATA_INTERNAL_ERROR", "Market-data operation failed.")
}
