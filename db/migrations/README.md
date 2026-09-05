# PortfolioAI — database migrations (dedicated Supabase project)

Sequential, bounded, reviewable SQL migrations. Naming:
`NNNN_short_description.sql` (e.g. `0001_enums.sql`).

> Note: this project's `supabase/` directory is reserved by the Lovable
> platform's own migration system, which targets a Lovable-managed database.
> PortfolioAI uses a **dedicated** Supabase project, so its migration files live
> here in `db/migrations/` and are applied to that project deliberately, with the
> result recorded in `docs/migrations.md`.

Conventions for every migration that creates a table in `public`:

1. `CREATE TABLE public.<name> (...)` — accounting quantities/prices use `numeric(38,18)`.
2. Explicit `GRANT` statements for exactly the roles the policies allow.
3. `ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;`
4. `CREATE POLICY ...` scoped to `auth.uid()`.
5. A rollback note in the file header.

No migration files exist yet. None will be created until the dedicated Supabase
project is connected and the schema step is approved.
