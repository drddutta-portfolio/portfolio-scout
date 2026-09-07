# PortfolioAI — Migration 08 Proposal, Revision 2 (REVIEW ONLY — NOT APPLIED)

**Scope (approved):** `public.portfolio_security_settings` + derived `public.current_holdings` **view**. Corporate actions deferred to Migration 09. No market data, no engines, no cost-basis/P&L, no UI. No migration file created; nothing applied to Supabase.

**Revision 2 changes (only these):**
1. Any ACTIVE SPLIT / REVERSAL / ADJUSTMENT for a holding now forces `net_quantity = NULL` (previously the numeric sum of the remaining rows was still returned — unsafe: BUY 100 + SPLIT 2:1 would have shown 100 as a potentially false current holding).
2. Fully-resolved zero holdings (`net_quantity = 0`) are now genuinely omitted, implemented with a derived subquery + outer `WHERE` (previously the "zero holdings produce no rows" statement was not implemented — GROUP BY would still have emitted the row).
3. Negative derived quantity decision resolved: returned visibly, never hidden or converted to NULL (open question closed).
4. Documented explicitly: role-change history is **deferred**, not removed from the roadmap.

## 1. Design principles carried forward

- `public.transactions` (txn_state = 'ACTIVE') remains the sole accounting source of truth. `current_holdings` is a **view**, not a stored ledger — it cannot drift, be overwritten, or become a competing source.
- A non-NULL `net_quantity` means: **every** ACTIVE quantity-affecting transaction for the holding is currently understood and has a usable quantity. If any SPLIT/REVERSAL/ADJUSTMENT exists, or any supported row has NULL quantity, `net_quantity` is NULL and the counters disclose why. Nothing is guessed; no corporate-action effect is calculated in M08.
- No cost basis, no average price, no P&L, no market value, no portfolio weight anywhere in this migration. No accounting-method default (no FIFO/LIFO/weighted-average assumption).
- No new enums: reuses M01 `portfolio_role` (CORE/SATELLITE/THEMATIC/WATCHLIST/UNASSIGNED). Core ≈ 35 remains a stock **count** (`portfolios.core_target_count`), untouched.
- RESTRICT deletion everywhere; owner-safe composite FKs; RLS designed with the schema; no anon access; no service-role credential.
- **Role-change history is deferred** to a later reviewed migration (audit/decision layer); `portfolio_security_settings.role` holds only the current role. This is a deferral, not a removal from the roadmap.

## 2. Object 1 — `public.portfolio_security_settings` (unchanged from Revision 1)

Per-portfolio, per-security user configuration. Non-financial configuration data (not accounting history), so owner-scoped browser INSERT/UPDATE/DELETE is permitted under RLS.

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

create index pss_owner_portfolio_idx on public.portfolio_security_settings (owner_id, portfolio_id);
create index pss_owner_security_idx  on public.portfolio_security_settings (owner_id, security_id);
```

- Timestamps protected exactly as M02: reuse `public.set_updated_at()` trigger; `created_at`/`updated_at` excluded from INSERT/UPDATE column grants. Identity keys (`owner_id`, `portfolio_id`, `security_id`) are insert-only — not in the UPDATE grant.
- Grants (explicit, per the M02a hardened-defaults model):
  - `revoke all` from `anon`/`authenticated`/`PUBLIC`, then:
  - `grant select on ... to authenticated;`
  - `grant insert (owner_id, portfolio_id, security_id, role, notes) to authenticated;`
  - `grant update (role, notes) to authenticated;`
  - `grant delete on ... to authenticated;` (justified: config data, not financial history)
  - `grant all on ... to service_role;` (Supabase/admin compatibility only, as in M05)
- RLS enabled; four owner-scoped policies, all `using (owner_id = auth.uid())`:
  - `pss_select_own` (SELECT), `pss_insert_own` (INSERT, WITH CHECK), `pss_update_own` (UPDATE, USING + WITH CHECK), `pss_delete_own` (DELETE).
- Cross-tenant role assignment is impossible: composite FK forces the portfolio to belong to the same owner_id; RLS forces owner_id = caller.

## 3. Object 2 — `public.current_holdings` (derived view, REVISED)

```sql
create view public.current_holdings
with (security_invoker = true) as
with derived as (
  select
    t.owner_id,
    t.portfolio_id,
    t.security_id,
    -- A non-NULL net_quantity means every ACTIVE quantity-affecting
    -- transaction for this holding is understood and has a usable quantity.
    case
      -- (a) unhandled semantics present: never guess SPLIT/REVERSAL/ADJUSTMENT effects
      when count(*) filter (
        where t.txn_type in ('SPLIT','REVERSAL','ADJUSTMENT')
      ) > 0 then null
      -- (b) supported row with missing quantity: missing is not zero
      when count(*) filter (
        where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
          and t.quantity is null
      ) > 0 then null
      -- (c) fully understood: explicit signed sum over supported types only
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
    count(*) filter (
      where t.txn_type in ('BUY','SELL','OPENING_POSITION','TRANSFER_IN','TRANSFER_OUT','BONUS')
        and t.quantity is null
    ) as missing_quantity_count,
    count(*) filter (where t.data_quality_state <> 'VALID') as non_valid_txn_count,
    min(t.trade_date) as first_trade_date,
    max(t.trade_date) as last_trade_date
  from public.transactions t
  where t.txn_state = 'ACTIVE'
  group by t.owner_id, t.portfolio_id, t.security_id
)
select
  owner_id, portfolio_id, security_id,
  net_quantity, active_txn_count, unhandled_txn_count,
  missing_quantity_count, non_valid_txn_count,
  first_trade_date, last_trade_date
from derived
-- Omit fully-resolved zero holdings. Rows whose net_quantity is NULL
-- (unhandled/missing data) and negative quantities stay visible for disclosure.
where net_quantity is distinct from 0;
```

Semantics (documented in the migration comments):

- **Non-NULL `net_quantity` guarantee:** every ACTIVE transaction for the holding has a currently-understood quantity effect and a non-NULL quantity. Supported directions: BUY +, OPENING_POSITION +, TRANSFER_IN +, BONUS +, SELL −, TRANSFER_OUT −.
- **Unhandled types invalidate the number:** any ACTIVE SPLIT / REVERSAL / ADJUSTMENT ⇒ `net_quantity` NULL, `unhandled_txn_count > 0`. Example: BUY 100 + SPLIT ⇒ NULL, not 100. No corporate-action interpretation exists in M08; this preserves the no-silent-double-counting invariant.
- **NULL quantity rule retained:** any supported ACTIVE row with NULL quantity ⇒ `net_quantity` NULL, `missing_quantity_count > 0`.
- **Zero-holding rule (now implemented):** a fully-resolved holding netting to exactly 0 (e.g. BUY 10 + SELL 10, no unhandled/missing/problem rows) produces **no row**. The outer `net_quantity is distinct from 0` filter keeps NULL and negative rows visible: BUY 10 + SELL 10 + SPLIT ⇒ row present, net_quantity NULL, unhandled_txn_count = 1. Negative quantities (over-sold / data problem) remain visible so `NEGATIVE_DERIVED_QUANTITY` can be flagged by consumers — never hidden or converted to NULL.
- `non_valid_txn_count` keeps source-data quality visible (INCOMPLETE/NEEDS_REVIEW contributing rows) without suppressing the holding.
- `first_trade_date`/`last_trade_date` may be NULL where source dates are NULL (M05 preserves NULL dates); no date is fabricated.
- No prices, no cost basis, no average price, no P&L, no market value, no portfolio weight columns.
- `security_invoker = true`: the view executes as the caller, so the M05 owner-scoped RLS on `transactions` is the security boundary — no new policy surface, no cross-owner leakage. View owner `postgres`; `grant select on public.current_holdings to authenticated;` only; nothing to anon/PUBLIC. No SECURITY DEFINER object anywhere in M08.

## 4. Exact migration file (to be created only on approval)

`db/migrations/0008_derived_holdings.sql`, one transaction:
1. `create table public.portfolio_security_settings (...)` as above
2. its indexes, `set_updated_at` trigger, explicit grants/revokes, RLS + 4 policies, comments
3. `create view public.current_holdings ... security_invoker = true` as above (derived CTE + outer filter)
4. view grant (authenticated SELECT only) + comments documenting derivation and zero-holding semantics
5. Nothing else — no seeds, no other tables, no functions, no enum changes, no ALTER of M01–M07 objects.

## 5. Rollback (unchanged)

```sql
begin;
drop view if exists public.current_holdings;
drop table if exists public.portfolio_security_settings;  -- no CASCADE; nothing references it
commit;
```
Safe: no other object depends on either. Never `drop ... cascade`.

## 6. Security implications

- No SECURITY DEFINER anything. The view uses `security_invoker` so existing transaction RLS is the enforcement point.
- Settings table adds browser DELETE for the first time — justified (non-financial config), owner-scoped by RLS, RESTRICT FKs prevent dangling references both ways.
- No anon access; no service-role application credential; no secrets; grants are explicit (M02a hardened defaults mean nothing is granted implicitly).

## 7. Verification plan

Structural:
- Exactly 2 new objects (+ indexes/trigger/policies); tables 10 → 11; views 0 → 1; functions 6 and enums 15 unchanged.
- Settings: composite owner-safe FK, unique (owner_id, portfolio_id, security_id), all FKs RESTRICT, RLS + 4 policies, exact column grants, `created_at`/`updated_at`/identity keys not client-rewritable, trigger present and SECURITY INVOKER.
- View: `security_invoker=true`, owner postgres, authenticated SELECT-only, anon/PUBLIC nothing, definition contains the unhandled-type NULL rule and the outer zero filter.

Behavioural (temporary data, rolled back):
- Two users: cross-owner SELECT/INSERT/UPDATE/DELETE on settings denied; cross-owner portfolio FK rejected; duplicate (owner, portfolio, security) settings row rejected; timestamp forging and identity-key UPDATE rejected.
- Derivation: BUY 10 + BUY 5 − SELL 4 + OPENING_POSITION 2 + TRANSFER_IN 3 − TRANSFER_OUT 1 + BONUS 1 ⇒ net_quantity 16.
- **Unhandled invalidation (new):**
  - BUY 100 + SPLIT ⇒ net_quantity NULL, unhandled_txn_count = 1
  - BUY 100 + ADJUSTMENT ⇒ net_quantity NULL, unhandled_txn_count = 1
  - BUY 100 + REVERSAL ⇒ net_quantity NULL, unhandled_txn_count = 1
- NULL quantity: BUY 10 + BUY (NULL qty) ⇒ net_quantity NULL, missing_quantity_count = 1.
- **Zero-holding filter (new):**
  - BUY 10 + SELL 10, all clean ⇒ no current_holdings row
  - BUY 10 + SELL 10 + SPLIT ⇒ row present, net_quantity NULL, unhandled_txn_count = 1
  - BUY 5 + SELL 10 ⇒ row present, net_quantity = −5 (visible, not nulled)
- SUPERSEDED/REVERSED transactions excluded entirely from every aggregate.
- NEEDS_REVIEW/INCOMPLETE contributing rows ⇒ non_valid_txn_count correct, row still visible.
- Cross-owner isolation through the view (user B sees zero of user A's rows).
- M05/M06/M07 regression: policies, FKs, grants, and `commit_import_batch` unchanged.

Then: secret scan, `tsc` type check, production build, update `docs/migrations.md` + `roadmap.md`, commit/sync to private GitHub.

## 8. Compatibility

- Purely additive; no change to M01–M07 objects. M07 RPC untouched; committed transactions flow into the view automatically.
- Forward-compatible with M09 corporate actions: when split/reversal/adjustment semantics are formally implemented, rule (a) is revisited by a reviewed migration; until then holdings affected by them are disclosed as unavailable rather than misstated.
- No accounting-method assumption, so later cost-basis engine choices remain open.

**Status: NOT APPLIED. No migration file created. Awaiting final approval.**
