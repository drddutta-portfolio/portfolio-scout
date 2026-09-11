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
  head: () => ({
    meta: [{ title: "EOD History — PortfolioAI" }],
  }),
  component: MarketDataEodPage,
});

const BATCH_SIZE = 5;
const COOLDOWN_WAIT_MS = 61_000;

interface EligibleSecurity {
  securityId: string;
  ticker: string;
}

interface BackfillResult {
  runId?: string;
  requested?: number;
  fetchedSecurities?: number;
  unresolved?: number;
  failed?: number;
  candlesUpserted?: number;
}

interface BatchResult extends BackfillResult {
  batch: number;
  tickers: string[];
  ok: boolean;
  error?: string;
}

function MarketDataEodPage() {
  const supabase = useSupabase();
  const { activePortfolio } = usePortfolios();
  const portfolioId = activePortfolio?.id ?? null;
  const [running, setRunning] = useState(false);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [results, setResults] = useState<BatchResult[]>([]);

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

  const completed = useMemo(() => {
    if (!progressKey || typeof window === "undefined") return new Set<string>();
    try {
      const value = JSON.parse(window.localStorage.getItem(progressKey) ?? "[]") as unknown;
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [progressKey, results]);

  const eligible = eligibility.data?.eligible ?? [];
  const remaining = eligible.filter((item) => !completed.has(item.securityId));
  const batches = chunks(remaining, BATCH_SIZE);

  async function invoke(batch: readonly EligibleSecurity[]): Promise<BackfillResult> {
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

  async function run() {
    if (!portfolioId || !progressKey || running || !remaining.length) return;
    setRunning(true);
    setResults([]);
    const persisted = new Set(completed);

    try {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]!;
        setCurrentBatch(index + 1);
        try {
          const result = await invoke(batch);
          const ok =
            (result.failed ?? 0) === 0
            && (result.unresolved ?? 0) === 0
            && (result.fetchedSecurities ?? 0) === batch.length;
          setResults((rows) => [...rows, { ...result, batch: index + 1, tickers: batch.map((item) => item.ticker), ok }]);
          if (!ok) {
            toast.error(`Batch ${index + 1} was partial and was not marked complete.`);
            break;
          }
          for (const item of batch) persisted.add(item.securityId);
          window.localStorage.setItem(progressKey, JSON.stringify([...persisted]));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Historical backfill failed.";
          setResults((rows) => [...rows, { batch: index + 1, tickers: batch.map((item) => item.ticker), ok: false, error: message }]);
          toast.error(`Backfill stopped at batch ${index + 1}. Progress through the previous batch is saved.`);
          break;
        }

        if (index < batches.length - 1) await wait(COOLDOWN_WAIT_MS);
      }
    } finally {
      setRunning(false);
    }
  }

  function resetProgress() {
    if (!progressKey || running) return;
    window.localStorage.removeItem(progressKey);
    setResults([]);
    setCurrentBatch(0);
    toast.success("Progress marker reset. Historical market data was not deleted.");
  }

  const fetched = results.reduce((sum, row) => sum + (row.fetchedSecurities ?? 0), 0);
  const candles = results.reduce((sum, row) => sum + (row.candlesUpserted ?? 0), 0);
  const failed = results.reduce((sum, row) => sum + (row.ok ? 0 : 1), 0);

  return (
    <>
      <PageHeader
        title="Full Portfolio EOD History"
        description="Production-safe resumable one-year Angel One EOD backfill. It respects the currently deployed 5-security server guard and 60-second operation cooldown; no transaction or holding data is modified."
      />

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Open holdings" value={String(eligibility.data?.openCount ?? 0)} />
          <Metric label="Verified eligible" value={String(eligible.length)} />
          <Metric label="Completed" value={String(completed.size)} />
          <Metric label="Remaining" value={String(remaining.length)} />
          <Metric label="Remaining batches" value={String(batches.length)} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">5 / BATCH</StatusBadge>
          <StatusBadge tone="neutral">61s COOLDOWN</StatusBadge>
          <StatusBadge tone="neutral">1 YEAR · ONE_DAY</StatusBadge>
          <span className="text-xs text-muted-foreground">{dateRange.fromDate} → {dateRange.toDate}</span>
        </div>

        {eligibility.data?.excluded ? (
          <p className="mt-3 text-sm text-amber-500">
            {eligibility.data.excluded} open holding(s) are not VERIFIED for Angel One and will be excluded.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={!portfolioId || running || eligibility.isLoading || remaining.length === 0} onClick={() => void run()}>
            {running
              ? `Running batch ${currentBatch}/${batches.length}…`
              : remaining.length === 0
                ? "Backfill complete"
                : `Backfill ${remaining.length} remaining holdings`}
          </Button>
          <Button variant="outline" disabled={running || completed.size === 0} onClick={resetProgress}>
            Reset progress only
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Keep this page open while it runs. Completion is saved in this browser after every successful batch, so a later session resumes from the remaining securities. Because the current backend intentionally allows only five securities per request and a 60-second cooldown, a first full 250-stock pass can take roughly 50 minutes. This is deliberately conservative until we separately review and deploy a larger server-side batch limit.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Fetched this session" value={String(fetched)} />
          <Metric label="Candles upserted" value={String(candles)} />
          <Metric label="Stopped / failed batches" value={String(failed)} />
        </div>

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
              {results.length ? results.map((row) => (
                <tr key={`${row.batch}-${row.runId ?? row.error}`} className="border-b border-border/60 last:border-b-0">
                  <td className="py-2.5 pr-4 font-mono">{row.batch}</td>
                  <td className="py-2.5 pr-4"><StatusBadge tone={row.ok ? "success" : "danger"}>{row.ok ? "COMPLETE" : "STOPPED"}</StatusBadge></td>
                  <td className="py-2.5 pr-4 text-xs text-muted-foreground">{row.tickers.join(", ")}</td>
                  <td className="py-2.5 pr-4 font-mono">{row.fetchedSecurities ?? 0}</td>
                  <td className="py-2.5 pr-4 font-mono">{row.candlesUpserted ?? 0}</td>
                  <td className="py-2.5 font-mono text-xs">{row.error ?? row.runId ?? "—"}</td>
                </tr>
              )) : (
                <tr><td colSpan={6} className="py-5 text-muted-foreground">No full-portfolio batches have run in this session yet.</td></tr>
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

function iso(value: Date) {
  return value.toISOString().slice(0, 10);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
