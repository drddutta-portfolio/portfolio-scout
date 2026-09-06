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
