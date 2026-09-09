import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/state";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";
import type { CurrentHolding, ImportBatch, PortfolioSecuritySetting } from "@/lib/types";
import { PORTFOLIO_ROLES } from "@/lib/types";

export const Route = createFileRoute("/_app/dashboard")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Dashboard — PortfolioAI" },
      { name: "description", content: "Structural and data-quality overview of your portfolio records." },
      { property: "og:title", content: "Dashboard — PortfolioAI" },
      { property: "og:description", content: "Structural and data-quality overview of your portfolio records." },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const supabase = useSupabase();
  const { activePortfolio, isLoading: portfoliosLoading } = usePortfolios();
  const portfolioId = activePortfolio?.id ?? null;

  const query = useQuery({
    queryKey: ["dashboard", portfolioId],
    enabled: Boolean(portfolioId),
    queryFn: async () => {
      const [holdings, settings, batches] = await Promise.all([
        supabase.from("current_holdings").select("*").eq("portfolio_id", portfolioId!),
        supabase
          .from("portfolio_security_settings")
          .select("security_id, role")
          .eq("portfolio_id", portfolioId!),
        supabase
          .from("import_batches")
          .select("*")
          .eq("portfolio_id", portfolioId!)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      if (holdings.error) throw new Error(holdings.error.message);
      if (settings.error) throw new Error(settings.error.message);
      if (batches.error) throw new Error(batches.error.message);
      return {
        holdings: (holdings.data ?? []) as CurrentHolding[],
        settings: (settings.data ?? []) as Pick<PortfolioSecuritySetting, "security_id" | "role">[],
        batches: (batches.data ?? []) as ImportBatch[],
      };
    },
  });

  if (portfoliosLoading) return <LoadingState label="Loading portfolios" />;
  if (!activePortfolio) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="No portfolio yet"
          description="Create your first portfolio in Settings, then import your transaction history."
          action={
            <Button asChild size="sm">
              <Link to="/settings">Open settings</Link>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${activePortfolio.name} · structural and data-quality view only. No prices, valuation or profit and loss exist in this milestone.`}
        actions={
          <Button asChild size="sm">
            <Link to="/import">Import transactions</Link>
          </Button>
        }
      />

      {query.isLoading ? <LoadingState label="Reading your records" /> : null}
      {query.error ? <ErrorState error={query.error} /> : null}

      {query.data ? <DashboardBody data={query.data} /> : null}
    </>
  );
}

function DashboardBody({
  data,
}: {
  data: {
    holdings: CurrentHolding[];
    settings: Pick<PortfolioSecuritySetting, "security_id" | "role">[];
    batches: ImportBatch[];
  };
}) {
  const { holdings, settings, batches } = data;
  const roleFor = new Map(settings.map((s) => [s.security_id, s.role]));

  const roleCounts = PORTFOLIO_ROLES.map((role) => ({
    role,
    count: holdings.filter((h) => (roleFor.get(h.security_id) ?? "UNASSIGNED") === role).length,
  }));

  const indeterminate = holdings.filter((h) => h.net_quantity === null).length;
  const negative = holdings.filter(
    (h) => h.net_quantity !== null && Number(h.net_quantity) < 0,
  ).length;
  const unhandled = holdings.filter((h) => h.unhandled_txn_count > 0).length;
  const nonValid = holdings.filter((h) => h.non_valid_txn_count > 0).length;

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Holdings" value={holdings.length} hint="Derived from active transactions" />
        <Metric
          label="Indeterminate quantity"
          value={indeterminate}
          hint="Quantity unavailable, never treated as zero"
          tone={indeterminate > 0 ? "warn" : "ok"}
        />
        <Metric
          label="Negative quantity"
          value={negative}
          hint="Kept visible for review"
          tone={negative > 0 ? "bad" : "ok"}
        />
        <Metric
          label="Unhandled transactions"
          value={unhandled}
          hint="Splits, reversals and adjustments are not interpreted yet"
          tone={unhandled > 0 ? "warn" : "ok"}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Portfolio roles</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Counts of holdings by assigned role. Core target is a number of stocks, never a
            percentage.
          </p>
          <ul className="mt-4 space-y-2">
            {roleCounts.map(({ role, count }) => (
              <li key={role} className="flex items-center justify-between text-sm">
                <StatusBadge tone={role === "UNASSIGNED" ? "neutral" : "info"}>{role}</StatusBadge>
                <span className="font-mono">{count}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Recent imports</h2>
          {batches.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No import batch yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {batches.map((batch) => (
                <li key={batch.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link
                    to="/import/$batchId"
                    params={{ batchId: batch.id }}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {batch.original_filename}
                  </Link>
                  <StatusBadge tone={batch.state === "COMMITTED" ? "ok" : "info"}>
                    {batch.state}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Rows with issues: {nonValid} holdings include at least one transaction that is not
            marked valid.
          </p>
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: number;
  hint: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        {tone !== "neutral" ? <StatusBadge tone={tone}>{tone}</StatusBadge> : null}
      </div>
      <p className="mt-2 font-mono text-2xl text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
