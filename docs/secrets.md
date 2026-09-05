# PortfolioAI — Secret and Environment-Variable Architecture

## Absolute rule

No secret, private credential, API key, access token, refresh token, password,
private key, service-role key or provider credential may appear anywhere in this
repository — source, documentation, tests, fixtures, logs or generated output.

Code references **variable names only**. Values live solely in the secure secret
store (and, for local work, in an untracked `.env` file).

## Naming note

The platform reserves the `VITE_` and `SUPABASE_` prefixes for its own managed
integrations. PortfolioAI's dedicated-project variables therefore use the
`PORTFOLIOAI_` prefix.

## Variables

### Dedicated Supabase project (stored in the secure secret store)

| Name | Purpose |
|------|---------|
| `PORTFOLIOAI_SUPABASE_URL` | Dedicated Supabase project URL |
| `PORTFOLIOAI_SUPABASE_PUBLISHABLE_KEY` | Publishable/anon key; RLS is the authorization boundary |

Server-side code reads these with `process.env['NAME']` **inside** server-function
handlers, never at module scope. The browser receives only the public pair
(project URL + publishable key — both public by design) at runtime through the
`getPublicSupabaseConfig` server function, so no value is ever bundled or
committed.

### Deliberately not introduced

| Name | Status |
|------|--------|
| `PORTFOLIOAI_SUPABASE_SERVICE_ROLE_KEY` | **Not used in Phase 0 or Phase 1.** Introducing it requires a written justification: why authenticated/RLS access is insufficient, where it is stored, why it cannot reach the browser, and the minimum privilege required. |

### Later phases (added only when that phase begins)

`ANGEL_ONE_API_KEY`, `ANGEL_ONE_CLIENT_ID`, `TRENDLYNE_API_KEY`, AI provider keys.

## Trusted write path (no service-role key)

```text
authenticated user
  -> restricted Supabase RPC
  -> hardened SECURITY DEFINER function
       validates auth.uid(), validates ownership,
       empty search_path, fully schema-qualified objects,
       EXECUTE granted narrowly to `authenticated`
```

## Repository hygiene

- `.env.example` is committed and contains names with empty values only.
- `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `.dev.vars`,
  and common credential file patterns.
- Before any configuration commit, tracked files are scanned for key-shaped
  values and the commit proceeds only if none are found.

## Live connection status (verified)

- Dedicated Supabase project reachable; publishable key validated against both
  the Data API and the Auth API.
- Full schema enumeration via the root OpenAPI endpoint is restricted to
  secret-key callers on new API keys — deliberately not used. Table-level
  inspection proceeds through the Data API as Phase 1 objects are proposed.
