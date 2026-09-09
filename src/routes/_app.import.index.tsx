import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/state";
import { MAPPABLE_FIELDS, guessMapping, type MappableField } from "@/lib/import-logic";
import { parseSpreadsheet, type ParsedFile } from "@/lib/parse-file";
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
  const [mapping, setMapping] = useState<Partial<Record<MappableField, number>>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotType, setSnapshotType] = useState<TxnType | "">("");
  const [snapshotDate, setSnapshotDate] = useState("");

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

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParseError(null);
    setBusy(true);
    try {
      const result = await parseSpreadsheet(file);
      setParsed(result);
      setMapping(guessMapping(result.headers));
    } catch (err) {
      setParsed(null);
      setParseError(err instanceof Error ? err.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }

  const stage = useMutation({
    mutationFn: async () => {
      if (!parsed || !activePortfolio) throw new Error("Nothing to stage.");
      const { data: batch, error } = await supabase
        .from("import_batches")
        .insert({
          owner_id: user!.id,
          portfolio_id: activePortfolio.id,
          original_filename: parsed.fileName,
          source_format: parsed.format,
          mime_type: parsed.mimeType,
          file_size_bytes: parsed.sizeBytes,
          file_sha256: parsed.sha256,
          client_request_id: crypto.randomUUID(),
          total_source_rows: parsed.rows.length,
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

      const records = parsed.rows.map((row, i) => {
        const payload: Record<string, string> = {};
        parsed.headers.forEach((header, index) => {
          payload[header] = row[index] ?? "";
        });
        return {
          import_batch_id: batchId,
          owner_id: user!.id,
          source_row_number: i + 1,
          raw_payload: payload,
          raw_line: row.join(","),
          raw_security_text: pick(row, "security_text"),
          raw_exchange: pick(row, "exchange"),
          raw_isin: pick(row, "isin"),
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
    parsed &&
      mapping.security_text !== undefined &&
      hasType &&
      hasDate &&
      mapping.quantity !== undefined,
  );

  return (
    <>
      <PageHeader
        title="Import transactions"
        description="Your file is read inside the browser. Only the extracted cell text and a checksum are stored; the original file is never uploaded."
      />

      <div className="space-y-4">
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">1. Choose a file</h2>
          <p className="mt-1 text-xs text-muted-foreground">CSV, XLSX or XLS. First sheet only.</p>
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
              {parsed.rows.length} rows · {parsed.headers.length} columns · sha256{" "}
              {parsed.sha256.slice(0, 16)}…
            </p>
          ) : null}
        </section>

        {parsed ? (
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
                        {parsed.headers.map((header, index) => (
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
                  2b. Snapshot values for the whole file
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  This file has no transaction type and/or trade date per row. Choose them yourself
                  and they will be applied to every row exactly as entered. Nothing is guessed.
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
                      <Label htmlFor="snapshot-date">Date for all rows</Label>
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
              <div className="mt-3 overflow-x-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left font-mono uppercase tracking-wider text-muted-foreground">
                    <tr>
                      {parsed.headers.map((header, i) => (
                        <th key={i} className="whitespace-nowrap px-3 py-2">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {parsed.rows.slice(0, 8).map((row, i) => (
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
                  {stage.isPending ? "Staging…" : "Stage rows for review"}
                </Button>
                {!canStage ? (
                  <p className="text-xs text-muted-foreground">
                    Provide security, quantity, and a transaction type and trade date — either
                    mapped from the file or chosen above for the whole file.
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
