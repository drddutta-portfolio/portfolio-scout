# PortfolioAI — Project Documentation

## Specification pack (canonical)

The four documents in `docs/specs/` are the project specification and are read
together:

1. `PortfolioAI_Master_Blueprint_v1.1_Lovable.md` — WHAT the product must do.
2. `PortfolioAI_Database_Architecture_Lovable_v1.0.md` — persistence, accounting, provenance, security.
3. `PortfolioAI_Development_Rules_v1.0_Lovable.md` — how implementation changes are performed.
4. `PortfolioAI_Lovable_Build_Guide_v1.0.md` — how the build is sequenced.

Genuine conflicts are surfaced, never silently resolved.

## Other documents

- `migrations.md` — the migration register and live-schema observations.
- `secrets.md` — the secret and environment-variable architecture.

## Infrastructure

- Frontend: React 19 + TypeScript + Vite 7 + TanStack Router/Start + Tailwind v4.
- Backend: a **dedicated Supabase project** (database, auth, RLS). Lovable Cloud
  is not used as the backend.
- Source control: dedicated GitHub repository.
