-- 0017_canonical_financial_data_foundation.sql
-- PortfolioAI Stage 3A — provider-agnostic canonical financial data foundation.
--
-- PREPARED FOR REVIEW. DO NOT APPLY UNTIL REVIEWED.
--
-- Invariants
--   * security-level financial evidence only; no transaction/holding mutation.
--   * provider-specific fields stay in provenance/source fields, not schema columns.
--   * missing data stays NULL/missing; never silently converted to zero.
--   * observation history is point-in-time and versioned; later revisions must not
--     silently erase earlier evidence.
--   * browser is SELECT-only; ingestion is server-side/service-role only.
--   * Trendlyne is a planned provider, not a hard-coded dependency.
--
-- Rollback before application dependency only (never CASCADE), reverse order:
-- analyst_revision_observations, analyst_estimate_observations,
-- analyst_consensus_observations, shareholding_observations,
-- fundamental_observations, financial_periods, financial_metric_definitions,
-- financial_data_providers.

begin;

-- 1. Shared provider/source registry. ----------------------------------------
create table public.financial_data_providers (
  code          text primary key,
  display_name  text not null,
  provider_type text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fdp_code_ck check (code ~ '^[A-Z0-9_]{2,40}$'),
  constraint fdp_name_ck check (char_length(display_name) between 1 and 120),
  constraint fdp_type_ck check (provider_type in ('STRUCTURED_PROVIDER','OFFICIAL_SOURCE','MANUAL','OTHER_VERIFIED'))
);

insert into public.financial_data_providers(code, display_name, provider_type) values
  ('TRENDLYNE','Trendlyne','STRUCTURED_PROVIDER'),
  ('OFFICIAL_COMPANY','Official company disclosure','OFFICIAL_SOURCE'),
  ('NSE_BSE','NSE/BSE disclosure','OFFICIAL_SOURCE'),
  ('MANUAL','Manual verified entry','MANUAL'),
  ('OTHER_VERIFIED','Other verified source','OTHER_VERIFIED');

create trigger financial_data_providers_set_updated_at
before update on public.financial_data_providers
for each row execute function public.set_updated_at();

-- 2. Canonical metric dictionary. -------------------------------------------
create table public.financial_metric_definitions (
  code             text primary key,
  display_name     text not null,
  metric_family    text not null,
  value_type       text not null default 'NUMERIC',
  canonical_unit   text not null,
  flow_stock_type  text not null,
  is_active        boolean not null default true,
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint fmd_code_ck check (code ~ '^[A-Z0-9_]{2,64}$'),
  constraint fmd_family_ck check (metric_family in ('INCOME_STATEMENT','MARGIN','CAPITAL_EFFICIENCY','CASH_FLOW','BALANCE_SHEET','SHAREHOLDER_RETURN','CAPITAL_STRUCTURE','OTHER')),
  constraint fmd_value_type_ck check (value_type in ('NUMERIC','TEXT')),
  constraint fmd_flow_stock_ck check (flow_stock_type in ('FLOW','STOCK','RATIO','PER_SHARE','COUNT','TEXT')),
  constraint fmd_description_ck check (description is null or char_length(description) <= 1000)
);

insert into public.financial_metric_definitions
  (code, display_name, metric_family, value_type, canonical_unit, flow_stock_type, description)
values
  ('REVENUE','Revenue','INCOME_STATEMENT','NUMERIC','CURRENCY','FLOW','Reported operating revenue / sales.'),
  ('EBITDA','EBITDA','INCOME_STATEMENT','NUMERIC','CURRENCY','FLOW','Earnings before interest, tax, depreciation and amortisation.'),
  ('PBT','Profit Before Tax','INCOME_STATEMENT','NUMERIC','CURRENCY','FLOW','Profit before tax.'),
  ('PAT','Profit After Tax','INCOME_STATEMENT','NUMERIC','CURRENCY','FLOW','Profit after tax attributable per provider definition.'),
  ('EPS','Earnings Per Share','INCOME_STATEMENT','NUMERIC','CURRENCY_PER_SHARE','PER_SHARE','Earnings per share.'),
  ('EBITDA_MARGIN','EBITDA Margin','MARGIN','NUMERIC','PERCENT','RATIO','EBITDA as percentage of revenue.'),
  ('PBT_MARGIN','PBT Margin','MARGIN','NUMERIC','PERCENT','RATIO','PBT as percentage of revenue.'),
  ('PAT_MARGIN','PAT Margin','MARGIN','NUMERIC','PERCENT','RATIO','PAT as percentage of revenue.'),
  ('ROCE','Return on Capital Employed','CAPITAL_EFFICIENCY','NUMERIC','PERCENT','RATIO','Return on capital employed.'),
  ('ROE','Return on Equity','CAPITAL_EFFICIENCY','NUMERIC','PERCENT','RATIO','Return on equity.'),
  ('CFO','Cash Flow From Operations','CASH_FLOW','NUMERIC','CURRENCY','FLOW','Cash flow from operating activities.'),
  ('CAPEX','Capital Expenditure','CASH_FLOW','NUMERIC','CURRENCY','FLOW','Capital expenditure; canonical sign convention defined by adapter methodology.'),
  ('FREE_CASH_FLOW','Free Cash Flow','CASH_FLOW','NUMERIC','CURRENCY','FLOW','Free cash flow under the recorded normalization methodology.'),
  ('TOTAL_DEBT','Total Debt','BALANCE_SHEET','NUMERIC','CURRENCY','STOCK','Interest-bearing debt under provider definition.'),
  ('CASH_EQUIVALENTS','Cash & Equivalents','BALANCE_SHEET','NUMERIC','CURRENCY','STOCK','Cash and cash-equivalent balance.'),
  ('NET_DEBT','Net Debt','BALANCE_SHEET','NUMERIC','CURRENCY','STOCK','Debt net of cash under the recorded normalization methodology.'),
  ('NET_WORTH','Net Worth','BALANCE_SHEET','NUMERIC','CURRENCY','STOCK','Shareholders equity / net worth under provider definition.'),
  ('DIVIDEND_PAYOUT','Dividend Payout','SHAREHOLDER_RETURN','NUMERIC','PERCENT','RATIO','Dividend payout ratio.'),
  ('SHARES_OUTSTANDING','Shares Outstanding','CAPITAL_STRUCTURE','NUMERIC','COUNT','COUNT','Outstanding share count.'),
  ('BOOK_VALUE_PER_SHARE','Book Value Per Share','CAPITAL_STRUCTURE','NUMERIC','CURRENCY_PER_SHARE','PER_SHARE','Book value per share.');

create trigger financial_metric_definitions_set_updated_at
before update on public.financial_metric_definitions
for each row execute function public.set_updated_at();

-- 3. Provider-independent financial period identity. ------------------------
create table public.financial_periods (
  id                uuid primary key default gen_random_uuid(),
  security_id       uuid not null references public.securities(id) on delete restrict,
  period_type       text not null,
  period_start      date,
  period_end        date not null,
  fiscal_year_label text,
  fiscal_quarter    smallint,
  created_at        timestamptz not null default now(),

  constraint fp_period_type_ck check (period_type in ('QUARTER','ANNUAL','TTM')),
  constraint fp_dates_ck check (period_start is null or period_start <= period_end),
  constraint fp_quarter_ck check (
    (period_type = 'QUARTER' and fiscal_quarter between 1 and 4)
    or (period_type <> 'QUARTER' and fiscal_quarter is null)
  ),
  constraint fp_fiscal_year_label_ck check (fiscal_year_label is null or char_length(fiscal_year_label) between 2 and 24),
  constraint fp_unique_security_period unique (security_id, period_type, period_end),
  constraint fp_id_security_key unique (id, security_id)
);

create index fp_security_end_idx on public.financial_periods(security_id, period_end desc);

-- 4. Canonical fundamental observations. ------------------------------------
create table public.fundamental_observations (
  id                       uuid primary key default gen_random_uuid(),
  security_id              uuid not null references public.securities(id) on delete restrict,
  financial_period_id      uuid not null,
  metric_code              text not null references public.financial_metric_definitions(code) on delete restrict,
  statement_scope          text not null default 'UNKNOWN',
  normalized_numeric_value numeric(38,18),
  normalized_text_value    text,
  unit                     text not null,
  currency                 char(3),
  provider_code            text not null references public.financial_data_providers(code) on delete restrict,
  source_parameter         text,
  source_record_key        text not null,
  original_value           jsonb not null,
  observation_date         timestamptz,
  published_at             timestamptz,
  retrieved_at             timestamptz not null,
  confidence               numeric(5,4),
  normalization_method     text not null,
  normalization_version    text not null,
  observation_version      integer not null default 1,
  supersedes_observation_id uuid references public.fundamental_observations(id) on delete restrict,
  source_url               text,
  source_reference         text,
  created_at               timestamptz not null default now(),

  constraint fo_period_security_fk foreign key (financial_period_id, security_id)
    references public.financial_periods(id, security_id) on delete restrict,
  constraint fo_scope_ck check (statement_scope in ('CONSOLIDATED','STANDALONE','UNKNOWN')),
  constraint fo_value_shape_ck check (
    (normalized_numeric_value is not null and normalized_text_value is null)
    or (normalized_numeric_value is null and normalized_text_value is not null)
  ),
  constraint fo_unit_ck check (char_length(unit) between 1 and 40),
  constraint fo_currency_ck check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint fo_source_parameter_ck check (source_parameter is null or char_length(source_parameter) <= 200),
  constraint fo_source_record_key_ck check (char_length(source_record_key) between 1 and 300),
  constraint fo_confidence_ck check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint fo_norm_method_ck check (char_length(normalization_method) between 1 and 120),
  constraint fo_norm_version_ck check (char_length(normalization_version) between 1 and 64),
  constraint fo_observation_version_ck check (observation_version >= 1),
  constraint fo_source_url_ck check (source_url is null or char_length(source_url) <= 2000),
  constraint fo_source_reference_ck check (source_reference is null or char_length(source_reference) <= 1000),
  constraint fo_unique_source_version unique (
    provider_code, source_record_key, metric_code, financial_period_id, statement_scope, observation_version
  )
);

create index fo_security_metric_period_idx
  on public.fundamental_observations(security_id, metric_code, financial_period_id, retrieved_at desc);
create index fo_provider_retrieved_idx
  on public.fundamental_observations(provider_code, retrieved_at desc);
create index fo_publication_idx
  on public.fundamental_observations(security_id, published_at desc) where published_at is not null;

comment on table public.fundamental_observations is
  'Point-in-time provider observations mapped to canonical metrics. Insert new versions for corrections/revisions; do not silently rewrite historical evidence.';

-- 5. Shareholding / ownership observations. ---------------------------------
create table public.shareholding_observations (
  id                       uuid primary key default gen_random_uuid(),
  security_id              uuid not null references public.securities(id) on delete restrict,
  financial_period_id      uuid not null,
  canonical_category       text not null,
  source_category_label    text,
  holding_percent          numeric(20,8),
  shares_held              numeric(38,0),
  pledged_percent          numeric(20,8),
  provider_code            text not null references public.financial_data_providers(code) on delete restrict,
  source_record_key        text not null,
  original_value           jsonb not null,
  observation_date         timestamptz,
  published_at             timestamptz,
  retrieved_at             timestamptz not null,
  confidence               numeric(5,4),
  normalization_method     text not null,
  normalization_version    text not null,
  observation_version      integer not null default 1,
  supersedes_observation_id uuid references public.shareholding_observations(id) on delete restrict,
  source_url               text,
  created_at               timestamptz not null default now(),

  constraint sho_period_security_fk foreign key (financial_period_id, security_id)
    references public.financial_periods(id, security_id) on delete restrict,
  constraint sho_category_ck check (canonical_category in ('PROMOTER','FII_FPI','DII','MUTUAL_FUNDS','INSURANCE','GOVERNMENT','PUBLIC','OTHER','UNKNOWN')),
  constraint sho_holding_ck check (holding_percent is null or (holding_percent >= 0 and holding_percent <= 100)),
  constraint sho_shares_ck check (shares_held is null or shares_held >= 0),
  constraint sho_pledged_ck check (pledged_percent is null or (pledged_percent >= 0 and pledged_percent <= 100)),
  constraint sho_source_key_ck check (char_length(source_record_key) between 1 and 300),
  constraint sho_confidence_ck check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint sho_observation_version_ck check (observation_version >= 1),
  constraint sho_unique_source_version unique (
    provider_code, source_record_key, financial_period_id, canonical_category, observation_version
  )
);

create index sho_security_period_idx
  on public.shareholding_observations(security_id, financial_period_id, retrieved_at desc);

-- 6. Analyst consensus observations. ----------------------------------------
create table public.analyst_consensus_observations (
  id                         uuid primary key default gen_random_uuid(),
  security_id                uuid not null references public.securities(id) on delete restrict,
  provider_code              text not null references public.financial_data_providers(code) on delete restrict,
  source_record_key          text not null,
  observation_date           timestamptz not null,
  analyst_count              integer,
  buy_count                  integer,
  hold_count                 integer,
  sell_count                 integer,
  consensus_label_raw        text,
  consensus_label_normalized text not null default 'UNKNOWN',
  provider_consensus_score   numeric(20,8),
  target_price_consensus     numeric(38,18),
  target_price_high          numeric(38,18),
  target_price_low           numeric(38,18),
  current_price_observed     numeric(38,18),
  currency                   char(3) not null default 'INR',
  original_value             jsonb not null,
  published_at               timestamptz,
  retrieved_at               timestamptz not null,
  confidence                 numeric(5,4),
  normalization_method       text not null,
  normalization_version      text not null,
  observation_version        integer not null default 1,
  supersedes_observation_id  uuid references public.analyst_consensus_observations(id) on delete restrict,
  source_url                 text,
  created_at                 timestamptz not null default now(),

  constraint aco_counts_ck check (
    (analyst_count is null or analyst_count >= 0)
    and (buy_count is null or buy_count >= 0)
    and (hold_count is null or hold_count >= 0)
    and (sell_count is null or sell_count >= 0)
  ),
  constraint aco_label_ck check (consensus_label_normalized in ('STRONG_BUY','BUY','HOLD','SELL','STRONG_SELL','MIXED','NOT_COVERED','UNKNOWN')),
  constraint aco_prices_ck check (
    (target_price_consensus is null or target_price_consensus >= 0)
    and (target_price_high is null or target_price_high >= 0)
    and (target_price_low is null or target_price_low >= 0)
    and (current_price_observed is null or current_price_observed >= 0)
  ),
  constraint aco_target_range_ck check (
    target_price_high is null or target_price_low is null or target_price_high >= target_price_low
  ),
  constraint aco_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint aco_confidence_ck check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint aco_observation_version_ck check (observation_version >= 1),
  constraint aco_source_key_ck check (char_length(source_record_key) between 1 and 300),
  constraint aco_unique_source_version unique (security_id, provider_code, source_record_key, observation_version)
);

create index aco_security_observed_idx
  on public.analyst_consensus_observations(security_id, observation_date desc);

-- 7. Period-specific analyst estimates. -------------------------------------
create table public.analyst_estimate_observations (
  id                         uuid primary key default gen_random_uuid(),
  security_id                uuid not null references public.securities(id) on delete restrict,
  financial_period_id        uuid not null,
  metric_code                text not null references public.financial_metric_definitions(code) on delete restrict,
  estimate_type              text not null,
  estimate_value             numeric(38,18) not null,
  unit                       text not null,
  currency                   char(3),
  analyst_count              integer,
  provider_code              text not null references public.financial_data_providers(code) on delete restrict,
  source_record_key          text not null,
  observation_date           timestamptz not null,
  original_value             jsonb not null,
  published_at               timestamptz,
  retrieved_at               timestamptz not null,
  confidence                 numeric(5,4),
  normalization_method       text not null,
  normalization_version      text not null,
  observation_version        integer not null default 1,
  supersedes_observation_id  uuid references public.analyst_estimate_observations(id) on delete restrict,
  source_url                 text,
  created_at                 timestamptz not null default now(),

  constraint aeo_period_security_fk foreign key (financial_period_id, security_id)
    references public.financial_periods(id, security_id) on delete restrict,
  constraint aeo_estimate_type_ck check (estimate_type in ('CONSENSUS','HIGH','LOW','OTHER')),
  constraint aeo_unit_ck check (char_length(unit) between 1 and 40),
  constraint aeo_currency_ck check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint aeo_analyst_count_ck check (analyst_count is null or analyst_count >= 0),
  constraint aeo_confidence_ck check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint aeo_observation_version_ck check (observation_version >= 1),
  constraint aeo_source_key_ck check (char_length(source_record_key) between 1 and 300),
  constraint aeo_unique_source_version unique (
    provider_code, source_record_key, financial_period_id, metric_code, estimate_type, observation_version
  )
);

create index aeo_security_metric_observed_idx
  on public.analyst_estimate_observations(security_id, metric_code, observation_date desc);

-- 8. Analyst / earnings revision observations. ------------------------------
create table public.analyst_revision_observations (
  id                         uuid primary key default gen_random_uuid(),
  security_id                uuid not null references public.securities(id) on delete restrict,
  financial_period_id        uuid,
  revision_subject           text not null,
  window_days                integer,
  revision_percent           numeric(20,8),
  previous_value             numeric(38,18),
  current_value              numeric(38,18),
  upward_revision_count      integer,
  downward_revision_count    integer,
  analyst_upgrade_count      integer,
  analyst_downgrade_count    integer,
  unit                       text,
  currency                   char(3),
  provider_code              text not null references public.financial_data_providers(code) on delete restrict,
  source_record_key          text not null,
  observation_date           timestamptz not null,
  original_value             jsonb not null,
  published_at               timestamptz,
  retrieved_at               timestamptz not null,
  confidence                 numeric(5,4),
  normalization_method       text not null,
  normalization_version      text not null,
  observation_version        integer not null default 1,
  supersedes_observation_id  uuid references public.analyst_revision_observations(id) on delete restrict,
  source_url                 text,
  created_at                 timestamptz not null default now(),

  constraint aro_period_security_fk foreign key (financial_period_id, security_id)
    references public.financial_periods(id, security_id) on delete restrict,
  constraint aro_subject_ck check (revision_subject in ('EPS','REVENUE','EBITDA','PBT','PAT','TARGET_PRICE','OTHER')),
  constraint aro_window_ck check (window_days is null or window_days between 1 and 3650),
  constraint aro_counts_ck check (
    (upward_revision_count is null or upward_revision_count >= 0)
    and (downward_revision_count is null or downward_revision_count >= 0)
    and (analyst_upgrade_count is null or analyst_upgrade_count >= 0)
    and (analyst_downgrade_count is null or analyst_downgrade_count >= 0)
  ),
  constraint aro_currency_ck check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint aro_confidence_ck check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint aro_observation_version_ck check (observation_version >= 1),
  constraint aro_source_key_ck check (char_length(source_record_key) between 1 and 300),
  constraint aro_unique_source_version unique (
    security_id, provider_code, source_record_key, revision_subject, observation_version
  )
);

create index aro_security_subject_observed_idx
  on public.analyst_revision_observations(security_id, revision_subject, observation_date desc);

-- 9. Explicit privileges. Browser is read-only; no anon access. -------------
revoke all on public.financial_data_providers from public, anon, authenticated;
revoke all on public.financial_metric_definitions from public, anon, authenticated;
revoke all on public.financial_periods from public, anon, authenticated;
revoke all on public.fundamental_observations from public, anon, authenticated;
revoke all on public.shareholding_observations from public, anon, authenticated;
revoke all on public.analyst_consensus_observations from public, anon, authenticated;
revoke all on public.analyst_estimate_observations from public, anon, authenticated;
revoke all on public.analyst_revision_observations from public, anon, authenticated;

grant select on public.financial_data_providers to authenticated;
grant select on public.financial_metric_definitions to authenticated;
grant select on public.financial_periods to authenticated;
grant select on public.fundamental_observations to authenticated;
grant select on public.shareholding_observations to authenticated;
grant select on public.analyst_consensus_observations to authenticated;
grant select on public.analyst_estimate_observations to authenticated;
grant select on public.analyst_revision_observations to authenticated;

grant all on public.financial_data_providers to service_role;
grant all on public.financial_metric_definitions to service_role;
grant all on public.financial_periods to service_role;
-- Observation tables are append-oriented at the privilege level.
grant select, insert on public.fundamental_observations to service_role;
grant select, insert on public.shareholding_observations to service_role;
grant select, insert on public.analyst_consensus_observations to service_role;
grant select, insert on public.analyst_estimate_observations to service_role;
grant select, insert on public.analyst_revision_observations to service_role;

-- 10. RLS: authenticated read-only shared evidence. --------------------------
alter table public.financial_data_providers enable row level security;
alter table public.financial_metric_definitions enable row level security;
alter table public.financial_periods enable row level security;
alter table public.fundamental_observations enable row level security;
alter table public.shareholding_observations enable row level security;
alter table public.analyst_consensus_observations enable row level security;
alter table public.analyst_estimate_observations enable row level security;
alter table public.analyst_revision_observations enable row level security;

create policy fdp_authenticated_read on public.financial_data_providers
  for select to authenticated using (true);
create policy fmd_authenticated_read on public.financial_metric_definitions
  for select to authenticated using (true);
create policy fp_authenticated_read on public.financial_periods
  for select to authenticated using (true);
create policy fo_authenticated_read on public.fundamental_observations
  for select to authenticated using (true);
create policy sho_authenticated_read on public.shareholding_observations
  for select to authenticated using (true);
create policy aco_authenticated_read on public.analyst_consensus_observations
  for select to authenticated using (true);
create policy aeo_authenticated_read on public.analyst_estimate_observations
  for select to authenticated using (true);
create policy aro_authenticated_read on public.analyst_revision_observations
  for select to authenticated using (true);

comment on table public.financial_periods is
  'Provider-independent financial period identity for security-level fundamental and estimate evidence.';
comment on table public.shareholding_observations is
  'Point-in-time normalized ownership/shareholding evidence with original provider category retained.';
comment on table public.analyst_consensus_observations is
  'Point-in-time analyst consensus evidence. NOT_COVERED is an availability state, not a negative investment score.';
comment on table public.analyst_estimate_observations is
  'Period-specific analyst estimates retained as point-in-time provider evidence.';
comment on table public.analyst_revision_observations is
  'Point-in-time earnings/target revision evidence; later provider changes are new versions, not silent overwrites.';

commit;
