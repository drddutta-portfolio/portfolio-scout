const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function parseSampleSecurityIds(value: unknown):
  | { readonly specified: false; readonly valid: true; readonly ids: readonly [] }
  | { readonly specified: true; readonly valid: true; readonly ids: readonly string[] }
  | { readonly specified: true; readonly valid: false; readonly ids: readonly [] } {
  if (value === undefined || value === null) return { specified: false, valid: true, ids: [] }
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return { specified: true, valid: false, ids: [] }
  const ids = [...new Set(value)]
  if (ids.some((item) => typeof item !== "string" || !UUID.test(item))) return { specified: true, valid: false, ids: [] }
  return { specified: true, valid: true, ids: ids as string[] }
}
