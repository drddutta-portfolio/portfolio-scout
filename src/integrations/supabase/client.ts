import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig } from "@/lib/supabase-config.functions";

/**
 * Browser Supabase client for the dedicated PortfolioAI Supabase project.
 *
 * Uses the publishable (anon) key ONLY. Row Level Security is the authorization
 * boundary. The service-role key is never referenced here and never reaches the
 * browser. No credential value is ever hard-coded — the public configuration
 * (project URL + publishable key, both public by design) is fetched at runtime
 * from the server, which reads it from the secure secret store.
 */

let clientPromise: Promise<SupabaseClient> | null = null;

/**
 * Returns the browser Supabase client, creating it on first use.
 * Rejects with a clear, non-sensitive error when the dedicated project
 * is not yet connected, rather than silently degrading.
 */
export function getSupabaseClient(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = getPublicSupabaseConfig().then(({ url, publishableKey }) =>
      createClient(url, publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    );
  }
  return clientPromise;
}
