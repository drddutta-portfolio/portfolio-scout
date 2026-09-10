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
  LoadingState,
  PageHeader,
  StatusBadge,
  Unavailable,
} from "@/components/state";
import { buildHoldingSnapshotImport } from "@/lib/holdings-snapshot";
import { parseSpreadsheet } from "@/lib/parse-file";
import { chunks } from "@/lib/security-resolution";
import type {
  CurrentHolding,
  PortfolioHoldingSnapshot,
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
        content: "Professional portfolio holdings terminal with ledger reconciliation and source-aware valuation data.",
      },
      { property: "og:title", content: "Holdings — PortfolioAI" },
      {
        property: "og:description",
        content: "Professional portfolio holdings terminal with ledger reconciliation and source-aware valuation data.",
      },
    ],
  }),
  component: HoldingsPage,
});

interface MarketPriceCacheRow {
  securityId: string;
  price: string;
  retrievedAt: string;
}

interface MarketPriceCacheResponse {
  prices?: MarketPriceCacheRow[];
}

interface HoldingRow {
  holding: CurrentHolding | null;
  snapshot: PortfolioHoldingSnapshot | null;
  security: Security | null;
  setting: PortfolioSecuritySetting | null;
  marketPrice: MarketPriceCacheRow | null;
}

type PositionFilter = "ALL" | "OPEN" | "CLOSED" | "MISMATCH";
type SortMode = "TICKER" | "CURRENT_VALUE" | "UNREALIZED_PCT" | "REALIZED_PL";
type PriceSource = "LIVE" | "CACHED" | "SHEET" | "UNAVAILABLE";

const ANGEL_FRESH_MS = 5 * 60 * 1000;

function HoldingsPage() {
  const supabase = useSupabase();
  const { user } = useAuth();
  const { activePortfolio } = usePortfolios();
  const queryClient = useQueryClient();
  const portfolioId = activePortfolio?.id ?? null;

  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState<PositionFilter>("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("TICKER");

  const query = useQuery({
    queryKey: ["holdings-pro", portfolioId],
    enabled: Boolean(portfolioId),
    queryFn: async (): Promise<{ rows: HoldingRow[]; snapshotStoreAvailable: boolean }> => {
      const [holdingsResult, settingsResult, snapshotsResult] = await Promise.all([
        supabase.from("current_holdings").select("*").eq("portfolio_id", portfolioId!),
        supabase.from("portfolio_security_settings").select("*").eq("portfolio_id", portfolioId!),
        supabase.from("portfolio_holding_snapshots").select("*").eq("portfolio_id", portfolioId!),
      ]);

      if (holdingsResult.error) throw new Error(holdingsResult.error.message);
      if (settingsResult.error) throw new Error(settingsResult.error.message);

      const snapshotStoreMissing = Boolean(
        snapshotsResult.error &&
          (snapshotsResult.error.code === "42P01" ||
            snapshotsResult.error.message.toLowerCase().includes("portfolio_holding_snapshots")),
      );
      if (snapshotsResult.error && !snapshotStoreMissing) {
        throw new Error(snapshotsResult.error.message);
      }

      const holdings = (holdingsResult.data ?? []) as CurrentHolding[];
      const snapshots = snapshotStoreMissing
        ? []
        : ((snapshotsResult.data ?? []) as PortfolioHoldingSnapshot[]);
      const settings = (settingsResult.data ?? []) as PortfolioSecuritySetting[];

      const securityIds = Array.from(
        new Set([
          ...holdings.map((row) => row.security_id),
          ...snapshots.map((row) => row.security_id),
        ]),
      );
      const securities = new Map<string, Security>();
      for (const chunk of chunks(securityIds, 200)) {
        const { data, error } = await supabase.from("securities").select("*").in("id", chunk);
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as Security[]) securities.set(row.id, row);
      }

      const marketPrices = new Map<string, MarketPriceCacheRow>();
      if (securityIds.length) {
        const { data, error } = await supabase.functions.invoke("refresh-market-data", {
          body: { action: "READ_CACHE", securityIds },
        });
        if (error) {
          console.warn("Holdings market-data cache unavailable; using spreadsheet fallback.", error.message);
        } else {
          const response = (data ?? {}) as MarketPriceCacheResponse;
          for (const price of response.prices ?? []) marketPrices.set(price.securityId, price);
        }
      }

      const holdingMap = new Map(holdings.map((row) => [row.security_id, row]));
      const snapshotMap = new Map(snapshots.map((row) => [row.security_id, row]));
      const settingMap = new Map(settings.map((row) => [row.security_id, row]));
      const allIds = Array.from(new Set([...holdingMap.keys(), ...snapshotMap.keys()]));

      const rows = allIds.map((securityId) => ({
        holding: holdingMap.get(securityId) ?? null,
        snapshot: snapshotMap.get(securityId) ?? null,
        security: securities.get(securityId) ?? null,
        setting: settingMap.get(securityId) ?? null,
        marketPrice: marketPrices.get(securityId) ?? null,
      }));

      return { rows, snapshotStoreAvailable: !snapshotStoreMissing };
    },
  });

  const setRole = useMutation({
    mutationFn: async ({ securityId, role, existingId }: { securityId: string; role: PortfolioRole; existingId: string | null }) => {
      if (existingId) {
        const { error } = await supabase.from("portfolio_security_settings").update({ role }).eq("id", existingId);
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
      void queryClient.invalidateQueries({ queryKey: ["holdings-pro", portfolioId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", portfolioId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const uploadSnapshot = useMutation({
    mutationFn: async (file: File) => {
      if (!activePortfolio || !user) throw new Error("No active portfolio.");
      if (!query.data?.snapshotStoreAvailable) {
        throw new Error("Migration 0012 must be deployed before importing a HOLDINGS snapshot.");
      }

      const parsed = await parseSpreadsheet(file);
      const result = await buildHoldingSnapshotImport(supabase, parsed);
      if (result.resolved.length === 0) throw new Error("No HOLDINGS rows could be matched to the Security Master.");

      const importedAt = new Date().toISOString();
      const records = result.resolved.map((row) => ({
        owner_id: user.id,
        portfolio_id: activePortfolio.id,
        ...row,
        source_filename: parsed.fileName,
        source_file_sha256: parsed.sha256,
        snapshot_as_of_date: null,
        imported_at: importedAt,
      }));

      for (const chunk of chunks(records, 150)) {
        const { error } = await supabase
          .from("portfolio_holding_snapshots")
          .upsert(chunk, { onConflict: "owner_id,portfolio_id,security_id" });
        if (error) throw new Error(error.message);
      }

      if (result.unresolvedTickers.length === 0) {
        const { data: existing, error } = await supabase
          .from("portfolio_holding_snapshots")
          .select("id,security_id")
          .eq("portfolio_id", activePortfolio.id);
        if (error) throw new Error(error.message);
        const resolvedIds = new Set(result.resolved.map((row) => row.security_id));
        const staleIds = (existing ?? [])
          .filter((row) => !resolvedIds.has((row as { security_id: string }).security_id))
          .map((row) => (row as { id: string }).id);
        for (const chunk of chunks(staleIds, 150)) {
          const { error: deleteError } = await supabase
            .from("portfolio_holding_snapshots")
            .delete()
            .in("id", chunk);
          if (deleteError) throw new Error(deleteError.message);
        }
      }

      return result;
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["holdings-pro", portfolioId] });
      if (result.unresolvedTickers.length === 0) {
        toast.success(`${result.resolved.length} HOLDINGS rows loaded`);
      } else {
        toast.warning(
          `${result.resolved.length}/${result.totalRows} rows loaded · ${result.unresolvedTickers.length} symbols need review`,
        );
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = query.data?.rows ?? [];
  const preparedRows = useMemo(() => rows.map((row) => prepareHoldingRow(row)), [rows]);

  const enriched = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = preparedRows.filter((row) => {
      if (needle && !`${row.ticker} ${row.company} ${row.snapshot?.sector ?? ""}`.toLowerCase().includes(needle)) return false;
      if (positionFilter === "OPEN" && row.closed) return false;
      if (positionFilter === "CLOSED" && !row.closed) return false;
      if (positionFilter === "MISMATCH" && !row.mismatch) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      if (sortMode === "CURRENT_VALUE") return nullableSortDesc(a.currentValue, b.currentValue);
      if (sortMode === "UNREALIZED_PCT") return nullableSortDesc(a.unrealizedPct, b.unrealizedPct);
      if (sortMode === "REALIZED_PL") return numberOrZero(b.snapshot?.spreadsheet_realized_pl) - numberOrZero(a.snapshot?.spreadsheet_realized_pl);
      return a.ticker.localeCompare(b.ticker);
    });
  }, [preparedRows, search, positionFilter, sortMode]);

  const summary = useMemo(() => {
    const snapshotRows = rows.filter((row) => row.snapshot);
    const valuationRows = preparedRows.filter((row) => row.currentValue !== null);
    const unrealizedRows = preparedRows.filter((row) => row.unrealized !== null);
    return {
      invested: snapshotRows.reduce((sum, row) => sum + numberOrZero(row.snapshot?.invested_value), 0),
      currentValue: valuationRows.reduce((sum, row) => sum + (row.currentValue ?? 0), 0),
      currentValueCount: valuationRows.length,
      unrealized: unrealizedRows.reduce((sum, row) => sum + (row.unrealized ?? 0), 0),
      unrealizedCount: unrealizedRows.length,
      realized: snapshotRows.reduce((sum, row) => sum + numberOrZero(row.snapshot?.spreadsheet_realized_pl), 0),
      open: rows.filter((row) => (row.holding ? nullableNumber(row.holding.net_quantity) : 0) !== 0).length,
      snapshotCount: snapshotRows.length,
      liveCount: preparedRows.filter((row) => row.priceSource === "LIVE").length,
      cachedCount: preparedRows.filter((row) => row.priceSource === "CACHED").length,
      mismatches: rows.filter((row) => {
        if (!row.snapshot) return false;
        const ledger = row.holding ? nullableNumber(row.holding.net_quantity) : 0;
        const claim = nullableNumber(row.snapshot.net_units_claim);
        return ledger !== null && claim !== null && Math.abs(ledger - claim) > 0.00000001;
      }).length,
    };
  }, [preparedRows, rows]);

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
        description="Professional consolidated holdings view. Ledger quantities remain authoritative; cached Angel One prices are used when available, with spreadsheet valuation retained as the fallback source."
        actions={
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline"><Link to="/import">Import transactions</Link></Button>
            <Label htmlFor="holdings-snapshot-file" className="cursor-pointer">
              <span className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted/40">
                {uploadSnapshot.isPending ? "Loading…" : "Load HOLDINGS spreadsheet"}
              </span>
            </Label>
            <input
              id="holdings-snapshot-file"
              className="hidden"
              type="file"
              accept=".xlsx,.xls"
              disabled={uploadSnapshot.isPending || !query.data?.snapshotStoreAvailable}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) uploadSnapshot.mutate(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
        }
      />

      {query.isLoading ? <LoadingState label="Building holdings terminal" /> : null}
      {query.error ? <ErrorState error={query.error} /> : null}

      {query.data && !query.data.snapshotStoreAvailable ? (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
          <strong className="text-foreground">Spreadsheet valuation store is not deployed yet.</strong>{" "}
          Run <code>db/migrations/0012_portfolio_holding_snapshot.sql</code> in Supabase, refresh this page, then load Portfolio-101.xlsx once. The transaction ledger is unaffected.
        </div>
      ) : null}

      {query.data?.snapshotStoreAvailable && summary.snapshotCount === 0 ? (
        <div className="mb-4 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-muted-foreground">
          The ledger is ready. Load the same Portfolio-101.xlsx workbook to populate Avg. Buy Price, Invested Value, spreadsheet fallback Current Price/Value, P&L and Sector.
        </div>
      ) : null}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Kpi label="Invested value" value={summary.snapshotCount ? formatInr(summary.invested) : "—"} />
        <Kpi label="Current value" value={summary.currentValueCount ? formatInr(summary.currentValue) : "—"} sub="Angel One when available · sheet fallback" />
        <Kpi label="Unrealised P/L" value={summary.unrealizedCount ? formatSignedInr(summary.unrealized) : "—"} tone={summary.unrealized >= 0 ? "positive" : "negative"} />
        <Kpi label="Realised P/L" value={summary.snapshotCount ? formatSignedInr(summary.realized) : "—"} tone={summary.realized >= 0 ? "positive" : "negative"} />
        <Kpi label="Open positions" value={String(summary.open)} />
        <Kpi label="Qty mismatches" value={String(summary.mismatches)} tone={summary.mismatches === 0 ? "positive" : "negative"} />
      </section>

      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="min-w-[240px] flex-1 space-y-1.5">
          <Label htmlFor="holding-search">Search holdings</Label>
          <Input id="holding-search" value={search} placeholder="Ticker, company or sector" onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="w-44 space-y-1.5">
          <Label>Positions</Label>
          <Select value={positionFilter} onValueChange={(value) => setPositionFilter(value as PositionFilter)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All positions</SelectItem>
              <SelectItem value="OPEN">Open only</SelectItem>
              <SelectItem value="CLOSED">Closed only</SelectItem>
              <SelectItem value="MISMATCH">Qty mismatch</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-48 space-y-1.5">
          <Label>Sort by</Label>
          <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="TICKER">Ticker A–Z</SelectItem>
              <SelectItem value="CURRENT_VALUE">Current value</SelectItem>
              <SelectItem value="UNREALIZED_PCT">Unrealised %</SelectItem>
              <SelectItem value="REALIZED_PL">Realised P/L</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-right">
          <p className="font-mono text-xs text-muted-foreground">{enriched.length} positions shown</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Price hierarchy: LIVE → CACHED → SHEET · {summary.liveCount} live · {summary.cachedCount} cached</p>
        </div>
      </section>

      {query.data && rows.length === 0 ? (
        <EmptyState title="No holdings yet" description="Commit transactions first, then optionally load a HOLDINGS spreadsheet snapshot." />
      ) : null}

      {enriched.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1780px] text-sm">
            <thead className="sticky top-0 bg-muted/60 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">Ticker</th>
                <th className="px-3 py-2.5">Company</th>
                <th className="px-3 py-2.5 text-right">Net units</th>
                <th className="px-3 py-2.5 text-right">Avg. buy</th>
                <th className="px-3 py-2.5 text-right">Invested value</th>
                <th className="px-3 py-2.5 text-right">Current price</th>
                <th className="px-3 py-2.5 text-right">Current value</th>
                <th className="px-3 py-2.5 text-right">Unrealised P/L</th>
                <th className="px-3 py-2.5 text-right">Unrealised %</th>
                <th className="px-3 py-2.5 text-right">Realised P/L</th>
                <th className="px-3 py-2.5 text-right">Realised %</th>
                <th className="px-3 py-2.5">Sector</th>
                <th className="px-3 py-2.5">Quality</th>
                <th className="px-3 py-2.5">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {enriched.map((row) => {
                const snapshot = row.snapshot;
                const holding = row.holding;
                const securityId = row.security?.id ?? snapshot?.security_id ?? holding?.security_id;
                const nonValid = Number(holding?.non_valid_txn_count ?? 0);
                const realized = nullableNumber(snapshot?.spreadsheet_realized_pl ?? null);
                const realizedPct = nullableNumber(snapshot?.spreadsheet_realized_pct ?? null);
                return (
                  <tr key={securityId} className={`align-top ${row.closed ? "bg-muted/15" : ""}`}>
                    <td className="px-3 py-3">
                      <p className="font-mono font-semibold text-foreground">{row.ticker}</p>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{row.security?.exchange ?? "—"}</p>
                    </td>
                    <td className="max-w-[260px] px-3 py-3">
                      <p className="truncate text-foreground">{row.company}</p>
                      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{row.security?.isin ?? "no ISIN"}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-semibold">
                      {row.ledgerQuantity === null ? <Unavailable reason="Ledger quantity cannot be determined." /> : trimNumber(row.ledgerQuantity)}
                      {row.mismatch ? <div className="mt-1"><StatusBadge tone="bad">sheet {trimNumber(row.snapshotQuantity ?? 0)}</StatusBadge></div> : null}
                    </td>
                    <MetricCell value={snapshot?.avg_buy_price} kind="inr" />
                    <MetricCell value={snapshot?.invested_value} kind="inr" />
                    <td className="px-3 py-3 text-right">
                      {row.currentPrice !== null ? (
                        <><span className="font-mono">{formatInr(row.currentPrice, 2)}</span><div className="mt-1"><PriceSourceBadge source={row.priceSource} /></div></>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <NumericMetricCell value={row.currentValue} kind="inr" />
                    <NumericMetricCell value={row.unrealized} kind="inr" signed />
                    <NumericMetricCell value={row.unrealizedPct} kind="pct" signed />
                    <NumericMetricCell value={realized} kind="inr" signed />
                    <NumericMetricCell value={realizedPct} kind="pct" signed />
                    <td className="max-w-[180px] px-3 py-3 text-xs text-muted-foreground">{snapshot?.sector ?? "—"}</td>
                    <td className="px-3 py-3">
                      <div className="flex max-w-[170px] flex-wrap gap-1">
                        {row.mismatch ? <StatusBadge tone="bad">qty mismatch</StatusBadge> : snapshot ? <StatusBadge tone="ok">qty reconciled</StatusBadge> : null}
                        {nonValid > 0 ? <StatusBadge tone="warn">{nonValid} incomplete txn{nonValid === 1 ? "" : "s"}</StatusBadge> : null}
                        {row.closed ? <StatusBadge tone="neutral">closed</StatusBadge> : null}
                        {!snapshot ? <StatusBadge tone="neutral">no snapshot</StatusBadge> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {securityId ? (
                        <Select
                          value={row.setting?.role ?? "UNASSIGNED"}
                          onValueChange={(role) => setRole.mutate({ securityId, role: role as PortfolioRole, existingId: row.setting?.id ?? null })}
                        >
                          <SelectTrigger className="h-8 w-[145px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{PORTFOLIO_ROLES.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : "—"}
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

function prepareHoldingRow(row: HoldingRow) {
  const ledgerQuantity = row.holding ? nullableNumber(row.holding.net_quantity) : 0;
  const snapshotQuantity = nullableNumber(row.snapshot?.net_units_claim ?? null);
  const mismatch = row.snapshot !== null && ledgerQuantity !== null && snapshotQuantity !== null && Math.abs(ledgerQuantity - snapshotQuantity) > 0.00000001;
  const closed = ledgerQuantity === 0;
  const ticker = row.snapshot?.source_ticker ?? row.security?.primary_symbol ?? "—";
  const company = row.snapshot?.source_company_name ?? row.security?.name ?? "Unknown security";

  const angelPrice = nullableNumber(row.marketPrice?.price ?? null);
  const retrievedAtMs = row.marketPrice?.retrievedAt ? new Date(row.marketPrice.retrievedAt).getTime() : Number.NaN;
  const angelFresh = Number.isFinite(retrievedAtMs) && Date.now() - retrievedAtMs <= ANGEL_FRESH_MS;
  const sheetPrice = nullableNumber(row.snapshot?.spreadsheet_current_price ?? null);

  let currentPrice: number | null = null;
  let priceSource: PriceSource = "UNAVAILABLE";
  if (angelPrice !== null) {
    currentPrice = angelPrice;
    priceSource = angelFresh ? "LIVE" : "CACHED";
  } else if (sheetPrice !== null) {
    currentPrice = sheetPrice;
    priceSource = "SHEET";
  }

  const investedValue = nullableNumber(row.snapshot?.invested_value ?? null);
  let currentValue: number | null = null;
  let unrealized: number | null = null;
  let unrealizedPct: number | null = null;

  if (priceSource === "LIVE" || priceSource === "CACHED") {
    currentValue = currentPrice !== null && ledgerQuantity !== null ? currentPrice * ledgerQuantity : null;
    unrealized = currentValue !== null && investedValue !== null ? currentValue - investedValue : null;
    unrealizedPct = unrealized !== null && investedValue !== null && investedValue !== 0 ? (unrealized / investedValue) * 100 : null;
  } else if (priceSource === "SHEET") {
    currentValue = nullableNumber(row.snapshot?.spreadsheet_current_value ?? null);
    unrealized = nullableNumber(row.snapshot?.spreadsheet_unrealized_pl ?? null);
    unrealizedPct = nullableNumber(row.snapshot?.spreadsheet_unrealized_pct ?? null);
  }

  return { ...row, ledgerQuantity, snapshotQuantity, mismatch, closed, ticker, company, currentPrice, currentValue, unrealized, unrealizedPct, priceSource };
}

function PriceSourceBadge({ source }: { source: PriceSource }) {
  if (source === "LIVE") return <StatusBadge tone="ok">LIVE</StatusBadge>;
  if (source === "CACHED") return <StatusBadge tone="warn">CACHED</StatusBadge>;
  if (source === "SHEET") return <StatusBadge tone="neutral">SHEET</StatusBadge>;
  return null;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" | "negative" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-2 font-mono text-xl font-semibold ${tone === "positive" ? "text-emerald-400" : tone === "negative" ? "text-destructive" : "text-foreground"}`}>{value}</p>
      {sub ? <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function MetricCell({ value, kind, signed = false }: { value: string | null | undefined; kind: "inr" | "pct"; signed?: boolean }) {
  return <NumericMetricCell value={nullableNumber(value ?? null)} kind={kind} signed={signed} />;
}

function NumericMetricCell({ value, kind, signed = false }: { value: number | null; kind: "inr" | "pct"; signed?: boolean }) {
  if (value === null) return <td className="px-3 py-3 text-right text-muted-foreground">—</td>;
  const text = kind === "pct" ? `${value.toFixed(2)}%` : formatInr(value, 2);
  const tone = signed ? (value > 0 ? "text-emerald-400" : value < 0 ? "text-destructive" : "text-muted-foreground") : "text-foreground";
  return <td className={`px-3 py-3 text-right font-mono ${tone}`}>{text}</td>;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nullableSortDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function numberOrZero(value: string | number | null | undefined): number {
  return nullableNumber(value) ?? 0;
}

function trimNumber(value: string | number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 8 }).format(numeric);
}

function formatInr(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits,
  }).format(value);
}

function formatSignedInr(value: number): string {
  const absolute = formatInr(Math.abs(value));
  return value > 0 ? `+${absolute}` : value < 0 ? `-${absolute}` : absolute;
}
