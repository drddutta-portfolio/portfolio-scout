import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader, StatusBadge } from "@/components/state";
import { useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/market-data-eod-pilot")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "EOD Pilot — PortfolioAI" },
      {
        name: "description",
        content: "Controlled Angel One historical EOD OHLCV pilot for five verified portfolio holdings.",
      },
    ],
  }),
  component: MarketDataEodPilotPage,
});

const PILOT_SECURITIES = [
  { ticker: "360ONE", securityId: "89557526-da9a-5906-a767-57ed2c59a122" },
  { ticker: "ABCAPITAL", securityId: "4f781eb8-a199-5ce8-92bf-bc32b33829ba" },
  { ticker: "ACMESOLAR", securityId: "5e9a5c1e-24a8-5aad-820f-93ff02d49294" },
  { ticker: "AKUMS", securityId: "bbbf0618-bf76-5421-9b6d-b699e247cb53" },
  { ticker: "ALIVUS", securityId: "0a4c3072-bd59-5883-a4a6-162e9d34d93d" },
] as const;

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

interface HistoryRow {
  security_id: string;
  trade_date: string;
  open_price: string | number;
  high_price: string | number;
  low_price: string | number;
  close_price: string | number;
  volume: string | number | null;
}

interface VerificationRow {
  ticker: string;
  securityId: string;
  candles: number;
  firstDate: string | null;
  lastDate: string | null;
  invalidOhlc: number;
  nullVolume: number;
}

function MarketDataEodPilotPage() {
  const supabase = useSupabase();
  const { activePortfolio } = usePortfolios();
  const queryClient = useQueryClient();
  const portfolioId = activePortfolio?.id ?? null;

  const dateRange = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 364);
    return {
      fromDate: formatIsoDate(from),
      toDate: formatIsoDate(to),
    };
  }, []);

  const verification = useQuery({
    queryKey: ["eod-pilot-verification", dateRange.fromDate, dateRange.toDate],
    queryFn: async (): Promise<VerificationRow[]> => {
      const { data, error } = await supabase
        .from("market_price_history_eod")
        .select("security_id,trade_date,open_price,high_price,low_price,close_price,volume")
        .eq("provider_code", "ANGEL_ONE")
        .in("security_id", PILOT_SECURITIES.map((item) => item.securityId))
        .gte("trade_date", dateRange.fromDate)
        .lte("trade_date", dateRange.toDate)
        .order("trade_date", { ascending: true });

      if (error) throw new Error(error.message);
      const rows = (data ?? []) as HistoryRow[];

      return PILOT_SECURITIES.map((security) => {
        const securityRows = rows.filter((row) => row.security_id === security.securityId);
        let invalidOhlc = 0;
        let nullVolume = 0;

        for (const row of securityRows) {
          const open = Number(row.open_price);
          const high = Number(row.high_price);
          const low = Number(row.low_price);
          const close = Number(row.close_price);
          if (
            !Number.isFinite(open)
            || !Number.isFinite(high)
            || !Number.isFinite(low)
            || !Number.isFinite(close)
            || high < low
            || high < open
            || high < close
            || low > open
            || low > close
          ) {
            invalidOhlc += 1;
          }
          if (row.volume === null || row.volume === undefined || row.volume === "") nullVolume += 1;
        }

        return {
          ticker: security.ticker,
          securityId: security.securityId,
          candles: securityRows.length,
          firstDate: securityRows[0]?.trade_date ?? null,
          lastDate: securityRows.at(-1)?.trade_date ?? null,
          invalidOhlc,
          nullVolume,
        };
      });
    },
  });

  const backfill = useMutation({
    mutationFn: async (): Promise<BackfillResult> => {
      if (!portfolioId) throw new Error("No active portfolio selected.");

      const { data, error } = await supabase.functions.invoke("backfill-market-eod", {
        body: {
          action: "BACKFILL_EOD",
          portfolioId,
          securityIds: PILOT_SECURITIES.map((item) => item.securityId),
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
        },
      });

      if (error) {
        const context = (error as { context?: Response }).context;
        if (context) {
          try {
            const body = (await context.json()) as { error?: string; code?: string };
            if (body.error) {
              throw new Error(body.code ? `${body.error} (${body.code})` : body.error);
            }
          } catch (parseError) {
            if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") {
              throw parseError;
            }
          }
        }
        throw new Error(error.message);
      }

      return (data ?? {}) as BackfillResult;
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["eod-pilot-verification"] });
      toast.success(
        `EOD pilot complete: ${result.fetchedSecurities ?? 0}/${result.requested ?? 0} securities · ${result.candlesUpserted ?? 0} candles · ${result.failed ?? 0} failed`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const verificationSummary = useMemo(() => {
    const rows = verification.data ?? [];
    return {
      totalCandles: rows.reduce((sum, row) => sum + row.candles, 0),
      securitiesWithData: rows.filter((row) => row.candles > 0).length,
      invalidOhlc: rows.reduce((sum, row) => sum + row.invalidOhlc, 0),
      nullVolume: rows.reduce((sum, row) => sum + row.nullVolume, 0),
    };
  }, [verification.data]);

  return (
    <>
      <PageHeader
        title="Angel One EOD Pilot"
        description="Controlled one-year historical OHLCV backfill for the same five securities used in the successful Angel One market-data pilot. This writes only provider observation data and does not modify transactions or holdings."
      />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral">PILOT ONLY</StatusBadge>
            <span className="text-xs text-muted-foreground">5 verified holdings · 1 year · ONE_DAY candles</span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">From</p>
              <p className="mt-1 font-mono text-sm text-foreground">{dateRange.fromDate}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">To</p>
              <p className="mt-1 font-mono text-sm text-foreground">{dateRange.toDate}</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {PILOT_SECURITIES.map((item) => (
              <StatusBadge key={item.securityId} tone="neutral">{item.ticker}</StatusBadge>
            ))}
          </div>

          <Button
            className="mt-6"
            disabled={!portfolioId || backfill.isPending}
            onClick={() => backfill.mutate()}
          >
            {backfill.isPending ? "Running EOD pilot…" : "Run 5-stock EOD pilot"}
          </Button>

          {!portfolioId ? (
            <p className="mt-3 text-sm text-destructive">Select a portfolio before running the pilot.</p>
          ) : null}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Pilot result</h2>

          {backfill.data ? (
            <div className="mt-4 space-y-3 text-sm">
              <ResultRow label="Run ID" value={backfill.data.runId ?? "—"} mono />
              <ResultRow label="Requested" value={String(backfill.data.requested ?? 0)} />
              <ResultRow label="Fetched securities" value={String(backfill.data.fetchedSecurities ?? 0)} />
              <ResultRow label="Unresolved" value={String(backfill.data.unresolved ?? 0)} />
              <ResultRow label="Failed" value={String(backfill.data.failed ?? 0)} />
              <ResultRow label="Candles upserted" value={String(backfill.data.candlesUpserted ?? 0)} />
              <ResultRow label="Range" value={`${backfill.data.fromDate ?? dateRange.fromDate} → ${backfill.data.toDate ?? dateRange.toDate}`} />
            </div>
          ) : backfill.error ? (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {backfill.error.message}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No pilot has been run in this session yet.</p>
          )}
        </section>
      </div>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Persisted EOD verification</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Read-only validation of the rows now stored in market_price_history_eod for the five pilot securities.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={verification.isFetching} onClick={() => void verification.refetch()}>
            {verification.isFetching ? "Verifying…" : "Verify stored candles"}
          </Button>
        </div>

        {verification.error ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {verification.error.message}
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <Metric label="Securities with data" value={`${verificationSummary.securitiesWithData}/5`} />
              <Metric label="Stored candles" value={String(verificationSummary.totalCandles)} />
              <Metric label="Invalid OHLC" value={String(verificationSummary.invalidOhlc)} />
              <Metric label="Missing volume" value={String(verificationSummary.nullVolume)} />
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Ticker</th>
                    <th className="pb-2 pr-4 font-medium">Candles</th>
                    <th className="pb-2 pr-4 font-medium">First date</th>
                    <th className="pb-2 pr-4 font-medium">Last date</th>
                    <th className="pb-2 pr-4 font-medium">Invalid OHLC</th>
                    <th className="pb-2 font-medium">Missing volume</th>
                  </tr>
                </thead>
                <tbody>
                  {(verification.data ?? []).map((row) => (
                    <tr key={row.securityId} className="border-b border-border/60 last:border-b-0">
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{row.ticker}</td>
                      <td className="py-2.5 pr-4 font-mono text-foreground">{row.candles}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{row.firstDate ?? "—"}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{row.lastDate ?? "—"}</td>
                      <td className="py-2.5 pr-4 font-mono text-foreground">{row.invalidOhlc}</td>
                      <td className="py-2.5 font-mono text-foreground">{row.nullVolume}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function ResultRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border pb-2 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`${mono ? "font-mono text-xs" : "font-mono"} break-all text-right text-foreground`}>{value}</span>
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

function formatIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
