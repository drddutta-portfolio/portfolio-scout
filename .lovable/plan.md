# Migration 06 — Import staging and provenance (PROPOSAL ONLY)

Not applied. No migration file created. No remote schema change. Migration 05 untouched. No canonical transactions inserted. No UI work. No secrets or service-role credential.

Proposed filename: `db/migrations/0006_import_staging.sql`

## 1. Model summary

Two new tables plus two new enums, and one additive lineage column on `transactions`.

- `import_batches` — one upload attempt, owned by one user, targeting one portfolio.
- `import_source_rows` — immutable raw evidence + mutable interpretation for each source row.
- `transactions.import_source_row_id` — nullable lineage. **Batch is NOT duplicated on transactions**: it is derivable through the source row, and a second column would be redundant state that could drift. Recommendation: source-row lineage only.

New enums (existing 13 unchanged):

- `import_row_resolution`: `UNRESOLVED`, `RESOLVED`, `EXCLUDED`, `COMMITTED`. Staging workflow state, deliberately separate from `data_quality_state` — one is "can this row be committed yet", the other is "is the data itself complete". Overloading them would make both ambiguous.
- `security_resolution_state`: `UNRESOLVED`, `RESOLVED`, `AMBIGUOUS`, `UNSUPPORTED`. Lets validation and UI distinguish the four cases without fuzzy matching in the database.

`data_quality_state` and `data_quality_issue[]` are reused unchanged. `MISSING_BROKER` (unknown source institution) and `MISSING_ACCOUNT` (institution known, account not identified) stay distinct exactly as in Migration 05.

## 2. Field classification

`import_batches` — required now: `id`, `owner_id`, `portfolio_id`, `state`, `original_filename`, `source_format`, `created_at`, `updated_at`. Useful now: `source_system`, `file_size_bytes`, `file_sha256`, `mime_type`, `client_request_id`, `total_source_rows`, `rows_valid`, `rows_incomplete`, `rows_needs_review`, `error_summary`, `committed_at`. Deferred: storage object path, per-column mapping profile, retry counters, UI wizard step.

`import_source_rows` — required now: `id`, `import_batch_id`, `owner_id`, `source_row_number`, `raw_payload jsonb`, `raw_line text`, resolution + data-quality columns, timestamps. Useful now: all `raw_*` strings and `candidate_*` parsed values listed below, `security_resolution`, `candidate_security_id`, `candidate_broker_account_id`, `duplicate_of_row_id`, `duplicate_reason`, `candidate_fingerprint`. Deferred: ranked candidate-match arrays, reviewer identity/notes, per-row commit error text (batch-level `error_summary` suffices in Phase 1).

## 3. Raw vs parsed

Both, deliberately. `raw_payload jsonb not null` holds the full parsed-but-untyped source record (header key → cell text). `raw_line text` holds the original delimited line when the format has one. In addition, the specific fields validation depends on are kept as explicit `raw_*` text columns so constraints and indexes can reference them. No whole-file payload and no binary is stored per row; the uploaded file itself stays outside the row (fingerprinted by `file_sha256`).

Parsing failures: the `raw_*` text is preserved verbatim and the paired `candidate_*` column stays `NULL`, never `0`. `raw_date = 'N/A'` → `candidate_trade_date IS NULL` plus `MISSING_DATE`; `raw_quantity = '1,250'` → `candidate_quantity = 1250`. All parsed financial and quantity values are `numeric(38,18)`; no floating point anywhere.

## 4. Exact SQL for review

```sql
-- 0006_import_staging.sql — untrusted import staging + provenance.
begin;

create type public.import_row_resolution as enum
  ('UNRESOLVED','RESOLVED','EXCLUDED','COMMITTED');
create type public.security_resolution_state as enum
  ('UNRESOLVED','RESOLVED','AMBIGUOUS','UNSUPPORTED');

create table public.import_batches (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete restrict,
  portfolio_id       uuid not null,
  state              public.import_batch_state not null default 'UPLOADED',
  original_filename  text not null,
  source_format      text not null,
  source_system      text,
  mime_type          text,
  file_size_bytes    bigint,
  file_sha256        char(64),
  client_request_id  uuid,
  total_source_rows  integer,
  rows_valid         integer not null default 0,
  rows_incomplete    integer not null default 0,
  rows_needs_review  integer not null default 0,
  error_summary      text,
  committed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint import_batches_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios (owner_id, id) on delete restrict,
  constraint import_batches_owner_id_id_key unique (owner_id, id),
  constraint import_batches_filename_len check (char_length(original_filename) between 1 and 260),
  constraint import_batches_format_ck check (source_format in ('CSV','XLSX','XLS','JSON','MANUAL','OTHER')),
  constraint import_batches_sha_format check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint import_batches_size_nonneg check (file_size_bytes is null or file_size_bytes >= 0),
  constraint import_batches_counts_nonneg check (
    coalesce(total_source_rows,0) >= 0 and rows_valid >= 0
    and rows_incomplete >= 0 and rows_needs_review >= 0),
  constraint import_batches_committed_at_state check (
    (committed_at is null) = (state <> 'COMMITTED'))
);

create unique index import_batches_client_request_uidx
  on public.import_batches (owner_id, client_request_id) where client_request_id is not null;
create index import_batches_owner_idx on public.import_batches (owner_id);
create index import_batches_portfolio_idx on public.import_batches (portfolio_id);
create index import_batches_sha_idx on public.import_batches (owner_id, file_sha256) where file_sha256 is not null;

create table public.import_source_rows (
  id                        uuid primary key default gen_random_uuid(),
  import_batch_id           uuid not null,
  owner_id                  uuid not null references public.profiles(id) on delete restrict,
  source_row_number         integer not null,
  raw_payload               jsonb not null,
  raw_line                  text,
  raw_security_text         text,
  raw_exchange              text,
  raw_isin                  text,
  raw_broker_text           text,
  raw_account_text          text,
  raw_txn_type              text,
  raw_date                  text,
  raw_quantity              text,
  raw_unit_price            text,
  raw_gross_amount          text,
  raw_total_charges         text,
  raw_currency              text,
  raw_source_reference      text,
  candidate_security_id     uuid references public.securities(id) on delete restrict,
  candidate_broker_account_id uuid,
  candidate_txn_type        public.txn_type,
  candidate_trade_date      date,
  candidate_quantity        numeric(38,18),
  candidate_unit_price      numeric(38,18),
  candidate_gross_amount    numeric(38,18),
  candidate_total_charges   numeric(38,18),
  candidate_currency        char(3),
  candidate_fingerprint     text,
  security_resolution       public.security_resolution_state not null default 'UNRESOLVED',
  resolution                public.import_row_resolution not null default 'UNRESOLVED',
  data_quality_state        public.data_quality_state not null default 'INCOMPLETE',
  data_quality_issues       public.data_quality_issue[] not null default '{}',
  duplicate_of_row_id       uuid,
  duplicate_reason          text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint import_source_rows_batch_owner_fk
    foreign key (owner_id, import_batch_id)
    references public.import_batches (owner_id, id) on delete restrict,
  constraint import_source_rows_account_owner_fk
    foreign key (owner_id, candidate_broker_account_id)
    references public.broker_accounts (owner_id, id) on delete restrict,
  constraint import_source_rows_owner_id_id_key unique (owner_id, id),
  -- Owner-safe self reference; deliberately NOT restricted to the same batch.
  constraint import_source_rows_duplicate_owner_fk
    foreign key (owner_id, duplicate_of_row_id)
    references public.import_source_rows (owner_id, id) on delete restrict,
  constraint import_source_rows_batch_ordinal_key unique (import_batch_id, source_row_number),
  constraint import_source_rows_ordinal_positive check (source_row_number >= 1),
  constraint import_source_rows_qty_nonneg check (candidate_quantity is null or candidate_quantity > 0),
  constraint import_source_rows_price_nonneg check (candidate_unit_price is null or candidate_unit_price >= 0),
  constraint import_source_rows_gross_nonneg check (candidate_gross_amount is null or candidate_gross_amount >= 0),
  constraint import_source_rows_charges_nonneg check (candidate_total_charges is null or candidate_total_charges >= 0),
  constraint import_source_rows_currency_format check (candidate_currency is null or candidate_currency ~ '^[A-Z]{3}$'),
  constraint import_source_rows_resolution_ck check (
    resolution <> 'RESOLVED' or (
      candidate_security_id is not null and security_resolution = 'RESOLVED'
      and candidate_txn_type is not null and candidate_trade_date is not null
      and candidate_quantity is not null)),
  constraint import_source_rows_security_state_ck check (
    (security_resolution = 'RESOLVED') = (candidate_security_id is not null)),
  constraint import_source_rows_valid_no_issues check (
    data_quality_state <> 'VALID' or cardinality(data_quality_issues) = 0),
  -- An initial UNRESOLVED row may have no issue yet: validation has not run.
  -- Once past UNRESOLVED, a non-VALID state must name at least one issue.
  constraint import_source_rows_flagged_has_issue check (
    resolution = 'UNRESOLVED'
    or data_quality_state = 'VALID'
    or cardinality(data_quality_issues) >= 1),
  constraint import_source_rows_missing_account_disclosed check (
    candidate_broker_account_id is not null
    or 'MISSING_ACCOUNT' = any(data_quality_issues)
    or resolution = 'UNRESOLVED'),
  constraint import_source_rows_dup_not_self check (duplicate_of_row_id is distinct from id)
);

create index import_source_rows_batch_idx on public.import_source_rows (import_batch_id, source_row_number);
create index import_source_rows_owner_idx on public.import_source_rows (owner_id);
create index import_source_rows_security_idx on public.import_source_rows (candidate_security_id)
  where candidate_security_id is not null;
create index import_source_rows_fingerprint_idx on public.import_source_rows (owner_id, candidate_fingerprint)
  where candidate_fingerprint is not null;

-- Lineage on the canonical ledger (nullable: manual trusted rows have none).
alter table public.transactions
  add column import_source_row_id uuid,
  add constraint transactions_source_row_owner_fk
    foreign key (owner_id, import_source_row_id)
    references public.import_source_rows (owner_id, id) on delete restrict;

-- One canonical transaction per staging row: makes commit retry idempotent.
create unique index transactions_source_row_uidx
  on public.transactions (import_source_row_id) where import_source_row_id is not null;

-- Extend the Migration 05 guard to lineage (drop/recreate; behaviour otherwise identical).
create or replace function public.transactions_guard_immutable_fields()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
  or new.portfolio_id is distinct from old.portfolio_id
  or new.broker_account_id is distinct from old.broker_account_id
  or new.security_id is distinct from old.security_id
  or new.txn_type is distinct from old.txn_type
  or new.trade_date is distinct from old.trade_date
  or new.quantity is distinct from old.quantity
  or new.unit_price is distinct from old.unit_price
  or new.gross_amount is distinct from old.gross_amount
  or new.total_charges is distinct from old.total_charges
  or new.currency is distinct from old.currency
  or new.source_system is distinct from old.source_system
  or new.source_reference is distinct from old.source_reference
  or new.import_source_row_id is distinct from old.import_source_row_id
  or new.created_at is distinct from old.created_at
  then
    raise exception
      'transactions: economic/source/lineage fields are immutable; correct via a reversal or superseding ledger row'
      using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
revoke execute on function public.transactions_guard_immutable_fields() from public;
revoke execute on function public.transactions_guard_immutable_fields() from anon, authenticated;

-- Raw evidence is immutable; interpretation may change.
create function public.import_source_rows_guard_raw()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id
  or new.import_batch_id is distinct from old.import_batch_id
  or new.owner_id is distinct from old.owner_id
  or new.source_row_number is distinct from old.source_row_number
  or new.raw_payload is distinct from old.raw_payload
  or new.raw_line is distinct from old.raw_line
  or new.raw_security_text is distinct from old.raw_security_text
  or new.raw_exchange is distinct from old.raw_exchange
  or new.raw_isin is distinct from old.raw_isin
  or new.raw_broker_text is distinct from old.raw_broker_text
  or new.raw_account_text is distinct from old.raw_account_text
  or new.raw_txn_type is distinct from old.raw_txn_type
  or new.raw_date is distinct from old.raw_date
  or new.raw_quantity is distinct from old.raw_quantity
  or new.raw_unit_price is distinct from old.raw_unit_price
  or new.raw_gross_amount is distinct from old.raw_gross_amount
  or new.raw_total_charges is distinct from old.raw_total_charges
  or new.raw_currency is distinct from old.raw_currency
  or new.raw_source_reference is distinct from old.raw_source_reference
  or new.created_at is distinct from old.created_at
  then
    raise exception 'import_source_rows: raw source evidence is immutable'
      using errcode = 'restrict_violation';
  end if;
  if old.resolution = 'COMMITTED' and new.resolution is distinct from old.resolution then
    raise exception 'import_source_rows: a COMMITTED row cannot be re-opened'
      using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;

-- Trusted-only lifecycle states and immutable committed batches.
create function public.import_batches_guard_state()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
  or new.portfolio_id is distinct from old.portfolio_id
  or new.original_filename is distinct from old.original_filename
  or new.file_sha256 is distinct from old.file_sha256
  or new.created_at is distinct from old.created_at then
    raise exception 'import_batches: provenance fields are immutable'
      using errcode = 'restrict_violation';
  end if;
  if old.state = 'COMMITTED' and new.state is distinct from old.state then
    raise exception 'import_batches: COMMITTED is terminal'
      using errcode = 'restrict_violation';
  end if;
  if pg_catalog.current_setting('role', true) = 'authenticated'
     and new.state is distinct from old.state
     and new.state in ('COMMITTING','COMMITTED','FAILED') then
    raise exception 'import_batches: % is set only by the trusted server path', new.state
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end; $$;

revoke execute on function public.import_source_rows_guard_raw() from public, anon, authenticated;
revoke execute on function public.import_batches_guard_state() from public, anon, authenticated;

create trigger import_batches_protect_state before update on public.import_batches
  for each row execute function public.import_batches_guard_state();
create trigger import_batches_set_updated_at before update on public.import_batches
  for each row execute function public.set_updated_at();
create trigger import_source_rows_protect_raw before update on public.import_source_rows
  for each row execute function public.import_source_rows_guard_raw();
create trigger import_source_rows_set_updated_at before update on public.import_source_rows
  for each row execute function public.set_updated_at();

-- Explicit grants only (Migration 02a model). anon: nothing.
grant select, delete on public.import_batches to authenticated;
grant insert (owner_id, portfolio_id, original_filename, source_format, source_system,
  mime_type, file_size_bytes, file_sha256, client_request_id, total_source_rows)
  on public.import_batches to authenticated;
grant update (state, source_system, total_source_rows, rows_valid, rows_incomplete,
  rows_needs_review, error_summary) on public.import_batches to authenticated;
grant all on public.import_batches to service_role;

grant select, delete on public.import_source_rows to authenticated;
grant insert (import_batch_id, owner_id, source_row_number, raw_payload, raw_line,
  raw_security_text, raw_exchange, raw_isin, raw_broker_text, raw_account_text,
  raw_txn_type, raw_date, raw_quantity, raw_unit_price, raw_gross_amount,
  raw_total_charges, raw_currency, raw_source_reference)
  on public.import_source_rows to authenticated;
grant update (candidate_security_id, candidate_broker_account_id, candidate_txn_type,
  candidate_trade_date, candidate_quantity, candidate_unit_price, candidate_gross_amount,
  candidate_total_charges, candidate_currency, candidate_fingerprint, security_resolution,
  resolution, data_quality_state, data_quality_issues, duplicate_of_row_id, duplicate_reason)
  on public.import_source_rows to authenticated;
grant all on public.import_source_rows to service_role;

alter table public.import_batches enable row level security;
alter table public.import_source_rows enable row level security;

create policy import_batches_select_own on public.import_batches
  for select to authenticated using (owner_id = auth.uid());
create policy import_batches_insert_own on public.import_batches
  for insert to authenticated with check (owner_id = auth.uid() and state = 'UPLOADED');
create policy import_batches_update_own on public.import_batches
  for update to authenticated using (owner_id = auth.uid() and state <> 'COMMITTED')
  with check (owner_id = auth.uid()
    and state in ('UPLOADED','PREVIEWED','VALIDATED','AWAITING_CONFIRMATION','REJECTED'));
create policy import_batches_delete_own on public.import_batches
  for delete to authenticated
  using (owner_id = auth.uid() and state in ('UPLOADED','PREVIEWED','VALIDATED','REJECTED','FAILED'));

create policy import_source_rows_select_own on public.import_source_rows
  for select to authenticated using (owner_id = auth.uid());
create policy import_source_rows_insert_own on public.import_source_rows
  for insert to authenticated with check (owner_id = auth.uid()
    and exists (select 1 from public.import_batches b
                where b.id = import_batch_id and b.owner_id = auth.uid()
                  and b.state in ('UPLOADED','PREVIEWED')));
create policy import_source_rows_update_own on public.import_source_rows
  for update to authenticated using (owner_id = auth.uid() and resolution <> 'COMMITTED')
  with check (owner_id = auth.uid() and resolution in ('UNRESOLVED','RESOLVED','EXCLUDED'));
create policy import_source_rows_delete_own on public.import_source_rows
  for delete to authenticated using (owner_id = auth.uid() and resolution <> 'COMMITTED');

commit;
```

## 5. Ownership, deletion and retention

Every cross-table reference is a composite `(owner_id, …)` FK, so cross-owner mixing is impossible at the schema level, not merely by RLS: batch→portfolio, row→batch, row→broker_account, transaction→source row. `candidate_security_id` references the shared `securities` table (no owner dimension). All FKs are `ON DELETE RESTRICT` — nothing cascades.

Deletion: the owner may delete their own rows and a batch only before commit, and `RESTRICT` makes it physically impossible to delete a source row or batch once a canonical transaction references it. Because row→batch is `RESTRICT`, discarding a batch means deleting its rows first (a later trusted RPC can do this in one call). `COMMITTED` batches and `COMMITTED` rows are permanently non-deletable and non-editable.

## 6. Duplicate detection and idempotency

No hard uniqueness on economic content — legitimate identical trades must be allowed. Enforced uniqueness is only where semantics are guaranteed: `(import_batch_id, source_row_number)`, `(owner_id, client_request_id)`, and one transaction per source row. Everything else is advisory: `file_sha256` gives a same-file-uploaded-twice warning (never proof of economic identity), `candidate_fingerprint` (normalised account+security+type+date+quantity+price hash, computed by the app) gives a duplicate-candidate warning, and `duplicate_of_row_id` + `duplicate_reason` + `DUPLICATE_SUSPECTED` record the finding without discarding the row. Cases A–E map to: A ordinal uniqueness (hard), B file hash (warning), C allowed by design, D source-reference comparison within owner+account (warning), E fingerprint (warning).

`source_row_number` is the physical row number in the uploaded file including any header row, so an auditor can open the file and jump straight to it; the header itself is never staged as a data row.

Batch idempotency for the future `commit_import_batch`: `(owner_id, client_request_id)` deduplicates the request; `transactions_source_row_uidx` makes a re-run insert-or-skip per row; `COMMITTING`/`COMMITTED` are trusted-only and `COMMITTED` is terminal, so a retry after a crash resumes rather than duplicates. Migration 07 needs no further schema.

## 7. Verification and test plan (run after approval and apply)

Structural: exactly two new tables and two new enums, existing 13 enums and all prior tables unchanged, one new nullable column on `transactions`, all FKs `confdeltype='r'`, expected indexes/uniques, RLS on with the eight listed policies, `relacl` showing no `anon`, functions `prosecdef=false` with `search_path=''` and no `anon`/`authenticated` EXECUTE.

Behavioural (all in rolled-back transactions): cross-owner batch/row/account/lineage inserts rejected; duplicate ordinal rejected; two legitimate identical rows accepted; raw-field UPDATE rejected while candidate UPDATE succeeds and advances `updated_at`; `authenticated` cannot set `COMMITTING`/`COMMITTED`/`FAILED`, cannot re-open a `COMMITTED` batch or row, cannot delete a committed batch/row, cannot INSERT/UPDATE/DELETE `transactions`; `anon` denied everywhere; deleting a batch whose rows exist is blocked; deleting a source row referenced by a transaction is blocked; a second transaction on the same source row is rejected; all Migration 05 immutability checks still fail, now including `import_source_row_id`. Then secret scan, `tsgo --noEmit`, build, and documentation updates.
