import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAuth } from "@/providers/auth";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "PortfolioAI — personal investment ledger" },
      {
        name: "description",
        content:
          "PortfolioAI: transaction-derived personal portfolio records, deterministic imports and auditable holdings.",
      },
      { property: "og:title", content: "PortfolioAI — personal investment ledger" },
      {
        property: "og:description",
        content: "Deterministic, transaction-derived portfolio records for a single investor.",
      },
    ],
  }),
  component: RootRedirect,
});

function RootRedirect() {
  const { status, session } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (status !== "ready") return;
    void navigate({ to: session ? "/dashboard" : "/login", replace: true });
  }, [status, session, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
        PortfolioAI
      </p>
    </div>
  );
}
