import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/state";
import { useSupabase } from "@/providers/auth";

export const Route = createFileRoute("/_app/market-data-test")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Market Data Test — PortfolioAI" }],
  }),
  component: MarketDataTestPage,
});

const EXPECTED_PORTFOLIO_ID = "0033a8c9-03d5-4fcf-a64e-edf279957f72";

const SAMPLE_SECURITIES = [
  { symbol: "360ONE", id: "89557526-da9a-5906-a767-57ed2c59a122" },
  { symbol: "ABCAPITAL", id: "4f781eb8-a199-5ce8-92bf-bc32b33829ba" },
  { symbol: "ACMESOLAR", id: "5e9a5c1e-24a8-5aad-820f-93ff02d49294" },
  { symbol: "AKUMS", id: "bbbf0618-bf76-5421-9b6d-b699e247cb53" },
  { symbol: "ALIVUS", id: "0a4c3072-bd59-5883-a4a6-162e9d34d93d" },
] as const;

interface MappingResult {
  mapped?: number;
  ambiguous?: number;
  unresolved?: number;
  quarantined?: number;
  unsupported?: number;
  error?: string;
  code?: string;
}

interface RefreshResult {
  runId?: string;
  fetched?: number;
  cached?: number;
  unresolved?: number;
  failed?: number;
  error?: string;
  code?: string;
}

function MarketDataTestPage() {
  const supabase = useSupabase();
  const [mappingResult, setMappingResult] = useState<MappingResult | null>(null);
  const [fullMappingResult, setFullMappingResult] = useState<MappingResult | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);

  const invoke = async <T,>(action: "SYNC_MAPPINGS" | "REFRESH", scope: "SAMPLE" | "ALL_OPEN") => {
    const body: Record<string, unknown> = {
      action,
      portfolioId: EXPECTED_PORTFOLIO_ID,
    };
    if (scope === "SAMPLE") {
      body.securityIds = SAMPLE_SECURITIES.map((security) => security.id);
    }

    const { data, error } = await supabase.functions.invoke("refresh-market-data", { body });

    if (error) {
      const context = (error as { context?: Response }).context;
      if (context) {
        try {
          const responseBody = (await context.json()) as { error?: string };
          throw new Error(responseBody.error ?? error.message);
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") {
            throw parseError;
          }
        }
      }
      throw new Error(error.message);
    }

    return (data ?? {}) as T;
  };

  const mappingTest = useMutation({
    mutationFn: () => invoke<MappingResult>("SYNC_MAPPINGS", "SAMPLE"),
    onSuccess: (data) => {
      setMappingResult(data);
      toast.success("Angel One mapping test completed");
    },
    onError: (error: Error) => {
      setMappingResult({ error: error.message });
      toast.error(error.message);
    },
  });

  const fullMappingTest = useMutation({
    mutationFn: () => invoke<MappingResult>("SYNC_MAPPINGS", "ALL_OPEN"),
    onSuccess: (data) => {
      setFullMappingResult(data);
      toast.success("Full open-holdings mapping completed");
    },
    onError: (error: Error) => {
      setFullMappingResult({ error: error.message });
      toast.error(error.message);
    },
  });

  const refreshTest = useMutation({
    mutationFn: () => invoke<RefreshResult>("REFRESH", "SAMPLE"),
    onSuccess: (data) => {
      setRefreshResult(data);
      toast.success("Angel One live price test completed");
    },
    onError: (error: Error) => {
      setRefreshResult({ error: error.message });
      toast.error(error.message);
    },
  });

  const busy = mappingTest.isPending || fullMappingTest.isPending || refreshTest.isPending;

  return (
    <>
      <PageHeader
        title="Angel One Market Data Test"
        description="Verified five-security pilot plus controlled mapping of all current open holdings. Full-portfolio price refresh remains disabled until mapping results are reviewed."
      />

      <div className="max-w-3xl space-y-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Approved five-security pilot</p>
            <p className="text-muted-foreground">360ONE · ABCAPITAL · ACMESOLAR · AKUMS · ALIVUS</p>
            <p className="font-mono text-xs text-muted-foreground">Portfolio: {EXPECTED_PORTFOLIO_ID}</p>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            The pilot buttons remain locked to these five current holdings. The Edge Function independently verifies ownership and holdings membership. Angel One credentials remain only in Supabase Edge Function Secrets.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={busy}
              onClick={() => {
                setMappingResult(null);
                mappingTest.mutate();
              }}
            >
              {mappingTest.isPending ? "Testing mapping…" : "Test 5 Mapping"}
            </Button>

            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setRefreshResult(null);
                refreshTest.mutate();
              }}
            >
              {refreshTest.isPending ? "Refreshing prices…" : "Test 5 Live Prices"}
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Stage 2 — map all open holdings</p>
            <p className="text-muted-foreground">
              Runs deterministic Angel One instrument mapping for every current open holding in the Consolidated portfolio. This does not request market prices.
            </p>
            <p className="text-xs text-muted-foreground">
              Exact exchange/symbol matches can be verified automatically. Ambiguous, unresolved or changed verified identities remain visible for review instead of being force-mapped.
            </p>
          </div>

          <Button
            className="mt-4"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setFullMappingResult(null);
              fullMappingTest.mutate();
            }}
          >
            {fullMappingTest.isPending ? "Mapping all open holdings…" : "Map All Open Holdings"}
          </Button>
        </section>

        {mappingResult ? <MappingResultCard title="Five-security mapping result" result={mappingResult} /> : null}
        {fullMappingResult ? <MappingResultCard title="All open holdings mapping result" result={fullMappingResult} /> : null}

        {refreshResult ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <p className="mb-3 text-sm font-medium text-foreground">Five-security live price result</p>
            {refreshResult.error ? (
              <p className="text-sm text-destructive">{refreshResult.error}</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-4">
                  <ResultStat label="Fetched" value={refreshResult.fetched} />
                  <ResultStat label="Cached" value={refreshResult.cached} />
                  <ResultStat label="Unresolved" value={refreshResult.unresolved} />
                  <ResultStat label="Failed" value={refreshResult.failed} />
                </div>
                {refreshResult.runId ? (
                  <p className="mt-3 font-mono text-xs text-muted-foreground">Run: {refreshResult.runId}</p>
                ) : null}
              </>
            )}
            {refreshResult.code ? <p className="mt-3 font-mono text-xs text-muted-foreground">Code: {refreshResult.code}</p> : null}
          </section>
        ) : null}
      </div>
    </>
  );
}

function MappingResultCard({ title, result }: { title: string; result: MappingResult }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <p className="mb-3 text-sm font-medium text-foreground">{title}</p>
      {result.error ? (
        <p className="text-sm text-destructive">{result.error}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-5">
          <ResultStat label="Mapped" value={result.mapped} />
          <ResultStat label="Ambiguous" value={result.ambiguous} />
          <ResultStat label="Unresolved" value={result.unresolved} />
          <ResultStat label="Quarantined" value={result.quarantined} />
          <ResultStat label="Unsupported" value={result.unsupported} />
        </div>
      )}
      {result.code ? <p className="mt-3 font-mono text-xs text-muted-foreground">Code: {result.code}</p> : null}
    </section>
  );
}

function ResultStat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value ?? 0}</p>
    </div>
  );
}
