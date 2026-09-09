# Migration 10 — verification plan (PREPARED ONLY, NOT DEPLOYED)

File under review: `db/migrations/0010_commit_missing_trade_date.sql`.

Nothing in this document has been executed against Supabase. Run every check
inside a transaction that ends with `rollback;` except the migration itself.

## Structural checks (after a future deployment)

1. `import_source_rows_resolution_ck` no longer mentions `candidate_trade_date`:
   ```sql
   select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'import_source_rows_resolution_ck';
   ```
2. `import_source_rows_missing_date_disclosed` exists and requires
   `INCOMPLETE` + `MISSING_DATE`.
3. `commit_import_batch(uuid)` is still `security definer`, owner `postgres`,
   `proconfig = {search_path=}`; `anon`/`PUBLIC` have no EXECUTE, `authenticated`
   does.
4. Migrations 0001–0009a objects unchanged: enum list, table list, RLS enabled
   flags, policy count, and `public.transactions` / `public.current_holdings`
   definitions identical to the M08/M09a verification baselines.

## Behavioural checks

Each case: stage one batch, move it to `AWAITING_CONFIRMATION`, call
`public.commit_import_batch(:batch)` as the owning authenticated user, assert,
then `rollback`.

| # | Scenario | Expected |
|---|----------|----------|
| 1 | RESOLVED row, all facts present, `candidate_trade_date is null`, `INCOMPLETE`, issues `{MISSING_DATE}` | commit succeeds; 1 transaction; `trade_date is null` |
| 2 | Same row after commit | `data_quality_state = 'INCOMPLETE'` and `data_quality_issues = '{MISSING_DATE}'`; never `VALID` |
| 3 | Holdings effect of case 1 | `public.current_holdings` shows the security with the expected `net_quantity`; `first_trade_date`/`last_trade_date` may be null |
| 4 | NULL date **plus** another issue (e.g. `{MISSING_DATE,MISSING_ACCOUNT}`) | `commit_import_batch` raises `22023` "not valid for commit"; zero transactions |
| 5 | NULL date, but `candidate_broker_account_id is null` | blocked (case 4 path and the per-row account guard) |
| 6 | Fully dated VALID row | unchanged behaviour: commits `VALID`, zero issues |
| 7 | `SPLIT`, `REVERSAL`, `ADJUSTMENT` (each separately), otherwise complete | still blocked with `22023` "is not yet committable" |
| 8 | Re-run commit on an already `COMMITTED` batch | `already_committed = true`, no new transactions (idempotency unchanged) |
| 9 | Batch in `COMMITTING` | raises `55006` |
| 10 | Row owned by another user inside the batch | raises `40002` |
| 11 | `EXCLUDED` rows in the batch | preserved, counted in `excluded_row_count`, no transaction |
| 12 | Direct browser writes | `insert`/`update`/`delete` on `public.transactions` as `authenticated` still fail; no new grant is issued by M10 |
| 13 | Attempt to stage `RESOLVED` + null date + `VALID` | rejected by `import_source_rows_missing_date_disclosed` / `..._valid_no_issues` |

## Rollback rehearsal

Before rolling back, confirm no dateless committed lineage exists:

```sql
select count(*) from public.transactions
 where trade_date is null and import_source_row_id is not null;
```

Only if that is `0`, apply the rollback block documented at the head of the
migration and restore `commit_import_batch` verbatim from
`db/migrations/0007_commit_import_batch.sql`.

## Application-side gate

The review UI only offers the missing-date commit when
`VITE_M10_NULL_DATE_COMMIT=true`. Leave it unset until M10 is deployed and the
checks above pass; with the flag unset, a dateless row stays blocked exactly as
it is today, so the deployed M07 is never called with a shape it rejects.
