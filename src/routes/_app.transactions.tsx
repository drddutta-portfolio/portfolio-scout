import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
  EmptyState,
  ErrorState,
  IssueBadges,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "@/components/state";
import type { Broker, BrokerAccount, Security, Transaction } from "@/lib/types";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/transactions")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Transactions — PortfolioAI" },
      { name: "description", content: "Committed portfolio transactions with source state and data quality." },
      { property: "og:title", content: "Transactions — PortfolioAI" },
      { property: "og:description", content: "Committed portfolio transactions with source state and data quality." },
    ],
  }),
  component: TransactionsPage,
});

const ALL = "__all__";
const QUALITY_ALL = "__quality_all__";
const QUALITY_MISSING_BROKER = "__missing_broker__";

function TransactionsPage() {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  const { activePortfolio } = usePortfolios();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [stateFilter, setStateFilter] = useState<string>(ALL);
  const [qualityFilter, setQualityFilter] = useState<string>(QUALITY_ALL);
  const [repairChoices, setRepairChoices] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ["transactions", activePortfolio?.id],
    enabled: Boolean(activePortfolio),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("portfolio_id", activePortfolio!.id)
        .order("trade_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const txns = (data ?? []) as Transaction[];

      const ids = Array.from(new Set(txns.map((t) => t.security_id)));
      let names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: secs, error: secError } = await supabase
          .from("securities")
          .select("id,primary_symbol,name")
          .in("id", ids);
        if (secError) throw new Error(secError.message);
        names = new Map(
          ((secs ?? []) as Pick<Security, "id" | "primary_symbol" | "name">[]).map((s) => [
            s.id,
            s.primary_symbol ? `${s.primary_symbol} · ${s.name}` : s.name,
          ]),
        );
      }
      return { txns, names };
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

  const repairBroker = useMutation({
    mutationFn: async ({ transactionId, brokerAccountId }: { transactionId: string; brokerAccountId: string }) => {
      const { data, error } = await supabase.rpc("resolve_transaction_broker_account", {
        p_transaction_id: transactionId,
        p_broker_account_id: brokerAccountId,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: async (_, variables) => {
      toast.success("Broker account recorded and audit entry created");
      setRepairChoices((prev) => {
        const next = { ...prev };
        delete next[variables.transactionId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["transactions", activePortfolio?.id] });
      await queryClient.invalidateQueries({ queryKey: ["holdings", activePortfolio?.id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const filtered = useMemo(() => {
    const txns = query.data?.txns ?? [];
    const names = query.data?.names;
    const needle = search.trim().toLowerCase();
    return txns.filter((txn) => {
      if (typeFilter !== ALL && txn.txn_type !== typeFilter) return false;
      if (stateFilter !== ALL && txn.txn_state !== stateFilter) return false;
      if (qualityFilter === QUALITY_MISSING_BROKER && !txn.data_quality_issues.includes("MISSING_ACCOUNT")) return false;
      if (qualityFilter !== QUALITY_ALL && qualityFilter !== QUALITY_MISSING_BROKER && txn.data_quality_state !== qualityFilter) return false;
      if (!needle) return true;
      const label = names?.get(txn.security_id) ?? "";
      return label.toLowerCase().includes(needle) || (txn.source_reference ?? "").toLowerCase().includes(needle);
    });
  }, [query.data, search, typeFilter, stateFilter, qualityFilter]);

  if (!activePortfolio) {
    return (
      <>
        <PageHeader title="Transactions" />
        <EmptyState title="No portfolio selected" description="Create a portfolio in Settings first." action={<Button asChild size="sm"><Link to="/settings">Open settings</Link></Button>} />
      </>
    );
  }

  const accounts = accountsQuery.data?.accounts ?? [];
  const brokers = accountsQuery.data?.brokers ?? [];
  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? "Broker";
  const accountLabel = (id: string | null) => {
    if (!id) return "Unknown";
    const account = accounts.find((a) => a.id === id);
    return account ? `${account.nickname} · ${brokerName(account.broker_id)}` : id;
  };

  const types = Array.from(new Set((query.data?.txns ?? []).map((t) => t.txn_type))).sort();
  const states = Array.from(new Set((query.data?.txns ?? []).map((t) => t.txn_state))).sort();
  const missingBrokerCount = (query.data?.txns ?? []).filter((t) => t.broker_account_id === null && t.data_quality_issues.includes("MISSING_ACCOUNT")).length;

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Committed accounting records. Missing source facts stay visible; known facts are never silently rewritten."
        actions={<Button asChild size="sm"><Link to="/import">Add or import trades</Link></Button>}
      />

      <div className="mb-4 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        Finalised economic/source fields remain immutable. M11 permits one trusted repair only: filling a broker account that was genuinely unknown at import time. That repair removes only MISSING_BROKER/MISSING_ACCOUNT and writes an audit record. A known broker cannot be changed through this workflow.
      </div>

      {missingBrokerCount > 0 ? (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
          <strong className="text-foreground">{missingBrokerCount} committed transaction{missingBrokerCount === 1 ? " has" : "s have"} an unknown broker account.</strong>{" "}
          Use the Quality filter → “Missing broker/account” to resolve them later when you have reliable information.
        </div>
      ) : null}

      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-64 space-y-1.5">
          <Label htmlFor="txn-search">Search</Label>
          <Input id="txn-search" value={search} placeholder="Ticker, name or reference" onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-40 space-y-1.5">
          <Label>Type</Label>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>All types</SelectItem>{types.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="w-40 space-y-1.5">
          <Label>State</Label>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>All states</SelectItem>{states.map((state) => <SelectItem key={state} value={state}>{state}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="w-52 space-y-1.5">
          <Label>Quality</Label>
          <Select value={qualityFilter} onValueChange={setQualityFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={QUALITY_ALL}>All quality states</SelectItem>
              <SelectItem value={QUALITY_MISSING_BROKER}>Missing broker/account</SelectItem>
              <SelectItem value="VALID">Valid</SelectItem>
              <SelectItem value="INCOMPLETE">Incomplete</SelectItem>
              <SelectItem value="NEEDS_REVIEW">Needs review</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="ml-auto font-mono text-xs text-muted-foreground">{filtered.length} of {query.data?.txns.length ?? 0} shown</p>
      </section>

      {query.isLoading ? <LoadingState label="Loading transactions" /> : null}
      {query.error ? <ErrorState error={query.error} /> : null}
      {accountsQuery.error ? <ErrorState error={accountsQuery.error} /> : null}
      {query.data && query.data.txns.length === 0 ? (
        <EmptyState title="No transactions yet" description="Import a statement or add a trade manually to get started." action={<Button asChild size="sm"><Link to="/import">Go to import</Link></Button>} />
      ) : null}

      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Security</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5 text-right">Quantity</th>
                <th className="px-3 py-2.5">Broker account</th>
                <th className="px-3 py-2.5 text-right">Unit price</th>
                <th className="px-3 py-2.5">Currency</th>
                <th className="px-3 py-2.5">Quality</th>
                <th className="px-3 py-2.5">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((txn) => {
                const repairable = txn.txn_state === "ACTIVE" && txn.broker_account_id === null && txn.data_quality_issues.includes("MISSING_ACCOUNT") && txn.data_quality_issues.includes("MISSING_BROKER");
                const selectedAccount = repairChoices[txn.id] ?? "";
                return (
                  <tr key={txn.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono">{txn.trade_date ?? <span className="text-muted-foreground">no date</span>}</td>
                    <td className="px-3 py-2.5">{query.data?.names.get(txn.security_id) ?? txn.security_id}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{txn.txn_type}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{txn.quantity ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {repairable ? (
                        <div className="flex min-w-[310px] items-center gap-2">
                          <Select value={selectedAccount} onValueChange={(value) => setRepairChoices((prev) => ({ ...prev, [txn.id]: value }))}>
                            <SelectTrigger className="h-8 w-[210px]"><SelectValue placeholder="Unknown — choose later" /></SelectTrigger>
                            <SelectContent>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.nickname} · {brokerName(account.broker_id)}</SelectItem>)}</SelectContent>
                          </Select>
                          <Button size="sm" disabled={!selectedAccount || repairBroker.isPending} onClick={() => repairBroker.mutate({ transactionId: txn.id, brokerAccountId: selectedAccount })}>Save broker</Button>
                        </div>
                      ) : <span className="text-xs">{accountLabel(txn.broker_account_id)}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{txn.unit_price ?? "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{txn.currency ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {txn.data_quality_state === "VALID" ? <StatusBadge tone="ok">valid</StatusBadge> : <div className="space-y-1"><StatusBadge tone="warn">{txn.data_quality_state.toLowerCase()}</StatusBadge><IssueBadges issues={txn.data_quality_issues ?? []} /></div>}
                    </td>
                    <td className="px-3 py-2.5"><StatusBadge tone={txn.txn_state === "ACTIVE" ? "ok" : "neutral"}>{txn.txn_state.toLowerCase()}</StatusBadge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : query.data && query.data.txns.length > 0 ? <p className="text-sm text-muted-foreground">No transactions match the current filters.</p> : null}
    </>
  );
}
