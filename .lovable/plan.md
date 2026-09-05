# Migration 02 — Identity foundation (REVISED proposal, NOT applied)

**Filename:** `db/migrations/0002_identity.sql`

Amendments folded in: non-destructive Auth FK, database-controlled audit timestamps via column-level grants, `display_decimals` removed. Everything else from the approved design is retained.

## Scope decision (unchanged)

| Table | Verdict | Reason |
|---|---|---|
| `profiles` | Create now | Stable owner anchor for every later user-owned table; identity only, no credentials. |
| `user_settings` | Create now, typed columns only | Genuine per-user display preferences. No JSON blob. |
| `app_config` | Deferred | Core target count, concentration limits, accounting-method selection and default active portfolio are portfolio-scoped and belong as typed, auditable columns on `portfolios` (Migration 03). No untyped dumping ground. |

`default_portfolio_id` is added to `user_settings` in Migration 03, alongside the table it points at.

## Table 1 — `public.profiles`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | — | PK; `references auth.users(id) on delete restrict` |
| `display_name` | `text` | NULL | — | check: 1–120 chars when present |
| `created_at` | `timestamptz` | NOT NULL | `now()` | database-controlled, never granted to clients |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | trigger-controlled, never granted to clients |

PK = FK = `auth.users.id`. No extra index (PK covers `id = auth.uid()`). Profile creation is manual and idempotent from the app (`insert ... on conflict (id) do nothing`) — no trigger on `auth.users`, no `SECURITY DEFINER`. No DELETE policy or grant.

## Table 2 — `public.user_settings`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `uuid` | NOT NULL | — | PK; `references public.profiles(id) on delete restrict` |
| `locale` | `text` | NOT NULL | `'en-IN'` | check `~ '^[a-z]{2}(-[A-Z]{2})?$'` |
| `timezone` | `text` | NOT NULL | `'Asia/Kolkata'` | check 1–64 chars |
| `date_format` | `text` | NOT NULL | `'DD-MM-YYYY'` | check in fixed allow-list |
| `number_locale` | `text` | NOT NULL | `'en-IN'` | display grouping only |
| `created_at` | `timestamptz` | NOT NULL | `now()` | database-controlled |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | trigger-controlled |

`display_decimals` removed — metric-specific display precision (currency, price, quantity, percentage, ratio) is a UI-layer concern to be designed later. Canonical precision remains `numeric(38,18)` where applicable.

## Auth-user deletion behaviour

`on delete restrict` on `profiles.id` means Postgres **refuses** to delete a row in `auth.users` while a PortfolioAI profile exists for it. Deleting an authentication identity can therefore never cascade away investment, accounting or decision history — the delete simply errors. Consequences accepted deliberately:

- Supabase Auth admin "delete user" will fail with a foreign-key violation for any user who has a profile. That is the intended guard, not a bug.
- Real account/data removal must be an explicit, controlled, separately approved workflow that archives or removes PortfolioAI data first and only then removes the auth identity.
- `user_settings.user_id` also uses `restrict` so nothing disappears incidentally.
- **Principle binding on all future migrations:** ledger, holdings, import-lineage, corporate-action, engine-result and credit-history tables never use `on delete cascade` toward an owner or identity parent. Cascade is permitted only inside a single owned aggregate where the child has no independent audit value (for example import staging rows belonging to their own batch), and each such case must be stated explicitly in that migration.

## Audit-timestamp protection — exact GRANT strategy

Table-wide UPDATE is never granted. Grants are column-scoped, so `created_at` and `updated_at` are not writable by `authenticated` at all — the client cannot supply them on INSERT (PostgREST rejects a payload touching a non-granted column) and cannot change them on UPDATE. Defaults populate them on insert; the `BEFORE UPDATE` trigger sets `updated_at`. Triggers execute independently of the caller's column privileges, so the trigger still works.

```sql
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name)     on public.profiles to authenticated;

grant select on public.user_settings to authenticated;
grant insert (user_id, locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;
grant update (locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;

grant all on public.profiles      to service_role;
grant all on public.user_settings to service_role;
```

No grants of any kind to `anon`. No DELETE granted to anyone but `service_role`. SELECT is table-wide so the UI can read timestamps and so PostgREST `returning` works. The `service_role` GRANT is a Postgres privilege statement only — no service-role key is introduced or used by the application.

## Complete SQL

```sql
-- 0002_identity.sql — profiles, user_settings, shared updated_at trigger.
-- Auth deletion is non-destructive (restrict). Audit timestamps are DB-controlled.
begin;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 120)
);

create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  locale text not null default 'en-IN'
    check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Asia/Kolkata'
    check (char_length(timezone) between 1 and 64),
  date_format text not null default 'DD-MM-YYYY'
    check (date_format in ('DD-MM-YYYY','MM-DD-YYYY','YYYY-MM-DD')),
  number_locale text not null default 'en-IN'
    check (number_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

-- Column-scoped privileges: created_at / updated_at are never client-writable.
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select on public.user_settings to authenticated;
grant insert (user_id, locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;
grant update (locale, timezone, date_format, number_locale)
  on public.user_settings to authenticated;

grant all on public.profiles to service_role;
grant all on public.user_settings to service_role;

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy user_settings_select_own on public.user_settings
  for select to authenticated using (user_id = auth.uid());
create policy user_settings_insert_own on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());
create policy user_settings_update_own on public.user_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;
```

No DELETE policies exist, so no one but `service_role` can remove rows — and only through a deliberate server-side workflow that does not exist yet.

## Rollback

```sql
begin;
drop table if exists public.user_settings;
drop table if exists public.profiles;
drop function if exists public.set_updated_at();
commit;
```
Safe only while no later migration depends on these objects; from Migration 03 onward, revert dependents first. Never `cascade`. Rollback removes profile/settings rows (auth users are untouched).

## Risks and future compatibility

- `restrict` will surface as a foreign-key error in any tooling that tries to delete an auth user. This is the intended safety behaviour and must be documented for whoever operates the Supabase dashboard.
- Manual profile creation: a signed-in user without a profile row cannot own later data, so the first-load upsert must run in the auth bootstrap path and be covered by tests.
- Column-level grants must be extended deliberately whenever a new client-writable column is added; forgetting shows up as a clear permission error, never as silent data loss.
- `set_updated_at()` is intentionally generic and reused by all later migrations; no future migration should redeclare it.

## Verification after eventual deployment

1. `public` contains exactly `profiles` and `user_settings`.
2. Columns, types, nullability, defaults and check constraints match this proposal; `display_decimals` absent.
3. `confdeltype = 'r'` (RESTRICT) on both foreign keys.
4. RLS enabled on both; `pg_policies` shows exactly 6 policies, all `roles = {authenticated}`.
5. Column privileges: `has_column_privilege('authenticated','public.profiles','created_at','UPDATE')` is false; same for `updated_at` on both tables and for INSERT on those columns. `has_table_privilege('authenticated', ..., 'DELETE')` false.
6. `anon` has no privilege of any kind on either table.
7. `set_updated_at` has `prosecdef = false` and empty `search_path`; both triggers present.
8. Signed-in smoke tests: own-row upsert succeeds; an attempt to write `created_at` is rejected; an UPDATE bumps `updated_at` automatically; inserting a row with another user's id fails; a second user cannot read the first user's rows; deleting the auth user fails with a FK restriction.
9. Migration 01's 12 enum types unchanged.
10. Type check and build clean; repository secret scan clean.

## Confirmations

- Migration 02 has **not** been applied; the SQL file has not been created.
- No remote Supabase schema change has been made.
- No secrets, API keys, tokens or credentials appear in code, SQL or documentation.
- No service-role key is introduced or used.
