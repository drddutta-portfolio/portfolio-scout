import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { ErrorState, LoadingState } from "@/components/state";
import { useAuth } from "@/providers/auth";

/**
 * Session gate for every application route.
 * ssr: false — the Supabase session lives in browser storage, so the server
 * cannot evaluate it and a server-side gate would loop on hard refresh.
 */
export const Route = createFileRoute("/_app")({
  ssr: false,
  component: ProtectedLayout,
});

function ProtectedLayout() {
  const { status, session, configError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (status === "ready" && !session) {
      void navigate({ to: "/login", replace: true });
    }
  }, [status, session, navigate]);

  if (status === "error") {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState error={configError} title="Backend unavailable" />
      </div>
    );
  }

  if (status === "loading" || !session) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <LoadingState label="Checking your session" />
      </div>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
