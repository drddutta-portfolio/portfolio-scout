import { AlertTriangle, Inbox, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DataQualityIssue } from "@/lib/types";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, title = "Could not load this data" }: { error: unknown; title?: string }) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        {title}
      </div>
      <p className="mt-1 font-mono text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-400",
};

export function StatusBadge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const ISSUE_TONE: Partial<Record<DataQualityIssue, Tone>> = {
  UNSUPPORTED_CORPORATE_ACTION: "bad",
  AMBIGUOUS_SECURITY: "warn",
  UNRESOLVED_SECURITY: "warn",
  DUPLICATE_SUSPECTED: "info",
  NEGATIVE_DERIVED_QUANTITY: "bad",
};

export function IssueBadges({ issues }: { issues: DataQualityIssue[] }) {
  if (!issues || issues.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {issues.map((issue) => (
        <StatusBadge key={issue} tone={ISSUE_TONE[issue] ?? "warn"}>
          {issue.replace(/_/g, " ")}
        </StatusBadge>
      ))}
    </span>
  );
}

/** A value the backend genuinely does not have. Never rendered as zero. */
export function Unavailable({ reason }: { reason: string }) {
  return (
    <span title={reason} className="font-mono text-xs uppercase tracking-wide text-amber-400">
      Unavailable
    </span>
  );
}
