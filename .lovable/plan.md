# Migration 07 — Trusted Import Commit (PROPOSAL ONLY, NOT APPLIED)

Status: proposal for review. No migration file created, no Supabase change, no
transactions inserted, no UI, no service-role credential.

## 1. Filename

`db/migrations/0007_commit_import_batch.sql`

Contents: exactly one function (`public.commit_import_batch`), its
REVOKE/GRANT block, and comments. No new tables, columns, enums, policies or
grants on tables. Existing RLS, grants and M05/M06 guards are untouched.

## 2. RPC signature

```
public.commit_import_batch(p_batch_id uuid)
returns table (
  batch_id uuid,
  status public.import_batch_state,
  committed_transaction_count integer,
  excluded_row_count integer,
  already_committed boolean
)
```

One argument. Everything else is loaded server-side from
`import_batches` / `import_source_rows`. Owner comes from `auth.uid()`,
portfolio from the batch, all economic facts from the staging row.

`p_client_request_id` is deliberately NOT added: `import_batches` already
carries `client_request_id` with a unique `(owner_id, client_request_id)`
index, set at upload time, and the batch row lock plus
`transactions_source_row_uidx` already make retries deterministic. A second
idempotency token would add a code path with no additional guarantee.

## 3. Owner and security model

- `security definer`, `language plpgsql`, `set search_path = ''`, all objects
  fully schema-qualified (`public.`, `auth.uid()`, `pg_catalog` operators).
- Owner: **`postgres`** — the role that owns every object created by
  Migrations 01–06 and the role used by the rolled-back M06 definer probe.
  `service_role` is not used as owner; no service-role key exists in the app.
- Because `postgres` owns the tables and they are not `FORCE ROW LEVEL
  SECURITY`, the function's own statements bypass RLS. Every ownership check
  is therefore written explicitly in the body, never assumed from RLS.
- No dynamic SQL, no user-supplied identifiers, no `EXECUTE format(...)`.
- Interaction with the M06 guard: `import_batches_guard_state()` rejects
  `COMMITTING/COMMITTED/FAILED` only when `current_user = 'authenticated'`.
  Inside a definer function owned by `postgres`, `current_user` is `postgres`
  while `session_user`/`auth.uid()` still identify the caller — so the RPC may
  perform the trusted transition and a direct browser UPDATE still cannot.
  `import_source_rows_update_own` (an RLS policy) likewise does not apply to
  the definer's statements, so the RPC can set `resolution = 'COMMITTED'`.

## 4. Batch state transitions

Allowed entry state: **`AWAITING_CONFIRMATION` only**.

`AWAITING_CONFIRMATION → COMMITTING → COMMITTED` inside one call.

- `COMMITTED` → returns the idempotent success result, inserts nothing.
- `COMMITTING` → error `batch is being committed` (a live concurrent call
  holds the lock; a crashed call rolled its transition back, so a persisted
  `COMMITTING` means a genuine anomaly requiring review). No crash-recovery
  machinery is added.
- Any other state → error `batch is not awaiting confirmation`.

The intermediate `COMMITTING` write exists so that the state is observable to
`FOR UPDATE`-blocked callers after commit and so the value is not invented
later; because the whole function is one transaction, an exception rolls it
back with everything else.

## 5. Eligible rows

Strict rule: `resolution = 'RESOLVED' AND data_quality_state = 'VALID' AND
cardinality(data_quality_issues) = 0`.

Semantics option **B**: `EXCLUDED` rows are permitted and ignored; anything
else that is not eligible aborts the whole commit. Concretely, the commit
fails if any row in the batch has `resolution IN ('UNRESOLVED')`, or
`resolution = 'RESOLVED'` with `data_quality_state <> 'VALID'`. Nothing enters
the ledger merely because candidate fields are non-null.

Pre-existing `resolution = 'COMMITTED'` rows in an
`AWAITING_CONFIRMATION` batch are an inconsistent-lineage error.

## 6. Excluded rows

Preserved exactly as-is: never inserted, never deleted, never re-stated,
remain `EXCLUDED` after commit and stay distinguishable from `COMMITTED`.
They are counted in the return value only.

## 7. Server-side revalidation (per eligible row, before any insert)

- row `owner_id = auth.uid()` and `import_batch_id = p_batch_id`;
- `security_resolution = 'RESOLVED'` and `candidate_security_id` present and
  exists in `public.securities`;
- `candidate_broker_account_id` present and the account row exists with
  `owner_id = auth.uid()`;
- `candidate_txn_type` present; `candidate_trade_date` present;
- `candidate_quantity` present and `> 0`;
- `candidate_unit_price / gross_amount / total_charges` are NULL or `>= 0`;
- `candidate_currency` present and matches `^[A-Z]{3}$` (see §9);
- `data_quality_state = 'VALID'` and `data_quality_issues = '{}'`;
- `candidate_txn_type NOT IN ('SPLIT','REVERSAL','ADJUSTMENT')` — M05 requires
  those to be `NEEDS_REVIEW`, which is not committable; they are rejected with
  an explicit "type not yet interpretable" error rather than being bent;
- no existing `public.transactions` row already carries this
  `import_source_row_id`.

## 8. Mapping (staging → ledger)

| transactions column | source |
|---|---|
| owner_id | `auth.uid()` (= batch owner, verified) |
| portfolio_id | `import_batches.portfolio_id` |
| broker_account_id | `candidate_broker_account_id` |
| security_id | `candidate_security_id` |
| txn_type | `candidate_txn_type` |
| trade_date | `candidate_trade_date` |
| quantity | `candidate_quantity` |
| unit_price | `candidate_unit_price` (may stay NULL) |
| gross_amount | `candidate_gross_amount` (never derived) |
| total_charges | `candidate_total_charges` (may stay NULL) |
| currency | `candidate_currency` (explicit, never defaulted) |
| txn_state | `'ACTIVE'` |
| data_quality_state | `'VALID'` |
| data_quality_issues | `'{}'` |
| source_system | `import_batches.source_system` |
| source_reference | `raw_source_reference` |
| import_source_row_id | source row `id` |
| notes | NULL |

No absent fact is fabricated; no arithmetic is performed.

## 9. Currency rule

A row with `candidate_currency IS NULL` is **rejected**. The column default
`'INR'` on `transactions` must never be reached through this path; the insert
lists `currency` explicitly. Establishing a documented per-source default
belongs to the staging/normalisation step before `AWAITING_CONFIRMATION`, not
to the trusted commit.

## 10. Idempotency

- Batch already `COMMITTED`: return
  `(batch_id, 'COMMITTED', <count of transactions with lineage into this
  batch>, <excluded count>, already_committed = true)` — no writes.
- Before inserting, the RPC checks for an existing transaction per source row
  (`NOT EXISTS` on `import_source_row_id`). A hit inside a batch that is not
  yet `COMMITTED` is inconsistent lineage → abort with a clear error, never a
  silent second insert. `transactions_source_row_uidx` remains the last-resort
  backstop, not the primary mechanism.
- Retry after a failed attempt: nothing persisted, so retry is clean.

## 11. Concurrency

`SELECT ... FROM public.import_batches WHERE id = p_batch_id FOR UPDATE` is
the first data statement after the auth check. A second concurrent call blocks
there; when the first commits, the second re-reads state `COMMITTED` and takes
the idempotent path. Browser row edits are blocked because
`import_source_rows_update_own` requires the parent batch state to be one of
`UPLOADED/PREVIEWED/VALIDATED/AWAITING_CONFIRMATION`, and the batch is
`COMMITTING` (then `COMMITTED`) for the whole critical section; the batch row
lock also serialises any concurrent browser UPDATE of the batch itself.

## 12. Atomicity

A PostgreSQL function runs inside the caller's transaction; PostgREST runs one
statement per request. Any `raise exception` (or constraint violation) rolls
back every insert, every `resolution` change and the state transition — the
batch reverts to `AWAITING_CONFIRMATION`. There is no per-row commit, no
exception swallowing, and no autonomous transaction.

## 13. Batch counters

Authorization never reads `rows_valid / rows_incomplete / rows_needs_review /
total_source_rows`. Eligibility is recomputed with aggregates over
`import_source_rows`. On success the RPC refreshes the stored counters from
those recomputed values (and `total_source_rows` from the actual row count) so
the persisted record matches what was committed.

## 14. Source-row finalization

Exactly the rows that produced a transaction go `RESOLVED → COMMITTED`, in the
same statement set as the inserts. `EXCLUDED` stays `EXCLUDED`. No other row
is touched. The M06 committed-interpretation freeze then applies to those rows
from that moment on.

## 15. Error model

`raise exception` with stable, non-leaking messages and errcodes:

| condition | errcode | message |
|---|---|---|
| `auth.uid()` NULL | 28000 | `commit_import_batch: authentication required` |
| batch missing / not owned | 42501 | `commit_import_batch: batch not found` (no existence oracle) |
| wrong state | 22023 | `commit_import_batch: batch is not awaiting confirmation` |
| state `COMMITTING` | 55006 | `commit_import_batch: batch commit already in progress` |
| unresolved rows present | 22023 | `... N row(s) are unresolved` |
| incomplete / needs-review rows | 22023 | `... N row(s) are not valid for commit` |
| missing account/security/date/quantity/currency | 22023 | `... row N: <field> is required` |
| uninterpretable type | 22023 | `... row N: SPLIT/REVERSAL/ADJUSTMENT is not yet committable` |
| existing lineage | 40002 | `... row N already has a canonical transaction` |
| empty commit set | 22023 | `... no committable rows` |

No raw payloads, no identifiers of other users, no internal SQL text.

## 16. Return schema

Single row: `batch_id uuid`, `status public.import_batch_state`,
`committed_transaction_count integer`, `excluded_row_count integer`,
`already_committed boolean`. No payload echo.

## 17. Empty batch

Recommended and proposed: **reject**. Zero source rows, all rows `EXCLUDED`,
or zero eligible rows all raise `no committable rows`; the batch stays
`AWAITING_CONFIRMATION`. An economically empty batch is never marked
`COMMITTED` implicitly. If you later want an explicit "close as empty" path,
that is a separate reviewed operation.

## 18. Grants

```sql
revoke all on function public.commit_import_batch(uuid) from public;
revoke all on function public.commit_import_batch(uuid) from anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;
```

No table grants change; `authenticated` still has no INSERT/UPDATE/DELETE on
`public.transactions`.

## 19. Exact SQL (for review)

```sql
begin;

create function public.commit_import_batch(p_batch_id uuid)
returns table (
  batch_id uuid,
  status public.import_batch_state,
  committed_transaction_count integer,
  excluded_row_count integer,
  already_committed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_batch      public.import_batches%rowtype;
  v_bad        integer;
  v_row        public.import_source_rows%rowtype;
  v_inserted   integer := 0;
  v_excluded   integer := 0;
begin
  if v_uid is null then
    raise exception 'commit_import_batch: authentication required'
      using errcode = '28000';
  end if;

  select * into v_batch
    from public.import_batches b
   where b.id = p_batch_id and b.owner_id = v_uid
   for update;

  if not found then
    raise exception 'commit_import_batch: batch not found'
      using errcode = '42501';
  end if;

  select count(*) into v_excluded
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id and r.resolution = 'EXCLUDED';

  if v_batch.state = 'COMMITTED' then
    select count(*) into v_inserted
      from public.transactions t
      join public.import_source_rows r on r.id = t.import_source_row_id
     where r.import_batch_id = v_batch.id;
    return query select v_batch.id, v_batch.state, v_inserted, v_excluded, true;
    return;
  end if;

  if v_batch.state = 'COMMITTING' then
    raise exception 'commit_import_batch: batch commit already in progress'
      using errcode = '55006';
  end if;

  if v_batch.state <> 'AWAITING_CONFIRMATION' then
    raise exception 'commit_import_batch: batch is not awaiting confirmation'
      using errcode = '22023';
  end if;

  -- portfolio ownership (defence in depth; the composite FK already binds it)
  perform 1 from public.portfolios p
   where p.id = v_batch.portfolio_id and p.owner_id = v_uid;
  if not found then
    raise exception 'commit_import_batch: batch not found' using errcode = '42501';
  end if;

  -- no row may be left in an indeterminate state
  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'UNRESOLVED';
  if v_bad > 0 then
    raise exception 'commit_import_batch: % row(s) are unresolved', v_bad
      using errcode = '22023';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'RESOLVED'
     and (r.data_quality_state <> 'VALID'
          or pg_catalog.cardinality(r.data_quality_issues) > 0);
  if v_bad > 0 then
    raise exception 'commit_import_batch: % row(s) are not valid for commit', v_bad
      using errcode = '22023';
  end if;

  select count(*) into v_bad
    from public.import_source_rows r
   where r.import_batch_id = v_batch.id
     and r.resolution = 'COMMITTED';
  if v_bad > 0 then
    raise exception 'commit_import_batch: inconsistent lineage in batch'
      using errcode = '40002';
  end if;

  update public.import_batches
     set state = 'COMMITTING'
   where id = v_batch.id;

  for v_row in
    select * from public.import_source_rows r
     where r.import_batch_id = v_batch.id
       and r.owner_id = v_uid
       and r.resolution = 'RESOLVED'
       and r.data_quality_state = 'VALID'
     order by r.source_row_number
     for update
  loop
    if v_row.security_resolution <> 'RESOLVED' or v_row.candidate_security_id is null then
      raise exception 'commit_import_batch: row %: security is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.securities s where s.id = v_row.candidate_security_id;
    if not found then
      raise exception 'commit_import_batch: row %: security is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_broker_account_id is null then
      raise exception 'commit_import_batch: row %: broker account is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.broker_accounts a
      where a.id = v_row.candidate_broker_account_id and a.owner_id = v_uid;
    if not found then
      raise exception 'commit_import_batch: row %: broker account is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_txn_type is null then
      raise exception 'commit_import_batch: row %: transaction type is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_txn_type in ('SPLIT','REVERSAL','ADJUSTMENT') then
      raise exception 'commit_import_batch: row %: % is not yet committable',
        v_row.source_row_number, v_row.candidate_txn_type using errcode = '22023';
    end if;
    if v_row.candidate_trade_date is null then
      raise exception 'commit_import_batch: row %: trade date is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_quantity is null or v_row.candidate_quantity <= 0 then
      raise exception 'commit_import_batch: row %: quantity is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if v_row.candidate_currency is null then
      raise exception 'commit_import_batch: row %: currency is required', v_row.source_row_number
        using errcode = '22023';
    end if;
    if coalesce(v_row.candidate_unit_price, 0) < 0
       or coalesce(v_row.candidate_gross_amount, 0) < 0
       or coalesce(v_row.candidate_total_charges, 0) < 0 then
      raise exception 'commit_import_batch: row %: negative amount', v_row.source_row_number
        using errcode = '22023';
    end if;
    perform 1 from public.transactions t where t.import_source_row_id = v_row.id;
    if found then
      raise exception 'commit_import_batch: row % already has a canonical transaction',
        v_row.source_row_number using errcode = '40002';
    end if;

    insert into public.transactions (
      owner_id, portfolio_id, broker_account_id, security_id, txn_type,
      trade_date, quantity, unit_price, gross_amount, total_charges, currency,
      txn_state, data_quality_state, data_quality_issues,
      source_system, source_reference, import_source_row_id)
    values (
      v_uid, v_batch.portfolio_id, v_row.candidate_broker_account_id,
      v_row.candidate_security_id, v_row.candidate_txn_type,
      v_row.candidate_trade_date, v_row.candidate_quantity,
      v_row.candidate_unit_price, v_row.candidate_gross_amount,
      v_row.candidate_total_charges, v_row.candidate_currency,
      'ACTIVE', 'VALID', '{}',
      v_batch.source_system, v_row.raw_source_reference, v_row.id);

    update public.import_source_rows
       set resolution = 'COMMITTED'
     where id = v_row.id;

    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted = 0 then
    raise exception 'commit_import_batch: no committable rows' using errcode = '22023';
  end if;

  update public.import_batches b
     set state = 'COMMITTED',
         committed_at = pg_catalog.now(),
         total_source_rows = s.total,
         rows_valid        = s.valid,
         rows_incomplete   = s.incomplete,
         rows_needs_review = s.review
    from (
      select count(*)::int as total,
             count(*) filter (where data_quality_state = 'VALID')::int as valid,
             count(*) filter (where data_quality_state = 'INCOMPLETE')::int as incomplete,
             count(*) filter (where data_quality_state = 'NEEDS_REVIEW')::int as review
        from public.import_source_rows where import_batch_id = v_batch.id
    ) s
   where b.id = v_batch.id;

  return query select v_batch.id, 'COMMITTED'::public.import_batch_state,
                      v_inserted, v_excluded, false;
end;
$$;

alter function public.commit_import_batch(uuid) owner to postgres;

comment on function public.commit_import_batch(uuid) is
  'Trusted atomic import commit: AWAITING_CONFIRMATION -> COMMITTING -> COMMITTED. '
  'Loads all canonical facts server-side; the browser supplies only the batch id.';

revoke all on function public.commit_import_batch(uuid) from public;
revoke all on function public.commit_import_batch(uuid) from anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;

commit;
```

## 20. Rollback

```sql
begin;
drop function if exists public.commit_import_batch(uuid);
commit;
```
Dropping the function does not affect already-committed ledger rows (correct:
committed facts are never rewritten).

## 21. Structural verification plan

- exactly one new function; no new tables, columns, enums, policies;
- `prosecdef = true`, `proconfig = {search_path=}`, owner `postgres`,
  `provolatile = 'v'`, `prokind = 'f'`;
- `has_function_privilege('anon', ..., 'execute') = false`,
  `('authenticated', ...) = true`, PUBLIC revoked;
- enum count still 15; M01–M06 tables, constraints, triggers, RLS policies and
  column grants byte-identical to the pre-migration snapshot;
- `authenticated` still has only SELECT on `public.transactions`.

## 22. Behavioural test plan (all inside a rolled-back transaction)

Unauthenticated reject; wrong-owner reject (`batch not found`); single-row
commit; multi-row commit; batch with an explicit EXCLUDED row (commits the
rest, EXCLUDED untouched); UNRESOLVED row present (whole batch fails);
INCOMPLETE row; NEEDS_REVIEW row; missing account / security / date /
quantity / currency each reject; SPLIT, REVERSAL, ADJUSTMENT each reject;
pre-existing lineage rejects; retry of a COMMITTED batch returns
`already_committed = true` with unchanged counts and no new rows;
concurrency reasoning verified with two sessions (second blocks on
`FOR UPDATE`, then takes the idempotent path); empty batch rejects;
all-EXCLUDED batch rejects; one invalid row among many leaves zero
transactions and the batch back at `AWAITING_CONFIRMATION`; field-by-field
mapping assertions; `resolution = 'COMMITTED'` for exactly the inserted rows;
batch `state = 'COMMITTED'`, `committed_at` non-null and consistent with the
M06 constraint; refreshed counters match recomputed values; direct
authenticated INSERT/UPDATE/DELETE on `public.transactions` still denied;
direct authenticated UPDATE of batch state to COMMITTING/COMMITTED/FAILED
still denied; committed source rows still frozen; final row/function counts
show no residual test data.

## 23. Compatibility with Migrations 01–06

No schema object from M01–M06 is altered. The function relies on: M05
constraints and immutability trigger, M06 `import_source_row_id` +
`transactions_source_row_uidx`, the `current_user`-based batch state guard,
the committed-row interpretation freeze, owner-safe composite FKs, and the
explicit-grant model from M02a. Nothing is loosened.

## Confirmations

Migration 07 NOT applied · no migration file created · no Supabase schema
modification · no portfolio transactions inserted · no service-role
application credential · no UI work.
