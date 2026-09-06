# Migration 04 — Security identity layer (revised proposal, planning only)

Proposed file: `db/migrations/0004_security_identity.sql`

Status: **NOT applied.** No permanent remote schema change was made during the capability inspection — every probe object was created inside a transaction that was rolled back, or in `pg_temp`, and absence was re-verified afterwards (`pg_class` count = 0). Migrations 01 / 02 / 02a / 03 remain untouched. No secrets or credentials introduced; no service-role credential is used by the application.

## 1. Capability-check findings (read-only / rolled back)

| Check | Evidence | Result |
|---|---|---|
| PostgreSQL version | `PostgreSQL 17.6 on x86_64-pc-linux-gnu` | NFKC available (`normalize` exists since PG 13) |
| Encoding / collation | `server_encoding = UTF8`, `datcollate = en_US.UTF-8`, `datlocprovider = i` (ICU) | `normalize()` is legal (it errors only on non-UTF8) |
| `normalize(x, NFKC)` syntax | Works **unqualified only**. `pg_catalog.normalize(x, NFKC)` fails with `column "nfkc" does not exist`; the keyword form is parser sugar. `pg_catalog.normalize(x,'NFKC')` with a text literal works. | Use the unqualified keyword form inside the function; `pg_catalog` is always implicitly on the search path, so `set search_path = ''` is safe |
| Volatility of every built-in used | `pg_proc.provolatile = 'i'` for `normalize(text,text)`, `upper(text)`, `btrim(text)`, all `regexp_replace` variants | All IMMUTABLE — the composite expression can legally be IMMUTABLE |
| STORED generated column accepts it | Probe: `pg_temp` function marked IMMUTABLE + temp table `generated always as (fn(v)) stored` → `CREATE TABLE` and 6 inserts succeeded | Accepted |
| Determinism of results | `'  m&m  '→'M&M'`, `'M_M'→'M_M'`, `'MM'→'MM'` (3 distinct values), `'reliance   industries'→'RELIANCE INDUSTRIES'`, `'M&M'+U+200B→'M&M'`, fullwidth `'ｍ＆ｍ'→'M&M'` | Correct and conservative; punctuation preserved; only compatibility-equivalent fullwidth forms fold, which is desirable |
| Function default privileges | A freshly created `public` function still shows `proacl = NULL` and role `authenticated` **could execute it** in the probe, despite the 02a default-privilege hardening (`pg_default_acl` for `postgres`/`public`/`f` = `{postgres=X/postgres}`) | **Migration 04 must explicitly `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated`** — the hardened default alone does not cover this case |

Conclusion: full NFKC normalization is safe on this database and is retained. The minimum-safe fallback (trim / collapse whitespace / uppercase, punctuation preserved) was also verified to work in a generated column, and stays documented as the fallback if a future environment cannot support NFKC.

## 2. Decisions (unchanged from the approved architecture)

**Ownership: shared canonical reference data.** Instrument identity is not user-specific; per-user tables would fragment identity and corporate-action handling. `authenticated` gets SELECT only on both tables — no browser INSERT/UPDATE/DELETE at all. Master data is maintained through reviewed migrations, and later through an explicitly approved curation workflow. `created_at`/`updated_at` are database-controlled with no write grant to any browser role.

**Exchange: constrained text**, not an enum, not a reference table yet. `^[A-Z0-9]{2,12}$`, nullable (unlisted/mutual-fund/bond instruments legitimately have no venue). A reference table can be added later without changing column semantics.

**Symbol: never globally unique.** Unique only within `(exchange, primary_symbol)`, and only when both are present. `primary_symbol` requires `exchange`.

**ISIN: nullable, globally unique when present.** An ISIN is a global instrument identifier, so two rows sharing one would be the same instrument recorded twice — exactly the silent duplication to prevent. Partial unique index, so the many rows without an ISIN are unaffected. Never fabricated. Syntax check only (`^[A-Z]{2}[A-Z0-9]{9}[0-9]$`); check-digit validation belongs in reviewed curation logic.

**Currency:** `char(3)` NOT NULL default `'INR'`; immutable in practice because no browser UPDATE grant exists. Nothing else assumes INR.

**Status:** `is_active`, `delisted_on`, `archived_at`. No DELETE grant, no CASCADE anywhere.

**Alias type:** new enum `security_alias_type` — `EXCHANGE_SYMBOL`, `BROKER_SYMBOL`, `LEGACY_SYMBOL`, `ISIN`, `COMPANY_NAME`, `IMPORT_TEXT`, `OTHER`.

## 3. Revision: `is_confirmed` removed

`is_confirmed` is dropped from `security_aliases`. Canonical alias identity and per-row import resolution are separate concepts: `security_aliases` states *what a source identifier means*, while a later import/resolution lineage table states *how a particular raw row was decided* (resolution method/status, selected security, `confirmed_by`, `confirmed_at`, source import row). Putting workflow state on the canonical table would mix a durable mapping with a one-off decision and make "manually confirmed" ambiguous. Import classification (resolved / unresolved / ambiguous / manually confirmed) is unaffected: it comes from lookup cardinality plus the future lineage table, backed by the existing `data_quality_issue` values `UNRESOLVED_SECURITY` and `AMBIGUOUS_SECURITY`.

## 4. Revision: minimal alias-context integrity checks

Three CHECK constraints only, no validation framework:
- `alias_type = 'EXCHANGE_SYMBOL'` ⇒ `exchange` is not null (an exchange symbol without a venue is meaningless);
- `alias_type = 'BROKER_SYMBOL'` ⇒ `source` is not null (a broker symbol without the broker is unresolvable);
- `alias_type = 'ISIN'` ⇒ `alias_normalized` matches the same ISIN syntax as `securities.isin`.

`COMPANY_NAME`, `IMPORT_TEXT`, `LEGACY_SYMBOL` and `OTHER` require no context — they legitimately arrive with neither exchange nor source.

The ISIN check references the generated column `alias_normalized`, which PostgreSQL permits in a table CHECK, and normalization (trim + uppercase) is exactly what makes the syntax check meaningful.

## 5. Alias uniqueness and resolution

Unique key: `(alias_type, coalesce(source, ''), coalesce(exchange, ''), alias_normalized)`, enforced by an expression unique index so NULL contexts cannot escape the constraint.

- one alias in one context → at most one security → **deterministic exact match**;
- no matching row → **unresolved**;
- same normalized alias under different contexts (two brokers using `M&M` for different instruments) stays representable, and a context-free lookup returning more than one row is **ambiguous** — the import engine decides, nothing merges silently;
- **manually confirmed** is recorded later by the import lineage table, not here.

No fuzzy matching, no scoring, no import tables.

## 6. Normalization implementation

`alias_value` keeps the raw source text for lineage. `alias_normalized` is a STORED generated column driven by `public.normalize_alias(text)`: `language sql`, `immutable`, `strict`, `security invoker`, `set search_path = ''` — never SECURITY DEFINER.

Rules: NFKC → strip zero-width characters → collapse internal whitespace → trim → uppercase. Nothing else; `&`, `-`, `_`, `.`, `/` and all other punctuation are preserved, so `M&M`, `M_M` and `MM` remain three distinct values (verified).

## 7. Privilege model (revised)

| Object | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| `securities` | nothing | SELECT | ALL (PostgreSQL grant only) |
| `security_aliases` | nothing | SELECT | ALL (PostgreSQL grant only) |
| `normalize_alias(text)` | none (explicitly revoked) | none (explicitly revoked) | EXECUTE |

The `PUBLIC`/`anon`/`authenticated` EXECUTE revoke is explicit because the capability check proved the 02a default hardening does not stop a new function from being PUBLIC-executable. The single `service_role` EXECUTE grant is retained for a concrete reason: `service_role` holds ALL on the tables, and PostgreSQL checks EXECUTE on functions used in a generated-column expression against the inserting role — without it, a `service_role` INSERT would fail. This is a PostgreSQL grant only; no service-role key exists in the application.

RLS: enabled on both tables, exactly two policies, both SELECT-only for `authenticated`. No write policies exist, so even an accidental future grant is still blocked.

## 8. Exact SQL (revised)

```sql
-- 0004_security_identity.sql
-- PortfolioAI Migration 04 — canonical security identity + source aliases.
--
-- Invariants:
--   * securities is the single canonical identity layer for instruments.
--     Shared reference data; the browser has SELECT only, never write.
--   * No security is ever DELETEd by the application: is_active / delisted_on /
--     archived_at carry lifecycle. Accounting history must never lose identity.
--   * ISIN is nullable and never fabricated; unique only when present.
--   * A symbol is unique only within an exchange, never globally.
--   * Alias normalization is deterministic and conservative: it must never
--     collapse legitimately distinct source symbols (M&M vs M_M vs MM).
--   * security_aliases records identity mappings ONLY. Per-row import
--     resolution state (resolved / unresolved / ambiguous / manually confirmed,
--     confirmed_by, confirmed_at) belongs to a later import-lineage table.
--   * Explicit-grant model (Migration 02a), plus an explicit function REVOKE:
--     verified that new public functions are otherwise PUBLIC-executable.
--   * Audit timestamps are database-controlled; reuses public.set_updated_at()
--     — NOT redeclared.
--
-- Rollback (safe only while nothing references these objects):
-- begin;
-- drop table if exists public.security_aliases;
-- drop table if exists public.securities;
-- drop function if exists public.normalize_alias(text);
-- drop type if exists public.security_alias_type;
-- commit;

begin;

create type public.security_alias_type as enum (
  'EXCHANGE_SYMBOL',
  'BROKER_SYMBOL',
  'LEGACY_SYMBOL',
  'ISIN',
  'COMPANY_NAME',
  'IMPORT_TEXT',
  'OTHER'
);

-- Unqualified normalize(..., NFKC) is required: the keyword form is parser
-- sugar and pg_catalog.normalize(x, NFKC) is a syntax error. pg_catalog is
-- always implicitly on the search path, so search_path = '' remains safe.
create function public.normalize_alias(input text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select upper(
    btrim(
      regexp_replace(
        regexp_replace(normalize(input, NFKC), '[\u200B-\u200D\uFEFF]', '', 'g'),
        '\s+', ' ', 'g'
      )
    )
  )
$$;

comment on function public.normalize_alias(text) is
  'Deterministic alias normalization: NFKC, strip zero-width, collapse whitespace, trim, uppercase. Punctuation (& - _ . /) is intentionally PRESERVED so distinct source symbols never collapse.';

revoke all on function public.normalize_alias(text) from public;
revoke all on function public.normalize_alias(text) from anon, authenticated;

create table public.securities (
  id uuid primary key default gen_random_uuid(),
  asset_class public.asset_class not null default 'UNKNOWN',
  name text not null check (char_length(name) between 1 and 200),
  isin text check (isin is null or isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  exchange text check (exchange is null or exchange ~ '^[A-Z0-9]{2,12}$'),
  primary_symbol text check (primary_symbol is null or primary_symbol ~ '^[A-Z0-9][A-Z0-9&._\-]{0,31}$'),
  currency char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  delisted_on date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint securities_symbol_needs_exchange
    check (primary_symbol is null or exchange is not null)
);

comment on table public.securities is
  'Canonical instrument identity. Shared reference data; browser read-only. A symbol change does not create a new row when economic identity is unchanged.';
comment on column public.securities.isin is
  'Nullable. Never fabricated. Globally unique when present (partial unique index).';
comment on column public.securities.currency is
  'Instrument trading/denomination currency. Not editable from the browser.';

create unique index securities_isin_key
  on public.securities (isin) where isin is not null;
create unique index securities_exchange_symbol_key
  on public.securities (exchange, primary_symbol)
  where exchange is not null and primary_symbol is not null;
create index securities_asset_class_idx on public.securities (asset_class);
create index securities_active_idx on public.securities (is_active) where is_active;

create table public.security_aliases (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities(id) on delete restrict,
  alias_type public.security_alias_type not null,
  alias_value text not null check (char_length(alias_value) between 1 and 200),
  alias_normalized text generated always as (public.normalize_alias(alias_value)) stored,
  source text check (source is null or char_length(source) between 1 and 64),
  exchange text check (exchange is null or exchange ~ '^[A-Z0-9]{2,12}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint security_aliases_exchange_symbol_needs_exchange
    check (alias_type <> 'EXCHANGE_SYMBOL' or exchange is not null),
  constraint security_aliases_broker_symbol_needs_source
    check (alias_type <> 'BROKER_SYMBOL' or source is not null),
  constraint security_aliases_isin_syntax
    check (alias_type <> 'ISIN' or alias_normalized ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$')
);

comment on table public.security_aliases is
  'Source-specific identifiers resolving to a canonical security. alias_value keeps raw source text for lineage; alias_normalized is deterministic. Identity mappings only — per-row import resolution state lives in a later import-lineage table. Uniqueness is per (alias_type, source, exchange, alias_normalized) so the same text under different contexts stays representable and is classified as ambiguous by the import engine rather than silently merged.';

create unique index security_aliases_context_key
  on public.security_aliases (
    alias_type,
    coalesce(source, ''),
    coalesce(exchange, ''),
    alias_normalized
  );
create index security_aliases_security_idx on public.security_aliases (security_id);
create index security_aliases_normalized_idx on public.security_aliases (alias_normalized);

create trigger securities_set_updated_at before update on public.securities
  for each row execute function public.set_updated_at();
create trigger security_aliases_set_updated_at before update on public.security_aliases
  for each row execute function public.set_updated_at();

grant select on public.securities to authenticated;
grant all on public.securities to service_role;
grant select on public.security_aliases to authenticated;
grant all on public.security_aliases to service_role;
grant execute on function public.normalize_alias(text) to service_role;

alter table public.securities enable row level security;
alter table public.security_aliases enable row level security;

create policy securities_select_all on public.securities
  for select to authenticated using (true);
create policy security_aliases_select_all on public.security_aliases
  for select to authenticated using (true);

commit;
```

No rows are seeded: no canonical security universe has been approved, and fabricating instruments would violate the no-fabricated-facts rule.

## 9. Field classification

`securities` — Phase 1 required: `id`, `asset_class`, `name`, `currency`, `created_at`, `updated_at`. Useful and safe now: `isin`, `exchange`, `primary_symbol`, `is_active`, `delisted_on`, `archived_at`. Premature/deferred: sector, industry, market-cap band, lot size, face value, listing date, issuer/entity link (Credit Intelligence needs an issuer table, not a column here), index membership, series (`EQ`/`BE`), FIGI and other identifier columns, any market data or fundamentals.

`security_aliases` — Phase 1 required: `id`, `security_id`, `alias_type`, `alias_value`, `alias_normalized`, `created_at`. Useful and safe now: `source`, `exchange`, `updated_at`. Premature/deferred: `is_confirmed` (**removed this revision**), resolution method/status, `confirmed_by`, `confirmed_at`, validity periods, confidence scores, anything fuzzy-matching related.

## 10. Deletion behaviour

- `security_aliases.security_id -> securities(id)` **ON DELETE RESTRICT** — a canonical security referenced by aliases (and later by transactions) must never vanish; retirement is `is_active = false` / `archived_at`.
- No CASCADE, no SET NULL, no NO ACTION anywhere; no DELETE privilege for `anon` or `authenticated`.

## 11. Corporate-action and import compatibility

- Symbol change: update `primary_symbol`, add a `LEGACY_SYMBOL` alias. Identity row unchanged.
- ISIN change: update `isin`, add an `ISIN`-type alias for the old value. Identity row unchanged.
- Merger/demerger/spin-off: new `securities` rows plus future corporate-action records linking old and new identities; the old row is deactivated, never deleted.
- Split/bonus: no identity effect — they are accounting events.
- Delisting: `is_active = false`, `delisted_on` set; history retained.
- Import: a raw row with ticker only, name only, ISIN, exchange+symbol or a broker symbol resolves against `security_aliases` via `(alias_type, source, exchange, normalize_alias(raw))`, and is classified by the future lineage table.

## 12. Risks

- Global ISIN uniqueness rejects a genuine duplicate rather than merging it — intended; curation must handle it explicitly.
- The generated column depends on `normalize_alias`, so changing normalization later requires a reviewed migration that rebuilds the column and unique index — deliberately not a silent change.
- Free-text `exchange` allows typos; mitigated by the CHECK and, later, a reference table.
- NFKC folds compatibility-equivalent forms (fullwidth `ｍ＆ｍ` → `M&M`). Verified as desirable, but recorded as a behaviour, not an accident.
- No seed data means everything is unresolved until a universe is loaded through a reviewed migration — correct behaviour, not a defect.

## 13. Post-deployment verification plan

Structural: exactly two new tables; the 12 Migration 01 enums unchanged plus exactly one new enum `security_alias_type` with 7 values in order; `profiles`, `user_settings`, `brokers`, `portfolios`, `broker_accounts` unchanged; `pg_default_acl` for `postgres`/`public` still owner-only; `set_updated_at()` unchanged and reused (`prosecdef = false`); `normalize_alias` is `provolatile = 'i'`, `proisstrict = true`, `prosecdef = false`, `search_path=""`, and its `proacl` grants EXECUTE to `service_role` only (no `PUBLIC`, `anon` or `authenticated` entry).

Constraint tests: duplicate ISIN rejected; two NULL ISINs accepted; duplicate `(exchange, primary_symbol)` rejected; the same symbol on two exchanges accepted; `primary_symbol` without `exchange` rejected; malformed ISIN/exchange/currency rejected; FK `confdeltype = 'r'` and deleting a referenced security blocked.

New alias-context tests: `EXCHANGE_SYMBOL` without `exchange` rejected, with `exchange` accepted; `BROKER_SYMBOL` without `source` rejected, with `source` accepted; `ISIN` alias with `'INE101A01026'` accepted and with `'INE101A0102'` rejected; `COMPANY_NAME` / `IMPORT_TEXT` / `LEGACY_SYMBOL` / `OTHER` accepted with neither context. Confirm `security_aliases` has **no** `is_confirmed` column.

Normalization tests: `'  m&m  '→'M&M'`; `'M_M'→'M_M'`; `'MM'→'MM'` (three distinct); `'reliance   industries'→'RELIANCE INDUSTRIES'`; zero-width character stripped.

Uniqueness tests: the same normalized alias with the same type/source/exchange rejected; the same normalized alias under a different `source` or `exchange` accepted, and a context-free lookup then returns >1 row (ambiguous).

Privilege/RLS tests (signed-in, rolled back): `authenticated` SELECT succeeds on both tables; INSERT/UPDATE/DELETE denied on both; `authenticated` and `anon` cannot EXECUTE `normalize_alias`; `anon` denied on both tables; RLS enabled with exactly two policies; `updated_at` advances on a privileged UPDATE via the reused trigger.

Repository: secret scan, type check and build clean; `docs/migrations.md` and `roadmap.md` updated after deployment (roadmap entry for Migration 04 will be added at that point — plan mode does not modify repository files).
