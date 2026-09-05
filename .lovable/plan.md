# Migration 02 — Identity foundation (proposal only, NOT applied)

**Filename:** `db/migrations/0002_identity.sql`

## Re-evaluation of the three earlier-proposed tables

| Table | Verdict | Reason |
|---|---|---|
| `profiles` | **Create now** | Every user-owned table from Migration 03 onward needs a stable owner anchor and a display identity that is safe to read without touching `auth.users`. Auth stays the credential source of truth. |
| `user_settings` | **Create now, typed columns only** | Genuinely user-scoped preferences (locale, timezone, number/date format, default landing view). No JSON blob. |
| `app_config` | **Defer — do not create** | Every material rule the earlier plan wanted to park here is portfolio-scoped, not app-scoped: Core target count, concentration limits, accounting-method selection and default active portfolio all belong to typed columns on `portfolios` (Migration 03), where they are auditable per portfolio and per user. A generic key/value JSON store would hide product rules in untyped data, which the specifications forbid. If a genuinely global, non-user setting ever appears, it gets its own typed table then. |

`default_portfolio_id` is intentionally **not** in `user_settings` yet — the `portfolios` table does not exist. It is added as a nullable FK in Migration 03, in the same migration that creates the target.

## Table 1 — `public.profiles`

Purpose: per-user identity anchor; owner target for all later FKs; no credentials.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | — | PK; `references auth.users(id) on delete cascade` |
| `display_name` | `text` | NULL | — | check: length 1–120 when present |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | maintained by trigger |

- PK = FK = `auth.users.id` (one profile per auth user; no surrogate key, no separate unique constraint needed).
- No extra index: the PK covers all access paths (`id = auth.uid()`).
- `on delete cascade`: deleting the auth user removes the profile. Updates to `id` are impossible in practice (`auth.users.id` is immutable); no `on update` clause.
- **Creation is manual, not triggered.** No `on auth.users` trigger: it would need `SECURITY DEFINER` on a table this project does not own the lifecycle of, and the spec says no privileged helpers without concrete need. Instead the app calls an idempotent client-side upsert on first authenticated load (`insert ... on conflict (id) do nothing`), permitted by an INSERT policy that requires `id = auth.uid()`. This is safe because the client cannot forge `auth.uid()`.
- No DELETE policy — profile removal happens only via auth-user deletion cascade.

## Table 2 — `public.user_settings`

Purpose: display/UX preferences owned by one authenticated user. Explicitly **not** a place for financial or portfolio rules.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `uuid` | NOT NULL | — | PK; `references public.profiles(id) on delete cascade` |
| `locale` | `text` | NOT NULL | `'en-IN'` | check `~ '^[a-z]{2}(-[A-Z]{2})?$'` |
| `timezone` | `text` | NOT NULL | `'Asia/Kolkata'` | check length 1–64 |
| `date_format` | `text` | NOT NULL | `'DD-MM-YYYY'` | check in a fixed allow-list |
| `number_locale` | `text` | NOT NULL | `'en-IN'` | display grouping only; never affects stored precision |
| `display_decimals` | `smallint` | NOT NULL | `2` | check between 0 and 8 — **display only**; canonical storage stays `numeric(38,18)` |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | trigger-maintained |

- One row per user enforced by the PK. No additional indexes needed.
- Row is created lazily by the same first-load upsert; absence of a row means "all defaults", never an error.

## Trigger / function

One shared, minimal, non-privileged helper:

- `public.set_updated_at()` — `returns trigger`, `language plpgsql`, **not** `SECURITY DEFINER`, `set search_path = ''`, sets `new.updated_at = now()`. Attached as `before update` on both tables. Justified because `updated_at` must not be client-controllable; no privilege escalation involved. Reused by all later migrations.

## RLS and grants

RLS enabled on both tables. Policies are `TO authenticated` only; `anon` gets nothing.

- `profiles`: SELECT / INSERT (`with check id = auth.uid()`) / UPDATE (`using` + `with check id = auth.uid()`). No DELETE.
- `user_settings`: SELECT / INSERT / UPDATE on `user_id = auth.uid()`. No DELETE (a settings row is reset, not deleted).

Grants: `GRANT SELECT, INSERT, UPDATE ON <table> TO authenticated;` and `GRANT ALL ... TO service_role;` (standard grant, no service-role key is introduced or used anywhere in the app). No grants to `anon`. `updated_at`/`created_at` are trigger/default-protected rather than column-revoked, keeping later migrations simple.

Browser writes required: yes, INSERT and UPDATE only, and only for the caller's own row. No DELETE from the browser. No SECURITY DEFINER RPC needed at this stage — the trusted-RPC path stays reserved for import commits.

## Complete SQL

```sql
-- 0002_identity.sql — profiles, user_settings, shared updated_at trigger.
begin;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 120)
);

create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  locale text not null default 'en-IN'
    check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Asia/Kolkata'
    check (char_length(timezone) between 1 and 64),
  date_format text not null default 'DD-MM-YYYY'
    check (date_format in ('DD-MM-YYYY','MM-DD-YYYY','YYYY-MM-DD')),
  number_locale text not null default 'en-IN'
    check (number_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  display_decimals smallint not null default 2
    check (display_decimals between 0 and 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.user_settings to authenticated;
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

## Rollback

```sql
begin;
drop table if exists public.user_settings;
drop table if exists public.profiles;
drop function if exists public.set_updated_at();
commit;
```
Safe only while no later migration depends on these objects; from Migration 03 onward, revert dependents first. Never `cascade`. Rollback destroys profile/settings rows (not auth users).

## Risks and future compatibility

- Manual profile creation means a signed-in user with no profile row must be handled by the app's first-load upsert; a missed call would break later FKs. Mitigated by doing the upsert in the auth bootstrap path and by testing it.
- `profiles.id` cascade-deletes downstream data once Migration 03+ references it — intended, but every later FK must state its delete behaviour explicitly.
- Keeping `default_portfolio_id` out until Migration 03 avoids a nullable FK to a non-existent table.
- `set_updated_at` is deliberately generic so no future migration re-declares it.

## Verification after eventual deployment

1. `pg_tables` in `public` returns exactly `profiles`, `user_settings` (plus nothing else).
2. Column names/types/nullability/defaults match this proposal.
3. `relrowsecurity = true` on both; `pg_policies` shows exactly the 6 policies with `roles = {authenticated}`.
4. `has_table_privilege('anon', ...)` false for select/insert/update/delete on both tables.
5. `pg_proc` shows `set_updated_at` with `prosecdef = false` and empty `search_path`; two triggers present.
6. Signed-in smoke test: upsert own profile succeeds; inserting a row with a different `user_id` fails; a second user cannot read the first user's rows.
7. Enum types from Migration 01 unchanged (12, untouched).
8. Type check and build clean; repository secret scan clean.

## Confirmations

- Migration 02 has **not** been applied; no SQL file has been created for it yet.
- No remote Supabase schema change has been made in this step.
- No secrets, API keys, tokens or credentials are introduced in code, SQL or documentation.
- No service-role key is introduced or used; the `service_role` GRANT is a standard Postgres privilege statement, not a credential.
