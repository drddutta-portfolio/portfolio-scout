import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

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
import type { Security, Transaction } from "@/lib/types";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/transactions")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Transactions — PortfolioAI" },
      {
        name: "description",
        content:
          "Every committed transaction in your portfolio, with its source, state and data quality.",
      },
      { property: "og:title", content: "Transactions — PortfolioAI" },
      {
        property: "og:description",
        content:
          "Every committed transaction in your portfolio, with its source, state and data quality.",
      },
    ],
  }),
  component: TransactionsPage,
});

const ALL = "__all__";

function TransactionsPage() {
  const supabase = useSupabase();
  const { activePortfolio } = usePortfolios();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [stateFilter, setStateFilter] = useState<string>(ALL);

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
          .select("id,symbol,name")
          .in("id", ids);
        if (secError) throw new Error(secError.message);
        names = new Map(
          ((secs ?? []) as Pick<Security, "id" | "symbol" | "name">[]).map((s) => [
            s.id,
            s.symbol ? `${s.symbol} · ${s.name}` : s.name,
          ]),
        );
      }
      return { txns, names };
    },
  });

  const filtered = useMemo(() => {
    const txns = query.data?.txns ?? [];
    const names = query.data?.names;
    const needle = search.trim().toLowerCase();
    return txns.filter((txn) => {
      if (typeFilter !== ALL && txn.txn_type !== typeFilter) return false;
      if (stateFilter !== ALL && txn.txn_state !== stateFilter) return false;
      if (!needle) return true;
      const label = names?.get(txn.security_id) ?? "";
      return label.toLowerCase().includes(needle);
    });
  }, [query.data, search, typeFilter, stateFilter]);

  if (!activePortfolio) {
    return (
      <>
        <PageHeader title="Transactions" />
        <EmptyState
          title="No portfolio selected"
          description="Create a portfolio in Settings first."
          action={
            <Button asChild size="sm">
              <Link to="/settings">Open settings</Link>
            </Button>
          }
        />
      </>
    );
  }

  const types = Array.from(new Set((query.data?.txns ?? []).map((t) => t.txn_type))).sort();
  const states = Array.from(new Set((query.data?.txns ?? []).map((t) => t.txn_state))).sort();

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every finalised transaction, exactly as it was recorded. Blank cells mean the source did not state a value — nothing is filled in for you."
        actions={
          <Button asChild size="sm">
            <Link to="/import">Add or import trades</Link>
          </Button>
        }
      />

      <div className="mb-4 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        A finalised transaction cannot be changed or removed here: the record is what your accounting
        is built on. Corrections and reversals need a reviewed change to the accounting rules, which
        is not available yet. Until then, fix mistakes while they are still in a staged import — a
        staged row can be edited, excluded or deleted on its review page.
      </div>

      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-64 space-y-1.5">
          <Label htmlFor="txn-search">Search security</Label>
          <Input
            id="txn-search"
            value={search}
            placeholder="Ticker or name"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-44 space-y-1.5">
          <Label>Type</Label>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {types.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44 space-y-1.5">
          <Label>State</Label>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All states</SelectItem>
              {states.map((state) => (
                <SelectItem key={state} value={state}>
                  {state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="ml-auto font-mono text-xs text-muted-foreground">
          {filtered.length} of {query.data?.txns.length ?? 0} shown
        </p>
      </section>

      {query.isLoading ? <LoadingState label="Loading transactions" /> : null}
      {query.error ? <ErrorState error={query.error} /> : null}
      {query.data && query.data.txns.length === 0 ? (
        <EmptyState
          title="No transactions yet"
          description="Import a statement or add a trade manually to get started."
          action={
            <Button asChild size="sm">
              <Link to="/import">Go to import</Link>
            </Button>
          }
        />
      ) : null}

      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Security</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5 text-right">Quantity</th>
                <th className="px-3 py-2.5 text-right">Unit price</th>
                <th className="px-3 py-2.5 text-right">Charges</th>
                <th className="px-3 py-2.5">Currency</th>
                <th className="px-3 py-2.5">Quality</th>
                <th className="px-3 py-2.5">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((txn) => (
                <tr key={txn.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono">
                    {txn.trade_date ?? <span className="text-muted-foreground">no date</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {query.data?.names.get(txn.security_id) ?? txn.security_id}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{txn.txn_type}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{txn.quantity}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{txn.unit_price ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{txn.total_charges ?? "—"}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{txn.currency ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    {txn.data_quality_state === "VALID" ? (
                      <StatusBadge tone="ok">valid</StatusBadge>
                    ) : (
                      <div className="space-y-1">
                        <StatusBadge tone="warn">
                          {txn.data_quality_state.toLowerCase()}
                        </StatusBadge>
                        <IssueBadges issues={txn.data_quality_issues ?? []} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge tone={txn.txn_state === "ACTIVE" ? "ok" : "neutral"}>
                      {txn.txn_state.toLowerCase()}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
