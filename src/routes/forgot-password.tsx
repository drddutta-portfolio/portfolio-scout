import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/routes/login";
import { useAuth } from "@/providers/auth";

export const Route = createFileRoute("/forgot-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Reset your password — PortfolioAI" },
      { name: "description", content: "Request a PortfolioAI password reset email." },
      { property: "og:title", content: "Reset your password — PortfolioAI" },
      { property: "og:description", content: "Request a PortfolioAI password reset email." },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Forgot password" subtitle="We will email a link to set a new password.">
      {sent ? (
        <p className="text-sm text-muted-foreground">
          If that address has an account, a reset link is on its way.
        </p>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-xs text-muted-foreground">
        <Link to="/login" className="underline underline-offset-4 hover:text-foreground">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
