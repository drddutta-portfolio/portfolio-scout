import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/state";
import {
  MAPPABLE_FIELDS,
  detectSheetKind,
  guessMapping,
  isFillerRow,
  parseHoldingsSheet,
  parseStockMaster,
  storeHoldingsClaim,
  type MappableField,
} from "@/lib/import-logic";
import { parseSpreadsheet, type ParsedFile, type ParsedSheet } from "@/lib/parse-file";
import { chunks } from "@/lib/security-resolution";
import { SUPPORTED_TXN_TYPES, type ImportBatch, type TxnType } from "@/lib/types";
import { useAuth, useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/import/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Import transactions — PortfolioAI" },
      {
        name: "description",
        content: "Read a CSV, XLSX or XLS statement in your browser and stage it for review.",
      },
      { property: "og:title", content: "Import transactions — PortfolioAI" },
      {
        property: "og:description",
        content: "Read a CSV, XLSX or XLS statement in your browser and stage it for review.",
      },
    ],
  }),
  component: ImportPage,
});

const NONE = "__none__";

function ImportPage() {
  const supabase = useSupabase();
  const { user } = useAuth();
  const { activePortfolio } = usePortfolios();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [tradeSheet, setTradeSheet] = useState<string>("");
  const [mapping, setMapping] = useState<Partial<Record<MappableField, number>>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotType, setSnapshotType] = useState<TxnType | "">("");
  const [snapshotDate, setSnapshotDate] = useState("");
  const [showManual, setShowManual] = useState(false);

  const batches = useQuery({
    queryKey: ["batches", activePortfolio?.id],
    enabled: Boolean(activePortfolio),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("import_batches")
        .select("*")
        .eq("portfolio_id", activePortfolio!.id)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ImportBatch[];
    },
  });

  const sheetKinds = useMemo(() => {
    const map = new Map<string, ReturnType<typeof detectSheetKind>>();
    for (const sheet of parsed?.sheets ?? []) {
      map.set(sheet.name, detectSheetKind(sheet.name, sheet.headers));
    }
    return map;
  }, [parsed]);

  const active: ParsedSheet | null =
    parsed?.sheets.find((sheet) => sheet.name === tradeSheet) ?? null;

  const stockMaster = useMemo(() => {
    const sheet = parsed?.sheets.find((s) => sheetKinds.get(s.name) === "STOCKMASTER");
    return sheet ? parseStockMaster(sheet.headers, sheet.rows) : null;
  }, [parsed, sheetKinds]);

  const holdingsClaims = useMemo(() => {
    const sheet = parsed?.sheets.find((s) => sheetKinds.get(s.name) === "HOLDINGS");
    return sheet ? parseHoldingsSheet(sheet.headers, sheet.rows) : [];
  }, [parsed, sheetKinds]);

  const dataRows = useMemo(
    () => (active ? active.rows.filter((row) => !isFillerRow(row, mapping)) : []),
    [active, mapping],
  );
  const skipped = (active?.rows.length ?? 0) - dataRows.length;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParseError(null);
    setBusy(true);
    try {
      const result = await parseSpreadsheet(file);
      setParsed(result);
      const kinds = result.sheets.map((sheet) => ({
        sheet,
        kind: detectSheetKind(sheet.name, sheet.headers),
      }));
      const chosen = kinds.find((k) => k.kind === "TRANSACTIONS")?.sheet ?? result.sheets[0]!;
      setTradeSheet(chosen.name);
      setMapping(guessMapping(chosen.headers));
    } catch (err) {
      setParsed(null);
      setParseError(err instanceof Error ? err.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }

  function selectSheet(name: string) {
    setTradeSheet(name);
    const sheet = parsed?.sheets.find((s) => s.name === name);
    if (sheet) setMapping(guessMapping(sheet.headers));
  }

  const stage = useMutation({
    mutationFn: async () => {
      if (!parsed || !active || !activePortfolio) throw new Error("Nothing to stage.");
      const { data: batch, error } = await supabase
        .from("import_batches")
        .insert({
          owner_id: user!.id,
          portfolio_id: activePortfolio.id,
          original_filename: `${parsed.fileName} · ${active.name}`,
          source_format: parsed.format,
          mime_type: parsed.mimeType,
          file_size_bytes: parsed.sizeBytes,
          file_sha256: parsed.sha256,
          client_request_id: crypto.randomUUID(),
          total_source_rows: dataRows.length,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const batchId = (batch as { id: string }).id;

      const pick = (row: string[], field: MappableField): string | null => {
        const index = mapping[field];
        if (index === undefined) return null;
        const value = row[index];
        return value && value.trim() !== "" ? value.trim() : null;
      };

      const records = dataRows.map((row, i) => {
        const payload: Record<string, string> = {};
        active.headers.forEach((header, index) => {
          payload[header] = row[index] ?? "";
        });

        let isin = pick(row, "isin");
        const symbol = pick(row, "security_text");
        if (!isin && symbol && stockMaster) {
          const entry = stockMaster.get(symbol.toUpperCase());
          if (entry?.isin) {
            isin = entry.isin;
            payload["__isin_source"] = `${parsed.fileName} · STOCKMASTER sheet`;
          }
        }

        return {
          import_batch_id: batchId,
          owner_id: user!.id,
          source_row_number: i + 1,
          raw_payload: payload,
          raw_line: row.join(","),
          raw_security_text: symbol,
          raw_exchange: pick(row, "exchange"),
          raw_isin: isin,
          raw_broker_text: pick(row, "broker_text"),
          raw_account_text: pick(row, "account_text"),
          raw_txn_type: pick(row, "txn_type") ?? (snapshotType === "" ? null : snapshotType),
          raw_date: pick(row, "date") ?? (snapshotDate === "" ? null : snapshotDate),
          raw_quantity: pick(row, "quantity"),
          raw_unit_price: pick(row, "unit_price"),
          raw_gross_amount: pick(row, "gross_amount"),
          raw_total_charges: pick(row, "total_charges"),
          raw_currency: pick(row, "currency"),
          raw_source_reference: pick(row, "source_reference"),
        };
      });

      for (const chunk of chunks(records, 250)) {
        const { error: rowError } = await supabase.from("import_source_rows").insert(chunk);
        if (rowError) throw new Error(rowError.message);
      }

      if (holdingsClaims.length > 0) storeHoldingsClaim(batchId, holdingsClaims);

      await supabase.from("import_batches").update({ state: "PREVIEWED" }).eq("id", batchId);
      return batchId;
    },
    onSuccess: async (batchId) => {
      await queryClient.invalidateQueries({ queryKey: ["batches", activePortfolio?.id] });
      toast.success("Rows staged for review");
      await navigate({ to: "/import/$batchId", params: { batchId } });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!activePortfolio) {
    return (
      <>
        <PageHeader title="Import" />
        <EmptyState
          title="No portfolio selected"
          description="Create a portfolio in Settings before importing."
          action={
            <Button asChild size="sm">
              <Link to="/settings">Open settings</Link>
            </Button>
          }
        />
      </>
    );
  }

  const hasType = mapping.txn_type !== undefined || snapshotType !== "";
  const hasDate = mapping.date !== undefined || snapshotDate !== "";

  const canStage = Boolean(
    active && dataRows.length > 0 && mapping.security_text !== undefined && hasType && mapping.quantity !== undefined,
  );

  return (
    <>
      <PageHeader
        title="Import transactions"
        description="Your file is read inside the browser. Only the extracted cell text and a checksum are stored; the original file is never uploaded."
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowManual((v) => !v)}>
            {showManual ? "Close" : "Add a trade manually"}
          </Button>
        }
      />

      {showManual ? (
        <div className="mb-4">
          <ManualTradeForm onDone={() => setShowManual(false)} />
        </div>
      ) : null}

      <div className="space-y-4">
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">1. Choose a file</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            CSV, XLSX or XLS. Workbooks with several sheets are supported.
          </p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            className="mt-3 block w-full cursor-pointer rounded border border-border bg-background p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-secondary-foreground"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          {busy ? <div className="mt-3"><LoadingState label="Reading the file" /></div> : null}
          {parseError ? <div className="mt-3"><ErrorState error={parseError} title="Could not read that file" /></div> : null}
          {parsed ? (
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              {parsed.sheets.length} sheet{parsed.sheets.length === 1 ? "" : "s"} · sha256{" "}
              {parsed.sha256.slice(0, 16)}…
            </p>
          ) : null}
        </section>

        {parsed && parsed.sheets.length > 0 ? (
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-foreground">1b. Which sheet holds the trades?</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Only the trades sheet is imported. A holdings sheet is used for comparison, and a
              stock-master sheet only helps match tickers — neither is stored as a fact.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {parsed.sheets.map((sheet) => {
                const kind = sheetKinds.get(sheet.name) ?? "UNKNOWN";
                const selected = sheet.name === tradeSheet;
                return (
                  <button
                    key={sheet.name}
                    type="button"
                    onClick={() => selectSheet(sheet.name)}
                    className={`rounded border px-3 py-2 text-left text-xs transition-colors ${
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="font-medium">{sheet.name}</div>
                    <div className="font-mono text-[10px] uppercase tracking-widest">
                      {kind.toLowerCase()} · {sheet.rows.length} rows
                    </div>
                  </button>
                );
              })}
            </div>
            {holdingsClaims.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Holdings sheet found: {holdingsClaims.length} tickers kept for comparison after the
                import is finalised.
              </p>
            ) : null}
            {stockMaster && stockMaster.size > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Stock master found: {stockMaster.size} symbols with ISINs available as matching
                evidence.
              </p>
            ) : null}
          </section>
        ) : null}

        {active ? (
          <>
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-semibold text-foreground">2. Map the columns</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Anything left unmapped stays empty. Nothing is guessed, defaulted or derived later.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {MAPPABLE_FIELDS.map(({ field, label, hint }) => (
                  <div key={field} className="space-y-1.5">
                    <Label>
                      {label}
                      {hint ? (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          {hint}
                        </span>
                      ) : null}
                    </Label>
                    <Select
                      value={mapping[field] === undefined ? NONE : String(mapping[field])}
                      onValueChange={(value) =>
                        setMapping((prev) => {
                          const next = { ...prev };
                          if (value === NONE) delete next[field];
                          else next[field] = Number(value);
                          return next;
                        })
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not in this file</SelectItem>
                        {active.headers.map((header, index) => (
                          <SelectItem key={`${header}-${index}`} value={String(index)}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </section>

            {mapping.txn_type === undefined || mapping.date === undefined ? (
              <section className="rounded-lg border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground">
                  2b. Values for rows that do not state them
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Anything you choose here is applied exactly as entered and only where the file
                  itself is silent. Leave the date empty and undated rows simply stay undated —
                  they are held back rather than guessed.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {mapping.txn_type === undefined ? (
                    <div className="space-y-1.5">
                      <Label>Transaction type for all rows</Label>
                      <Select
                        value={snapshotType === "" ? NONE : snapshotType}
                        onValueChange={(value) =>
                          setSnapshotType(value === NONE ? "" : (value as TxnType))
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Choose a type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Leave empty</SelectItem>
                          {SUPPORTED_TXN_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {type}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {mapping.date === undefined ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="snapshot-date">Date for rows with no date</Label>
                      <input
                        id="snapshot-date"
                        type="date"
                        value={snapshotDate}
                        onChange={(event) => setSnapshotDate(event.target.value)}
                        className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
                      />
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-semibold text-foreground">3. Preview</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {dataRows.length} rows will be staged
                {skipped > 0 ? ` · ${skipped} empty rows skipped` : ""}.
              </p>
              <div className="mt-3 overflow-x-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left font-mono uppercase tracking-wider text-muted-foreground">
                    <tr>
                      {active.headers.map((header, i) => (
                        <th key={i} className="whitespace-nowrap px-3 py-2">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dataRows.slice(0, 8).map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j} className="whitespace-nowrap px-3 py-1.5 font-mono">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button disabled={!canStage || stage.isPending} onClick={() => stage.mutate()}>
                  {stage.isPending ? "Staging…" : `Stage ${dataRows.length} rows for review`}
                </Button>
                {!canStage ? (
                  <p className="text-xs text-muted-foreground">
                    Map a security column, a quantity column, and either a transaction-type column
                    or a type chosen above.
                  </p>
                ) : null}
              </div>
            </section>
          </>
        ) : null}

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Import batches</h2>
          {batches.isLoading ? <LoadingState label="Loading batches" /> : null}
          {batches.error ? <ErrorState error={batches.error} /> : null}
          {batches.data && batches.data.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No import batch yet.</p>
          ) : null}
          <ul className="mt-2 divide-y divide-border">
            {(batches.data ?? []).map((batch) => (
              <li key={batch.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <Link
                  to="/import/$batchId"
                  params={{ batchId: batch.id }}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {batch.original_filename}
                </Link>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {batch.total_source_rows ?? "?"} rows
                </span>
                <StatusBadge tone={batch.state === "COMMITTED" ? "ok" : "info"}>
                  {batch.state}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

/**
 * A manual entry is not a shortcut around the ledger: it becomes a one-row
 * staging batch and goes through the same review and trusted commit path.
 */
function ManualTradeForm({ onDone }: { onDone: () => void }) {
  const supabase = useSupabase();
  const { user } = useAuth();
  const { activePortfolio } = usePortfolios();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [security, setSecurity] = useState("");
  const [isin, setIsin] = useState("");
  const [exchange, setExchange] = useState("");
  const [type, setType] = useState<TxnType | "">("");
  const [date, setDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [charges, setCharges] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [broker, setBroker] = useState("");
  const [reference, setReference] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      if (!activePortfolio) throw new Error("Select a portfolio first.");
      if (!security.trim()) throw new Error("Enter the security.");
      if (type === "") throw new Error("Choose a transaction type.");
      if (!quantity.trim()) throw new Error("Enter the quantity.");

      const entered = new Date().toISOString();
      const { data: batch, error } = await supabase
        .from("import_batches")
        .insert({
          owner_id: user!.id,
          portfolio_id: activePortfolio.id,
          original_filename: `Manual entry · ${entered.slice(0, 16).replace("T", " ")}`,
          source_format: "MANUAL",
          client_request_id: crypto.randomUUID(),
          total_source_rows: 1,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const batchId = (batch as { id: string }).id;

      const value = (v: string) => (v.trim() === "" ? null : v.trim());
      const { error: rowError } = await supabase.from("import_source_rows").insert({
        import_batch_id: batchId,
        owner_id: user!.id,
        source_row_number: 1,
        raw_payload: { entered_at: entered, entered_by: "manual form" },
        raw_security_text: value(security),
        raw_isin: value(isin.toUpperCase()),
        raw_exchange: value(exchange.toUpperCase()),
        raw_broker_text: value(broker),
        raw_txn_type: type,
        raw_date: value(date),
        raw_quantity: value(quantity),
        raw_unit_price: value(price),
        raw_total_charges: value(charges),
        raw_currency: value(currency.toUpperCase()),
        raw_source_reference: value(reference),
      });
      if (rowError) throw new Error(rowError.message);

      await supabase.from("import_batches").update({ state: "PREVIEWED" }).eq("id", batchId);
      return batchId;
    },
    onSuccess: async (batchId) => {
      await queryClient.invalidateQueries({ queryKey: ["batches", activePortfolio?.id] });
      toast.success("Trade staged — confirm the security and account to finalise it");
      onDone();
      await navigate({ to: "/import/$batchId", params: { batchId } });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">Add a trade manually</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        This goes through the same review and confirmation as a file. Leave the date empty if you
        genuinely do not know it — the trade is then held back rather than dated for you.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Security name or ticker" value={security} onChange={setSecurity} />
        <Field label="ISIN (optional)" value={isin} onChange={setIsin} />
        <Field label="Exchange (optional)" value={exchange} onChange={setExchange} />
        <div className="space-y-1.5">
          <Label>Transaction type</Label>
          <Select value={type === "" ? NONE : type} onValueChange={(v) => setType(v === NONE ? "" : (v as TxnType))}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not chosen</SelectItem>
              {SUPPORTED_TXN_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="manual-date">Trade date</Label>
          <input
            id="manual-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
          />
        </div>
        <Field label="Quantity" value={quantity} onChange={setQuantity} />
        <Field label="Unit price (optional)" value={price} onChange={setPrice} />
        <Field label="Charges (optional)" value={charges} onChange={setCharges} />
        <Field label="Currency" value={currency} onChange={setCurrency} />
        <Field label="Broker (optional)" value={broker} onChange={setBroker} />
        <Field label="Reference (optional)" value={reference} onChange={setReference} />
      </div>
      <div className="mt-4 flex gap-2">
        <Button disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Staging…" : "Stage this trade"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input className="h-9" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
