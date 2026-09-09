import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState, IssueBadges, LoadingState, PageHeader, StatusBadge } from "@/components/state";
import { BrokerAccountsPanel } from "@/routes/_app.settings";
import {
  evaluateRow,
  fingerprint,
  isUnsupportedTxnType,
  parseSourceDate,
  parseSourceNumber,
  parseTxnType,
  readHoldingsClaim,
} from "@/lib/import-logic";
import {
  buildMasterIndex,
  chunks,
  resolveCandidates,
  type Candidates,
} from "@/lib/security-resolution";
import type {
  Broker,
  BrokerAccount,
  CurrentHolding,
  ImportBatch,
  ImportSourceRow,
  Security,
} from "@/lib/types";
import { useSupabase } from "@/providers/auth";

export const Route = createFileRoute("/_app/import/$batchId")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Review import — PortfolioAI" },
      {
        name: "description",
        content: "Confirm securities and accounts row by row before committing an import.",
      },
      { property: "og:title", content: "Review import — PortfolioAI" },
      {
        property: "og:description",
        content: "Confirm securities and accounts row by row before committing an import.",
      },
    ],
  }),
  component: BatchPage,
});

interface RowChoice {
  securityId: string | null;
  brokerAccountId: string | null;
  excluded: boolean;
}

/**
 * Migration 10 (prepared, not deployed) lets a row whose only defect is an
 * unknown trade date reach the ledger as INCOMPLETE + MISSING_DATE. Until the
 * migration is actually deployed this stays off, so the deployed commit
 * function is never called with a shape it would reject.
 */
const ALLOW_MISSING_DATE = import.meta.env["VITE_M10_NULL_DATE_COMMIT"] === "true";

const BLANK_BROKER = "\u0000blank";

function BatchPage() {
  const { batchId } = Route.useParams();
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [declaredCurrency, setDeclaredCurrency] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);
  /** Rows where the user picked an account by hand; never overwritten silently. */
  const [explicitAccounts, setExplicitAccounts] = useState<Record<string, true>>({});
  const [brokerMap, setBrokerMap] = useState<Record<string, string>>({});

  const batchQuery = useQuery({
    queryKey: ["batch", batchId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("import_batches")
        .select("*")
        .eq("id", batchId)
        .single();
      if (error) throw new Error(error.message);
      return data as ImportBatch;
    },
  });

  const rowsQuery = useQuery({
    queryKey: ["batch-rows", batchId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("import_source_rows")
        .select("*")
        .eq("import_batch_id", batchId)
        .order("source_row_number");
      if (error) throw new Error(error.message);
      return (data ?? []) as ImportSourceRow[];
    },
  });

  const accountsQuery = useQuery({
    queryKey: ["broker-accounts"],
    queryFn: async () => {
      const [accounts, brokers] = await Promise.all([
        supabase.from("broker_accounts").select("*").is("archived_at", null).order("created_at"),
        supabase.from("brokers").select("*"),
      ]);
      if (accounts.error) throw new Error(accounts.error.message);
      if (brokers.error) throw new Error(brokers.error.message);
      return {
        accounts: (accounts.data ?? []) as BrokerAccount[],
        brokers: (brokers.data ?? []) as Broker[],
      };
    },
  });

  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  const matchesQuery = useQuery({
    queryKey: ["batch-matches", batchId, rows.length],
    enabled: rows.length > 0,
    queryFn: async () => {
      const inputs = rows.map((row) => ({
        isin: row.raw_isin,
        exchange: row.raw_exchange,
        securityText: row.raw_security_text,
      }));
      const index = await buildMasterIndex(supabase, inputs);
      const map: Record<string, Candidates> = {};
      rows.forEach((row, i) => {
        map[row.id] = resolveCandidates(index, inputs[i]!);
      });
      return map;
    },
  });

  // Seed local choices from anything already persisted on the row.
  useEffect(() => {
    if (rows.length === 0) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        if (next[row.id]) continue;
        next[row.id] = {
          securityId: row.candidate_security_id,
          brokerAccountId: row.candidate_broker_account_id,
          excluded: row.resolution === "EXCLUDED",
        };
      }
      return next;
    });
  }, [rows]);

  const derived = useMemo(() => {
    return rows.map((row) => {
      const choice = choices[row.id] ?? {
        securityId: null,
        brokerAccountId: null,
        excluded: false,
      };
      const candidates = matchesQuery.data?.[row.id];
      const txnType = parseTxnType(row.raw_txn_type);
      const tradeDate = parseSourceDate(row.raw_date);
      const quantity = parseSourceNumber(row.raw_quantity);
      const currency = (row.raw_currency ?? declaredCurrency).trim().toUpperCase() || null;
      const verdict = evaluateRow(
        {
          securityResolved: Boolean(choice.securityId),
          securityAmbiguous: (candidates?.securities.length ?? 0) > 1 && !choice.securityId,
          brokerAccountId: choice.brokerAccountId,
          brokerTextPresent: Boolean(row.raw_broker_text),
          txnType,
          tradeDate,
          quantity,
          currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
        },
        { allowMissingDate: ALLOW_MISSING_DATE },
      );
      return { row, choice, candidates, txnType, tradeDate, quantity, currency, verdict };
    });
  }, [rows, choices, matchesQuery.data, declaredCurrency]);

  const includedRows = derived.filter((item) => !item.choice.excluded);
  const readyCount = includedRows.filter((item) => item.verdict.ready).length;
  const blockedCount = includedRows.length - readyCount;
  /** Blocked only because the source never stated a date (unblocked by M10). */
  const awaitingDateSupport = ALLOW_MISSING_DATE
    ? 0
    : includedRows.filter((item) => !item.verdict.ready && item.verdict.missingDateOnly).length;
  const batch = batchQuery.data;
  const isCommitted = batch?.state === "COMMITTED";

  /** Distinct source broker names in the batch, with their row counts. */
  const brokerGroups = useMemo(() => {
    const map = new Map<string, { label: string; rowIds: string[] }>();
    for (const item of derived) {
      const raw = (item.row.raw_broker_text ?? "").trim();
      const key = raw === "" ? BLANK_BROKER : raw.toUpperCase();
      const entry = map.get(key) ?? {
        label: raw === "" ? "(no broker stated)" : raw,
        rowIds: [],
      };
      entry.rowIds.push(item.row.id);
      map.set(key, entry);
    }
    return Array.from(map.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) =>
        a.key === BLANK_BROKER ? 1 : b.key === BLANK_BROKER ? -1 : a.label.localeCompare(b.label),
      );
  }, [derived]);

  const save = useMutation({
    mutationFn: async () => {
      for (const chunk of chunks(derived, 20)) {
        await Promise.all(
          chunk.map(async (item) => {
            const { row, choice, verdict, txnType, tradeDate, quantity, currency } = item;
            if (row.resolution === "COMMITTED") return;
            const base = {
              candidate_security_id: choice.securityId,
              security_resolution: choice.securityId ? "RESOLVED" : "UNRESOLVED",
              candidate_broker_account_id: choice.brokerAccountId,
              candidate_txn_type: txnType,
              candidate_trade_date: tradeDate,
              candidate_quantity: quantity,
              candidate_unit_price: parseSourceNumber(row.raw_unit_price),
              candidate_gross_amount: parseSourceNumber(row.raw_gross_amount),
              candidate_total_charges: parseSourceNumber(row.raw_total_charges),
              candidate_currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
              candidate_fingerprint: fingerprint([
                choice.securityId,
                txnType,
                tradeDate,
                quantity,
                row.raw_source_reference,
              ]),
            };
            // A row that is complete apart from an unknown date is stored as
            // RESOLVED + INCOMPLETE + MISSING_DATE. The date is never invented.
            const resolvedQuality =
              verdict.issues.length === 0
                ? { data_quality_state: "VALID", data_quality_issues: [] as string[] }
                : { data_quality_state: "INCOMPLETE", data_quality_issues: ["MISSING_DATE"] };
            const payload = choice.excluded
              ? {
                  ...base,
                  resolution: "EXCLUDED",
                  data_quality_state: verdict.ready
                    ? resolvedQuality.data_quality_state
                    : verdict.dataQualityState,
                  data_quality_issues: verdict.ready
                    ? resolvedQuality.data_quality_issues
                    : verdict.issues,
                }
              : verdict.ready
                ? {
                    ...base,
                    resolution: "RESOLVED",
                    ...resolvedQuality,
                  }
                : {
                    ...base,
                    resolution: "UNRESOLVED",
                    data_quality_state: verdict.dataQualityState,
                    data_quality_issues: verdict.issues,
                  };

            const { error } = await supabase
              .from("import_source_rows")
              .update(payload)
              .eq("id", row.id);
            if (error) throw new Error(`Row ${row.source_row_number}: ${error.message}`);
          }),
        );
      }
    },
    onSuccess: () => {
      toast.success("Review saved");
      void queryClient.invalidateQueries({ queryKey: ["batch-rows", batchId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const commit = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      const { error: stateError } = await supabase
        .from("import_batches")
        .update({ state: "AWAITING_CONFIRMATION" })
        .eq("id", batchId);
      if (stateError) throw new Error(stateError.message);
      const { data, error } = await supabase.rpc("commit_import_batch", { p_batch_id: batchId });
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data[0] : data) as {
        committed_transaction_count: number;
        excluded_row_count: number;
        already_committed: boolean;
      };
    },
    onSuccess: async (result) => {
      toast.success(
        `${result.committed_transaction_count} transactions committed · ${result.excluded_row_count} rows excluded`,
      );
      await queryClient.invalidateQueries();
      await navigate({ to: "/holdings" });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /**
   * Staged rows are still just source evidence, so a row entered by mistake
   * can be removed outright. Once a row is committed it belongs to the ledger
   * and can no longer be deleted here.
   */
  const removeRow = useMutation({
    mutationFn: async (rowId: string) => {
      const { error } = await supabase.from("import_source_rows").delete().eq("id", rowId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Row removed from the batch");
      void queryClient.invalidateQueries({ queryKey: ["batch-rows", batchId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (batchQuery.isLoading || rowsQuery.isLoading)
    return <LoadingState label="Loading the batch" />;
  if (batchQuery.error) return <ErrorState error={batchQuery.error} />;
  if (rowsQuery.error) return <ErrorState error={rowsQuery.error} />;
  if (!batch) return <ErrorState error="Batch not found" />;

  const accounts = accountsQuery.data?.accounts ?? [];
  const brokers = accountsQuery.data?.brokers ?? [];
  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? "Broker";

  function setChoice(rowId: string, patch: Partial<RowChoice>) {
    setChoices((prev) => ({
      ...prev,
      [rowId]: {
        securityId: prev[rowId]?.securityId ?? null,
        brokerAccountId: prev[rowId]?.brokerAccountId ?? null,
        excluded: prev[rowId]?.excluded ?? false,
        ...patch,
      },
    }));
  }

  /** A row-level pick is the user's own decision and is never overwritten silently. */
  function setRowAccount(rowId: string, accountId: string) {
    setExplicitAccounts((prev) => ({ ...prev, [rowId]: true }));
    setChoice(rowId, { brokerAccountId: accountId });
  }

  function confirmAllSuggestions() {
    setChoices((prev) => {
      const next = { ...prev };
      for (const item of derived) {
        const only =
          item.candidates?.securities.length === 1 ? item.candidates.securities[0]! : null;
        if (!only || next[item.row.id]?.securityId) continue;
        next[item.row.id] = {
          securityId: only.id,
          brokerAccountId: next[item.row.id]?.brokerAccountId ?? null,
          excluded: next[item.row.id]?.excluded ?? false,
        };
      }
      return next;
    });
  }

  /**
   * Assigns one demat account to every row whose source broker name matches.
   * Rows the user already set by hand keep their choice unless `force` is set,
   * which only happens through the explicit re-apply confirmation.
   */
  function applyBrokerMapping(groupKey: string, accountId: string, force = false) {
    const group = brokerGroups.find((g) => g.key === groupKey);
    if (!group || !accountId) return;
    let overwritten = 0;
    setChoices((prev) => {
      const next = { ...prev };
      for (const rowId of group.rowIds) {
        const current = next[rowId];
        if (!force && explicitAccounts[rowId] && current?.brokerAccountId) continue;
        if (current?.brokerAccountId && current.brokerAccountId !== accountId) overwritten += 1;
        next[rowId] = {
          securityId: current?.securityId ?? null,
          brokerAccountId: accountId,
          excluded: current?.excluded ?? false,
        };
      }
      return next;
    });
    toast.success(
      `${group.rowIds.length} rows from ${group.label} mapped` +
        (overwritten > 0 ? ` · ${overwritten} previous choices replaced` : ""),
    );
  }

  /** Sets aside every row that is not complete, so the rest can be committed. */
  function excludeBlocked() {
    setChoices((prev) => {
      const next = { ...prev };
      for (const item of derived) {
        if (item.choice.excluded || item.verdict.ready) continue;
        next[item.row.id] = {
          securityId: next[item.row.id]?.securityId ?? null,
          brokerAccountId: next[item.row.id]?.brokerAccountId ?? null,
          excluded: true,
        };
      }
      return next;
    });
  }

  return (
    <>
      <PageHeader
        title={batch.original_filename}
        description={`${batch.total_source_rows ?? rows.length} source rows · state ${batch.state}. Every security match is a suggestion until you confirm it.`}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/import">All batches</Link>
          </Button>
        }
      />

      {isCommitted ? (
        <>
          <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-400">
            This batch is committed. Its interpretation is now frozen.
          </div>
          <Reconciliation batchId={batchId} portfolioId={batch.portfolio_id} />
        </>
      ) : null}

      <section className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Included" value={includedRows.length} />
        <Stat label="Ready to commit" value={readyCount} />
        <Stat label="Blocked" value={blockedCount} />
        <Stat label="Excluded" value={derived.length - includedRows.length} />
      </section>

      {!isCommitted ? (
        <section className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
          <div className="w-40 space-y-1.5">
            <Label htmlFor="currency">Currency if absent</Label>
            <Input
              id="currency"
              maxLength={3}
              placeholder="INR"
              value={declaredCurrency}
              onChange={(e) => setDeclaredCurrency(e.target.value.toUpperCase())}
            />
          </div>
          <Button variant="outline" onClick={confirmAllSuggestions}>
            Confirm all single suggestions
          </Button>
          <Button variant="outline" onClick={excludeBlocked} disabled={blockedCount === 0}>
            Exclude {blockedCount} incomplete rows
          </Button>
          <Button variant="ghost" onClick={() => setShowAccounts((v) => !v)}>
            {showAccounts ? "Hide" : "Add"} broker account
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save review"}
            </Button>
            <Button
              onClick={() => commit.mutate()}
              disabled={commit.isPending || readyCount === 0 || blockedCount > 0}
            >
              {commit.isPending ? "Committing…" : `Commit ${readyCount} rows`}
            </Button>
          </div>
          {blockedCount > 0 ? (
            <p className="w-full text-xs text-muted-foreground">
              Every included row must be complete before committing. Resolve or exclude the{" "}
              {blockedCount} blocked rows.
              {awaitingDateSupport > 0
                ? ` ${awaitingDateSupport} of them are complete apart from a date the source never stated; they can be committed once the missing-date update is deployed.`
                : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      {!isCommitted ? (
        <section className="mb-4 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Broker names in this file</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Each broker name found in the file is listed once. Choose which of your accounts it
            belongs to; only the matching rows are assigned. Rows you set by hand keep your choice
            unless you use “Re-apply”.
          </p>
          <div className="mt-3 space-y-2">
            {brokerGroups.map((group) => {
              const assigned = group.rowIds.filter((id) => choices[id]?.brokerAccountId).length;
              return (
                <div key={group.key} className="flex flex-wrap items-center gap-3">
                  <span className="w-52 truncate text-sm text-foreground">
                    {group.label}
                    {group.key === BLANK_BROKER ? (
                      <StatusBadge tone="warn" className="ml-2">
                        not stated
                      </StatusBadge>
                    ) : null}
                  </span>
                  <span className="w-28 font-mono text-[11px] text-muted-foreground">
                    {assigned}/{group.rowIds.length} set
                  </span>
                  <Select
                    value={brokerMap[group.key] ?? ""}
                    onValueChange={(value) => {
                      setBrokerMap((prev) => ({ ...prev, [group.key]: value }));
                      applyBrokerMapping(group.key, value);
                    }}
                  >
                    <SelectTrigger className="h-8 w-[240px]">
                      <SelectValue placeholder="Choose account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.nickname} · {brokerName(account.broker_id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!brokerMap[group.key]}
                    onClick={() => {
                      const accountId = brokerMap[group.key];
                      if (!accountId) return;
                      if (
                        window.confirm(
                          `Replace the account on all ${group.rowIds.length} rows from ${group.label}, including rows you set by hand?`,
                        )
                      ) {
                        applyBrokerMapping(group.key, accountId, true);
                      }
                    }}
                  >
                    Re-apply to all
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {showAccounts ? (
        <div className="mb-4">
          <BrokerAccountsPanel compact />
        </div>
      ) : null}

      {matchesQuery.isLoading ? <LoadingState label="Matching securities" /> : null}
      {matchesQuery.error ? <ErrorState error={matchesQuery.error} /> : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5">#</th>
              <th className="px-3 py-2.5">Source</th>
              <th className="px-3 py-2.5">Interpreted</th>
              <th className="px-3 py-2.5">Security</th>
              <th className="px-3 py-2.5">Account</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {derived.map((item) => {
              const { row, choice, candidates, txnType, tradeDate, quantity, verdict } = item;
              const chosen = candidates?.securities.find((s) => s.id === choice.securityId) ?? null;
              return (
                <tr key={row.id} className={choice.excluded ? "opacity-50" : undefined}>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {row.source_row_number}
                  </td>
                  <td className="max-w-[220px] px-3 py-3">
                    <p className="truncate text-xs text-foreground">
                      {row.raw_security_text ?? "—"}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {row.raw_isin ?? "no ISIN"} · {row.raw_exchange ?? "no exchange"}
                    </p>
                  </td>
                  <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
                    <div>{txnType ?? "type?"}</div>
                    <div>{tradeDate ?? "date?"}</div>
                    <div>{quantity ?? "qty?"}</div>
                  </td>
                  <td className="px-3 py-3">
                    {isCommitted ? (
                      <span className="font-mono text-[11px]">{chosen?.name ?? "—"}</span>
                    ) : candidates && candidates.securities.length > 0 ? (
                      <div className="space-y-1">
                        <Select
                          value={choice.securityId ?? ""}
                          onValueChange={(value) => setChoice(row.id, { securityId: value })}
                        >
                          <SelectTrigger className="h-8 w-[260px]">
                            <SelectValue placeholder="Confirm a match" />
                          </SelectTrigger>
                          <SelectContent>
                            {candidates.securities.map((security: Security) => (
                              <SelectItem key={security.id} value={security.id}>
                                {security.name} · {security.exchange ?? "—"}:
                                {security.primary_symbol ?? "—"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <StatusBadge tone={choice.securityId ? "ok" : "info"}>
                          {choice.securityId
                            ? "confirmed"
                            : `suggested · ${candidates.basis ?? "match"}`}
                        </StatusBadge>
                      </div>
                    ) : (
                      <StatusBadge tone="warn">no master match</StatusBadge>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {isCommitted ? (
                      <span className="font-mono text-[11px]">
                        {accounts.find((a) => a.id === choice.brokerAccountId)?.nickname ?? "—"}
                      </span>
                    ) : (
                      <Select
                        value={choice.brokerAccountId ?? ""}
                        onValueChange={(value) => setRowAccount(row.id, value)}
                      >
                        <SelectTrigger className="h-8 w-[190px]">
                          <SelectValue placeholder="Choose account" />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.nickname} · {brokerName(account.broker_id)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {choice.excluded ? (
                      <StatusBadge tone="neutral">excluded</StatusBadge>
                    ) : verdict.ready ? (
                      <div className="space-y-1">
                        <StatusBadge tone="ok">ready</StatusBadge>
                        {verdict.issues.includes("MISSING_DATE") ? (
                          <StatusBadge tone="warn">date unknown · kept empty</StatusBadge>
                        ) : null}
                      </div>
                    ) : verdict.missingDateOnly ? (
                      <div className="space-y-1">
                        <StatusBadge tone="warn">waiting on missing-date support</StatusBadge>
                        <p className="max-w-[240px] text-[11px] text-muted-foreground">
                          Everything else is complete. The source never stated a date, so this row
                          can only be committed after the missing-date update is deployed.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <IssueBadges issues={verdict.issues} />
                        <p className="max-w-[240px] text-[11px] text-muted-foreground">
                          {verdict.blockingReasons[0]}
                        </p>
                      </div>
                    )}

                    {isUnsupportedTxnType(txnType) ? (
                      <StatusBadge tone="bad" className="mt-1">
                        corporate action not interpreted
                      </StatusBadge>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {!isCommitted && row.resolution !== "COMMITTED" ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setChoice(row.id, { excluded: !choice.excluded })}
                        >
                          {choice.excluded ? "Include" : "Exclude"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={removeRow.isPending}
                          onClick={() => removeRow.mutate(row.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl text-foreground">{value}</p>
    </div>
  );
}

/**
 * Compares the holdings sheet that came with the workbook against the units
 * actually derived from the committed ledger. The sheet is never treated as a
 * fact: it is only shown side by side so differences are visible.
 */
function Reconciliation({ batchId, portfolioId }: { batchId: string; portfolioId: string }) {
  const supabase = useSupabase();
  const claims = useMemo(() => readHoldingsClaim(batchId), [batchId]);

  const holdings = useQuery({
    queryKey: ["reconcile", portfolioId, claims?.length ?? 0],
    enabled: Boolean(claims && claims.length > 0),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("current_holdings")
        .select("*")
        .eq("portfolio_id", portfolioId);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as CurrentHolding[];
      const bySecurity = new Map<string, CurrentHolding>();
      for (const row of rows) bySecurity.set(row.security_id, row);

      // The sheet's ticker text is resolved through the same deterministic
      // identity rules the import uses (exact ISIN, exact exchange+symbol,
      // exact supported alias). Nothing is matched loosely.
      const inputs = (claims ?? []).map((claim) => ({
        isin: null,
        exchange: null,
        securityText: claim.ticker,
      }));
      const index = await buildMasterIndex(supabase, inputs);
      const resolved = (claims ?? []).map((claim, i) => {
        const candidates = resolveCandidates(index, inputs[i]!);
        const unique = candidates.securities.length === 1 ? candidates.securities[0]! : null;
        return {
          ticker: claim.ticker,
          netUnits: claim.netUnits,
          security: unique,
          ambiguous: candidates.securities.length > 1,
          derived: unique ? (bySecurity.get(unique.id) ?? null) : null,
        };
      });
      return resolved;
    },
  });

  if (!claims || claims.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">Comparison with the holdings sheet</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The sheet's own unit counts next to the units derived from your committed transactions. The
        derived figure is the accounting truth; a difference means the sheet and the ledger
        disagree.
      </p>
      {holdings.isLoading ? <LoadingState label="Comparing" /> : null}
      {holdings.error ? <ErrorState error={holdings.error} /> : null}
      {holdings.data ? (
        <div className="mt-3 max-h-80 overflow-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/60 text-left font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Matched security</th>
                <th className="px-3 py-2 text-right">Sheet units</th>
                <th className="px-3 py-2 text-right">Derived units</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {holdings.data.map((entry) => {
                const derivedValue = entry.derived?.net_quantity ?? null;
                const same =
                  entry.netUnits !== null &&
                  derivedValue !== null &&
                  Number(entry.netUnits) === Number(derivedValue);
                return (
                  <tr key={entry.ticker}>
                    <td className="px-3 py-1.5 font-mono">{entry.ticker}</td>
                    <td className="px-3 py-1.5">
                      {entry.security ? (
                        <span className="font-mono text-[11px]">{entry.security.name}</span>
                      ) : entry.ambiguous ? (
                        <StatusBadge tone="warn">ambiguous ticker</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">no unique match</StatusBadge>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{entry.netUnits ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {derivedValue ?? "UNAVAILABLE"}
                    </td>
                    <td className="px-3 py-1.5">
                      {!entry.security ? (
                        <StatusBadge tone="neutral">not compared</StatusBadge>
                      ) : derivedValue === null ? (
                        <StatusBadge tone="neutral">not derived</StatusBadge>
                      ) : same ? (
                        <StatusBadge tone="ok">matches</StatusBadge>
                      ) : (
                        <StatusBadge tone="bad">differs</StatusBadge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
