-- 0018_financial_ingestion_control.sql
-- PortfolioAI Stage 3B — provider ingestion control and rejection audit.
--
-- PREPARED FOR REVIEW. DO NOT APPLY UNTIL REVIEWED.
--
-- Invariants
--   * additive control/audit layer only; no mutation of transactions, holdings,
--     market data, or Stage 3A financial evidence.
--   * browser is read-only for ingestion history; writes are server/service-role.
--   * no provider credentials, tokens, cookies, passwords, API keys or raw secrets.
--   * rejection details must be diagnostic only and must not contain secrets.

begin;

create table public.financial_data_ingestion_runs (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid references public.profiles(id) on delete restrict,
  portfolio_id           uuid references public.portfolios(id) on delete restrict,
  provider_code          text not null references public.financial_data_providers(code) on delete restrict,
  operation              text not null,
  requested_by           uuid references public.profiles(id) on delete restrict,
  security_id            uuid references public.securities(id) on delete restrict,
  status                 text not null,
  requested_record_count integer not null default 0,
  resolved_record_count  integer not null default 0,
  inserted_record_count  integer not null default 0,
  unchanged_record_count integer not null default 0,
  rejected_record_count  integer not null default 0,
  failed_record_count    integer not null default 0,
  adapter_version        text not null,
  provider_contract      text,
  started_at             timestamptz not null default now(),
  completed_at           timestamptz,
  error_code             text,
  error_summary          text,
  created_at             timestamptz not null default now(),

  constraint fdir_operation_ck check (operation in ('DISCOVER','BACKFILL_FUNDAMENTALS','REFRESH_FUNDAMENTALS','REFRESH_SHAREHOLDING','REFRESH_ANALYST','TEST_ADAPTER')),
  constraint fdir_status_ck check (status in ('RUNNING','SUCCEEDED','PARTIAL','FAILED','SKIPPED_UNCHANGED')),
  constraint fdir_counts_ck check (
    requested_record_count >= 0 and resolved_record_count >= 0
    and inserted_record_count >= 0 and unchanged_record_count >= 0
    and rejected_record_count >= 0 and failed_record_count >= 0
  ),
  constraint fdir_adapter_version_ck check (char_length(adapter_version) between 1 and 64),
  constraint fdir_provider_contract_ck check (provider_contract is null or char_length(provider_contract) <= 200),
  constraint fdir_error_code_ck check (error_code is null or char_length(error_code) <= 100),
  constraint fdir_error_summary_ck check (error_summary is null or char_length(error_summary) <= 1000),
  constraint fdir_owner_portfolio_shape_ck check (
    portfolio_id is null or owner_id is not null
  )
);

create index fdir_provider_started_idx
  on public.financial_data_ingestion_runs(provider_code, started_at desc);
create index fdir_owner_started_idx
  on public.financial_data_ingestion_runs(owner_id, started_at desc)
  where owner_id is not null;
create index fdir_security_started_idx
  on public.financial_data_ingestion_runs(security_id, started_at desc)
  where security_id is not null;

comment on table public.financial_data_ingestion_runs is
  'Audit/control rows for provider ingestion attempts. Contains no provider credentials and is not financial evidence.';

create table public.financial_data_ingestion_rejections (
  id                  uuid primary key default gen_random_uuid(),
  ingestion_run_id    uuid not null references public.financial_data_ingestion_runs(id) on delete restrict,
  provider_code       text not null references public.financial_data_providers(code) on delete restrict,
  security_id         uuid references public.securities(id) on delete restrict,
  source_record_key   text,
  rejection_code      text not null,
  rejection_summary   text not null,
  source_parameter    text,
  safe_context        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),

  constraint fdirj_code_ck check (rejection_code in (
    'SECURITY_UNRESOLVED',
    'PERIOD_AMBIGUOUS',
    'STATEMENT_SCOPE_AMBIGUOUS',
    'UNIT_UNSUPPORTED',
    'METRIC_UNMAPPED',
    'VALUE_INVALID',
    'SOURCE_IDENTITY_MISSING',
    'VERSION_CONFLICT',
    'OTHER'
  )),
  constraint fdirj_summary_ck check (char_length(rejection_summary) between 1 and 1000),
  constraint fdirj_source_key_ck check (source_record_key is null or char_length(source_record_key) <= 300),
  constraint fdirj_source_parameter_ck check (source_parameter is null or char_length(source_parameter) <= 200)
);

create index fdirj_run_idx
  on public.financial_data_ingestion_rejections(ingestion_run_id, created_at);
create index fdirj_provider_code_idx
  on public.financial_data_ingestion_rejections(provider_code, rejection_code, created_at desc);

comment on table public.financial_data_ingestion_rejections is
  'Safe structured diagnostics for provider records rejected during normalization. Must never contain secrets.';

-- Privileges: browser read-only; service role owns ingestion writes.
revoke all on public.financial_data_ingestion_runs from public, anon, authenticated;
revoke all on public.financial_data_ingestion_rejections from public, anon, authenticated;

grant select on public.financial_data_ingestion_runs to authenticated;
grant select on public.financial_data_ingestion_rejections to authenticated;
grant all on public.financial_data_ingestion_runs to service_role;
grant all on public.financial_data_ingestion_rejections to service_role;

alter table public.financial_data_ingestion_runs enable row level security;
alter table public.financial_data_ingestion_rejections enable row level security;

-- Personal-use V1: authenticated users may inspect shared ingestion audit/evidence.
-- If multi-user isolation is introduced later, narrow these policies using owner/security access rules.
create policy fdir_authenticated_read on public.financial_data_ingestion_runs
  for select to authenticated using (true);
create policy fdirj_authenticated_read on public.financial_data_ingestion_rejections
  for select to authenticated using (true);

commit;
