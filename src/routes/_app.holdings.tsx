import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  LoadingState,
  PageHeader,
  StatusBadge,
  Unavailable,
} from "@/components/state";
import { chunks } from "@/lib/security-resolution";
import type {
  CurrentHolding,
  PortfolioRole,
  PortfolioSecuritySetting,
  Security,
} from "@/lib/types";
import { PORTFOLIO_ROLES } from "@/lib/types";
import { useAuth, useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/holdings")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Holdings — PortfolioAI" },
      {
        name: "description",
        content: "Holdings derived from your committed transactions, with data-quality disclosure.",
      },
      { property: "og:title", content: "Holdings — PortfolioAI" },
      {
        property: "og:description",
        content: "Holdings derived from your committed transactions, with data-quality disclosure.",
      },
    ],
  }),
  component: HoldingsPage,
});

interface HoldingRow {
  holding: CurrentHolding;
  security: Security | null;
  setting: PortfolioSecuritySetting | null;
}

function HoldingsPage() {
  const supabase = useSupabase();
  const { user } = useAuth();
  const { activePortfolio } = usePortfolios();
  const queryClient = useQueryClient();
  const portfolioId = activePortfolio?.id ?? null;

  const query = useQuery({
    queryKey: ["holdings", portfolioId],
    enabled: Boolean(portfolioId),
    queryFn: async (): Promise<HoldingRow[]> => {
      const { data: holdings, error } = await supabase
        .from("current_holdings")
        .select("*")
        .eq("portfolio_id", portfolioId!);
      if (error) throw new Error(error.message);
      const list = (holdings ?? []) as CurrentHolding[];
      const ids = list.map((h) => h.security_id);

      const securities = new Map<string, Security>();
      for (const chunk of chunks(ids, 200)) {
        const { data, error: secError } = await supabase
          .from("securities")
          .select("*")
          .in("id", chunk);
        if (secError) throw new Error(secError.message);
        for (const row of (data ?? []) as Security[]) securities.set(row.id, row);
      }

      const { data: settingsData, error: settingsError } = await supabase
        .from("portfolio_security_settings")
        .select("*")
        .eq("portfolio_id", portfolioId!);
      if (settingsError) throw new Error(settingsError.message);
      const settings = new Map(
        ((settingsData ?? []) as PortfolioSecuritySetting[]).map((s) => [s.security_id, s]),
      );

      return list
        .map((holding) => ({
          holding,
          security: securities.get(holding.security_id) ?? null,
          setting: settings.get(holding.security_id) ?? null,
        }))
        .sort((a, b) => (a.security?.name ?? "").localeCompare(b.security?.name ?? ""));
    },
  });

  const setRole = useMutation({
    mutationFn: async ({
      securityId,
      role,
      existingId,
    }: {
      securityId: string;
      role: PortfolioRole;
      existingId: string | null;
    }) => {
      if (existingId) {
        const { error } = await supabase
          .from("portfolio_security_settings")
          .update({ role })
          .eq("id", existingId);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("portfolio_security_settings").insert({
          owner_id: user!.id,
          portfolio_id: portfolioId,
          security_id: securityId,
          role,
        });
        if (error) throw new Error(error.message);
      }
    },
    onSuccess: () => {
      toast.success("Role saved");
      void queryClient.invalidateQueries({ queryKey: ["holdings", portfolioId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", portfolioId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!activePortfolio) {
    return (
      <>
        <PageHeader title="Holdings" />
        <EmptyState title="No portfolio selected" description="Create a portfolio in Settings first." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Holdings"
        description="Derived from active transactions only. Quantities are ledger quantities: no cost basis, market price, valuation, weight or profit and loss is calculated in this milestone."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/import">Import transactions</Link>
          </Button>
        }
      />

      {query.isLoading ? <LoadingState label="Deriving holdings" /> : null}
      {query.error ? <ErrorState error={query.error} /> : null}

      {query.data && query.data.length === 0 ? (
        <EmptyState
          title="No holdings yet"
          description="Holdings appear once transactions are committed through an import. Fully closed positions are intentionally not listed."
          action={
            <Button asChild size="sm">
              <Link to="/import">Start an import</Link>
            </Button>
          }
        />
      ) : null}

      {query.data && query.data.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Security</th>
                <th className="px-4 py-2.5">Listing</th>
                <th className="px-4 py-2.5 text-right">Net quantity</th>
                <th className="px-4 py-2.5 text-right">Txns</th>
                <th className="px-4 py-2.5">Dates</th>
                <th className="px-4 py-2.5">Flags</th>
                <th className="px-4 py-2.5">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {query.data.map(({ holding, security, setting }) => {
                // PostgREST may deserialize PostgreSQL numeric/count values as
                // either JSON numbers or strings depending on the value/type.
                // Treat both safely at the render boundary instead of assuming
                // the TypeScript declaration controls runtime JSON shapes.
                const quantity = holding.net_quantity as unknown as string | number | null;
                const numeric = quantity === null ? null : Number(quantity);
                const activeTxnCount = Number(holding.active_txn_count ?? 0);
                const unhandledTxnCount = Number(holding.unhandled_txn_count ?? 0);
                const missingQuantityCount = Number(holding.missing_quantity_count ?? 0);
                const nonValidTxnCount = Number(holding.non_valid_txn_count ?? 0);

                return (
                  <tr key={holding.security_id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">
                        {security?.name ?? "Unknown security"}
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {security?.isin ?? "no ISIN"} · {security?.asset_class ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {security?.exchange && security?.primary_symbol
                        ? `${security.exchange}:${security.primary_symbol}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {quantity === null ? (
                        <Unavailable reason="Some transactions for this holding are not yet interpretable, so no quantity can be stated." />
                      ) : (
                        <span className={numeric !== null && numeric < 0 ? "text-destructive" : undefined}>
                          {trimNumber(quantity)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {activeTxnCount}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {holding.first_trade_date ?? "—"} → {holding.last_trade_date ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {quantity === null ? (
                          <StatusBadge tone="warn">Insufficient data</StatusBadge>
                        ) : null}
                        {numeric !== null && numeric < 0 ? (
                          <StatusBadge tone="bad">Negative</StatusBadge>
                        ) : null}
                        {unhandledTxnCount > 0 ? (
                          <StatusBadge tone="warn">
                            {unhandledTxnCount} unhandled
                          </StatusBadge>
                        ) : null}
                        {missingQuantityCount > 0 ? (
                          <StatusBadge tone="warn">
                            {missingQuantityCount} missing qty
                          </StatusBadge>
                        ) : null}
                        {nonValidTxnCount > 0 ? (
                          <StatusBadge tone="warn">
                            {nonValidTxnCount} not valid
                          </StatusBadge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={setting?.role ?? "UNASSIGNED"}
                        onValueChange={(role) =>
                          setRole.mutate({
                            securityId: holding.security_id,
                            role: role as PortfolioRole,
                            existingId: setting?.id ?? null,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-[150px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PORTFOLIO_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function trimNumber(value: string | number): string {
  const text = String(value);
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
