import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { getSupabaseClient } from "@/integrations/supabase/client";

/**
 * Small auth provider over the existing external Supabase project.
 * No public signup: users are created manually in Supabase.
 * On the first authenticated load, the owner's profiles / user_settings rows
 * are provisioned through the existing authenticated INSERT grants only.
 */

interface AuthContextValue {
  client: SupabaseClient | null;
  session: Session | null;
  user: User | null;
  status: "loading" | "ready" | "error";
  configError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    getSupabaseClient()
      .then(async (c) => {
        if (cancelled) return;
        setClient(c);
        const { data } = await c.auth.getSession();
        if (cancelled) return;
        setSession(data.session ?? null);
        setStatus("ready");
        const sub = c.auth.onAuthStateChange((_event, next) => setSession(next ?? null));
        unsubscribe = () => sub.data.subscription.unsubscribe();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setConfigError(error instanceof Error ? error.message : "Supabase is not available.");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // First-authenticated-load provisioning (existing grants only).
  useEffect(() => {
    const userId = session?.user?.id;
    if (!client || !userId) return;
    let cancelled = false;
    void (async () => {
      const { data: profile } = await client
        .from("profiles")
        .select("id")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled) return;
      if (!profile) {
        await client
          .from("profiles")
          .insert({ id: userId, display_name: session?.user?.email ?? null });
      }
      const { data: settings } = await client
        .from("user_settings")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (cancelled) return;
      if (!settings) {
        await client.from("user_settings").insert({ user_id: userId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session?.user?.id, session?.user?.email]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const c = client ?? (await getSupabaseClient());
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    [client],
  );

  const signOut = useCallback(async () => {
    const c = client ?? (await getSupabaseClient());
    await c.auth.signOut();
  }, [client]);

  const sendPasswordReset = useCallback(
    async (email: string) => {
      const c = client ?? (await getSupabaseClient());
      const { error } = await c.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw new Error(error.message);
    },
    [client],
  );

  const updatePassword = useCallback(
    async (password: string) => {
      const c = client ?? (await getSupabaseClient());
      const { error } = await c.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },
    [client],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      client,
      session,
      user: session?.user ?? null,
      status,
      configError,
      signIn,
      signOut,
      sendPasswordReset,
      updatePassword,
    }),
    [client, session, status, configError, signIn, signOut, sendPasswordReset, updatePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Supabase client guaranteed present inside the authenticated shell. */
export function useSupabase(): SupabaseClient {
  const { client } = useAuth();
  if (!client) throw new Error("Supabase client is not ready yet");
  return client;
}
