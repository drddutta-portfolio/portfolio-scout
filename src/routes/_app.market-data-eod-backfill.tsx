import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader, StatusBadge } from "@/components/state";
import { chunks } from "@/lib/security-resolution";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/market-data-eod-backfill")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "EOD Backfill — PortfolioAI" },
      {
        name: "description",
        content: "Controlled resumable Angel One EOD OHLCV backfill for verified open portfolio holdings.",
      },
    ],
  }),
  component: MarketDataEodBackfillPage,
});

const BATCH_SIZE = 25;
const BETWEEN_BATCH_DELAY_MS = 6_000;
const RETRY_DELAY_MS = 10_000;

interface HoldingRow {
  security_id: string;
  net_quantity: string | number;
}

interface MappingRow {
  security_id: string;
  mapping_status: string;
}

interface SecurityRow {
  id: string;
  primary_symbol: string | null;
  name: string;
}

interface EligibleSecurity {
  securityId: string;
  ticker: string;
  name: string;
}

interface BackfillResult {
  runId?: string;
  requested?: number;
  fetchedSecurities?: number;
  unresolved?: number;
  failed?: number;
  candlesUpserted?: number;
  fromDate?: string;
  toDate?: string;
}

interface BatchResult extends BackfillResult {
  batchNumber: number;
  tickers: string[];
  ok: boolean;
  error?: string;
}

function MarketDataEodBackfillPage() {
  const supabase = useSupabase();
  const { activePortfolio } = usePortfolios();
  const portfolioId = activePortfolio?.id ?? null;
  const [running, setRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [currentBatch, setCurrentBatch] = useState(0);

  const dateRange = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 364);
    return { fromDate: formatIsoDate(from), toDate: formatIsoDate(to) };
  }, []);

  const progressKey = portfolioId
    ? `portfolioai:eod-backfill:${portfolioId}:${dateRange.fromDate}:${dateRange.toDate}`
    : null;

  const eligibility = useQuery({
    queryKey: ["eod-backfill-eligibility", portfolioId],
    enabled: Boolean(portfolioId),
    queryFn: async (): Promise<{ eligible: EligibleSecurity[]; openCount: number; unresolvedCount: number }> => {
      const { data: holdingsData, error: holdingsError } = await supabase
        .from("current_holdings")
        .select("security_id,net_quantity")
        .eq("portfolio_id", portfolioId!);
      if (holdingsError) throw new Error(holdingsError.message);

      const openHoldings = ((holdingsData ?? []) as HoldingRow[]).filter((row) => Number(row.net_quantity) > 0);
      const openIds = [...new Set(openHoldings.map((row) => row.security_id))];
      if (!openIds.length) return { eligible: [], openCount: 0, unresolvedCount: 0 };

      const mappings: MappingRow[] = [];
      const securities: SecurityRow[] = [];
      for (const idChunk of chunks(openIds, 200)) {
        const [mappingResult, securityResult] = await Promise.all([
          supabase
            .from("market_data_instrument_mappings")
            .select("security_id,mapping_status")
            .eq("provider_code", "ANGEL_ONE")
            .in("security_id", idChunk),
          supabase
            .from("securities")
            .select("id,primary_symbol,name")
            .in("id", idChunk),
        ]);
        if (mappingResult.error) throw new Error(mappingResult.error.message);
        if (securityResult.error) throw new Error(securityResult.error.message);
        mappings.push(...((mappingResult.data ?? []) as MappingRow[]));
        securities.push(...((securityResult.data ?? []) as SecurityRow[]));
      }

      const verifiedIds = new Set(
        mappings.filter((row) => row.mapping_status === "VERIFIED").map((row) => row.security_id),
      );
      const securityMap = new Map(securities.map((row) => [row.id, row]));
      const eligible = openIds
        .filter((id) => verifiedIds.has(id))
        .map((id) => {
          const security = securityMap.get(id);
          return {
            securityId: id,
            ticker: security?.primary_symbol ?? id.slice(0, 8),
            name: security?.name ?? "Unknown security",
          };
        })
        .sort((a, b) => a.ticker.localeCompare(b.ticker));

      return {
        eligible,
        openCount: openIds.length,
        unresolvedCount: openIds.length - eligible.length,
      };
    },
  });

  const completedIds = useMemo(() => {
    if (!progressKey || typeof window === "undefined") return new Set<string>();
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey) ?? "[]") as unknown;
      return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [progressKey, batchResults]);

  const eligible = eligibility.data?.eligible ?? [];
  const remaining = eligible.filter((item) => !completedIds.has(item.securityId));
  const plannedBatches = chunks(remaining, BATCH_SIZE);

  async function invokeBatch(batch: readonly EligibleSecurity[]) {
    if (!portfolioId) throw new Error("No active portfolio selected.");
    const { data, error } = await supabase.functions.invoke("backfill-market-eod", {
      body: {
        action: "BACKFILL_EOD",
        portfolioId,
        securityIds: batch.map((item) => item.securityId),
        fromDate: dateRange.fromDate,
        toDate: dateRange.toDate,
      },
    });

    if (error) {
      const context = (error as { context?: Response }).context;
      if (context) {
        try {
          const body = (await context.json()) as { error?: string; code?: string };
          if (body.error) throw new Error(body.code ? `${body.error} (${body.code})` : body.error);
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") throw parseError;
        }
      }
      throw new Error(error.message);
    }
    return (data ?? {}) as BackfillResult;
  }

  async function runBackfill() {
    if (!portfolioId || !progressKey || running || !remaining.length) return;
    setRunning(true);
    setBatchResults([]);
    setCurrentBatch(0);
    const persisted = new Set(completedIds);
    let stopped = false;

    try {
      for (let index = 0; index < plannedBatches.length; index += 1) {
        const batch = plannedBatches[index]!;
        setCurrentBatch(index + 1);
        let result: BackfillResult | null = null;
        let finalError: Error | null = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            result = await invokeBatch(batch);
            finalError = null;
            break;
          } catch (error) {
            finalError = error instanceof Error ? error : new Error("Historical backfill batch failed.");
            const rateLimited = /rate|cooldown|429/i.test(finalError.message);
            if (attempt === 0 && rateLimited) {
              await sleep(RETRY_DELAY_MS);
              continue;
            }
            break;
          }
        }

        if (!result) {
          setBatchResults((rows) => [
            ...rows,
            {
              batchNumber: index + 1,
              tickers: batch.map((item) => item.ticker),
              ok: false,
              error: finalError?.message ?? "Batch failed.",
            },
          ]);
          stopped = true;
          toast.error(`Backfill stopped at batch ${index + 1}. You can resume after the issue is resolved.`);
          break;
        }

        const ok =
          (result.failed ?? 0) === 0
          && (result.unresolved ?? 0) === 0
          && (result.fetchedSecurities ?? 0) === batch.length;
        setBatchResults((rows) => [
          ...rows,
          {
            ...result,
            batchNumber: index + 1,
            tickers: batch.map((item) => item.ticker),
            ok,
          },
        ]);

        if (!ok) {
          stopped = true;
          toast.error(`Backfill stopped at partial batch ${index + 1}. The batch was not marked complete.`);
          break;
        }

        for (const item of batch) persisted.add(item.securityId);
        window.localStorage.setItem(progressKey, JSON.stringify([...persisted]));

        if (index < plannedBatches.length - 1) await sleep(BETWEEN_BATCH_DELAY_MS);
      }

      if (!stopped) toast.success("Full-portfolio EOD backfill completed for all eligible holdings.");
    } finally {
      setRunning(false);
    }
  }

  function resetProgress() {
    if (!progressKey || running) return;
    window.localStorage.removeItem(progressKey);
    setBatchResults([]);
    setCurrentBatch(0);
    toast.success("EOD backfill progress reset. No stored market data was deleted.");
  }

  const totals = useMemo(
    () => ({
      candles: batchResults.reduce((sum, row) => sum + (row.candlesUpserted ?? 0), 0),
      fetched: batchResults.reduce((sum, row) => sum + (row.fetchedSecurities ?? 0), 0),
      failed: batchResults.reduce((sum, row) => sum + (row.failed ?? (row.ok ? 0 : 1)), 0),
    }),
    [batchResults],
  );

  return (
    <>
      <PageHeader
        title="Full Portfolio EOD Backfill"
        description="Resumable one-year Angel One ONE_DAY history for current open holdings with VERIFIED mappings. Data writes are limited to historical provider observations. Transactions and holdings are not modified."
      />

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Open holdings" value={String(eligibility.data?.openCount ?? 0)} />
          <Metric label="Verified eligible" value={String(eligible.length)} />
          <Metric label="Already completed" value={String(completedIds.size)} />
          <Metric label="Remaining" value={String(remaining.length)} />
          <Metric label="Planned batches" value={String(plannedBatches.length)} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">25 SECURITIES / BATCH</StatusBadge>
          <StatusBadge tone="neutral">1 YEAR · ONE_DAY</StatusBadge>
          <span className="text-xs text-muted-foreground">
            {dateRange.fromDate} → {dateRange.toDate}
          </span>
        </div>

        {eligibility.data?.unresolvedCount ? (
          <p className="mt-3 text-sm text-amber-500">
            {eligibility.data.unresolvedCount} open holding(s) are not VERIFIED for Angel One and will be excluded.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            disabled={!portfolioId || eligibility.isLoading || running || remaining.length === 0}
            onClick={() => void runBackfill()}
          >
            {running
              ? `Running batch ${currentBatch}/${plannedBatches.length}…`
              : remaining.length === 0
                ? "Backfill complete"
                : `Backfill ${remaining.length} remaining holdings`}
          </Button>
          <Button variant="outline" disabled={running || completedIds.size === 0} onClick={resetProgress}>
            Reset progress only
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Progress is saved locally after each fully successful batch. If the page closes or a batch fails, reopen this page and continue from the remaining holdings. Resetting progress does not delete any historical rows from Supabase.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Fetched this session" value={String(totals.fetched)} />
          <Metric label="Candles upserted" value={String(totals.candles)} />
          <Metric label="Failed" value={String(totals.failed)} />
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 pr-4 font-medium">Batch</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Securities</th>
                <th className="pb-2 pr-4 font-medium">Fetched</th>
                <th className="pb-2 pr-4 font-medium">Candles</th>
                <th className="pb-2 font-medium">Run ID / Error</th>
              </tr>
            </thead>
            <tbody>
              {batchResults.length ? (
                batchResults.map((row) => (
                  <tr key={`${row.batchNumber}-${row.runId ?? row.error}`} className="border-b border-border/60 last:border-b-0">
                    <td className="py-2.5 pr-4 font-mono">{row.batchNumber}</td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge tone={row.ok ? "success" : "danger"}>{row.ok ? "COMPLETE" : "STOPPED"}</StatusBadge>
                    </td>
                    <td className="max-w-[360px] py-2.5 pr-4 text-xs text-muted-foreground">{row.tickers.join(", ")}</td>
                    <td className="py-2.5 pr-4 font-mono">{row.fetchedSecurities ?? 0}</td>
                    <td className="py-2.5 pr-4 font-mono">{row.candlesUpserted ?? 0}</td>
                    <td className="py-2.5 font-mono text-xs">{row.error ?? row.runId ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-5 text-sm text-muted-foreground">
                    No full-portfolio batches have been run in this session yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg text-foreground">{value}</p>
    </div>
  );
}

function formatIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
