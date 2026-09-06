# Roadmap

## Done
- [x] Migration 01 (db/migrations/0001_enums.sql) — applied 2026-09-05, verified remotely
- [x] Migration 02 (db/migrations/0002_identity.sql) — applied 2026-09-06; structure/RLS/FK/policies verified,
      privilege gap found (Supabase permissive default ACLs)
- [x] Migration 02a (db/migrations/0002a_identity_privileges.sql) — applied and verified 2026-09-06:
      anon has no privileges, authenticated has exactly the approved table/column set,
      created_at/updated_at not client-writable, set_updated_at() not directly callable,
      future public objects have no automatic Data API privileges

## Next (awaiting approval)
- [ ] Migration 03 — not started
