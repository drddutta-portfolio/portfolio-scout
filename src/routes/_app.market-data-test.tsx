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
  { symbol: "360ONE", id: "b68c6f9d-5881-4ca8-a9b6-b00d266f778f" },
  { symbol: "ABCAPITAL", id: "3833b30d-f007-486a-afd4-d44d313f8e99" },
  { symbol: "ACMESOLAR", id: "5b9171f3-d8cb-4b24-8432-1905b214915a" },
  { symbol: "AKUMS", id: "89d94355-8c96-4d21-8bb7-1e3bcf096a93" },
  { symbol: "ALIVUS", id: "de565d84-02de-4e97-a255-43ee56c8650e" },
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

function MarketDataTestPage() {
  const supabase = useSupabase();
  const [result, setResult] = useState<MappingResult | null>(null);

  const mappingTest = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("refresh-market-data", {
        body: {
          action: "SYNC_MAPPINGS",
          portfolioId: EXPECTED_PORTFOLIO_ID,
          securityIds: SAMPLE_SECURITIES.map((security) => security.id),
        },
      });

      if (error) {
        const context = (error as { context?: Response }).context;
        if (context) {
          try {
            const body = (await context.json()) as MappingResult;
            throw new Error(body.error ?? error.message);
          } catch (parseError) {
            if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") {
              throw parseError;
            }
          }
        }
        throw new Error(error.message);
      }

      return (data ?? {}) as MappingResult;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success("Angel One mapping test completed");
    },
    onError: (error: Error) => {
      setResult({ error: error.message });
      toast.error(error.message);
    },
  });

  return (
    <>
      <PageHeader
        title="Angel One Mapping Test"
        description="Controlled five-security test. This does not request live prices and cannot expand beyond the approved sample."
      />

      <div className="max-w-3xl space-y-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Approved sample</p>
            <p className="text-muted-foreground">360ONE · ABCAPITAL · ACMESOLAR · AKUMS · ALIVUS</p>
            <p className="font-mono text-xs text-muted-foreground">Portfolio: {EXPECTED_PORTFOLIO_ID}</p>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            This test always targets the approved Consolidated portfolio above. The Edge Function independently verifies portfolio ownership and confirms every sampled security is a current holding. Angel One credentials remain only in Supabase Edge Function Secrets.
          </p>

          <Button
            className="mt-4"
            disabled={mappingTest.isPending}
            onClick={() => {
              setResult(null);
              mappingTest.mutate();
            }}
          >
            {mappingTest.isPending ? "Testing mapping…" : "Test Angel One Mapping"}
          </Button>
        </section>

        {result ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <p className="mb-3 text-sm font-medium text-foreground">Result</p>
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
        ) : null}
      </div>
    </>
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
