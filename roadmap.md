# Roadmap

## Done
- [x] Migration 01 (db/migrations/0001_enums.sql) — applied 2026-09-05, verified remotely

## Current
- [ ] Migration 02 (db/migrations/0002_identity.sql) — apply exactly as approved
- [ ] Verification: tables, enums intact, FK RESTRICT x2, RLS, 6 policies, anon no access,
      column-level grants, no DELETE, set_updated_at not SECURITY DEFINER + empty search_path
- [ ] Behavioural tests as authenticated role (own row CRUD, timestamp protection, cross-user isolation, auth delete blocked)
- [ ] Secret scan, type check, build
- [ ] Update docs/migrations.md, then stop (no Migration 03)
