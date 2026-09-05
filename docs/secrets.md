# PortfolioAI — Secret and Environment-Variable Architecture

## Absolute rule

No secret, private credential, API key, access token, refresh token, password,
private key, service-role key or provider credential may appear anywhere in this
repository — source, documentation, tests, fixtures, logs or generated output.

Code references **variable names only**. Values live solely in the secure secret
store (and, for local work, in an untracked `.env` file).

## Variables

### Browser-visible (non-secret)

| Name | Purpose |
|------|---------|
| `VITE_SUPABASE_URL` | Dedicated Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable/anon key; RLS is the authorization boundary |

### Server-only (read with `process.env['NAME']` **inside** server-function handlers, never at module scope)

| Name | Purpose |
|------|---------|
| `SUPABASE_URL` | Dedicated Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key for server-side public reads |

### Deliberately not introduced

| Name | Status |
|------|--------|
| `SUPABASE_SERVICE_ROLE_KEY` | **Not used in Phase 0 or Phase 1.** Introducing it requires a written justification: why authenticated/RLS access is insufficient, where it is stored, why it cannot reach the browser, and the minimum privilege required. |

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
