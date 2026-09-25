import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader, StatusBadge } from "@/components/state";
import { chunks } from "@/lib/security-resolution";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/market-data-eod")({
  ssr: false,
  head: () => ({ meta: [{ title: "EOD History — PortfolioAI" }] }),
  component: MarketDataEodPage,
});

const BACKFILL_BATCH_SIZE = 5;
const BACKFILL_COOLDOWN_WAIT_MS = 61_000;
const REFRESH_BATCH_SIZE = 25;
const REFRESH_COOLDOWN_WAIT_MS = 11_000;

interface EligibleSecurity {
  securityId: string;
  ticker: string;
}

interface MarketDataResult {
  runId?: string;
  requested?: number;
  fetchedSecurities?: number;
  unresolved?: number;
  failed?: number;
  candlesUpserted?: number;
  fromDate?: string;
  toDate?: string;
}

interface BatchResult extends MarketDataResult {
  batch: number;
  tickers: string[];
  ok: boolean;
  error?: string;
}

interface CoverageRow {
  security_id: string;
  provider_code: string;
  candle_count: number | string;
  first_trade_date: string | null;
  last_trade_date: string | null;
  missing_volume_count: number | string;
  invalid_ohlc_count: number | string;
  latest_retrieved_at: string | null;
}

interface CoverageItem extends CoverageRow {
  ticker: string;
}

function MarketDataEodPage() {
  const supabase = useSupabase();
  const { activePortfolio } = usePortfolios();
  const portfolioId = activePortfolio?.id ?? null;

  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillBatch, setBackfillBatch] = useState(0);
  const [backfillResults, setBackfillResults] = useState<BatchResult[]>([]);
  const [refreshRunning, setRefreshRunning] = useState(false);
  const [refreshBatch, setRefreshBatch] = useState(0);
  const [refreshResults, setRefreshResults] = useState<BatchResult[]>([]);

  const dateRange = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 364);
    return { fromDate: iso(from), toDate: iso(to) };
  }, []);

  const progressKey = portfolioId
    ? `portfolioai:eod-safe:${portfolioId}:${dateRange.fromDate}:${dateRange.toDate}`
    : null;

  const eligibility = useQuery({
    queryKey: ["eod-safe-eligibility", portfolioId],
    enabled: Boolean(portfolioId),
    queryFn: async (): Promise<{ eligible: EligibleSecurity[]; openCount: number; excluded: number }> => {
      const { data: holdings, error: holdingsError } = await supabase
        .from("current_holdings")
        .select("security_id,net_quantity")
        .eq("portfolio_id", portfolioId!);
      if (holdingsError) throw new Error(holdingsError.message);

      const openIds = [...new Set(
        (holdings ?? [])
          .filter((row) => Number(row.net_quantity) > 0)
          .map((row) => String(row.security_id)),
      )];
      if (!openIds.length) return { eligible: [], openCount: 0, excluded: 0 };

      const verified = new Set<string>();
      const tickerById = new Map<string, string>();
      for (const idChunk of chunks(openIds, 200)) {
        const [mappingResult, securityResult] = await Promise.all([
          supabase
            .from("market_data_instrument_mappings")
            .select("security_id,mapping_status")
            .eq("provider_code", "ANGEL_ONE")
            .in("security_id", idChunk),
          supabase.from("securities").select("id,primary_symbol").in("id", idChunk),
        ]);
        if (mappingResult.error) throw new Error(mappingResult.error.message);
        if (securityResult.error) throw new Error(securityResult.error.message);
        for (const row of mappingResult.data ?? []) {
          if (row.mapping_status === "VERIFIED") verified.add(String(row.security_id));
        }
        for (const row of securityResult.data ?? []) {
          tickerById.set(String(row.id), row.primary_symbol ? String(row.primary_symbol) : String(row.id).slice(0, 8));
        }
      }

      const eligible = openIds
        .filter((id) => verified.has(id))
        .map((securityId) => ({ securityId, ticker: tickerById.get(securityId) ?? securityId.slice(0, 8) }))
        .sort((a, b) => a.ticker.localeCompare(b.ticker));

      return { eligible, openCount: openIds.length, excluded: openIds.length - eligible.length };
    },
  });

  const eligible = eligibility.data?.eligible ?? [];

  const coverage = useQuery({
    queryKey: ["eod-portfolio-coverage", portfolioId, eligible.map((item) => item.securityId).join("|")],
    enabled: Boolean(portfolioId) && eligible.length > 0,
    queryFn: async (): Promise<CoverageItem[]> => {
      const tickerById = new Map(eligible.map((item) => [item.securityId, item.ticker]));
      const rows: CoverageRow[] = [];

      for (const idChunk of chunks(eligible.map((item) => item.securityId), 200)) {
        const { data, error } = await supabase
          .from("market_eod_security_coverage")
          .select("security_id,provider_code,candle_count,first_trade_date,last_trade_date,missing_volume_count,invalid_ohlc_count,latest_retrieved_at")
          .eq("provider_code", "ANGEL_ONE")
          .in("security_id", idChunk);
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as CoverageRow[]));
      }

      const byId = new Map(rows.map((row) => [row.security_id, row]));
      return eligible.map((item) => {
        const row = byId.get(item.securityId);
        return row
          ? { ...row, ticker: tickerById.get(item.securityId) ?? item.ticker }
          : {
              security_id: item.securityId,
              provider_code: "ANGEL_ONE",
              candle_count: 0,
              first_trade_date: null,
              last_trade_date: null,
              missing_volume_count: 0,
              invalid_ohlc_count: 0,
              latest_retrieved_at: null,
              ticker: item.ticker,
            };
      });
    },
  });

  const completed = useMemo(() => {
    if (!progressKey || typeof window === "undefined") return new Set<string>();
    try {
      const value = JSON.parse(window.localStorage.getItem(progressKey) ?? "[]") as unknown;
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [progressKey, backfillResults]);

  const remaining = eligible.filter((item) => !completed.has(item.securityId));
  const backfillBatches = chunks(remaining, BACKFILL_BATCH_SIZE);
  const refreshBatches = chunks(eligible, REFRESH_BATCH_SIZE);

  async function invokeFunction(
    functionName: "backfill-market-eod" | "refresh-market-eod",
    batch: readonly EligibleSecurity[],
  ): Promise<MarketDataResult> {
    const body = functionName === "backfill-market-eod"
      ? {
          action: "BACKFILL_EOD",
          portfolioId,
          securityIds: batch.map((item) => item.securityId),
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
        }
      : {
          portfolioId,
          securityIds: batch.map((item) => item.securityId),
        };

    const { data, error } = await supabase.functions.invoke(functionName, { body });
    if (error) {
      const context = (error as { context?: Response }).context;
      if (context) {
        try {
          const parsed = (await context.json()) as { error?: string; code?: string };
          if (parsed.error) throw new Error(parsed.code ? `${parsed.error} (${parsed.code})` : parsed.error);
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") throw parseError;
        }
      }
      throw new Error(error.message);
    }
    return (data ?? {}) as MarketDataResult;
  }

  async function runBackfill() {
    if (!portfolioId || !progressKey || backfillRunning || refreshRunning || !remaining.length) return;
    setBackfillRunning(true);
    setBackfillResults([]);
    const persisted = new Set(completed);

    try {
      for (let index = 0; index < backfillBatches.length; index += 1) {
        const batch = backfillBatches[index]!;
        setBackfillBatch(index + 1);
        try {
          const result = await invokeFunction("backfill-market-eod", batch);
          const ok = isComplete(result, batch.length);
          setBackfillResults((rows) => [...rows, { ...result, batch: index + 1, tickers: batch.map((item) => item.ticker), ok }]);
          if (!ok) {
            toast.error(`Backfill batch ${index + 1} was partial and was not marked complete.`);
            break;
          }
          for (const item of batch) persisted.add(item.securityId);
          window.localStorage.setItem(progressKey, JSON.stringify([...persisted]));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Historical backfill failed.";
          setBackfillResults((rows) => [...rows, { batch: index + 1, tickers: batch.map((item) => item.ticker), ok: false, error: message }]);
          toast.error(`Backfill stopped at batch ${index + 1}. Progress through the previous batch is saved.`);
          break;
        }

        if (index < backfillBatches.length - 1) await wait(BACKFILL_COOLDOWN_WAIT_MS);
      }
    } finally {
      setBackfillRunning(false);
      void coverage.refetch();
    }
  }

  async function runIncrementalRefresh() {
    if (!portfolioId || refreshRunning || backfillRunning || !eligible.length) return;
    setRefreshRunning(true);
    setRefreshResults([]);

    try {
      for (let index = 0; index < refreshBatches.length; index += 1) {
        const batch = refreshBatches[index]!;
        setRefreshBatch(index + 1);
        try {
          const result = await invokeFunction("refresh-market-eod", batch);
          const ok = isComplete(result, batch.length);
          setRefreshResults((rows) => [...rows, { ...result, batch: index + 1, tickers: batch.map((item) => item.ticker), ok }]);
          if (!ok) {
            toast.error(`Incremental EOD batch ${index + 1} was partial. Refresh stopped safely.`);
            break;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Incremental EOD refresh failed.";
          setRefreshResults((rows) => [...rows, { batch: index + 1, tickers: batch.map((item) => item.ticker), ok: false, error: message }]);
          toast.error(`Incremental EOD refresh stopped at batch ${index + 1}.`);
          break;
        }

        if (index < refreshBatches.length - 1) await wait(REFRESH_COOLDOWN_WAIT_MS);
      }
    } finally {
      setRefreshRunning(false);
      await coverage.refetch();
    }
  }

  function resetProgress() {
    if (!progressKey || backfillRunning || refreshRunning) return;
    window.localStorage.removeItem(progressKey);
    setBackfillResults([]);
    setBackfillBatch(0);
    toast.success("Progress marker reset. Historical market data was not deleted.");
  }

  const coverageSummary = useMemo(() => {
    const rows = coverage.data ?? [];
    const withData = rows.filter((row) => Number(row.candle_count) > 0);
    const noData = rows.filter((row) => Number(row.candle_count) === 0);
    const invalid = rows.reduce((sum, row) => sum + Number(row.invalid_ohlc_count || 0), 0);
    const missingVolume = rows.reduce((sum, row) => sum + Number(row.missing_volume_count || 0), 0);
    const totalCandles = rows.reduce((sum, row) => sum + Number(row.candle_count || 0), 0);
    const latestDates = withData.map((row) => row.last_trade_date).filter((value): value is string => Boolean(value));
    const latestPortfolioDate = latestDates.length ? latestDates.sort().at(-1)! : null;
    return { withData: withData.length, noData: noData.length, invalid, missingVolume, totalCandles, latestPortfolioDate };
  }, [coverage.data]);

  const refreshTotals = totals(refreshResults);
  const backfillTotals = totals(backfillResults);

  return (
    <>
      <PageHeader
        title="Full Portfolio EOD History"
        description="Production-safe Angel One EOD history with portfolio-wide verification and incremental refresh. No transaction or holding data is modified."
      />

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Open holdings" value={String(eligibility.data?.openCount ?? 0)} />
          <Metric label="Verified eligible" value={String(eligible.length)} />
          <Metric label="Completed" value={String(completed.size)} />
          <Metric label="Remaining" value={String(remaining.length)} />
          <Metric label="Remaining batches" value={String(backfillBatches.length)} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">5 / BACKFILL BATCH</StatusBadge>
          <StatusBadge tone="neutral">61s BACKFILL COOLDOWN</StatusBadge>
          <StatusBadge tone="neutral">1 YEAR · ONE_DAY</StatusBadge>
          <span className="text-xs text-muted-foreground">{dateRange.fromDate} → {dateRange.toDate}</span>
        </div>

        {eligibility.data?.excluded ? (
          <p className="mt-3 text-sm text-amber-500">{eligibility.data.excluded} open holding(s) are not VERIFIED for Angel One and will be excluded.</p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={!portfolioId || backfillRunning || refreshRunning || eligibility.isLoading || remaining.length === 0} onClick={() => void runBackfill()}>
            {backfillRunning
              ? `Running backfill ${backfillBatch}/${backfillBatches.length}…`
              : remaining.length === 0
                ? "Backfill complete"
                : `Backfill ${remaining.length} remaining holdings`}
          </Button>
          <Button variant="outline" disabled={backfillRunning || refreshRunning || completed.size === 0} onClick={resetProgress}>
            Reset progress only
          </Button>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Stage 2C · Incremental EOD refresh</h2>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              Refreshes only the recent 10-calendar-day window for all VERIFIED open holdings. Requests run in 25-security batches and use idempotent upserts, so existing historical rows are updated rather than duplicated.
            </p>
          </div>
          <Button disabled={!portfolioId || refreshRunning || backfillRunning || eligibility.isLoading || eligible.length === 0} onClick={() => void runIncrementalRefresh()}>
            {refreshRunning ? `Refreshing batch ${refreshBatch}/${refreshBatches.length}…` : `Refresh EOD for ${eligible.length} holdings`}
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">25 / BATCH</StatusBadge>
          <StatusBadge tone="neutral">10-DAY LOOKBACK</StatusBadge>
          <StatusBadge tone="neutral">11s CLIENT WAIT</StatusBadge>
          <span className="text-xs text-muted-foreground">Manual refresh only · no background scheduler</span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Metric label="Fetched this refresh" value={String(refreshTotals.fetched)} />
          <Metric label="Candles upserted" value={String(refreshTotals.candles)} />
          <Metric label="Stopped / failed batches" value={String(refreshTotals.failed)} />
        </div>

        <BatchTable rows={refreshResults} emptyText="No incremental EOD refresh has run in this session yet." />
      </section>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Backfill fetched this session" value={String(backfillTotals.fetched)} />
          <Metric label="Backfill candles upserted" value={String(backfillTotals.candles)} />
          <Metric label="Backfill stopped / failed" value={String(backfillTotals.failed)} />
        </div>
        <BatchTable rows={backfillResults} emptyText="No full-portfolio backfill batches have run in this session yet." />
      </section>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Stage 2C · Portfolio-wide EOD health</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Aggregated read-only coverage from market_price_history_eod. The latest portfolio trade date is the comparison point, so newer IPOs are not penalized for shorter histories.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={coverage.isFetching || !eligible.length} onClick={() => void coverage.refetch()}>
            {coverage.isFetching ? "Verifying…" : "Verify portfolio history"}
          </Button>
        </div>

        {coverage.error ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{coverage.error.message}</div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <Metric label="With EOD data" value={`${coverageSummary.withData}/${eligible.length || 0}`} />
              <Metric label="No EOD data" value={String(coverageSummary.noData)} />
              <Metric label="Stored candles" value={String(coverageSummary.totalCandles)} />
              <Metric label="Invalid OHLC" value={String(coverageSummary.invalid)} />
              <Metric label="Missing volume" value={String(coverageSummary.missingVolume)} />
              <Metric label="Latest trade date" value={coverageSummary.latestPortfolioDate ?? "—"} />
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Ticker</th>
                    <th className="pb-2 pr-4 font-medium">Candles</th>
                    <th className="pb-2 pr-4 font-medium">First date</th>
                    <th className="pb-2 pr-4 font-medium">Last date</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Invalid OHLC</th>
                    <th className="pb-2 font-medium">Missing volume</th>
                  </tr>
                </thead>
                <tbody>
                  {(coverage.data ?? []).map((row) => {
                    const hasData = Number(row.candle_count) > 0;
                    const current = Boolean(coverageSummary.latestPortfolioDate) && row.last_trade_date === coverageSummary.latestPortfolioDate;
                    const clean = Number(row.invalid_ohlc_count) === 0;
                    const status = !hasData ? "NO DATA" : current && clean ? "CURRENT" : current ? "CHECK" : "LAGGING";
                    const tone = status === "CURRENT" ? "ok" : status === "NO DATA" ? "bad" : "warn";
                    return (
                      <tr key={row.security_id} className="border-b border-border/60 last:border-b-0">
                        <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{row.ticker}</td>
                        <td className="py-2.5 pr-4 font-mono">{Number(row.candle_count)}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs">{row.first_trade_date ?? "—"}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs">{row.last_trade_date ?? "—"}</td>
                        <td className="py-2.5 pr-4"><StatusBadge tone={tone}>{status}</StatusBadge></td>
                        <td className="py-2.5 pr-4 font-mono">{Number(row.invalid_ohlc_count)}</td>
                        <td className="py-2.5 font-mono">{Number(row.missing_volume_count)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function BatchTable({ rows, emptyText }: { rows: BatchResult[]; emptyText: string }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 pr-4 font-medium">Batch</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Tickers</th>
            <th className="pb-2 pr-4 font-medium">Fetched</th>
            <th className="pb-2 pr-4 font-medium">Candles</th>
            <th className="pb-2 font-medium">Run ID / Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={`${row.batch}-${row.runId ?? row.error}`} className="border-b border-border/60 last:border-b-0">
              <td className="py-2.5 pr-4 font-mono">{row.batch}</td>
              <td className="py-2.5 pr-4"><StatusBadge tone={row.ok ? "ok" : "bad"}>{row.ok ? "COMPLETE" : "STOPPED"}</StatusBadge></td>
              <td className="max-w-[420px] py-2.5 pr-4 text-xs text-muted-foreground">{row.tickers.join(", ")}</td>
              <td className="py-2.5 pr-4 font-mono">{row.fetchedSecurities ?? 0}</td>
              <td className="py-2.5 pr-4 font-mono">{row.candlesUpserted ?? 0}</td>
              <td className="py-2.5 font-mono text-xs">{row.error ?? row.runId ?? "—"}</td>
            </tr>
          )) : (
            <tr><td colSpan={6} className="py-5 text-muted-foreground">{emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </div>
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

function totals(rows: BatchResult[]) {
  return {
    fetched: rows.reduce((sum, row) => sum + (row.fetchedSecurities ?? 0), 0),
    candles: rows.reduce((sum, row) => sum + (row.candlesUpserted ?? 0), 0),
    failed: rows.reduce((sum, row) => sum + (row.ok ? 0 : 1), 0),
  };
}

function isComplete(result: MarketDataResult, expected: number) {
  return (result.failed ?? 0) === 0
    && (result.unresolved ?? 0) === 0
    && (result.fetchedSecurities ?? 0) === expected;
}

function iso(value: Date) {
  return value.toISOString().slice(0, 10);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
