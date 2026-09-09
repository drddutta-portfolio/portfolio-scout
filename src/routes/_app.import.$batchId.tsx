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
import {
  ErrorState,
  IssueBadges,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "@/components/state";
import { BrokerAccountsPanel } from "@/routes/_app.settings";
import {
  evaluateRow,
  fingerprint,
  isUnsupportedTxnType,
  parseSourceDate,
  parseSourceNumber,
  parseTxnType,
} from "@/lib/import-logic";
import {
  buildMasterIndex,
  chunks,
  resolveCandidates,
  type Candidates,
} from "@/lib/security-resolution";
import type { Broker, BrokerAccount, ImportBatch, ImportSourceRow, Security } from "@/lib/types";
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

function BatchPage() {
  const { batchId } = Route.useParams();
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [declaredCurrency, setDeclaredCurrency] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);

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
      const verdict = evaluateRow({
        securityResolved: Boolean(choice.securityId),
        securityAmbiguous: (candidates?.securities.length ?? 0) > 1 && !choice.securityId,
        brokerAccountId: choice.brokerAccountId,
        brokerTextPresent: Boolean(row.raw_broker_text),
        txnType,
        tradeDate,
        quantity,
        currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      });
      return { row, choice, candidates, txnType, tradeDate, quantity, currency, verdict };
    });
  }, [rows, choices, matchesQuery.data, declaredCurrency]);

  const includedRows = derived.filter((item) => !item.choice.excluded);
  const readyCount = includedRows.filter((item) => item.verdict.ready).length;
  const blockedCount = includedRows.length - readyCount;
  const batch = batchQuery.data;
  const isCommitted = batch?.state === "COMMITTED";

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
            const payload = choice.excluded
              ? {
                  ...base,
                  resolution: "EXCLUDED",
                  data_quality_state: verdict.ready ? "VALID" : verdict.dataQualityState,
                  data_quality_issues: verdict.ready ? [] : verdict.issues,
                }
              : verdict.ready
                ? {
                    ...base,
                    resolution: "RESOLVED",
                    data_quality_state: "VALID",
                    data_quality_issues: [],
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

  if (batchQuery.isLoading || rowsQuery.isLoading) return <LoadingState label="Loading the batch" />;
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

  function applyAccountToAll(accountId: string) {
    setChoices((prev) => {
      const next = { ...prev };
      for (const item of derived) {
        next[item.row.id] = {
          securityId: next[item.row.id]?.securityId ?? null,
          brokerAccountId: accountId,
          excluded: next[item.row.id]?.excluded ?? false,
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
        <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-400">
          This batch is committed. Its interpretation is now frozen.
        </div>
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
          <div className="w-52 space-y-1.5">
            <Label>Apply one account to all</Label>
            <Select onValueChange={applyAccountToAll}>
              <SelectTrigger>
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
          </div>
          <Button variant="outline" onClick={confirmAllSuggestions}>
            Confirm all single suggestions
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
            </p>
          ) : null}
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
                        onValueChange={(value) => setChoice(row.id, { brokerAccountId: value })}
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
                      <StatusBadge tone="ok">ready</StatusBadge>
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
                    {!isCommitted ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setChoice(row.id, { excluded: !choice.excluded })}
                      >
                        {choice.excluded ? "Include" : "Exclude"}
                      </Button>
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
