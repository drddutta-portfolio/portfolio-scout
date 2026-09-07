# PortfolioAI — Migration 08 Proposal (REVIEW ONLY — NOT APPLIED)

**Scope (approved via clarifying answers):** `public.portfolio_security_settings` + derived `public.current_holdings` **view**. Corporate actions are deferred to Migration 09. No market data, no engines, no cost-basis/P&L, no UI. No new file created yet; nothing applied to Supabase.

## 1. Design principles carried forward

- `public.transactions` (txn_state = 'ACTIVE') remains the sole accounting source of truth. `current_holdings` is a **view**, not a stored ledger — it cannot drift, be overwritten, or become a competing source.
- Quantity effects are explicit per `txn_type`. SPLIT / REVERSAL / ADJUSTMENT semantics are **not guessed**: their quantities are excluded from derived numbers and their presence is disclosed via flags.
- No cost basis, no average price, no P&L, no market value, no portfolio weight anywhere in this migration. No accounting-method default (no FIFO assumption).
- NULLs are preserved/disclosed: a holding whose contributing rows contain NULL quantity reports NULL net quantity plus a disclosure flag — never a silent zero or fabricated number.
- No new enums required: reuses M01 `portfolio_role` (CORE/SATELLITE/THEMATIC/WATCHLIST/UNASSIGNED). Core ≈ 35 remains a stock **count** (`portfolios.core_target_count`), untouched.
- RESTRICT deletion everywhere; owner-safe composite FKs; RLS designed with the schema; no anon access; no service-role credential.

## 2. Object 1 — `public.portfolio_security_settings`

Per-portfolio, per-security user configuration. This is non-financial configuration data (not accounting history), so owner-scoped browser INSERT/UPDATE/DELETE is permitted under RLS.

```sql
create table public.portfolio_security_settings (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete restrict,
  portfolio_id uuid not null,
  security_id  uuid not null references public.securities(id) on delete restrict,
  role         public.portfolio_role not null default 'UNASSIGNED',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint pss_portfolio_owner_fk
    foreign key (owner_id, portfolio_id)
    references public.portfolios (owner_id, id) on delete restrict,

  constraint pss_unique_per_portfolio_security
    unique (owner_id, portfolio_id, security_id),

  constraint pss_notes_len check (notes is null or char_length(notes) <= 4000)
);

-- one settings row per portfolio+security; the owner_id in the key keeps it owner-safe
create index pss_owner_portfolio_idx on public.portfolio_security_settings (owner_id, portfolio_id);
create index pss_owner_security_idx  on public.portfolio_security_settings (owner_id, security_id);
```

- Timestamps protected exactly as M02: reuse `public.set_updated_at()` trigger; `created_at`/`updated_at` excluded from INSERT/UPDATE column grants.
- Grants (explicit, after the M02a default-privilege hardening):
  - `revoke all` from `anon`/`authenticated`/`PUBLIC`, then:
  - `grant select on ... to authenticated;`
  - `grant insert (owner_id, portfolio_id, security_id, role, notes) to authenticated;`
  - `grant update (role, notes) to authenticated;`  (identity keys not rewritable)
  - `grant delete on ... to authenticated;` (justified: config data, not financial history)
- RLS enabled; four owner-scoped policies, all `using (owner_id = (select auth.uid()))`:
  - `pss_select_own` (SELECT), `pss_insert_own` (INSERT with check), `pss_update_own` (UPDATE using+with check), `pss_delete_own` (DELETE).
- Cross-tenant role assignment is impossible: composite FK forces the portfolio to belong to the same owner_id; RLS forces owner_id = caller.

## 3. Object 2 — `public.current_holdings` (derived view)

```sql
create view public.current_holdings
with (security_invoker = true) as
select
  t.owner_id,
  t.portfolio_id,
  t.security_id,
  -- supported quantity effects only; sign is explicit per txn_type
  case
    when count(*) filter (
      where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
        and t.quantity is null
    ) > 0 then null                                   -- disclose insufficiency, never fabricate
    else sum(
      case
        when t.txn_type in ('BUY','OPENING_POSITION','TRANSFER_IN','BONUS') then  t.quantity
        when t.txn_type in ('SELL','TRANSFER_OUT')                             then -t.quantity
      end
    ) filter (
      where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
    )
  end as net_quantity,
  count(*) as active_txn_count,
  count(*) filter (where t.txn_type in ('SPLIT','REVERSAL','ADJUSTMENT')) as unhandled_txn_count,
  count(*) filter (where t.quantity is null)                               as missing_quantity_count,
  count(*) filter (where t.data_quality_state <> 'VALID')                  as non_valid_txn_count,
  min(t.trade_date) as first_trade_date,
  max(t.trade_date) as last_trade_date
from public.transactions t
where t.txn_state = 'ACTIVE'
group by t.owner_id, t.portfolio_id, t.security_id;
```

Semantics (documented in the migration comments):

- `net_quantity` covers only BUY / SELL / OPENING_POSITION / TRANSFER_IN / TRANSFER_OUT / BONUS. SPLIT, REVERSAL and ADJUSTMENT rows are **excluded from the number** and surfaced through `unhandled_txn_count > 0`; consumers must treat such holdings as INSUFFICIENT_DATA until corporate-action handling (M09+) exists. This preserves the no-silent-double-counting invariant.
- Any NULL quantity among contributing rows ⇒ `net_quantity` is NULL and `missing_quantity_count > 0` (never zero-filled).
- A negative derived quantity is **not** hidden: the row is returned with its negative value; consumers flag `NEGATIVE_DERIVED_QUANTITY`. (A stricter variant — NULL it out — is noted as an open question below.)
- No prices, no cost basis, no P&L, no weight columns. Zero holdings produce no rows.
- `security_invoker = true`: the view executes as the caller, so the M05 owner-scoped RLS on `transactions` applies automatically — no new policy surface, no cross-owner leakage. View owner `postgres`; `grant select on public.current_holdings to authenticated;` only; nothing to anon/PUBLIC.
- `first_trade_date`/`last_trade_date` may be NULL when source dates are NULL (M05 preserves NULL dates); no date is fabricated.

## 4. Exact migration file (to be created only on approval)

`db/migrations/0008_derived_holdings.sql` containing, in one transaction:
1. `create table public.portfolio_security_settings (...)` as above
2. its indexes, trigger (`set_updated_at`), grants/revokes, RLS + 4 policies, column comments
3. `create view public.current_holdings ... security_invoker = true` as above
4. view grant (authenticated SELECT only), comments documenting derivation semantics
5. Nothing else — no seeds, no other tables, no functions, no enum changes, no ALTER of prior objects.

## 5. Rollback

```sql
begin;
drop view if exists public.current_holdings;
drop table if exists public.portfolio_security_settings;  -- no CASCADE; nothing references it
commit;
```
Safe: no other object depends on either. Never `drop ... cascade`.

## 6. Security implications

- No SECURITY DEFINER anything. View uses `security_invoker` so existing transaction RLS is the enforcement point.
- Settings table adds browser DELETE for the first time — justified (non-financial config), owner-scoped by RLS, RESTRICT FKs prevent dangling references both ways.
- No anon access; no service-role key; no secrets; grants are explicit (M02a hardened defaults mean nothing is granted implicitly).

## 7. Verification plan (structural + behavioural, all rolled back where data is created)

Structural:
- Exactly 2 new objects (+ indexes/trigger/policies); tables 10 → 11; views 0 → 1; functions/enums unchanged (6 / 15).
- Settings: composite owner-safe FK, unique (owner_id, portfolio_id, security_id), RESTRICT on all three FKs, RLS enabled, 4 policies, exact column grants, `created_at`/`updated_at` not client-writable, trigger present and non-SECURITY DEFINER.
- View: `security_invoker=true`, owner postgres, authenticated SELECT-only, anon/PUBLIC nothing.

Behavioural (temporary data, rolled back):
- Two users: cross-owner SELECT/INSERT/UPDATE/DELETE on settings denied; cross-owner portfolio FK rejected; duplicate (portfolio, security) settings row rejected.
- Timestamp forging rejected on INSERT and UPDATE.
- Derivation correctness: BUY 10 + BUY 5 − SELL 4 + OPENING_POSITION 2 + TRANSFER_IN 3 − TRANSFER_OUT 1 + BONUS 1 ⇒ net_quantity 16.
- NULL quantity row ⇒ net_quantity NULL, missing_quantity_count = 1.
- SPLIT/REVERSAL/ADJUSTMENT rows ⇒ excluded from net_quantity, unhandled_txn_count correct.
- SUPERSEDED/REVERSED transactions excluded entirely.
- Negative derived quantity surfaced (not hidden).
- Cross-owner isolation through the view (user B sees zero rows of user A).
- M05/M06/M07 regression: policies, FKs, grants, and `commit_import_batch` unchanged.

Then: secret scan, `tsc` type check, production build, update `docs/migrations.md` + `roadmap.md`, commit/sync to private GitHub.

## 8. Compatibility

- Purely additive; no change to M01–M07 objects. M07 RPC untouched; committed transactions flow into the view automatically.
- Forward-compatible with M09 corporate actions (unhandled counts are the disclosure hook) and with later cost-basis engines (view carries no accounting-method assumption).

## 9. Open question for your decision

- **Negative derived quantity:** return the negative value with disclosure (proposed), or NULL it and require a flag? Proposed: return it — hiding it would be a silent alteration of derived fact.

**Status: NOT APPLIED. No migration file created. Awaiting your approval.**
