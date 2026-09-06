# Migration 03 — portfolios, brokers, broker_accounts (proposal only)

Status: NOT applied. No remote schema change made. No secrets introduced. Migration 01 / 02 / 02a objects untouched.

File: `db/migrations/0003_portfolio_foundation.sql`

## Decisions

**brokers = shared reference data.** Canonical brokers (Zerodha, Motilal Oswal, Angel One etc.) are the same entity for every user; per-user copies would fragment identity and block later mapping of imports to a canonical broker. Table is read-only to `authenticated`, no browser writes. **Migration 03 seeds only `OTHER`.** The approved specifications do not confidently name the brokers required by the initial holdings/import sources, so no arbitrary starter subset is presented as a broker master; confirmed canonical brokers are added later through additive migrations. `code` is the stable identity. Unknown/unlisted brokers encountered during import map to `OTHER`, with the original broker/source text preserved in import-source/raw lineage (owned by the later import migrations). No credentials or integration configuration, ever.

**broker_accounts do NOT carry `portfolio_id`.** One portfolio may aggregate several accounts, and one account may later feed several logical portfolios. A direct FK would encode a false 1:1. The mapping arrives later as a join table (or is derived from transactions), when the import design fixes its semantics.

**`user_settings.default_portfolio_id`: DEFERRED.** A plain FK cannot assert that the portfolio belongs to the same user. The clean enforcement is a composite FK `(user_id, default_portfolio_id) -> portfolios(owner_id, id)`, which requires an extra unique key on `portfolios(owner_id, id)` and still leaves the column meaningless in Phase 1, where the UI uses a single portfolio. Deferring costs nothing and avoids a SECURITY DEFINER helper. Phase 1 picks the user's single portfolio by `created_at asc limit 1`. Migration 03 adds `unique (owner_id, id)` on `portfolios` now so the composite FK is available later without a rewrite.

**No accounting-method column.** Any default would silently pick a method. Cost basis / P&L stay unavailable until a method is formally approved; the column arrives with that approval, typed as an enum whose first value is an explicit unconfigured state.

## Field classification

`portfolios`
- Phase 1 required: `id`, `owner_id`, `name`, `base_currency`, `created_at`, `updated_at`
- Useful, included: `description` (nullable), `archived_at` (nullable timestamptz — archive instead of delete, preserves history), `core_target_count` (nullable int, a COUNT of stocks, never a percentage)
- `base_currency` is settable on INSERT only: it is excluded from the authenticated UPDATE grant. Once financial records exist, changing base currency is not an ordinary edit; any future conversion uses an explicitly reviewed workflow, not a browser UPDATE.
- Premature, excluded: accounting method, concentration/limit controls, benchmark, risk profile, rebalancing rules, target allocations

`broker_accounts`
- Phase 1 required: `id`, `owner_id`, `broker_id`, `nickname`, `created_at`, `updated_at`
- Useful, included: `account_ref_masked` (nullable, short display-only fragment such as last 4 chars), `archived_at`
- Removed from the earlier draft: `custom_broker_name`. Its "only when broker is OTHER" rule could not be enforced without a trigger or privileged function, which is not justified for a Phase 1 convenience field. An unlisted broker uses the canonical `OTHER` row; the original source text is preserved in import raw lineage; a proper custom-broker model is added later only if a real requirement emerges.
- Premature/forbidden: full client ID, PAN, credentials of any kind, API keys, tokens, TOTP secrets, PINs, private keys, integration config

Full broker client identifiers are **not** stored in Phase 1. Nothing in Phase 1 needs them; storing them adds a real privacy liability with no benefit. If integration later needs the full identifier, it is added deliberately with its own review; the masked fragment is user-typed and display-only.

## SQL

```sql
-- 0003_portfolio_foundation.sql
begin;

-- 1. brokers: shared reference data, no credentials, ever.
create table public.brokers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9_]{2,32}$'),
  name        text not null check (char_length(name) between 1 and 120),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.brokers (code, name) values
  ('OTHER','Other / not listed');

-- 2. portfolios: user-owned.
create table public.portfolios (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references public.profiles(id) on delete restrict,
  name              text not null check (char_length(name) between 1 and 120),
  description       text check (description is null or char_length(description) <= 2000),
  base_currency     char(3) not null default 'INR' check (base_currency ~ '^[A-Z]{3}$'),
  core_target_count integer check (core_target_count is null or core_target_count between 1 and 500),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner_id, name),
  unique (owner_id, id)   -- enables a future ownership-safe composite FK
);
comment on column public.portfolios.core_target_count is
  'Target NUMBER OF CORE STOCKS (e.g. ~35). Never an allocation percentage.';

-- 3. broker_accounts: user-owned. No portfolio_id (many-to-many arrives later).
create table public.broker_accounts (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete restrict,
  broker_id          uuid not null references public.brokers(id) on delete restrict,
  nickname           text not null check (char_length(nickname) between 1 and 80),
  account_ref_masked text check (account_ref_masked is null or char_length(account_ref_masked) between 1 and 24),
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (owner_id, nickname)
);

create index portfolios_owner_idx       on public.portfolios (owner_id);
create index broker_accounts_owner_idx  on public.broker_accounts (owner_id);
create index broker_accounts_broker_idx on public.broker_accounts (broker_id);

create trigger brokers_set_updated_at before update on public.brokers
  for each row execute function public.set_updated_at();
create trigger portfolios_set_updated_at before update on public.portfolios
  for each row execute function public.set_updated_at();
create trigger broker_accounts_set_updated_at before update on public.broker_accounts
  for each row execute function public.set_updated_at();

-- 4. Explicit grants only (Migration 02a model: nothing is automatic).
grant select on public.brokers to authenticated;
grant all    on public.brokers to service_role;

grant select on public.portfolios to authenticated;
grant insert (owner_id, name, description, base_currency, core_target_count)
  on public.portfolios to authenticated;
grant update (name, description, core_target_count, archived_at)
  on public.portfolios to authenticated;
grant all on public.portfolios to service_role;

grant select on public.broker_accounts to authenticated;
grant insert (owner_id, broker_id, nickname, account_ref_masked)
  on public.broker_accounts to authenticated;
grant update (nickname, account_ref_masked, archived_at)
  on public.broker_accounts to authenticated;
grant all on public.broker_accounts to service_role;

-- 5. RLS.
alter table public.brokers          enable row level security;
alter table public.portfolios       enable row level security;
alter table public.broker_accounts  enable row level security;

create policy brokers_select_all on public.brokers
  for select to authenticated using (true);

create policy portfolios_select_own on public.portfolios
  for select to authenticated using (owner_id = auth.uid());
create policy portfolios_insert_own on public.portfolios
  for insert to authenticated with check (owner_id = auth.uid());
create policy portfolios_update_own on public.portfolios
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy broker_accounts_select_own on public.broker_accounts
  for select to authenticated using (owner_id = auth.uid());
create policy broker_accounts_insert_own on public.broker_accounts
  for insert to authenticated with check (owner_id = auth.uid());
create policy broker_accounts_update_own on public.broker_accounts
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

commit;
```

`anon`: no grants, no policies, no access. No DELETE grant and no DELETE policy anywhere — removal is archival (`archived_at`). `created_at`/`updated_at` are excluded from every column grant, so they stay database-controlled; `owner_id` is insertable (must equal `auth.uid()` per policy) but not updatable, so rows cannot be reassigned; `base_currency` is insertable but not updatable, so it is fixed at portfolio creation.

## Deletion behaviour

| FK | Action | Justification |
|---|---|---|
| `portfolios.owner_id -> profiles.id` | RESTRICT | Portfolio/accounting history must never vanish with an owner deletion. |
| `broker_accounts.owner_id -> profiles.id` | RESTRICT | Same; accounts anchor future transaction lineage. |
| `broker_accounts.broker_id -> brokers.id` | RESTRICT | A referenced broker cannot be deleted; deactivate via `is_active` instead. |

No CASCADE and no SET NULL anywhere in this migration.

## Rollback

```sql
begin;
drop table if exists public.broker_accounts;
drop table if exists public.portfolios;
drop table if exists public.brokers;
commit;
```
Safe only while no later migration references these tables. Never `cascade`. `set_updated_at()` is shared and must not be dropped.

## Future compatibility risks

- Portfolio↔broker-account mapping stays open; the join table will be added when import semantics are fixed. Adding it later is additive.
- `unique (owner_id, id)` on `portfolios` is redundant today; it exists solely so the ownership-safe composite FK for `default_portfolio_id` needs no table rewrite.
- Only `OTHER` is seeded. Confirmed canonical brokers arrive as additive migrations inserting by stable `code`; those migrations must upsert on `code`, never re-insert.
- If the full broker client identifier is ever needed, it is a separate reviewed migration with its own privacy decision — not a widening of `account_ref_masked`.
- If a real custom-broker requirement emerges, it gets its own reviewed model (table or explicit design) — `custom_broker_name` is not resurrected without an enforceable OTHER relationship.
- If base-currency change is ever required, it arrives as an explicitly reviewed workflow (e.g. conversion or new-portfolio migration), not by re-granting UPDATE on the column.

## Post-deployment verification (run after approval)

1. Exactly three new tables in `public`; Migration 01's 12 enums and Migration 02's two tables unchanged.
2. `brokers` contains exactly one row: code `OTHER`. `broker_accounts` has no `custom_broker_name` column.
3. `relacl` on each new table shows no `anon` entry and only the approved `authenticated` privileges; `information_schema.column_privileges` shows: no INSERT/UPDATE on `created_at`/`updated_at`; no UPDATE on `portfolios.base_currency`, `portfolios.owner_id` or `broker_accounts.owner_id`/`broker_id`.
4. All three FKs report `confdeltype = 'r'`.
5. RLS enabled on all three; exactly seven policies with the approved names.
6. Behavioural, as two real signed-in users: own portfolio/account insert succeeds (including `base_currency` on insert); cross-user select/update returns nothing; forged `created_at` insert is rejected; UPDATE of `base_currency` is rejected; DELETE rejected; broker insert/update/delete rejected; broker select succeeds; profile deletion blocked by the portfolio FK.
7. Update of a row advances `updated_at` via the existing trigger.
8. Secret scan, type check and build clean; no service-role credential used by the application.
