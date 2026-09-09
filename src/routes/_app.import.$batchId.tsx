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

type RowFilter = "ALL" | "MISSING_BROKER" | "MISSING_ACCOUNT" | "MISSING_DATE" | "BLOCKED" | "READY";

/** Migration 10 is deployed; vite.config.ts permanently enables this capability. */
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
  const [explicitAccounts, setExplicitAccounts] = useState<Record<string, true>>({});
  const [brokerMap, setBrokerMap] = useState<Record<string, string>>({});
  const [rowFilter, setRowFilter] = useState<RowFilter>("ALL");
  const [rowSearch, setRowSearch] = useState("");
  const [selectedRows, setSelectedRows] = useState<Record<string, true>>({});
  const [bulkAccountId, setBulkAccountId] = useState("");

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
        supabase.from("brokers").select("*").eq("is_active", true),
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
      // Empty strings from old staging rows must not suppress the user's explicit
      // batch-level currency declaration. Missing still stays missing until the
      // user types a currency in the review UI.
      const rawCurrency = row.raw_currency?.trim().toUpperCase() ?? "";
      const currency = rawCurrency || declaredCurrency.trim().toUpperCase() || null;
      const verdict = evaluateRow(
        {
          securityResolved: Boolean(choice.securityId),
          securityAmbiguous: (candidates?.securities.length ?? 0) > 1 && !choice.securityId,
          brokerAccountId: choice.brokerAccountId,
          brokerTextPresent: Boolean(row.raw_broker_text?.trim()),
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
  const awaitingDateSupport = ALLOW_MISSING_DATE
    ? 0
    : includedRows.filter((item) => !item.verdict.ready && item.verdict.missingDateOnly).length;
  const batch = batchQuery.data;
  const isCommitted = batch?.state === "COMMITTED";

  const accounts = accountsQuery.data?.accounts ?? [];
  const brokers = accountsQuery.data?.brokers ?? [];
  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? "Broker";

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

  const namedBrokerGroups = brokerGroups.filter((group) => group.key !== BLANK_BROKER);
  const blankBrokerGroup = brokerGroups.find((group) => group.key === BLANK_BROKER) ?? null;

  const visibleRows = useMemo(() => {
    const search = rowSearch.trim().toUpperCase();
    return derived.filter((item) => {
      const haystack = [
        item.row.raw_security_text,
        item.row.raw_isin,
        item.row.raw_broker_text,
        item.row.raw_source_reference,
      ]
        .filter(Boolean)
        .join(" ")
        .toUpperCase();
      if (search && !haystack.includes(search)) return false;
      if (rowFilter === "MISSING_BROKER") return !item.row.raw_broker_text?.trim() && !item.choice.brokerAccountId;
      if (rowFilter === "MISSING_ACCOUNT") return !item.choice.brokerAccountId;
      if (rowFilter === "MISSING_DATE") return !item.tradeDate;
      if (rowFilter === "BLOCKED") return !item.choice.excluded && !item.verdict.ready;
      if (rowFilter === "READY") return !item.choice.excluded && item.verdict.ready;
      return true;
    });
  }, [derived, rowFilter, rowSearch]);

  const selectableVisibleIds = visibleRows
    .filter((item) => !isCommitted && item.row.resolution !== "COMMITTED")
    .map((item) => item.row.id);
  const selectedCount = Object.keys(selectedRows).length;

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
                ? { ...base, resolution: "RESOLVED", ...resolvedQuality }
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

  const removeRow = useMutation({
    mutationFn: async (rowId: string) => {
      const { error } = await supabase.from("import_source_rows").delete().eq("id", rowId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Manual staging row removed");
      void queryClient.invalidateQueries({ queryKey: ["batch-rows", batchId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (batchQuery.isLoading || rowsQuery.isLoading) return <LoadingState label="Loading the batch" />;
  if (batchQuery.error) return <ErrorState error={batchQuery.error} />;
  if (rowsQuery.error) return <ErrorState error={rowsQuery.error} />;
  if (!batch) return <ErrorState error="Batch not found" />;

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

  function setRowAccount(rowId: string, accountId: string) {
    setExplicitAccounts((prev) => ({ ...prev, [rowId]: true }));
    setChoice(rowId, { brokerAccountId: accountId });
  }

  function confirmAllSuggestions() {
    setChoices((prev) => {
      const next = { ...prev };
      for (const item of derived) {
        const only = item.candidates?.securities.length === 1 ? item.candidates.securities[0]! : null;
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

  function applyBrokerMapping(groupKey: string, accountId: string, force = false) {
    const group = namedBrokerGroups.find((g) => g.key === groupKey);
    if (!group || !accountId) return;
    let changed = 0;
    let preserved = 0;
    setChoices((prev) => {
      const next = { ...prev };
      for (const rowId of group.rowIds) {
        const current = next[rowId];
        if (!force && current?.brokerAccountId) {
          preserved += 1;
          continue;
        }
        if (current?.brokerAccountId !== accountId) changed += 1;
        next[rowId] = {
          securityId: current?.securityId ?? null,
          brokerAccountId: accountId,
          excluded: current?.excluded ?? false,
        };
      }
      return next;
    });
    toast.success(
      `${changed} rows from ${group.label} mapped` +
        (preserved > 0 ? ` · ${preserved} existing row choices preserved` : ""),
    );
  }

  function selectAllVisible() {
    const next: Record<string, true> = {};
    for (const id of selectableVisibleIds) next[id] = true;
    setSelectedRows(next);
  }

  function assignSelectedRows() {
    if (!bulkAccountId || selectedCount === 0) return;
    const selectedIds = new Set(Object.keys(selectedRows));
    setChoices((prev) => {
      const next = { ...prev };
      for (const rowId of selectedIds) {
        const current = next[rowId];
        next[rowId] = {
          securityId: current?.securityId ?? null,
          brokerAccountId: bulkAccountId,
          excluded: current?.excluded ?? false,
        };
      }
      return next;
    });
    setExplicitAccounts((prev) => {
      const next = { ...prev };
      for (const rowId of selectedIds) next[rowId] = true;
      return next;
    });
    toast.success(`${selectedCount} selected row${selectedCount === 1 ? "" : "s"} assigned`);
    setSelectedRows({});
  }

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
        description={`${batch.total_source_rows ?? rows.length} source rows · state ${batch.state}. Each transaction keeps its own broker/account; holdings are reconciled only after commit.`}
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
              Every included row must be commit-ready. Resolve or exclude the {blockedCount} blocked rows.
              {awaitingDateSupport > 0
                ? ` ${awaitingDateSupport} rows are waiting only for missing-date support.`
                : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      {!isCommitted ? (
        <section className="mb-4 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Broker names stated in the transaction sheet</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Map each source broker name to your matching demat account. The mapping is applied only to transaction rows carrying that broker name. Existing row-level choices are preserved unless you explicitly re-apply.
          </p>
          <div className="mt-3 space-y-2">
            {namedBrokerGroups.map((group) => {
              const assigned = group.rowIds.filter((id) => choices[id]?.brokerAccountId).length;
              return (
                <div key={group.key} className="flex flex-wrap items-center gap-3">
                  <span className="w-52 truncate text-sm text-foreground">{group.label}</span>
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
                          `Replace the account on all ${group.rowIds.length} rows whose source broker is ${group.label}?`,
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
          {blankBrokerGroup ? (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              <strong className="text-foreground">{blankBrokerGroup.rowIds.length} transaction rows do not state a broker.</strong>{" "}
              They are not assigned automatically because the same stock may have transactions in different demat accounts. Use the row selection workspace below to assign only the transactions you know belong to a particular account.
            </div>
          ) : null}
        </section>
      ) : null}

      {showAccounts ? (
        <div className="mb-4">
          <BrokerAccountsPanel compact />
        </div>
      ) : null}

      {!isCommitted ? (
        <section className="mb-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[210px] flex-1 space-y-1.5">
              <Label htmlFor="row-search">Find transaction</Label>
              <Input
                id="row-search"
                placeholder="Ticker, ISIN, broker or reference"
                value={rowSearch}
                onChange={(e) => setRowSearch(e.target.value)}
              />
            </div>
            <div className="w-[190px] space-y-1.5">
              <Label>Show rows</Label>
              <Select value={rowFilter} onValueChange={(value) => setRowFilter(value as RowFilter)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All rows</SelectItem>
                  <SelectItem value="MISSING_BROKER">Broker not stated + account missing</SelectItem>
                  <SelectItem value="MISSING_ACCOUNT">Account missing</SelectItem>
                  <SelectItem value="MISSING_DATE">Date missing</SelectItem>
                  <SelectItem value="BLOCKED">Blocked</SelectItem>
                  <SelectItem value="READY">Ready</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={selectAllVisible} disabled={selectableVisibleIds.length === 0}>
              Select visible ({selectableVisibleIds.length})
            </Button>
            <Button variant="ghost" onClick={() => setSelectedRows({})} disabled={selectedCount === 0}>
              Clear selection
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-background/30 p-3">
            <div className="w-[260px] space-y-1.5">
              <Label>Assign selected transactions to</Label>
              <Select value={bulkAccountId} onValueChange={setBulkAccountId}>
                <SelectTrigger><SelectValue placeholder="Choose demat account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.nickname} · {brokerName(account.broker_id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={assignSelectedRows} disabled={selectedCount === 0 || !bulkAccountId}>
              Assign {selectedCount} selected
            </Button>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Selection is transaction-level. It never assigns by ticker, so different purchases of ABCAPITAL or any other stock may correctly remain in different broker accounts.
            </p>
          </div>
        </section>
      ) : null}

      {matchesQuery.isLoading ? <LoadingState label="Matching securities" /> : null}
      {matchesQuery.error ? <ErrorState error={matchesQuery.error} /> : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              {!isCommitted ? <th className="w-10 px-3 py-2.5">Pick</th> : null}
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
            {visibleRows.map((item) => {
              const { row, choice, candidates, txnType, tradeDate, quantity, verdict } = item;
              const chosen = candidates?.securities.find((s) => s.id === choice.securityId) ?? null;
              const canSelect = row.resolution !== "COMMITTED";
              return (
                <tr key={row.id} className={choice.excluded ? "opacity-50" : undefined}>
                  {!isCommitted ? (
                    <td className="px-3 py-3 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select source row ${row.source_row_number}`}
                        disabled={!canSelect}
                        checked={Boolean(selectedRows[row.id])}
                        onChange={(e) =>
                          setSelectedRows((prev) => {
                            const next = { ...prev };
                            if (e.target.checked) next[row.id] = true;
                            else delete next[row.id];
                            return next;
                          })
                        }
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{row.source_row_number}</td>
                  <td className="max-w-[220px] px-3 py-3">
                    <p className="truncate text-xs text-foreground">{row.raw_security_text ?? "—"}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {row.raw_isin ?? "no ISIN"} · {row.raw_broker_text?.trim() || "broker not stated"}
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
                        <Select value={choice.securityId ?? ""} onValueChange={(value) => setChoice(row.id, { securityId: value })}>
                          <SelectTrigger className="h-8 w-[260px]"><SelectValue placeholder="Confirm a match" /></SelectTrigger>
                          <SelectContent>
                            {candidates.securities.map((security: Security) => (
                              <SelectItem key={security.id} value={security.id}>
                                {security.name} · {security.exchange ?? "—"}:{security.primary_symbol ?? "—"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <StatusBadge tone={choice.securityId ? "ok" : "info"}>
                          {choice.securityId ? "confirmed" : `suggested · ${candidates.basis ?? "match"}`}
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
                      <Select value={choice.brokerAccountId ?? ""} onValueChange={(value) => setRowAccount(row.id, value)}>
                        <SelectTrigger className="h-8 w-[200px]"><SelectValue placeholder="Choose account" /></SelectTrigger>
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
                        {verdict.issues.includes("MISSING_DATE") ? <StatusBadge tone="warn">date unknown · kept empty</StatusBadge> : null}
                      </div>
                    ) : verdict.missingDateOnly ? (
                      <div className="space-y-1">
                        <StatusBadge tone="warn">missing date only</StatusBadge>
                        <p className="max-w-[240px] text-[11px] text-muted-foreground">The date stays empty; M10 permits this row once every other fact is resolved.</p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <IssueBadges issues={verdict.issues} />
                        <p className="max-w-[240px] text-[11px] text-muted-foreground">{verdict.blockingReasons[0]}</p>
                      </div>
                    )}
                    {isUnsupportedTxnType(txnType) ? (
                      <StatusBadge tone="bad" className="mt-1">corporate action not interpreted</StatusBadge>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {!isCommitted && row.resolution !== "COMMITTED" ? (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setChoice(row.id, { excluded: !choice.excluded })}>
                          {choice.excluded ? "Include" : "Exclude"}
                        </Button>
                        {batch.source_format === "MANUAL" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={removeRow.isPending}
                            onClick={() => removeRow.mutate(row.id)}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visibleRows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No transactions match the current filter.</p>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl text-foreground">{value}</p>
    </div>
  );
}

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

      const inputs = (claims ?? []).map((claim) => ({
        isin: null,
        exchange: null,
        securityText: claim.ticker,
      }));
      const index = await buildMasterIndex(supabase, inputs);
      return (claims ?? []).map((claim, i) => {
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
    },
  });

  if (!claims || claims.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">Comparison with the consolidated HOLDINGS sheet</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        HOLDINGS is reconciliation evidence only. Transactions remain the accounting source of truth, and comparison is made by canonical security identity rather than raw ticker text.
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
                const same = entry.netUnits !== null && derivedValue !== null && Number(entry.netUnits) === Number(derivedValue);
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
                    <td className="px-3 py-1.5 text-right font-mono">{derivedValue ?? "UNAVAILABLE"}</td>
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
